import type { NextRequest } from 'next/server';
export class BodyError extends Error {
 readonly status:number;
 constructor(message:string,status:number){super(message);this.status=status;}
}
export async function readJsonBody(request:NextRequest,maxBytes=16000):Promise<unknown>{
 if(Number(request.headers.get('content-length'))>maxBytes)throw new BodyError('payload_too_large',413);
 const reader=request.body?.getReader();if(!reader)throw new BodyError('invalid_json',400);
 const chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
   if(size>maxBytes){await reader.cancel();throw new BodyError('payload_too_large',413);}chunks.push(next.value);
  }
 }finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 catch{throw new BodyError('invalid_json',400);}
}
