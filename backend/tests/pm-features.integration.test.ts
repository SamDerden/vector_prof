import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { randomUUID,createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { renderRoutePdf } from '../lib/route-pdf.ts';
import { PDFDocument } from 'pdf-lib';
import { assistantPost,assistantHistory } from '../lib/assistant-api.ts';
import { POST as feedback } from '../app/api/feedback/route.ts';
import { GET as pdf } from '../app/api/route/export/pdf/route.ts';
import { OpenAICompatibleClient } from '../lib/ai/llm/openaiCompatible.ts';
import { issueSessionProof,sessionProofCookieName } from '../lib/session-proof.ts';
import { loadRuntimeCatalog } from '../lib/runtime-catalog.ts';
import { buildFreezeIndex,validateFreezeEmbeddingIndex } from '../lib/ai/freeze-embedding.ts';
import { educationRouteSchema,saveEducationRoute } from '../lib/education-route.ts';

// Real PostgreSQL engine in WASM; no production connection or AI charges.
test('PM features: migrations, owner isolation, retries, quotas, provider errors, PDF and feedback',async()=>{
 const db=new PGlite();
 const q=async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {rows:r.rows as any[],rowCount:r.rows.length || r.affectedRows || 0};};
 (globalThis as any).pgPool={query:q,connect:async()=>({query:q,release(){}})};
 process.env.SESSION_PROOF_SECRET='local-test-only-'.repeat(4);
 process.env.SESSION_PROOF_ENFORCED='true';
 process.env.ASSISTANT_ENABLED='true';process.env.ASSISTANT_DAILY_LIMIT='30';process.env.ASSISTANT_RETENTION_DAYS='30';
 process.env.LLM_BASE_URL='https://example.invalid/v1';process.env.LLM_API_KEY='test';process.env.LLM_MODEL='test';
 for(const name of (await fs.readdir('migrations')).filter(x=>x.endsWith('.sql')).sort()){
  const sql=(await fs.readFile(`migrations/${name}`,'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
  await db.exec(sql);
 }
 await db.exec(await fs.readFile('migrations/013_pm_features.sql','utf8')); // additive migration re-run
 const account=randomUUID(),other=randomUUID(),session=randomUUID(),token='local-auth-token',csrf='local-csrf-token';
 for(const id of [account,other])await q("INSERT INTO accounts(id,email,status,verified_at) VALUES($1,$2,'active',now())",[id,`${id}@example.invalid`]);
 await q("INSERT INTO auth_sessions(id,account_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",[randomUUID(),account,createHash('sha256').update(token).digest('base64url'),csrf]);
 await q("INSERT INTO sessions(id,track_type,account_id) VALUES($1,'explore',$2)",[session,account]);
 await q('INSERT INTO profiles(session_id,school_grade) VALUES($1,9)',[session]);
 const profession=loadRuntimeCatalog().catalog.professions[0].profession_id;
 const requestId=randomUUID();
 const cookie=`vector_auth_session=${token}; vector_csrf=${csrf}; ${sessionProofCookieName(session)}=${issueSessionProof(session)}`;
 const req=(body:any,opts:{cookie?:string;csrf?:string;url?:string;method?:string}={})=>new NextRequest(opts.url??'http://localhost/api/profession-assistant/message',{method:opts.method??'POST',headers:{cookie:opts.cookie??cookie,'x-csrf-token':opts.csrf??csrf,'x-session-id':session,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const body={profession_id:profession,session_id:session,request_id:requestId,question:'А сколько учиться?'};
 let calls=0;
 const original=OpenAICompatibleClient.prototype.chat;
 OpenAICompatibleClient.prototype.chat=async()=>{calls++;return {text:'Обучение зависит от выбранной программы. Посмотри варианты в каталоге.',latencyMs:1};};
 try{
  assert.equal((await assistantPost(req(body,{cookie:''}))).status,401);
  assert.equal((await assistantPost(req(body,{csrf:'wrong'}))).status,403);
  const foreign=randomUUID();await q("INSERT INTO sessions(id,track_type,account_id) VALUES($1,'explore',$2)",[foreign,other]);await q('INSERT INTO profiles(session_id,school_grade) VALUES($1,9)',[foreign]);
  assert.equal((await assistantPost(req({...body,session_id:foreign}))).status,404);
  assert.equal((await assistantPost(req({...body,profession_id:'prof_9999'}))).status,404);
  const response=await assistantPost(req(body));assert.equal(response.status,200);const answer=await response.json();assert.equal(answer.conversation_id,requestId);assert.equal(answer.sources[0].id,profession);
  assert.equal((await assistantPost(req(body))).status,200);assert.equal(calls,1,'retry must not call provider');
  assert.equal((await assistantPost(req({...body,question:'Другая работа?'}))).status,409);
  assert.equal((await assistantPost(req({...body,conversation_id:requestId,profession_id:loadRuntimeCatalog().catalog.professions[1].profession_id}))).status,404);
  await q("INSERT INTO assistant_leases(account_id,request_id,expires_at) VALUES($1,$2,now()+interval '1 minute')",[account,randomUUID()]);
  assert.equal((await assistantPost(req({...body,request_id:randomUUID()}))).status,429);await q('DELETE FROM assistant_leases');
  const ood=await assistantPost(req({...body,request_id:randomUUID(),question:'Напиши сочинение за меня'}));assert.equal((await ood.json()).status,'out_of_domain');assert.equal(calls,1);
  const insufficient=await assistantPost(req({...body,request_id:randomUUID(),question:'Какая зарплата сегодня?'}));assert.equal((await insufficient.json()).status,'insufficient_data');assert.equal(calls,1);
  OpenAICompatibleClient.prototype.chat=async()=>{throw new Error('provider down');};
  assert.equal((await assistantPost(req({...body,request_id:randomUUID()}))).status,502);
  assert.equal((await q('SELECT * FROM assistant_leases')).rowCount,0);
  const history=await assistantHistory(req(undefined,{method:'GET',url:`http://localhost/api/profession-assistant/conversations?conversation_id=${requestId}`}));assert.equal(history.status,200);assert.equal((await history.json()).data.length,1);
  const routeInput=educationRouteSchema.parse({professionKey:profession,completed:[0,2],saved:[],version:null});
  const route=await saveEducationRoute(q,session,routeInput);assert.equal(route.status,201);assert.ok(route.route?.route_id);
  const pdfResponse=await pdf(req(undefined,{method:'GET',url:`http://localhost/api/route/export/pdf?route_id=${route.route!.route_id}`}));assert.equal(pdfResponse.status,200);const bytes=await pdfResponse.arrayBuffer();assert.equal((await PDFDocument.load(bytes)).getPageCount(),1);
  const badRoute=randomUUID();assert.equal((await pdf(req(undefined,{method:'GET',url:`http://localhost/api/route/export/pdf?route_id=${badRoute}`}))).status,404);
  assert.equal((await pdf(req(undefined,{method:'GET',url:`http://localhost/api/route/export/pdf?route_id=${route.route!.route_id}&version=999`}))).status,409);
  assert.equal((await pdf(req(undefined,{method:'GET',url:`http://localhost/api/route/export/pdf?route_id=${route.route!.route_id}&version=abc`}))).status,400);
  const fb={request_id:randomUUID(),route_id:route.route!.route_id,clarity:5,recommendations:4,navigation:3,usefulness:5,comment:'Тестовый отзыв без персональных данных'};
  assert.equal((await feedback(req(fb))).status,201);assert.equal((await feedback(req(fb))).status,200);assert.equal((await q('SELECT * FROM feedback')).rowCount,1);
  assert.equal((await feedback(req({...fb,request_id:randomUUID(),clarity:6}))).status,422);
  assert.equal((await feedback(req({...fb,request_id:randomUUID(),route_id:badRoute}))).status,404);
  await q('DELETE FROM accounts WHERE id=$1',[account]);assert.equal((await q('SELECT * FROM assistant_conversations')).rowCount,0);assert.equal((await q('SELECT * FROM assistant_messages')).rowCount,0);
 }finally{OpenAICompatibleClient.prototype.chat=original;delete (globalThis as any).pgPool;await db.close();}
});

test('freeze validator rejects duplicated coverage and wrong model even if counts match',()=>{
 const runtime=loadRuntimeCatalog();
 const index=buildFreezeIndex({catalog:runtime.catalog,origin:runtime.origin,model:'EmbeddingsGigaR',dimensions:2560,vectorSource:'provider',vectors:runtime.catalog.chunks.map(()=>Array.from({length:2560},(_,i)=>i===0?1:0))});
 assert.deepEqual(validateFreezeEmbeddingIndex(index,runtime.catalog),[]);
 index.entries[1]=index.entries[0];assert.ok(validateFreezeEmbeddingIndex(index,runtime.catalog).includes('duplicate chunks'));
 index.embedding_model='other';assert.ok(validateFreezeEmbeddingIndex(index,runtime.catalog).includes('embedding model'));
});

test('Cyrillic PDF paginates long routes and preserves link annotations',async()=>{
 const bytes=await renderRoutePdf(Array.from({length:80},(_,i)=>({text:`Шаг ${i+1}. Выбранная профессия — инженер. Сохранённый маршрут школьника.`,url:'https://example.org/program'})));
 const doc=await PDFDocument.load(bytes);assert.ok(doc.getPageCount()>1);
 assert.ok(doc.getPages()[0].node.Annots()?.size());
});
