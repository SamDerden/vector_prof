import { Pool } from 'pg';
const days=Number(process.env.ASSISTANT_RETENTION_DAYS);
if(!Number.isInteger(days)||days<1||days>365)throw new Error('Set agreed ASSISTANT_RETENTION_DAYS (1..365)');
const db=new Pool({connectionString:process.env.DATABASE_URL});
try{
 const predicate="created_at < now()-($1*interval '1 day')";
 const count=await db.query('SELECT count(*)::int AS count FROM assistant_messages WHERE '+predicate,[days]);
 console.log(JSON.stringify({expiredMessages:count.rows[0].count,apply:process.argv.includes('--apply')}));
 if(process.argv.includes('--apply'))await db.query('DELETE FROM assistant_messages WHERE '+predicate,[days]);
}finally{await db.end();}
