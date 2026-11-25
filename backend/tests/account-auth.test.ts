import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { createAccountApi, createMemoryAccountStore, hashPassword, verifyPassword, type OwnedNavigatorSession } from "../lib/auth/account-api.ts";

const PASSWORD = "correct-horse-battery";
const env = { NODE_ENV: "test", AUTH_REGISTRATION_ENABLED: "true", AUTH_CHALLENGE_SECRET: "test-challenge-pepper" } as NodeJS.ProcessEnv;

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
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function navigatorSession(id: string, mode: string, accountId: string | null = null): OwnedNavigatorSession {
  return {
    id,
    mode,
    accountId,
    schoolGrade: 9,
    municipality: "Екатеринбург",
    trackType: "explore",
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
    expiresAt: null,
    hasDiagnostic: true,
    hasRecommendation: true,
    hasRoute: false,
  };
}

async function registered(store: ReturnType<typeof createMemoryAccountStore>, clock: { now: Date }, codes: string[]) {
  const api = createAccountApi({
    store,
    env,
    now: () => clock.now,
    deliver: async (_email, _purpose, code) => {
      codes.push(code);
    },
  });
  const pending = await api.register(request("http://localhost/api/auth/register", {
    body: { email: "student@example.test", password: PASSWORD },
  }));
  assert.equal(pending.status, 202);
  const body = await pending.json() as { status: string; code?: string };
  assert.equal(body.status, "accepted");
  assert.equal(body.code, undefined);
  assert.equal(JSON.stringify(body).includes(codes[0]), false);
  const verified = await api.verify(request("http://localhost/api/auth/verify", {
    body: { email: "student@example.test", code: codes[0] },
  }));
  assert.equal(verified.status, 200);
  return api;
}

test("password is stored only as an adaptive scrypt hash", async () => {
  const first = await hashPassword(PASSWORD);
  const second = await hashPassword(PASSWORD);
  assert.match(first, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(PASSWORD, first), true);
  assert.equal(await verifyPassword("wrong-password-value", first), false);
  assert.equal(first.includes(PASSWORD), false);
});

test("register, verify, login, restore after reload, logout and expiry", async () => {
  const store = createMemoryAccountStore();
  const clock = { now: new Date("2026-11-25T10:00:00.000Z") };
  const codes: string[] = [];
  const api = await registered(store, clock, codes);

  const anonymous = await api.me(request("http://localhost/api/auth/me"));
  assert.deepEqual(await anonymous.json(), { authenticated: false, user: null });

  const login = await api.login(request("http://localhost/api/auth/login", {
    body: { email: "Student@Example.TEST", password: PASSWORD },
  }));
  assert.equal(login.status, 200);
  const setCookies = login.headers.getSetCookie();
  const sessionCookie = setCookies.find((cookie) => cookie.startsWith("vector_auth_session="));
  const csrfCookie = setCookies.find((cookie) => cookie.startsWith("vector_csrf="));
  assert.ok(sessionCookie?.includes("HttpOnly"));
  assert.ok(csrfCookie && !csrfCookie.includes("HttpOnly"));
  const header = cookieHeader(login);

  const restored = await api.me(request("http://localhost/api/auth/me", { cookie: header }));
  const me = await restored.json() as { authenticated: boolean; user: { email: string } };
  assert.equal(me.authenticated, true);
  assert.equal(me.user.email, "student@example.test");

  const logout = await api.logout(request("http://localhost/api/auth/logout", {
    cookie: header,
    headers: { "x-csrf-token": csrfCookie!.split(";")[0].split("=")[1] },
  }));
  assert.equal(logout.status, 200);
  const afterLogout = await api.me(request("http://localhost/api/auth/me", { cookie: header }));
  assert.equal((await afterLogout.json() as { authenticated: boolean }).authenticated, false);

  const again = await api.login(request("http://localhost/api/auth/login", {
    body: { email: "student@example.test", password: PASSWORD },
  }));
  const live = cookieHeader(again);
  clock.now = new Date("2026-12-03T10:00:00.000Z");
  const expired = await api.me(request("http://localhost/api/auth/me", { cookie: live }));
  assert.deepEqual(await expired.json(), { authenticated: false, user: null });
});

