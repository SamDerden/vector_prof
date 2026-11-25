import { loadRuntimeCatalog } from "../lib/runtime-catalog.ts";
import { applyProfessionSync, planProfessionSync, summarizePlan } from "../lib/freeze-profession-sync.ts";
import {
  CLEAN_DATABASE,
  STAND_DATABASE,
  STAND_HOST,
  STAND_PASSWORD,
  STAND_PORT,
  STAND_USER,
} from "./generation-stand-lib.mjs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Pool } = require("pg");

function databaseAllowed(name, confirmedDatabase) {
  if (name === STAND_DATABASE || name === "postgres" || name === "navigator") return false;
  if (name === CLEAN_DATABASE) return confirmedDatabase === CLEAN_DATABASE;
  return /^vector_prof_(sync|migration)_[a-z0-9_]+$/.test(name);
}

function targetDatabase(value) {
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (url.hostname !== STAND_HOST || url.port !== STAND_PORT || decodeURIComponent(url.username) !== STAND_USER) {
    throw new Error("Freeze sync must use the isolated stand on 127.0.0.1:55432.");
  }
  if (decodeURIComponent(url.password) !== STAND_PASSWORD) throw new Error("Freeze sync credentials do not match the isolated stand.");
  if (!databaseAllowed(database, process.env.CONFIRM_FREEZE_SYNC_DATABASE ?? "")) {
    throw new Error("Freeze sync refuses this database.");
  }
  return database;
}

const runtime = loadRuntimeCatalog();
if (runtime.origin !== "data_freeze_1") throw new Error("Freeze catalog is not the runtime catalog.");
const freeze = runtime.catalog.professions.map((profession) => ({
  professionId: profession.profession_id,
  name: profession.name,
  description: profession.what_kid_does || null,
}));
const apply = process.argv.includes("--apply");
if (apply && process.env.CONFIRM_FREEZE_SYNC !== "data_freeze_1") {
  throw new Error("Set CONFIRM_FREEZE_SYNC=data_freeze_1 before --apply.");
}
const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const database = targetDatabase(databaseUrl);

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const identity = await pool.query("SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port");
  const row = identity.rows[0];
  if (row.db !== database || row.usr !== STAND_USER || Number(row.port) === 5433) {
    throw new Error("Connected database does not match the freeze sync target.");
  }
  const existing = await pool.query(
    `SELECT id::text AS id, external_id, title, description, graph_profession_id
       FROM professions
      ORDER BY external_id NULLS LAST, title`
  );
  const plan = planProfessionSync(existing.rows.map((item) => ({
    id: item.id,
    externalId: item.external_id,
    title: item.title,
    description: item.description,
    graphProfessionId: item.graph_profession_id,
  })), freeze);
  const summary = summarizePlan(plan);
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, database, summary }, null, 2));
    process.exit(0);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(91826023)");
    const applied = await applyProfessionSync(client, plan);
    const check = await client.query(
      `SELECT count(*)::int AS n FROM professions WHERE external_id = ANY($1::text[])`,
      [freeze.map((item) => item.professionId)]
    );
    if (check.rows[0].n !== summary.insert + summary.update + summary.attach + summary.unchanged) {
      throw new Error("Freeze profession count does not match the sync plan.");
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ applied: true, database, summary, inserted: applied.inserted.length, updated: applied.updated, attached: applied.attached }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
