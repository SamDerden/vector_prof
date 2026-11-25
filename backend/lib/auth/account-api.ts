import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { productionDeliveryReady } from "./email-delivery.ts";

const SCRYPT_N = 16384;

function scryptKey(password: string, salt: Buffer, keylen: number, params: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keylen, params, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
const AUTH_COOKIE = "vector_auth_session";
const CSRF_COOKIE = "vector_csrf";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

export type AccountRecord = {
  id: string;
  email: string;
  passwordHash: string | null;
  status: "pending" | "active" | "disabled";
  verifiedAt: string | null;
  createdAt: string;
};

export type AuthChallenge = {
  id: string;
  accountId: string | null;
  email: string;
  purpose: "verify" | "reset";
  codeHash: string;
  expiresAt: string;
  attempts: number;
  consumedAt: string | null;
};

export type AuthSessionRecord = {
  id: string;
  accountId: string;
  tokenHash: string;
  csrfToken: string;
  expiresAt: string;
};

export type OwnedNavigatorSession = {
  id: string;
  mode: string | null;
  accountId: string | null;
  schoolGrade: number | null;
  municipality: string | null;
  trackType: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  hasDiagnostic: boolean;
  hasRecommendation: boolean;
  hasRoute: boolean;
};

export interface AccountStore {
  findAccountByEmail(email: string): Promise<AccountRecord | null>;
  findAccountById(id: string): Promise<AccountRecord | null>;
  insertAccount(account: AccountRecord): Promise<void>;
  saveAccount(account: AccountRecord): Promise<void>;
  insertChallenge(challenge: AuthChallenge): Promise<void>;
  latestChallenge(email: string, purpose: "verify" | "reset"): Promise<AuthChallenge | null>;
  saveChallenge(challenge: AuthChallenge): Promise<void>;
  insertAuthSession(session: AuthSessionRecord): Promise<void>;
  findAuthSession(tokenHash: string): Promise<AuthSessionRecord | null>;
  deleteAuthSession(id: string): Promise<void>;
  deleteAuthSessionsForAccount(accountId: string): Promise<void>;
  findNavigatorSession(id: string): Promise<OwnedNavigatorSession | null>;
  linkNavigatorSession(id: string, accountId: string): Promise<void>;
  listNavigatorSessions(accountId: string): Promise<OwnedNavigatorSession[]>;
  deleteAccount(id: string): Promise<void>;
}

export function createMemoryAccountStore(): AccountStore & {
  seedNavigatorSession(session: OwnedNavigatorSession): void;
} {
  const accounts = new Map<string, AccountRecord>();
  const challenges: AuthChallenge[] = [];
  const sessions: AuthSessionRecord[] = [];
  const navigator = new Map<string, OwnedNavigatorSession>();
  return {
    async findAccountByEmail(email) {
      return [...accounts.values()].find((account) => account.email === email) ?? null;
    },
    async findAccountById(id) {
      return accounts.get(id) ?? null;
    },
    async insertAccount(account) {
      accounts.set(account.id, { ...account });
    },
    async saveAccount(account) {
      accounts.set(account.id, { ...account });
    },
    async insertChallenge(challenge) {
      challenges.push({ ...challenge });
    },
    async latestChallenge(email, purpose) {
      return [...challenges].reverse().find((challenge) => challenge.email === email && challenge.purpose === purpose && !challenge.consumedAt) ?? null;
    },
    async saveChallenge(challenge) {
      const index = challenges.findIndex((item) => item.id === challenge.id);
      if (index >= 0) challenges[index] = { ...challenge };
    },
    async insertAuthSession(session) {
      sessions.push({ ...session });
    },
    async findAuthSession(tokenHash) {
      return sessions.find((session) => session.tokenHash === tokenHash) ?? null;
    },
    async deleteAuthSession(id) {
      const index = sessions.findIndex((session) => session.id === id);
      if (index >= 0) sessions.splice(index, 1);
    },
    async deleteAuthSessionsForAccount(accountId) {
      for (let index = sessions.length - 1; index >= 0; index -= 1) {
        if (sessions[index].accountId === accountId) sessions.splice(index, 1);
      }
    },
    async findNavigatorSession(id) {
      return navigator.get(id) ?? null;
    },
    async linkNavigatorSession(id, accountId) {
      const session = navigator.get(id);
      if (session) session.accountId = accountId;
    },
    async listNavigatorSessions(accountId) {
      return [...navigator.values()].filter((session) => session.accountId === accountId).slice(0, 50);
    },
    async deleteAccount(id) {
      accounts.delete(id);
      for (let index = sessions.length - 1; index >= 0; index -= 1) {
        if (sessions[index].accountId === id) sessions.splice(index, 1);
      }
      for (const session of navigator.values()) {
        if (session.accountId === id) session.accountId = null;
      }
    },
    seedNavigatorSession(session) {
      navigator.set(session.id, { ...session });
    },
  };
}

type Deps = {
  store: AccountStore;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  deliver?: (email: string, purpose: "verify" | "reset", code: string) => Promise<void>;
  verifyOwnership?: (sessionId: string, proof: string | undefined) => boolean;
};

export function registrationOpen(env: NodeJS.ProcessEnv) {
  if (env.AUTH_REGISTRATION_ENABLED === "false") return false;
  if (env.AUTH_REGISTRATION_ENABLED === "true") return true;
  return env.NODE_ENV !== "production";
}

function pepper(env: NodeJS.ProcessEnv) {
  return env.AUTH_CHALLENGE_SECRET || env.SESSION_PROOF_SECRET || (env.NODE_ENV === "production" ? "" : "dev-challenge-pepper-not-for-production");
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  const key = await scryptKey(password, salt, expected.length, { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

function hashCode(code: string, env: NodeJS.ProcessEnv) {
  return createHash("sha256").update(`${pepper(env)}:${code}`).digest("base64url");
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function validPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 12 && password.length <= 128;
}

function userView(account: AccountRecord) {
  return {
    id: account.id,
    email: account.email,
    phone: null,
    status: account.status,
    verifiedAt: account.verifiedAt,
    createdAt: account.createdAt,
  };
}

function cookieOptions(env: NodeJS.ProcessEnv, httpOnly: boolean) {
  return { httpOnly, sameSite: "strict" as const, secure: env.NODE_ENV === "production", path: "/", maxAge: SESSION_MS / 1000 };
}

function setAuthCookies(response: NextResponse, token: string, csrf: string, env: NodeJS.ProcessEnv) {
  response.cookies.set(AUTH_COOKIE, token, cookieOptions(env, true));
  response.cookies.set(CSRF_COOKIE, csrf, cookieOptions(env, false));
}

function clearAuthCookies(response: NextResponse, env: NodeJS.ProcessEnv) {
  response.cookies.set(AUTH_COOKIE, "", { ...cookieOptions(env, true), maxAge: 0 });
  response.cookies.set(CSRF_COOKIE, "", { ...cookieOptions(env, false), maxAge: 0 });
}

async function readBody(request: NextRequest) {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function createAccountApi(deps: Deps) {
  const env: NodeJS.ProcessEnv = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const deliver = deps.deliver ?? (async () => undefined);
  const hits = new Map<string, number[]>();

  function allow(key: string, seconds: number, max: number) {
    const current = now().getTime();
    const window = (hits.get(key) ?? []).filter((time) => current - time < seconds * 1000);
    if (window.length >= max) return false;
    window.push(current);
    hits.set(key, window);
    return true;
  }

  async function issueCode(account: AccountRecord | null, email: string, purpose: "verify" | "reset") {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await deps.store.insertChallenge({
      id: crypto.randomUUID(),
      accountId: account?.id ?? null,
      email,
      purpose,
      codeHash: hashCode(code, env),
      expiresAt: new Date(now().getTime() + CODE_MS).toISOString(),
      attempts: 0,
      consumedAt: null,
    });
    try {
      await deliver(email, purpose, code);
    } catch (error) {
      console.error("[account] delivery failed", error instanceof Error ? error.name : "unknown");
    }
  }

  async function openSession(account: AccountRecord) {
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    await deps.store.insertAuthSession({
      id: crypto.randomUUID(),
      accountId: account.id,
      tokenHash: hashToken(token),
      csrfToken: csrf,
      expiresAt: new Date(now().getTime() + SESSION_MS).toISOString(),
    });
    const response = NextResponse.json({ user: userView(account) });
    setAuthCookies(response, token, csrf, env);
    return response;
  }

  async function signedIn(request: NextRequest) {
    const token = request.cookies.get(AUTH_COOKIE)?.value;
    if (!token) return null;
    const session = await deps.store.findAuthSession(hashToken(token));
    if (!session || Date.parse(session.expiresAt) <= now().getTime()) return { expired: true as const, session: session ?? null };
    const account = await deps.store.findAccountById(session.accountId);
    if (!account || account.status === "disabled") return { expired: true as const, session };
    return { expired: false as const, account, session };
  }

  function csrfOk(request: NextRequest, session: AuthSessionRecord) {
    const header = request.headers.get("x-csrf-token") ?? "";
    const cookie = request.cookies.get(CSRF_COOKIE)?.value ?? "";
    const headerBuf = Buffer.from(header);
    const cookieBuf = Buffer.from(cookie);
    const storedBuf = Buffer.from(session.csrfToken);
    return header.length > 0
      && headerBuf.length === cookieBuf.length
      && cookieBuf.length === storedBuf.length
      && timingSafeEqual(headerBuf, cookieBuf)
      && timingSafeEqual(cookieBuf, storedBuf);
  }

  return {
    async register(request: NextRequest) {
      if (!registrationOpen(env) || !pepper(env) || (env.NODE_ENV === "production" && !productionDeliveryReady(env))) {
        return NextResponse.json({ error: "registration_not_configured" }, { status: 503 });
      }
      const body = await readBody(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!validEmail(email) || !validPassword(body.password)) {
        return NextResponse.json({ error: "validation" }, { status: 400 });
      }
      if (!allow(`register:${email}`, 3600, 5)) {
        return NextResponse.json({ error: "rate_limited", details: { retryAfterMs: 3_600_000 } }, { status: 429 });
      }
      let account = await deps.store.findAccountByEmail(email);
      if (!account) {
        account = {
          id: crypto.randomUUID(),
          email,
          passwordHash: await hashPassword(body.password),
          status: "pending",
          verifiedAt: null,
          createdAt: now().toISOString(),
        };
        await deps.store.insertAccount(account);
        await issueCode(account, email, "verify");
      } else if (account.status === "pending") {
        account.passwordHash = await hashPassword(body.password);
        await deps.store.saveAccount(account);
        await issueCode(account, email, "verify");
      }
      return NextResponse.json({ status: "accepted" }, { status: 202 });
    },

    async verify(request: NextRequest) {
      const body = await readBody(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const challenge = await deps.store.latestChallenge(email, "verify");
      if (!challenge || challenge.consumedAt) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
      if (Date.parse(challenge.expiresAt) <= now().getTime()) return NextResponse.json({ error: "code_expired" }, { status: 400 });
      if (challenge.attempts >= MAX_CODE_ATTEMPTS) return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
      const received = Buffer.from(hashCode(code, env));
      const expected = Buffer.from(challenge.codeHash);
      const matches = received.length === expected.length && timingSafeEqual(received, expected);
      challenge.attempts += 1;
      if (!matches) {
        await deps.store.saveChallenge(challenge);
        return NextResponse.json({ error: "invalid_code" }, { status: 400 });
      }
      challenge.consumedAt = now().toISOString();
      await deps.store.saveChallenge(challenge);
      const account = await deps.store.findAccountByEmail(email);
      if (!account) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
      account.status = "active";
      account.verifiedAt = now().toISOString();
      await deps.store.saveAccount(account);
      return NextResponse.json({ status: "verified" });
    },

    async resend(request: NextRequest) {
      const body = await readBody(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!allow(`resend:${email}`, 60, 1)) {
        return NextResponse.json({ error: "rate_limited", details: { retryAfterMs: 60_000 } }, { status: 429 });
      }
      const account = await deps.store.findAccountByEmail(email);
      if (account?.status === "pending") await issueCode(account, email, "verify");
      return NextResponse.json({ status: "accepted" }, { status: 202 });
    },

    async login(request: NextRequest) {
      const body = await readBody(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!allow(`login:${email}`, 900, 5)) {
        return NextResponse.json({ error: "rate_limited", details: { retryAfterMs: 900_000 } }, { status: 429 });
      }
      const account = validEmail(email) ? await deps.store.findAccountByEmail(email) : null;
      const passwordOk = Boolean(account && account.status === "active" && await verifyPassword(typeof body.password === "string" ? body.password : "", account.passwordHash));
      if (!account || !passwordOk) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
      return openSession(account);
    },

    async logout(request: NextRequest) {
      const auth = await signedIn(request);
      if (!auth || auth.expired || !auth.session) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
      if (!csrfOk(request, auth.session)) return NextResponse.json({ error: "csrf_token_invalid" }, { status: 403 });
      await deps.store.deleteAuthSession(auth.session.id);
      const response = NextResponse.json({ status: "ok" });
      clearAuthCookies(response, env);
      return response;
    },

    async me(request: NextRequest) {
      const auth = await signedIn(request);
      if (!auth || auth.expired) return NextResponse.json({ authenticated: false, user: null });
      return NextResponse.json({ authenticated: true, user: userView(auth.account) });
    },

    async forgot(request: NextRequest) {
      const body = await readBody(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!validEmail(email)) return NextResponse.json({ error: "validation" }, { status: 400 });
      if (!allow(`forgot:${email}`, 3600, 5)) {
        return NextResponse.json({ error: "rate_limited", details: { retryAfterMs: 3_600_000 } }, { status: 429 });
      }
      const account = await deps.store.findAccountByEmail(email);
      if (account?.status === "active") await issueCode(account, email, "reset");
      return NextResponse.json({ status: "accepted" }, { status: 202 });
    },

    async reset(request: NextRequest) {
      const body = await readBody(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (!validPassword(body.password)) return NextResponse.json({ error: "validation" }, { status: 400 });
      const challenge = await deps.store.latestChallenge(email, "reset");
      if (!challenge) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
      if (Date.parse(challenge.expiresAt) <= now().getTime()) return NextResponse.json({ error: "code_expired" }, { status: 400 });
      if (challenge.attempts >= MAX_CODE_ATTEMPTS) return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
      const received = Buffer.from(hashCode(code, env));
      const expected = Buffer.from(challenge.codeHash);
      if (!(received.length === expected.length && timingSafeEqual(received, expected))) {
        challenge.attempts += 1;
        await deps.store.saveChallenge(challenge);
        return NextResponse.json({ error: "invalid_code" }, { status: 400 });
      }
      challenge.consumedAt = now().toISOString();
      await deps.store.saveChallenge(challenge);
      const account = await deps.store.findAccountByEmail(email);
      if (!account) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
      account.passwordHash = await hashPassword(body.password);
      account.status = "active";
      account.verifiedAt = account.verifiedAt ?? now().toISOString();
      await deps.store.saveAccount(account);
      await deps.store.deleteAuthSessionsForAccount(account.id);
      return NextResponse.json({ status: "reset" });
    },

    async linkSession(request: NextRequest) {
      const auth = await signedIn(request);
      if (!auth || auth.expired) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
      if (!csrfOk(request, auth.session)) return NextResponse.json({ error: "csrf_token_invalid" }, { status: 403 });
      const sessionId = request.headers.get("x-session-id") ?? "";
      const proof = request.cookies.get(`vector_session_proof_${sessionId.toLowerCase().replace(/-/g, "")}`)?.value;
      if (!deps.verifyOwnership?.(sessionId, proof)) {
        return NextResponse.json({ error: "Эту анонимную сессию можно привязать только из браузера, где она была создана." }, { status: 403 });
      }
      const navigator = await deps.store.findNavigatorSession(sessionId);
      if (!navigator) return NextResponse.json({ error: "validation" }, { status: 404 });
      if (navigator.mode === "demo" || (navigator.accountId && navigator.accountId !== auth.account.id)) {
        return NextResponse.json({ error: "Эта сессия принадлежит демо-профилю или другому аккаунту." }, { status: 409 });
      }
      await deps.store.linkNavigatorSession(sessionId, auth.account.id);
      const linked = await deps.store.findNavigatorSession(sessionId);
      return NextResponse.json({ status: "linked", session: linked ? sessionView(linked) : null });
    },

    async overview(request: NextRequest) {
      const auth = await signedIn(request);
      if (!auth || auth.expired) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
      const sessions = await deps.store.listNavigatorSessions(auth.account.id);
      return NextResponse.json({
        user: userView(auth.account),
        sessions: sessions.map(sessionView),
        profile: sessions[0] ? { schoolGrade: sessions[0].schoolGrade, municipality: sessions[0].municipality } : null,
        limits: { maxSessions: 50 },
      });
    },

    async remove(request: NextRequest) {
      if (env.AUTH_ACCOUNT_DELETION_ENABLED !== "true") {
        return NextResponse.json({ error: "deletion_disabled" }, { status: 503 });
      }
      const auth = await signedIn(request);
      if (!auth || auth.expired) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
      if (!csrfOk(request, auth.session)) return NextResponse.json({ error: "csrf_token_invalid" }, { status: 403 });
      const body = await readBody(request);
      if (!await verifyPassword(typeof body.password === "string" ? body.password : "", auth.account.passwordHash)) {
        return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
      }
      await deps.store.deleteAccount(auth.account.id);
      const response = NextResponse.json({ status: "deleted" });
      clearAuthCookies(response, env);
      return response;
    },
  };
}

function sessionView(session: OwnedNavigatorSession) {
  return {
    sessionId: session.id,
    trackType: session.trackType,
    schoolGrade: session.schoolGrade,
    municipality: session.municipality,
    sessionMode: session.mode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    hasDiagnostic: session.hasDiagnostic,
    hasRecommendation: session.hasRecommendation,
    hasRoute: session.hasRoute,
  };
}
