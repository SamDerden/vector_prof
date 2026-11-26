import { NextRequest,NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/lib/db";
import { requireAccount } from "@/lib/auth/require-account";
import { handleError,jsonError } from "@/lib/http";
import { consumeLimit } from "@/lib/request-limits";
import { loadRuntimeCatalog } from "@/lib/runtime-catalog";
import { renderRoutePdf,type PdfLine } from "@/lib/route-pdf";
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
 try{
  const auth=await requireAccount(request);if('error' in auth)return auth.error;
  const id=z.string().uuid().safeParse(request.nextUrl.searchParams.get('route_id'));
  if(!id.success)return jsonError('invalid_route_id',400);
  await consumeLimit(query,`pdf:${auth.accountId}`,60,5);
  const result=await query(`SELECT r.*,p.school_grade,p.municipality,
   pr.title AS profession_title FROM education_routes r JOIN sessions s ON s.id=r.session_id
   LEFT JOIN profiles p ON p.session_id=s.id LEFT JOIN professions pr ON pr.id::text=r.profession_key
   WHERE r.id=$1 AND s.account_id=$2`,[id.data,auth.accountId]);
  if(!result.rowCount)return jsonError('route_not_found',404);
  const row=result.rows[0];const catalog=loadRuntimeCatalog().catalog;
  const lines:PdfLine[]=[{text:'Вектор — индивидуальный маршрут'},{text:`Версия маршрута: ${row.version}. Сохранён: ${new Date(row.updated_at).toISOString()}`},
   {text:`Класс: ${row.school_grade ?? 'не указан'}. Муниципалитет: ${row.municipality ?? 'не указан'}`},
   {text:`Профессия: ${row.profession_title ?? catalog.professions.find(p=>p.profession_id===row.profession_key)?.name ?? row.profession_key}`},
   {text:`Завершённые шаги: ${(row.completed as number[]).map(x=>x+1).join(', ') || 'нет'}`},
   {text:'Выбранные возможности'}];
  for(const saved of row.saved_ids as string[]){
   const key=saved.replace(/^program:/,'');
   const program=catalog.education_programs.find(p=>p.program_id===key);
   const trial=catalog.trials.find(p=>p.trial_id===key);
   let legacy: {title?:string;url?:string}={};
   if(/^[0-9a-f-]{36}$/i.test(key)) {
    const table=saved.startsWith('program:')?'education_programs':'professional_trials';
    const cols=table==='education_programs'?'title,url':'title';
    legacy=(await query(`SELECT ${cols} FROM ${table} WHERE id=$1`,[key])).rows[0] ?? {};
   }
   lines.push({text:program?.name ?? trial?.title ?? legacy.title ?? `Сохранённая возможность: ${saved}`});
   const url=trial?.source_url || program?.organization?.website || legacy.url;
   if(url && /^https?:\/\//i.test(url))lines.push({text:url,url});
  }
  if(!row.saved_ids.length)lines.push({text:'Возможности ещё не выбраны.'});
  lines.push({text:'Следующие действия: проверь условия участия на сайте организации и обсуди выбор со взрослым. Маршрут можно изменить.'});
  const bytes=await renderRoutePdf(lines);
  return new NextResponse(Buffer.from(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="vector-route.pdf"','Cache-Control':'private, no-store'}});
 }catch(error){return handleError(error);}
}
