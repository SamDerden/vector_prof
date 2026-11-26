import { NextRequest,NextResponse } from "next/server";
import { readJsonBody } from "@/lib/read-json-body";
import { query } from "@/lib/db";
import { requireExistingSession } from "@/lib/session";
import { consumeLimit } from "@/lib/request-limits";
import { feedbackInput } from "@/lib/feedback-schema";
import { handleError,jsonError } from "@/lib/http";
export const runtime="nodejs";
export async function POST(request:NextRequest){
 try{
  const session=await requireExistingSession(request);if('error' in session)return session.error;
  await consumeLimit(query,`feedback:${session.sessionId}`,3600,10);
  const b=feedbackInput.parse(await readJsonBody(request,12000));
  if(b.route_id){const route=await query('SELECT id FROM education_routes WHERE id=$1 AND session_id=$2',[b.route_id,session.sessionId]);if(!route.rowCount)return jsonError('route_not_found',404);}
  const result=await query(`INSERT INTO feedback(session_id,request_id,route_id,clarity,recommendations,navigation,usefulness,comment)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_id,request_id) DO NOTHING RETURNING id`,
   [session.sessionId,b.request_id,b.route_id,b.clarity,b.recommendations,b.navigation,b.usefulness,b.comment]);
  return NextResponse.json({status:'saved',replayed:!result.rowCount},{status:result.rowCount?201:200});
 }catch(error){if(error instanceof SyntaxError)return jsonError('invalid_json',400);return handleError(error);}
}
