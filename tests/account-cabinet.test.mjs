import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  PASSWORD_MAX,
  PASSWORD_MIN,
  SESSION_HEADER,
  AccountApiError,
  accountErrorMessage,
  fetchAccount,
  forgotPassword,
  humanizeAccountError,
  isEmail,
  linkSession,
  login,
  logout,
  normalizeEmail,
  register,
  resetPassword,
  validatePassword,
  verify,
} from "../lib/auth-api.ts";
import {
  formatDate,
  normalizeOverview,
  normalizeSession,
  shortSessionId,
  trackLabel,
} from "../lib/account-view.ts";
import { adoptOwnSessionId, readSessionId } from "../lib/session-store.ts";

const CONTRACT = readFileSync(new URL("../lib/auth-api.ts", import.meta.url), "utf8");
const ACCOUNT_PAGE = readFileSync(new URL("../app/account/page.tsx", import.meta.url), "utf8");
const CABINET = readFileSync(new URL("../app/account/AccountCabinet.tsx", import.meta.url), "utf8");
const FORMS = readFileSync(new URL("../app/account/AuthForms.tsx", import.meta.url), "utf8");
const HOME = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../app/account/account.css", import.meta.url), "utf8");

/* ------------------------------------------------------------------ */
/* cookie / CSRF plumbing                                              */
/* ------------------------------------------------------------------ */

function stubBrowser(cookies = {}) {
  const previous = { document: globalThis.document };
  globalThis.document = {
    get cookie() {
      return Object.entries(cookies)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join("; ");
    },
  };
  return () => {
    globalThis.document = previous.document;
  };
}

function recorder(response = { status: 200, body: {} }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: init.headers ?? {} });
    return new Response(typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json", ...(response.headers ?? {}) },
    });
  };
  return { calls, fetchImpl };
}

test("auth session cookie is never read from JavaScript", () => {
  assert.doesNotMatch(CONTRACT, /readCookie\(\s*["']vector_auth_session/);
  assert.doesNotMatch(CONTRACT, /localStorage[\s\S]{0,80}vector_auth_session/);
  assert.match(CONTRACT, /export const CSRF_COOKIE = "vector_csrf"/);
  // Password fields are masked by default and only revealed on explicit request.
  assert.match(FORMS, /type=\{showPassword \? "text" : "password"\}/);
  assert.equal((FORMS.match(/type=\{showPassword/g) ?? []).length, 2);
});

test("state-changing account requests send the CSRF double-submit header", async () => {
  const restore = stubBrowser({ [CSRF_COOKIE]: "token-123" });
  try {
    const { calls, fetchImpl } = recorder({ status: 200, body: { status: "ok" } });
    await logout({ fetchImpl });
    await linkSession({ sessionId: "6f9619ff-8b86-4111-a42d-00cf4fc964ff" }, { fetchImpl });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.headers[CSRF_HEADER], "token-123");
      assert.equal(call.init.credentials, "same-origin");
      assert.equal(call.init.method, "POST");
    }
    assert.equal(calls[1].headers[SESSION_HEADER], "6f9619ff-8b86-4111-a42d-00cf4fc964ff");
    assert.equal(calls[1].url, "/api/auth/link-session");
  } finally {
    restore();
  }
});

test("anonymous auth endpoints never require CSRF and never send a session id", async () => {
  const restore = stubBrowser({ [CSRF_COOKIE]: "token-123" });
  try {
    const { calls, fetchImpl } = recorder({ status: 202, body: { status: "accepted" } });
    await register({ email: " Student@Example.Test " }, { fetchImpl });
    await login({ email: "student@example.test", password: "example-long-password-123" }, { fetchImpl });
    await verify({ email: "student@example.test", code: "123456" }, { fetchImpl });
    await forgotPassword({ email: "student@example.test" }, { fetchImpl });
    await resetPassword({ email: "student@example.test", code: "123456", password: "example-long-password-456" }, { fetchImpl });
    for (const call of calls) {
      assert.equal(call.headers[CSRF_HEADER], undefined);
      assert.equal(call.headers[SESSION_HEADER], undefined);
      assert.doesNotMatch(call.url, /userId|user_id/);
    }
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: "student@example.test" });
  } finally {
    restore();
  }
});

