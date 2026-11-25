import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

import { applyStandMigrations, CLEAN_DATABASE, STAND_DATABASE, STAND_HOST, STAND_PASSWORD, STAND_PORT, STAND_USER } from "../scripts/generation-stand-lib.mjs";
import { applyProfessionSync, planProfessionSync, summarizePlan } from "../lib/freeze-profession-sync.ts";
import { loadRuntimeCatalog, resetRuntimeCatalogCache } from "../lib/runtime-catalog.ts";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Client, Pool } = require("pg");

const adminUrl = `postgresql://${STAND_USER}:${STAND_PASSWORD}@${STAND_HOST}:${STAND_PORT}/postgres`;
const cleanUrl = `postgresql://${STAND_USER}:${STAND_PASSWORD}@${STAND_HOST}:${STAND_PORT}/${CLEAN_DATABASE}`;
const standUrl = `postgresql://${STAND_USER}:${STAND_PASSWORD}@${STAND_HOST}:${STAND_PORT}/${STAND_DATABASE}`;
const emptyName = "vector_prof_migration_empty_20261125";
const cloneName = "vector_prof_sync_clone_20261125";

function urlFor(database: string) {
  return `postgresql://${STAND_USER}:${STAND_PASSWORD}@${STAND_HOST}:${STAND_PORT}/${database}`;
}

async function dropDatabase(admin: { query: (sql: string) => Promise<unknown> }, name: string) {
  if (name === STAND_DATABASE || name === CLEAN_DATABASE || name === "postgres") throw new Error("Refusing to drop a protected database");
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
}

test("migrations apply to an empty database and freeze sync is idempotent on a clone", async () => {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const identity = await admin.query("SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port");
  assert.equal(identity.rows[0].usr, STAND_USER);
  assert.notEqual(Number(identity.rows[0].port), 5433);
  assert.equal(identity.rows[0].db, "postgres");
  try {
    await dropDatabase(admin, emptyName);
    await admin.query(`CREATE DATABASE ${emptyName} OWNER ${STAND_USER}`);
    const empty = new Pool({ connectionString: urlFor(emptyName), max: 1 });
    try {
      const applied = await applyStandMigrations(empty);
      assert.equal(applied.length, 12);
      const tables = await empty.query("SELECT to_regclass('public.accounts') AS accounts");
      assert.equal(tables.rows[0].accounts, "accounts");
    } finally {
      await empty.end();
    }

    const source = new Pool({ connectionString: cleanUrl, max: 1 });
    const before = await source.query("SELECT id::text AS id, external_id FROM professions ORDER BY external_id");
    const sessions = await source.query("SELECT count(*)::int AS n FROM sessions");
    await source.end();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${CLEAN_DATABASE}' AND pid <> pg_backend_pid()`);
    await dropDatabase(admin, cloneName);
    await admin.query(`CREATE DATABASE ${cloneName} WITH TEMPLATE ${CLEAN_DATABASE} OWNER ${STAND_USER}`);

    const clone = new Pool({ connectionString: urlFor(cloneName), max: 1 });
    try {
      const clonedIdentity = await clone.query("SELECT current_database() AS db, inet_server_port() AS port");
      assert.equal(clonedIdentity.rows[0].db, cloneName);
      assert.notEqual(Number(clonedIdentity.rows[0].port), 5433);
      resetRuntimeCatalogCache();
      const freeze = loadRuntimeCatalog().catalog.professions.map((profession) => ({
        professionId: profession.profession_id,
        name: profession.name,
        description: profession.what_kid_does || null,
      }));
      const readRows = async () => (await clone.query(
        `SELECT id::text AS id, external_id, title, description, graph_profession_id FROM professions`
      )).rows.map((row: { id: string; external_id: string | null; title: string; description: string | null; graph_profession_id: string | null }) => ({
        id: row.id,
        externalId: row.external_id,
        title: row.title,
        description: row.description,
        graphProfessionId: row.graph_profession_id,
      }));
      const plan = planProfessionSync(await readRows(), freeze);
      const summary = summarizePlan(plan);
      assert.equal(summary.conflict, 0);
      const client = await clone.connect();
      try {
        await client.query("BEGIN");
        const applied = await applyProfessionSync(client, plan);
        await client.query("COMMIT");
        assert.equal(applied.inserted.length, summary.insert);
        assert.ok(applied.inserted.every((id: string) => /^[0-9a-f-]{36}$/i.test(id)));
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const after = await readRows();
      const byExternal = new Map(after.map((row: { externalId: string | null; id: string }) => [row.externalId, row.id]));
      for (const row of before.rows) {
        assert.equal(byExternal.get(row.external_id), row.id);
      }
      assert.equal(freeze.filter((item) => byExternal.has(item.professionId)).length, 152);
      for (const legacyId of ["prof_016", "prof_028", "prof_029"]) assert.ok(byExternal.has(legacyId));
      const sessionCount = await clone.query("SELECT count(*)::int AS n FROM sessions");
      assert.equal(sessionCount.rows[0].n, sessions.rows[0].n);
      const second = summarizePlan(planProfessionSync(await readRows(), freeze));
      assert.equal(second.insert, 0);
      assert.equal(second.attach, 0);
      assert.equal(second.update, 0);
      assert.equal(second.conflict, 0);
    } finally {
      await clone.end();
    }
  } finally {
    await dropDatabase(admin, emptyName);
    await dropDatabase(admin, cloneName);
    const stand = new Client({ connectionString: standUrl });
    await stand.connect();
    const standSessions = await stand.query("SELECT count(*)::int AS n FROM sessions");
    const accounts = await stand.query("SELECT to_regclass('public.accounts') AS rel");
    assert.equal(standSessions.rows[0].n, 32);
    assert.equal(accounts.rows[0].rel, null);
    await stand.end();
    await admin.end();
  }
});
