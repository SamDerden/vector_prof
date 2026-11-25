import { createRequire } from "node:module";

import { applyStandMigrations, CLEAN_DATABASE, STAND_DATABASE, STAND_HOST, STAND_PASSWORD, STAND_PORT, STAND_USER } from "./generation-stand-lib.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const pg = require("pg");

if (CLEAN_DATABASE === STAND_DATABASE || CLEAN_DATABASE.includes("navigator")) {
  throw new Error("Refusing to recreate the working stand database.");
}

const admin = new pg.Client({
  host: STAND_HOST,
  port: Number(STAND_PORT),
  user: STAND_USER,
  password: STAND_PASSWORD,
  database: "postgres",
});
await admin.connect();
try {
  const identity = await admin.query("SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port");
  const row = identity.rows[0];
  if (row.usr !== STAND_USER || Number(row.port) === 5433 || row.db === STAND_DATABASE) {
    throw new Error("Refusing to administer from the working stand database or port 5433.");
  }
  await admin.query(`
    SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
     WHERE datname = '${CLEAN_DATABASE}'
       AND pid <> pg_backend_pid()
  `);
  await admin.query(`DROP DATABASE IF EXISTS ${CLEAN_DATABASE}`);
  await admin.query(`CREATE DATABASE ${CLEAN_DATABASE} OWNER ${STAND_USER}`);
} finally {
  await admin.end();
}

const pool = new pg.Pool({
  host: STAND_HOST,
  port: Number(STAND_PORT),
  user: STAND_USER,
  password: STAND_PASSWORD,
  database: CLEAN_DATABASE,
  max: 2,
});
try {
  const identity = await pool.query("SELECT current_database() AS db, current_user AS usr");
  if (identity.rows[0].db !== CLEAN_DATABASE || identity.rows[0].usr !== STAND_USER) {
    throw new Error("Migration connection is not the clean database.");
  }
  const applied = await applyStandMigrations(pool);
  const tables = await pool.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('accounts', 'auth_sessions', 'auth_challenges', 'sessions')
     ORDER BY 1
  `);
  const column = await pool.query(`
    SELECT is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'account_id'
  `);
  console.log(JSON.stringify({
    database: identity.rows[0].db,
    user: identity.rows[0].usr,
    applied,
    tables: tables.rows.map((item) => item.table_name),
    accountIdNullable: column.rows[0]?.is_nullable ?? null,
  }));
} finally {
  await pool.end();
}

const preserved = new pg.Client({
  host: STAND_HOST,
  port: Number(STAND_PORT),
  user: STAND_USER,
  password: STAND_PASSWORD,
  database: STAND_DATABASE,
});
await preserved.connect();
try {
  const count = await preserved.query("SELECT count(*)::int AS n FROM sessions");
  console.log(JSON.stringify({ preservedDatabase: STAND_DATABASE, sessions: count.rows[0].n }));
} finally {
  await preserved.end();
}
