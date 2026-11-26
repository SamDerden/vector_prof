import { NextRequest } from "next/server";
import { assistantHistory } from "@/lib/assistant-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=(request:NextRequest)=>assistantHistory(request);
export const DELETE=(request:NextRequest)=>assistantHistory(request,true);
