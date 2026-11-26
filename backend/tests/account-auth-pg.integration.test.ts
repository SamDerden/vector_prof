import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createRequire } from "node:module";

import { NextRequest } from "next/server";

import { applyStandMigrations, CLEAN_DATABASE, STAND_DATABASE, STAND_HOST, STAND_PASSWORD, STAND_PORT, STAND_USER } from "../scripts/generation-stand-lib.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const pg = require("pg");

const protectedNames = new Set([STAND_DATABASE, CLEAN_DATABASE, "postgres", "navigator", "template0", "template1"]);
const dbName = `vector_prof_migration_claim_${Date.now()}`;
const password = "correct-horse-battery";
const replacement = "replacement-horse-battery";

function probe() {
  return new Promise<boolean>((resolve) => {
    if (STAND_HOST !== "127.0.0.1" || STAND_PORT !== "55432") {
      resolve(false);
      return;
    }
    const socket = net.connect({ host: STAND_HOST, port: Number(STAND_PORT) });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

function post(path: string, body: unknown) {
  return new NextRequest(`http://127.0.0.1/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sessionCookies(response: Response) {
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith("vector_auth_session="));
}

const listening = await probe();

test("one auth code is claimed once on isolated PostgreSQL", { skip: listening ? false : "isolated PostgreSQL is not listening on 127.0.0.1:55432" }, async () => {
  if (!/^vector_prof_migration_claim_[0-9]+$/.test(dbName) || protectedNames.has(dbName)) {
    throw new Error("Refusing to create a database outside the temporary migration namespace.");
  }
  const connection = { host: STAND_HOST, port: Number(STAND_PORT), user: STAND_USER, password: STAND_PASSWORD };
  const admin = new pg.Client({ ...connection, database: "postgres" });
  await admin.connect();
  let tempPool: InstanceType<typeof pg.Pool> | null = null;
  let endAppPool: (() => Promise<void>) | null = null;
  try {
    const identity = await admin.query("SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port");
    assert.equal(identity.rows[0].db, "postgres");
    assert.equal(identity.rows[0].usr, STAND_USER);
    assert.notEqual(Number(identity.rows[0].port), 5433);
    await admin.query(`CREATE DATABASE ${dbName} OWNER ${STAND_USER}`);
    tempPool = new pg.Pool({ ...connection, database: dbName, max: 4 });
    const created = await tempPool.query("SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port");
    assert.equal(created.rows[0].db, dbName);
    assert.equal(created.rows[0].usr, STAND_USER);
    assert.notEqual(Number(created.rows[0].port), 5433);
    const applied = await applyStandMigrations(tempPool);
    assert.equal(applied.length, 13);

    process.env.DATABASE_URL = `postgresql://${STAND_USER}:${STAND_PASSWORD}@${STAND_HOST}:${STAND_PORT}/${dbName}`;
    process.env.NODE_ENV = "test";
    process.env.AUTH_REGISTRATION_ENABLED = "true";
    process.env.AUTH_CHALLENGE_SECRET = "isolated-auth-claim";
    process.env.PGSSL = "false";
    process.env.DATABASE_POOL_MAX = "24";
    process.env.DATABASE_CONNECT_TIMEOUT_MS = "20000";
    const { createAccountApi } = await import("../lib/auth/account-api.ts");
    const { pgAccountStore } = await import("../lib/auth/account-store-pg.ts");
    const { getPool } = await import("../lib/db.ts");
    endAppPool = () => getPool().end();
    const warmed = [];
    for (let index = 0; index < 20; index += 1) warmed.push(await getPool().connect());
    for (const client of warmed) client.release();

    let clock = Date.parse("2026-11-26T15:00:00.000Z");
    const sent: Array<{ email: string; purpose: string; code: string }> = [];
    const api = createAccountApi({
      store: pgAccountStore,
      env: process.env,
      now: () => new Date(clock),
      deliver: async (email, purpose, code) => {
        sent.push({ email, purpose, code });
      },
    });

    async function sessionsFor(email: string) {
      const result = await tempPool!.query(
        `SELECT count(*)::int AS n
           FROM auth_sessions s
           JOIN accounts a ON a.id = s.account_id
          WHERE a.email = $1`,
        [email]
      );
      return Number(result.rows[0].n);
    }

    async function activate(email: string) {
      assert.equal((await api.register(post("register", { email, password }))).status, 202);
      assert.equal((await api.verify(post("verify", { email, code: sent.at(-1)?.code }))).status, 200);
    }

    let loginSuccesses = 0;
    let loginSessions = 0;
    for (let round = 0; round < 5; round += 1) {
      const email = `login-${round}@example.test`;
      await activate(email);
      clock += 61_000;
      assert.equal((await api.requestLoginCode(post("login/code", { email }))).status, 202);
      const code = sent.at(-1)?.code ?? "";
      const before = await sessionsFor(email);
      const responses = await Promise.all(Array.from({ length: 20 }, () => api.confirmLoginCode(post("login/code/verify", { email, code }))));
      const wins = responses.filter((response) => response.status === 200);
      assert.equal(wins.length, 1);
      assert.equal(sessionCookies(wins[0]).some((cookie) => cookie.includes("HttpOnly")), true);
      assert.equal(JSON.stringify(await wins[0].clone().json()).includes(code), false);
      for (const response of responses) {
        if (response.status === 200) continue;
        assert.equal(response.status, 400);
        assert.equal((await response.json() as { error: string }).error, "invalid_code");
        assert.equal(sessionCookies(response).length, 0);
      }
      const createdSessions = await sessionsFor(email) - before;
      assert.equal(createdSessions, 1);
      loginSuccesses += wins.length;
      loginSessions += createdSessions;
    }

    let verifySuccesses = 0;
    for (let round = 0; round < 3; round += 1) {
      const email = `verify-${round}@example.test`;
      assert.equal((await api.register(post("register", { email, password }))).status, 202);
      const code = sent.at(-1)?.code ?? "";
      const responses = await Promise.all(Array.from({ length: 12 }, () => api.verify(post("verify", { email, code }))));
      const wins = responses.filter((response) => response.status === 200).length;
      assert.equal(wins, 1);
      for (const response of responses.filter((item) => item.status !== 200)) {
        assert.equal(response.status, 400);
        assert.equal((await response.json() as { error: string }).error, "invalid_code");
      }
      assert.equal(await sessionsFor(email), 0);
      const status = await tempPool.query("SELECT status FROM accounts WHERE email = $1", [email]);
      assert.equal(status.rows[0].status, "active");
      verifySuccesses += wins;
    }

    let resetSuccesses = 0;
    for (let round = 0; round < 3; round += 1) {
      const email = `reset-${round}@example.test`;
      await activate(email);
      assert.equal((await api.forgot(post("password/forgot", { email }))).status, 202);
      const code = sent.at(-1)?.code ?? "";
      const responses = await Promise.all(Array.from({ length: 12 }, () => api.reset(post("password/reset", { email, code, password: replacement }))));
      const wins = responses.filter((response) => response.status === 200).length;
      assert.equal(wins, 1);
      for (const response of responses.filter((item) => item.status !== 200)) assert.equal(response.status, 400);
      assert.equal((await api.login(post("login", { email, password }))).status, 401);
      assert.equal((await api.login(post("login", { email, password: replacement }))).status, 200);
      assert.equal((await api.reset(post("password/reset", { email, code, password: replacement }))).status, 400);
      resetSuccesses += wins;
    }

    const first = "pair-a@example.test";
    const second = "pair-b@example.test";
    await activate(first);
    await activate(second);
    clock += 61_000;
    assert.equal((await api.requestLoginCode(post("login/code", { email: first }))).status, 202);
    const firstCode = sent.at(-1)?.code ?? "";
    clock += 61_000;
    assert.equal((await api.requestLoginCode(post("login/code", { email: second }))).status, 202);
    const secondCode = sent.at(-1)?.code ?? "";
    const paired = await Promise.all([
      ...Array.from({ length: 10 }, () => api.confirmLoginCode(post("login/code/verify", { email: first, code: firstCode }))),
      ...Array.from({ length: 10 }, () => api.confirmLoginCode(post("login/code/verify", { email: second, code: secondCode }))),
    ]);
    assert.equal(paired.filter((response) => response.status === 200).length, 2);
    assert.equal(await sessionsFor(first), 1);
    assert.equal(await sessionsFor(second), 1);

    let racedWins = 0;
    let racedSessions = 0;
    for (let round = 0; round < 8; round += 1) {
      const email = `race-${round}@example.test`;
      await activate(email);
      clock += 61_000;
      assert.equal((await api.requestLoginCode(post("login/code", { email }))).status, 202);
      const oldCode = sent.at(-1)?.code ?? "";
      const mark = sent.length;
      clock += 61_000;
      const raced = await Promise.all([
        api.requestLoginCode(post("login/code", { email })),
        ...Array.from({ length: 12 }, () => api.confirmLoginCode(post("login/code/verify", { email, code: oldCode }))),
      ]);
      const wins = raced.slice(1).filter((response) => response.status === 200).length;
      assert.ok(wins <= 1);
      assert.equal(await sessionsFor(email), wins);
      assert.equal((await api.confirmLoginCode(post("login/code/verify", { email, code: oldCode }))).status, 400);
      const newest = sent.slice(mark).filter((item) => item.email === email && item.purpose === "login").at(-1)?.code ?? "";
      assert.equal((await api.confirmLoginCode(post("login/code/verify", { email, code: newest }))).status, 200);
      assert.equal(await sessionsFor(email), wins + 1);
      racedWins += wins;
      racedSessions += wins + 1;
    }

    const idle = await tempPool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'"
    );
    assert.equal(Number(idle.rows[0].n), 0);
    console.log(JSON.stringify({
      database: dbName,
      loginParallel: 20,
      loginRounds: 5,
      loginSuccesses,
      loginNewSessions: loginSessions,
      verifyParallel: 12,
      verifySuccesses,
      resetParallel: 12,
      resetSuccesses,
      independentUsers: 2,
      issueVersusConfirmRounds: 8,
      oldCodeSuccesses: racedWins,
      sessionsAfterFreshCode: racedSessions,
    }));
  } finally {
    if (endAppPool) await endAppPool();
    if (tempPool) await tempPool.end();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [dbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
});
