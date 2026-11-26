// Bounded read-only smoke. This does NOT measure the AI queue or provider capacity.
import fs from 'node:fs/promises';
const base=new URL(process.argv[2]??'http://127.0.0.1:3000');
if(!['https:','http:'].includes(base.protocol)||base.username||base.password)throw new Error('Expected http(s) origin without credentials');
const concurrency=Number(process.env.PROBE_CONCURRENCY??10), each=Number(process.env.PROBE_REQUESTS_PER_CLIENT??5);
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>200||!Number.isInteger(each)||each<1||each>100)throw new Error('Bounds: 1..200 clients, 1..100 requests per client');
const rows=[],start=performance.now();
await Promise.all(Array.from({length:concurrency},async()=>{
 for(let i=0;i<each;i++){
  const path=i%2?'/api/professions':'/api/health',t=performance.now();
  try{const response=await fetch(new URL(path,base),{signal:AbortSignal.timeout(15000),redirect:'error'});await response.arrayBuffer();rows.push({path,status:response.status,ms:performance.now()-t});}
  catch{rows.push({path,status:0,ms:performance.now()-t});}
 }
}));
const times=rows.map(r=>r.ms).sort((a,b)=>a-b),seconds=(performance.now()-start)/1000;
const percentile=q=>Math.round(times[Math.ceil(times.length*q)-1]);
const result={timestamp:new Date().toISOString(),base:base.origin,kind:'read-only-smoke-not-AI-capacity',concurrency,requests:rows.length,seconds,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),requestsPerSecond:rows.length/seconds,statuses:rows.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{}),errors:rows.filter(r=>r.status<200||r.status>=400).length};
console.log(JSON.stringify(result,null,2));
if(process.argv[3])await fs.writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
if(result.errors)process.exitCode=1;
