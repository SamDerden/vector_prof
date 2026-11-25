import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

import { NextRequest } from "next/server";

import { createAccountApi } from "../lib/auth/account-api.ts";
import { getPool } from "../lib/db.ts";
import { pgAccountStore } from "../lib/auth/account-store-pg.ts";
import { CLEAN_DATABASE, STAND_DATABASE, STAND_HOST, STAND_PASSWORD, STAND_PORT, STAND_USER } from "../scripts/generation-stand-lib.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const pg = require("pg");

const cleanUrl = `postgresql://${STAND_USER}:${STAND_PASSWORD}@${STAND_HOST}:${STAND_PORT}/${CLEAN_DATABASE}`;
process.env.DATABASE_URL = cleanUrl;
process.env.NODE_ENV = "test";
process.env.AUTH_REGISTRATION_ENABLED = "true";
process.env.AUTH_CHALLENGE_SECRET = "clean-stand-challenge-pepper";

const pool = new pg.Pool({ connectionString: cleanUrl, max: 4 });
const password = "correct-horse-battery";

function request(url: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function cookieHeader(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function assertClean() {
  const identity = await pool.query("SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port");
  const row = identity.rows[0];
  assert.equal(row.db, CLEAN_DATABASE);
  assert.equal(row.usr, STAND_USER);
  assert.notEqual(Number(row.port), 5433);
  assert.notEqual(row.db, STAND_DATABASE);
}

test("clean database has account tables and keeps the working stand untouched", async () => {
  await assertClean();
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('accounts', 'auth_sessions', 'auth_challenges')
     ORDER BY 1
  `);
  assert.deepEqual(tables.rows.map((item: { table_name: string }) => item.table_name), ["accounts", "auth_challenges", "auth_sessions"]);
  const column = await pool.query(`
    SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'sessions' AND column_name = 'account_id'
  `);
  assert.equal(column.rows[0].is_nullable, "YES");
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
    assert.equal(count.rows[0].n, 32);
    const accountTable = await preserved.query("SELECT to_regclass('public.accounts') AS rel");
    assert.equal(accountTable.rows[0].rel, null);
  } finally {
    await preserved.end();
  }
});

test("account registration, login and isolation persist in PostgreSQL", async () => {
  await assertClean();
  const codes: string[] = [];
  const api = createAccountApi({
    store: pgAccountStore,
    env: process.env,
    deliver: async (_email, _purpose, code) => {
      codes.push(code);
    },
  });
  const email = "cabinet-a@example.test";
  const other = "cabinet-b@example.test";
  await pool.query("DELETE FROM accounts WHERE email = ANY($1::text[])", [[email, other]]);

  const registered = await api.register(request("http://127.0.0.1/api/auth/register", {
    body: { email, password },
  }));
  assert.equal(registered.status, 202);
  assert.equal(JSON.stringify(await registered.clone().json()).includes(codes[0] ?? "missing"), false);
  const verified = await api.verify(request("http://127.0.0.1/api/auth/verify", {
    body: { email, code: codes[0] },
  }));
  assert.equal(verified.status, 200);

  const stored = await pool.query("SELECT password_hash, status FROM accounts WHERE email = $1", [email]);
  assert.equal(stored.rows[0].status, "active");
  assert.match(stored.rows[0].password_hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(String(stored.rows[0].password_hash).includes(password), false);

  const duplicate = await pool.query("INSERT INTO accounts (email) VALUES ($1)", [email]).then(
    () => "inserted",
    (error: { code?: string }) => error.code
  );
  assert.equal(duplicate, "23505");

  const login = await api.login(request("http://127.0.0.1/api/auth/login", { body: { email, password } }));
  assert.equal(login.status, 200);
  const header = cookieHeader(login);
  const restored = await api.me(request("http://127.0.0.1/api/auth/me", { cookie: header }));
  assert.equal((await restored.json() as { authenticated: boolean }).authenticated, true);
  const csrf = login.headers.getSetCookie().find((cookie) => cookie.startsWith("vector_csrf="))!.split(";")[0].split("=")[1];
  const loggedOut = await api.logout(request("http://127.0.0.1/api/auth/logout", {
    cookie: header,
    headers: { "x-csrf-token": csrf },
  }));
  assert.equal(loggedOut.status, 200);
  const after = await api.me(request("http://127.0.0.1/api/auth/me", { cookie: header }));
  assert.equal((await after.json() as { authenticated: boolean }).authenticated, false);

  const again = await api.login(request("http://127.0.0.1/api/auth/login", { body: { email, password } }));
  const live = cookieHeader(again);
  const liveCsrf = again.headers.getSetCookie().find((cookie) => cookie.startsWith("vector_csrf="))!.split(";")[0].split("=")[1];
  const ownId = "11111111-1111-4111-8111-111111111111";
  const foreignId = "22222222-2222-4222-8222-222222222222";
  await pool.query(
    "INSERT INTO sessions (id, track_type, session_mode) VALUES ($1, 'explore', 'own'), ($2, 'explore', 'own')",
    [ownId, foreignId]
  );
  await pool.query(
    "INSERT INTO profiles (session_id, school_grade, municipality) VALUES ($1, 2, 'Екатеринбург'), ($2, 7, 'Екатеринбург')",
    [ownId, foreignId]
  );
  const otherCodes: string[] = [];
  const otherApi = createAccountApi({
    store: pgAccountStore,
    env: process.env,
    deliver: async (_email, _purpose, code) => {
      otherCodes.push(code);
    },
    verifyOwnership: (_sessionId, proof) => proof === "owned-proof",
  });
  assert.equal((await otherApi.register(request("http://127.0.0.1/api/auth/register", { body: { email: other, password } }))).status, 202);
  assert.equal((await otherApi.verify(request("http://127.0.0.1/api/auth/verify", { body: { email: other, code: otherCodes[0] } }))).status, 200);
  const otherLogin = await otherApi.login(request("http://127.0.0.1/api/auth/login", { body: { email: other, password } }));
  const otherHeader = cookieHeader(otherLogin);
  const otherCsrf = otherLogin.headers.getSetCookie().find((cookie) => cookie.startsWith("vector_csrf="))!.split(";")[0].split("=")[1];
  const owner = createAccountApi({
    store: pgAccountStore,
    env: process.env,
    deliver: async () => undefined,
    verifyOwnership: (_sessionId, proof) => proof === "owned-proof",
  });
  const denied = await owner.linkSession(request("http://127.0.0.1/api/auth/link-session", {
    cookie: live,
    headers: { "x-csrf-token": liveCsrf, "x-session-id": ownId },
  }));
  assert.equal(denied.status, 403);
  const linked = await owner.linkSession(request("http://127.0.0.1/api/auth/link-session", {
    cookie: `${live}; vector_session_proof_${ownId.replace(/-/g, "")}=owned-proof`,
    headers: { "x-csrf-token": liveCsrf, "x-session-id": ownId },
  }));
  assert.equal(linked.status, 200);
  await pool.query("UPDATE sessions SET account_id = (SELECT id FROM accounts WHERE email = $1) WHERE id = $2", [other, foreignId]);
  const stolen = await owner.linkSession(request("http://127.0.0.1/api/auth/link-session", {
    cookie: `${live}; vector_session_proof_${foreignId.replace(/-/g, "")}=owned-proof`,
    headers: { "x-csrf-token": liveCsrf, "x-session-id": foreignId },
  }));
  assert.equal(stolen.status, 409);
  const overview = await owner.overview(request("http://127.0.0.1/api/account", { cookie: live }));
  const cabinet = await overview.json() as { sessions: Array<{ sessionId: string; schoolGrade: number }> };
  assert.deepEqual(cabinet.sessions.map((session) => session.sessionId), [ownId]);
  assert.equal(cabinet.sessions[0].schoolGrade, 2);
  const otherOverview = await otherApi.overview(request("http://127.0.0.1/api/account", { cookie: otherHeader, headers: { "x-csrf-token": otherCsrf } }));
  const otherCabinet = await otherOverview.json() as { sessions: Array<{ sessionId: string }> };
  assert.deepEqual(otherCabinet.sessions.map((session) => session.sessionId), [foreignId]);

  const accountId = (await pool.query("SELECT id FROM accounts WHERE email = $1", [email])).rows[0].id;
  await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
  const remaining = await pool.query("SELECT account_id::text AS account_id FROM sessions WHERE id = $1", [ownId]);
  assert.equal(remaining.rows[0].account_id, null);
  const authRows = await pool.query("SELECT count(*)::int AS n FROM auth_sessions WHERE account_id = $1", [accountId]);
  assert.equal(authRows.rows[0].n, 0);
  await pool.query("DELETE FROM accounts WHERE email = $1", [other]);
  await pool.query("DELETE FROM sessions WHERE id = ANY($1::uuid[])", [[ownId, foreignId]]);
});

test("profession API returns the freeze catalog while PostgreSQL is connected", async () => {
  await assertClean();
  const { GET } = await import("../app/api/professions/route.ts");
  const response = await GET();
  const body = await response.json() as { count: number; source: string; data: Array<{ profession_id: string; id: string | null }> };
  assert.equal(response.status, 200);
  assert.equal(body.source, "data_freeze_1");
  assert.equal(body.count, 152);
  const stored = await pool.query("SELECT id::text AS id, external_id FROM professions");
  assert.equal(stored.rows.length, 30);
  const uuids = new Map(stored.rows.map((row: { id: string; external_id: string }) => [row.external_id, row.id]));
  const linked = body.data.filter((row) => row.id !== null);
  assert.equal(linked.length, 27);
  for (const row of body.data) {
    assert.equal(row.id, uuids.get(row.profession_id) ?? null);
  }
  const publicIds = new Set(body.data.map((row) => row.profession_id));
  const outsideFreeze = stored.rows
    .map((row: { external_id: string }) => row.external_id)
    .filter((id: string) => !publicIds.has(id))
    .sort();
  assert.deepEqual(outsideFreeze, ["prof_016", "prof_028", "prof_029"]);
});

test.after(async () => {
  await pool.end();
  await getPool().end();
});
