// Private operator command. Never expose this export over a public endpoint.
import { Pool } from 'pg';
import fs from 'node:fs/promises';
const out=process.argv[2];if(!out)throw new Error('Usage: node scripts/export-feedback.mjs /private/path/feedback.json');
const db=new Pool({connectionString:process.env.DATABASE_URL});
try{
 const result=await db.query('SELECT id,clarity,recommendations,navigation,usefulness,comment,created_at FROM feedback ORDER BY created_at');
 await fs.writeFile(out,JSON.stringify(result.rows,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({count:result.rowCount,file:out}));
}finally{await db.end();}