test("register sends exactly one identifier: email, never both channels", async () => {
  const { calls, fetchImpl } = recorder({ status: 202, body: {} });
  await register({ email: "student@example.test" }, { fetchImpl });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ["email"]);
  const withPassword = recorder({ status: 202, body: {} });
  await register({ email: "student@example.test", password: "correct-horse-battery" }, { fetchImpl: withPassword.fetchImpl });
  assert.deepEqual(JSON.parse(withPassword.calls[0].init.body), {
    email: "student@example.test",
    password: "correct-horse-battery",
  });
  assert.match(FORMS, /register\(\{\s*email,\s*password\s*\}\)/);
  assert.equal(normalizeEmail("  Student@Example.TEST "), "student@example.test");
  assert.ok(isEmail("student@example.test"));
  assert.ok(!isEmail("student@"));
  assert.ok(!isEmail(""));
});

/* ------------------------------------------------------------------ */
/* field validation                                                    */
/* ------------------------------------------------------------------ */

test("password policy matches the documented 12–128 range", () => {
  assert.equal(PASSWORD_MIN, 12);
  assert.equal(PASSWORD_MAX, 128);
  assert.match(validatePassword("short"), /12/);
  assert.equal(validatePassword("x".repeat(PASSWORD_MIN)), null);
  assert.equal(validatePassword("x".repeat(PASSWORD_MAX)), null);
  assert.match(validatePassword("x".repeat(PASSWORD_MAX + 1)), /128/);
});

/* ------------------------------------------------------------------ */
/* error mapping (fail-closed backend states)                          */
/* ------------------------------------------------------------------ */

test("registration_not_configured 503 becomes a readable Russian state", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "registration_not_configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(
    () => register({ email: "student@example.test" }, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof AccountApiError);
      assert.equal(error.code, "registration_not_configured");
      assert.equal(error.status, 503);
      assert.match(accountErrorMessage(error), /Регистрация пока недоступна/);
      return true;
    }
  );
});

test("raw english codes are not surfaced to the user", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "csrf_token_invalid" }), { status: 403, headers: { "Content-Type": "application/json" } });
  await assert.rejects(
    () => logout({ fetchImpl }),
    (error) => {
      assert.equal(error.code, "csrf");
      assert.doesNotMatch(accountErrorMessage(error), /csrf/i);
      assert.match(accountErrorMessage(error), /Обнови/);
      return true;
    }
  );
  const humanized = humanizeAccountError(new TypeError("Failed to fetch"));
  assert.equal(humanized.code, "network");
  assert.match(humanized.message, /Нет связи/);
});

test("rate limiting keeps the retry hint from details or header", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "rate_limited", details: { retryAfterMs: 42_000 } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(
    () => login({ email: "student@example.test", password: "example-long-password-123" }, { fetchImpl }),
    (error) => {
      assert.equal(error.code, "rate_limited");
      assert.equal(error.retryAfterMs, 42_000);
      return true;
    }
  );
});

/* ------------------------------------------------------------------ */
/* account overview normalization                                      */
/* ------------------------------------------------------------------ */

