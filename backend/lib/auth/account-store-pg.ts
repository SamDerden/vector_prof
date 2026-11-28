import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { isMissingSchemaError, pool, query } from "../db.ts";
import { createEmailDelivery } from "./email-delivery.ts";
import { ownsAnonymousSession } from "../session-proof.ts";
import {
  createAccountApi,
  sameSecret,
  type AccountRecord,
  type AccountStore,
  type AuthChallenge,
  type AuthSessionRecord,
  type OwnedNavigatorSession,
  type SettleChallengeInput,
} from "./account-api.ts";

type AccountRow = {
  id: string;
  email: string;
  password_hash: string | null;
  status: AccountRecord["status"];
  verified_at: Date | string | null;
  created_at: Date | string;
};

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function accountFrom(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    status: row.status,
    verifiedAt: iso(row.verified_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

const SESSION_SQL = `
  SELECT s.id::text AS id,
         s.session_mode AS mode,
         s.account_id::text AS account_id,
         p.school_grade,
         p.municipality,
         s.track_type,
         s.created_at,
         s.updated_at,
         s.expires_at,
         EXISTS (SELECT 1 FROM diagnostics d WHERE d.session_id = s.id) AS has_diagnostic,
         EXISTS (SELECT 1 FROM recommendations r WHERE r.session_id = s.id) AS has_recommendation,
         EXISTS (SELECT 1 FROM education_routes e WHERE e.session_id = s.id) AS has_route
    FROM sessions s
    LEFT JOIN profiles p ON p.session_id = s.id
`;

type SessionRow = {
  id: string;
  mode: string | null;
  account_id: string | null;
  school_grade: number | null;
  municipality: string | null;
  track_type: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  expires_at: Date | string | null;
  has_diagnostic: boolean;
  has_recommendation: boolean;
  has_route: boolean;
};

function sessionFrom(row: SessionRow): OwnedNavigatorSession {
  return {
    id: row.id,
    mode: row.mode,
    accountId: row.account_id,
    schoolGrade: row.school_grade,
    municipality: row.municipality,
    trackType: row.track_type,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
    hasDiagnostic: row.has_diagnostic,
    hasRecommendation: row.has_recommendation,
    hasRoute: row.has_route,
  };
}

async function settleLockedChallenge(client: PoolClient, input: SettleChallengeInput) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`${input.email}\n${input.purpose}`]);
  const selected = await client.query<{ id: string; code_hash: string; expires_at: Date | string; attempts: number }>(
    `SELECT id::text, code_hash, expires_at, attempts
       FROM auth_challenges
      WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [input.email, input.purpose]
  );
  const row = selected.rows[0];
  if (!row) return { outcome: "missing" as const };
  if (new Date(row.expires_at).getTime() <= Date.parse(input.now)) return { outcome: "expired" as const };
  if (row.attempts >= input.maxAttempts) return { outcome: "locked" as const };
  if (!sameSecret(row.code_hash, input.codeHash)) {
    await client.query(
      "UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1::uuid AND consumed_at IS NULL AND attempts < $2",
      [row.id, input.maxAttempts]
    );
    return { outcome: "mismatch" as const };
  }
  const claimed = await client.query(
    "UPDATE auth_challenges SET consumed_at = $2 WHERE id = $1::uuid AND consumed_at IS NULL RETURNING id",
    [row.id, input.now]
  );
  if ((claimed.rowCount ?? 0) !== 1) return { outcome: "missing" as const };

  const accountResult = await client.query<AccountRow>(
    "SELECT id::text, email, password_hash, status, verified_at, created_at FROM accounts WHERE email = $1 FOR UPDATE",
    [input.email]
  );
  const account = accountResult.rows[0] ?? null;
  if (input.effect.type === "verify" && account) {
    const updated = await client.query<AccountRow>(
      `UPDATE accounts
          SET status = 'active', verified_at = $2, updated_at = now()
        WHERE id = $1
      RETURNING id::text, email, password_hash, status, verified_at, created_at`,
      [account.id, input.now]
    );
    return { outcome: "consumed" as const, account: accountFrom(updated.rows[0]) };
  }
  if (input.effect.type === "reset" && account) {
    const updated = await client.query<AccountRow>(
      `UPDATE accounts
          SET password_hash = $2,
              status = 'active',
              verified_at = COALESCE(verified_at, $3),
              updated_at = now()
        WHERE id = $1
      RETURNING id::text, email, password_hash, status, verified_at, created_at`,
      [account.id, input.effect.passwordHash, input.now]
    );
    await client.query("DELETE FROM auth_sessions WHERE account_id = $1", [account.id]);
    return { outcome: "consumed" as const, account: accountFrom(updated.rows[0]) };
  }
  if (input.effect.type === "login" && account?.status === "active") {
    await client.query(
      "INSERT INTO auth_sessions (id, account_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [input.effect.session.id, account.id, input.effect.session.tokenHash, input.effect.session.csrfToken, input.effect.session.expiresAt]
    );
  }
  return { outcome: "consumed" as const, account: account ? accountFrom(account) : null };
}

export const pgAccountStore: AccountStore = {
  async findAccountByEmail(email) {
    const result = await query<AccountRow>("SELECT id::text, email, password_hash, status, verified_at, created_at FROM accounts WHERE email = $1", [email]);
    return result.rows[0] ? accountFrom(result.rows[0]) : null;
  },
  async findAccountById(id) {
    const result = await query<AccountRow>("SELECT id::text, email, password_hash, status, verified_at, created_at FROM accounts WHERE id = $1", [id]);
    return result.rows[0] ? accountFrom(result.rows[0]) : null;
  },
  async insertAccount(account) {
    await query(
      "INSERT INTO accounts (id, email, password_hash, status, verified_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [account.id, account.email, account.passwordHash, account.status, account.verifiedAt, account.createdAt]
    );
  },
  async saveAccount(account) {
    await query(
      "UPDATE accounts SET password_hash = $2, status = $3, verified_at = $4, updated_at = now() WHERE id = $1",
      [account.id, account.passwordHash, account.status, account.verifiedAt]
    );
  },
  async insertChallenge(challenge) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`${challenge.email}\n${challenge.purpose}`]);
        await client.query(
          `UPDATE auth_challenges
              SET consumed_at = now()
            WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL`,
          [challenge.email, challenge.purpose]
        );
        await client.query(
          "INSERT INTO auth_challenges (id, account_id, email, purpose, code_hash, expires_at, attempts) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [challenge.id, challenge.accountId, challenge.email, challenge.purpose, challenge.codeHash, challenge.expiresAt, challenge.attempts]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  },
  async latestChallenge(email, purpose) {
    const result = await query<{
      id: string;
      account_id: string | null;
      email: string;
      purpose: "verify" | "reset" | "login";
      code_hash: string;
      expires_at: Date | string;
      attempts: number;
      consumed_at: Date | string | null;
    }>(
      `SELECT id::text, account_id::text, email, purpose, code_hash, expires_at, attempts, consumed_at
         FROM auth_challenges
        WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [email, purpose]
    );
    const row = result.rows[0];
    if (!row) return null;
    const challenge: AuthChallenge = {
      id: row.id,
      accountId: row.account_id,
      email: row.email,
      purpose: row.purpose,
      codeHash: row.code_hash,
      expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
      attempts: row.attempts,
      consumedAt: iso(row.consumed_at),
    };
    return challenge;
  },
  async saveChallenge(challenge) {
    await query(
      "UPDATE auth_challenges SET attempts = $2, consumed_at = $3 WHERE id = $1",
      [challenge.id, challenge.attempts, challenge.consumedAt]
    );
  },
  async settleChallenge(input) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const settlement = await settleLockedChallenge(client, input);
        await client.query("COMMIT");
        return settlement;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  },
  async insertAuthSession(session) {
    await query(
      "INSERT INTO auth_sessions (id, account_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [session.id, session.accountId, session.tokenHash, session.csrfToken, session.expiresAt]
    );
  },
  async findAuthSession(tokenHash) {
    const result = await query<{ id: string; account_id: string; token_hash: string; csrf_token: string; expires_at: Date | string }>(
      "SELECT id::text, account_id::text, token_hash, csrf_token, expires_at FROM auth_sessions WHERE token_hash = $1",
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) return null;
    const session: AuthSessionRecord = {
      id: row.id,
      accountId: row.account_id,
      tokenHash: row.token_hash,
      csrfToken: row.csrf_token,
      expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
    };
    return session;
  },
  async deleteAuthSession(id) {
    await query("DELETE FROM auth_sessions WHERE id = $1", [id]);
  },
  async deleteAuthSessionsForAccount(accountId) {
    await query("DELETE FROM auth_sessions WHERE account_id = $1", [accountId]);
  },
  async findNavigatorSession(id) {
    const result = await query<SessionRow>(`${SESSION_SQL} WHERE s.id = $1`, [id]);
    return result.rows[0] ? sessionFrom(result.rows[0]) : null;
  },
  async linkNavigatorSession(id, accountId) {
    await query("UPDATE sessions SET account_id = $2, updated_at = now() WHERE id = $1 AND (account_id IS NULL OR account_id = $2)", [id, accountId]);
  },
  async listNavigatorSessions(accountId) {
    const result = await query<SessionRow>(`${SESSION_SQL} WHERE s.account_id = $1 ORDER BY s.updated_at DESC LIMIT 50`, [accountId]);
    return result.rows.map(sessionFrom);
  },
  async deleteAccount(id) {
    await query("UPDATE sessions SET account_id = NULL WHERE account_id = $1", [id]);
    await query("DELETE FROM accounts WHERE id = $1", [id]);
  },
};

async function deliver(email: string, purpose: "verify" | "reset" | "login", code: string) {
  await createEmailDelivery(process.env).send({ to: email, purpose, code });
}

function api() {
  return createAccountApi({
    store: pgAccountStore,
    env: process.env,
    async deliver(email, purpose, code) {
      await deliver(email, purpose, code);
    },
    verifyOwnership(sessionId, proof) {
      try {
        return ownsAnonymousSession(sessionId, proof);
      } catch {
        return false;
      }
    },
  });
}

export async function handleAccount(action: keyof ReturnType<typeof createAccountApi>, request: NextRequest) {
  try {
    return await api()[action](request);
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return NextResponse.json({ error: "registration_not_configured" }, { status: 503 });
    }
    console.error("[account] request failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
