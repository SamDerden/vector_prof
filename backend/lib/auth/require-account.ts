import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { pgAccountStore } from "./account-store-pg";
import { jsonError } from "../http";

export async function requireAccount(request: NextRequest, write = false) {
  const token = request.cookies.get("vector_auth_session")?.value;
  if (!token) return { error: jsonError("not_authenticated", 401) };
  const session = await pgAccountStore.findAuthSession(createHash("sha256").update(token).digest("base64url"));
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return { error: jsonError("not_authenticated", 401) };
  const account = await pgAccountStore.findAccountById(session.accountId);
  if (!account || account.status !== "active" || !account.verifiedAt) return { error: jsonError("not_authenticated", 401) };
  if (write) {
    const header = Buffer.from(request.headers.get("x-csrf-token") ?? "");
    const cookie = Buffer.from(request.cookies.get("vector_csrf")?.value ?? "");
    const stored = Buffer.from(session.csrfToken);
    if (!header.length || header.length !== stored.length || cookie.length !== stored.length ||
        !timingSafeEqual(header, stored) || !timingSafeEqual(cookie, stored)) return { error: jsonError("csrf_token_invalid", 403) };
  }
  return { accountId: account.id };
}