test("account overview tolerates missing and renamed fields", async () => {
  assert.deepEqual(normalizeOverview(null), {
    user: null,
    sessions: [],
    grade: null,
    municipality: null,
    progress: null,
    limits: null,
  });

  assert.equal(normalizeSession({}), null);
  assert.equal(normalizeSession("nope"), null);

  const raw = {
    user: { email: "student@example.test", status: "active" },
    sessions: [
      {
        session_id: "6f9619ff-8b86-4111-a42d-00cf4fc964ff",
        track_type: "interests",
        school_grade: 8,
        account_linked_at: "2026-11-17T10:00:00.000Z",
        updated_at: "2026-11-17T12:00:00.000Z",
        progress: { hasDiagnostic: true, hasRecommendation: true },
      },
      { id: "11111111-1111-4111-8111-111111111111", created_at: "2026-11-18T09:00:00.000Z", grade: "9" },
      { noId: true },
    ],
    profile: { schoolGrade: 8, municipality: "Екатеринбург" },
    limits: { maxSessions: 50 },
  };
  const overview = normalizeOverview(raw);
  assert.equal(overview.sessions.length, 2);
  assert.equal(overview.sessions[0].id, "11111111-1111-4111-8111-111111111111");
  assert.equal(overview.sessions[0].grade, 9);
  assert.equal(overview.sessions[1].grade, 8);
  assert.equal(overview.sessions[1].linked, true);
  assert.equal(overview.sessions[1].progress, 2);
  assert.equal(overview.grade, 8);
  assert.equal(overview.municipality, "Екатеринбург");
  assert.equal(overview.limits?.maxSessions, 50);
  assert.equal(trackLabel("interests"), "У меня есть интересы");
  assert.equal(trackLabel("custom-track"), "custom-track");
  assert.equal(shortSessionId("6f9619ff-8b86-4111-a42d-00cf4fc964ff"), "6f9619ff…64ff");
  assert.equal(formatDate("not-a-date"), "—");
  assert.match(formatDate("2026-11-17T10:00:00.000Z"), /2026/);
});

test("overview is read without a session header and without user-supplied ownership", async () => {
  const { calls, fetchImpl } = recorder({ status: 200, body: { authenticated: true, sessions: [] } });
  const result = await fetchAccount({ fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/account");
  assert.equal(calls[0].headers[SESSION_HEADER], undefined);
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(result, { authenticated: true, sessions: [] });
});

/* ------------------------------------------------------------------ */
/* session adoption (locator only)                                     */
/* ------------------------------------------------------------------ */

function stubStorage() {
  const local = new Map();
  const session = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (local.has(key) ? local.get(key) : null),
      setItem: (key, value) => local.set(key, String(value)),
    },
    sessionStorage: {
      getItem: (key) => (session.has(key) ? session.get(key) : null),
      setItem: (key, value) => session.set(key, String(value)),
    },
  };
  return { local, session, restore: () => {
    delete globalThis.window;
  } };
}

test("choosing an owned session only re-points the locator", () => {
  const storage = stubStorage();
  try {
    const id = "6f9619ff-8b86-4111-a42d-00cf4fc964ff";
    adoptOwnSessionId(id, { grade: 8 });
    assert.equal(readSessionId({ mode: "own" }, globalThis.window.localStorage), id);
    const context = JSON.parse(globalThis.window.sessionStorage.getItem("vector-active-context"));
    assert.equal(context.mode, "own");
    assert.equal(context.grade, 8);
    assert.throws(() => adoptOwnSessionId("not-a-uuid"), /UUID/);
  } finally {
    storage.restore();
  }
});

/* ------------------------------------------------------------------ */
/* routes and entry points                                             */
/* ------------------------------------------------------------------ */

test("cabinet lives at /account and is reachable from the main navigation", () => {
  assert.match(ACCOUNT_PAGE, /AccountExperience/);
  assert.match(ACCOUNT_PAGE, /robots/);
  assert.match(HOME, /href="\/account"/);
  assert.match(CONTRACT, /"\/api\/auth\/register"/);
  assert.match(CONTRACT, /"\/api\/auth\/verify"/);
  assert.match(CONTRACT, /"\/api\/auth\/verification\/resend"/);
  assert.match(CONTRACT, /"\/api\/auth\/login"/);
  assert.match(CONTRACT, /"\/api\/auth\/logout"/);
  assert.match(CONTRACT, /"\/api\/auth\/me"/);
  assert.match(CONTRACT, /"\/api\/auth\/password\/forgot"/);
  assert.match(CONTRACT, /"\/api\/auth\/password\/reset"/);
  assert.match(CONTRACT, /"\/api\/auth\/link-session"/);
  assert.match(CONTRACT, /"\/api\/account"/);
});

test("cabinet explains fail-closed deletion and never auto-links demo profiles", () => {
  assert.match(CABINET, /политики хранения/);
  assert.match(CABINET, /Демо-профили нельзя привязать/);
  assert.match(CABINET, /Привязать сессию по идентификатору/);
  assert.doesNotMatch(CABINET, /demoStudentId/);
  assert.match(CSS, /@media \(max-width: 640px\)/);
});