test("one account cannot read or link another account's session", async () => {
  const store = createMemoryAccountStore();
  const clock = { now: new Date("2026-11-25T10:00:00.000Z") };
  const ownId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  store.seedNavigatorSession(navigatorSession(ownId, "own"));
  store.seedNavigatorSession(navigatorSession(otherId, "own", "99999999-9999-4999-8999-999999999999"));
  store.seedNavigatorSession(navigatorSession("33333333-3333-4333-8333-333333333333", "demo"));
  const codes: string[] = [];
  const api = await registered(store, clock, codes);
  const login = await api.login(request("http://localhost/api/auth/login", {
    body: { email: "student@example.test", password: PASSWORD },
  }));
  const header = cookieHeader(login);
  const csrf = login.headers.getSetCookie().find((cookie) => cookie.startsWith("vector_csrf="))!.split(";")[0].split("=")[1];

  const denied = await api.linkSession(request("http://localhost/api/auth/link-session", {
    cookie: header,
    headers: { "x-csrf-token": csrf, "x-session-id": ownId },
  }));
  assert.equal(denied.status, 403);

  const proving = createAccountApi({
    store,
    env,
    now: () => clock.now,
    deliver: async () => undefined,
    verifyOwnership: (_sessionId, proof) => proof === "owned-proof",
  });
  const ok = await proving.linkSession(request("http://localhost/api/auth/link-session", {
    cookie: `${header}; vector_session_proof_${ownId.replace(/-/g, "")}=owned-proof`,
    headers: { "x-csrf-token": csrf, "x-session-id": ownId },
  }));
  assert.equal(ok.status, 200);
  const foreign = await proving.linkSession(request("http://localhost/api/auth/link-session", {
    cookie: `${header}; vector_session_proof_${otherId.replace(/-/g, "")}=owned-proof`,
    headers: { "x-csrf-token": csrf, "x-session-id": otherId },
  }));
  assert.equal(foreign.status, 409);
  const demo = await proving.linkSession(request("http://localhost/api/auth/link-session", {
    cookie: `${header}; vector_session_proof_33333333333343338333333333333333=owned-proof`,
    headers: { "x-csrf-token": csrf, "x-session-id": "33333333-3333-4333-8333-333333333333" },
  }));
  assert.equal(demo.status, 409);

  const overview = await proving.overview(request("http://localhost/api/account", { cookie: header }));
  const cabinet = await overview.json() as { sessions: Array<{ sessionId: string }> };
  assert.deepEqual(cabinet.sessions.map((session) => session.sessionId), [ownId]);
});

test("login attempts are limited and missing registration settings fail closed", async () => {
  const store = createMemoryAccountStore();
  const clock = { now: new Date("2026-11-25T10:00:00.000Z") };
  const api = await registered(store, clock, []);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await api.login(request("http://localhost/api/auth/login", {
      body: { email: "student@example.test", password: "not-the-right-secret" },
    }));
    assert.equal(failed.status, 401);
  }
  const limited = await api.login(request("http://localhost/api/auth/login", {
    body: { email: "student@example.test", password: PASSWORD },
  }));
  assert.equal(limited.status, 429);

  const closed = createAccountApi({
    store,
    env: { ...env, AUTH_REGISTRATION_ENABLED: "false" },
    now: () => clock.now,
  });
  const blocked = await closed.register(request("http://localhost/api/auth/register", {
    body: { email: "other@example.test", password: PASSWORD },
  }));
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json() as { error: string }).error, "registration_not_configured");

  const deletion = await api.remove(request("http://localhost/api/account", {
    method: "DELETE",
    body: { password: PASSWORD },
  }));
  assert.equal(deletion.status, 503);
  assert.equal((await deletion.json() as { error: string }).error, "deletion_disabled");
});
