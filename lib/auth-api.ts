import { API_BASE } from "./api";

/**
 * Client for the personal cabinet API.
 *
 * Contract: backend/docs/ACCOUNT_AUTH_API.md
 *
 * Security rules this module enforces on the client side:
 * - `vector_auth_session` is HttpOnly and must never be read from JavaScript;
 * - every state-changing account request carries `X-CSRF-Token` copied from the
 *   JS-readable `vector_csrf` cookie (double submit);
 * - `X-Session-ID` is only a locator: the backend decides ownership from the
 *   auth cookie, a client supplied user id is never used as proof;
 * - every request is same-origin (`/api/*` goes through the Next.js proxy).
 *
 * Registration is fail-closed on the backend until the product owner approves
 * the flags, so `503 registration_not_configured` is a normal, expected state
 * and is surfaced to the UI as a readable message instead of a crash.
 */

export const CSRF_COOKIE = "vector_csrf";
export const AUTH_COOKIE = "vector_auth_session";
export const SESSION_HEADER = "X-Session-ID";
export const CSRF_HEADER = "X-CSRF-Token";

export type AccountErrorCode =
  | "network"
  | "csrf"
  | "session_expired"
  | "rate_limited"
  | "registration_not_configured"
  | "feature_disabled"
  | "not_authenticated"
  | "invalid_credentials"
  | "invalid_code"
  | "code_expired"
  | "too_many_attempts"
  | "validation"
  | "conflict"
  | "server"
  | "unknown";

export type AccountError = {
  code: AccountErrorCode;
  status: number;
  message: string;
  details?: unknown;
  retryAfterMs?: number;
};

export type AccountUser = {
  id?: string;
  email: string | null;
  phone: string | null;
  status: string;
  verifiedAt: string | null;
  createdAt?: string | null;
};

export type OwnSession = {
  sessionId: string;
  trackType?: string | null;
  schoolGrade?: number | null;
  municipality?: string | null;
  sessionMode?: string | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  accountLinkedAt?: string | null;
  hasDiagnostic?: boolean;
  hasRecommendation?: boolean;
  hasRoute?: boolean;
  [key: string]: unknown;
};

export type AccountOverview = {
  user: AccountUser;
  sessions: OwnSession[];
  profile?: {
    schoolGrade?: number | null;
    municipality?: string | null;
    [key: string]: unknown;
  } | null;
  progress?: Record<string, unknown> | null;
  limits?: { maxSessions?: number; [key: string]: unknown } | null;
  [key: string]: unknown;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isEmail(value: string): boolean {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

export function validatePassword(value: string): string | null {
  if (value.length < PASSWORD_MIN) return `Пароль должен быть не короче ${PASSWORD_MIN} символов.`;
  if (value.length > PASSWORD_MAX) return `Пароль должен быть не длиннее ${PASSWORD_MAX} символов.`;
  return null;
}

function readCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const parts = document.cookie ? document.cookie.split(";") : [];
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

/** Only the CSRF cookie is JS-readable; the auth cookie stays HttpOnly. */
export function csrfToken(): string {
  return readCookie(CSRF_COOKIE);
}

const RUSSIAN_FALLBACKS: Record<AccountErrorCode, string> = {
  network: "Нет связи с сервером. Проверь соединение и попробуй ещё раз.",
  csrf: "Страница устарела. Обнови её и повтори действие.",
  session_expired: "Сессия истекла. Войди в аккаунт заново.",
  rate_limited: "Слишком много попыток. Попробуй позже.",
  registration_not_configured:
    "Регистрация пока недоступна: на сервере не включены обязательные настройки. Попробуй позже или обратись к администратору.",
  feature_disabled: "Действие пока недоступно: функция выключена на сервере.",
  not_authenticated: "Нужно войти в аккаунт.",
  invalid_credentials: "Неверный email или пароль.",
  invalid_code: "Код неверный или уже использован.",
  code_expired: "Срок действия кода истёк. Запроси новый.",
  too_many_attempts: "Слишком много неверных попыток. Запроси новый код.",
  validation: "Проверь заполненные поля.",
  conflict: "Данные изменились. Обнови страницу и повтори.",
  server: "На сервере произошла ошибка. Попробуй позже.",
  unknown: "Не удалось выполнить действие.",
};

function codeFromPayload(status: number, payload: Record<string, unknown>): AccountErrorCode {
  const raw = String(payload.error || payload.code || "").toLowerCase();
  if (raw.includes("registration_not_configured")) return "registration_not_configured";
  if (raw.includes("not_configured") || raw.includes("not_configured_yet")) return "feature_disabled";
  if (raw.includes("deletion_disabled") || raw.includes("disabled") || raw.includes("not_enabled")) return "feature_disabled";
  if (raw.includes("csrf")) return "csrf";
  if (raw.includes("rate_limited") || raw.includes("too_many_requests")) return "rate_limited";
  if (raw.includes("expired")) return "code_expired";
  if (raw.includes("attempts")) return "too_many_attempts";
  if (raw.includes("code") || raw.includes("challenge")) return "invalid_code";
  if (raw.includes("credential") || raw.includes("password")) return "invalid_credentials";
  if (status === 401) return "not_authenticated";
  if (status === 403) return "csrf";
  if (status === 409) return "conflict";
  if (status === 410) return "session_expired";
  if (status === 422 || status === 400) return "validation";
  if (status === 429) return "rate_limited";
  if (status === 503) return "feature_disabled";
  if (status >= 500) return "server";
  return "unknown";
}

function retryAfterMs(response: Response, payload: Record<string, unknown>): number | undefined {
  const details = payload.details && typeof payload.details === "object" ? (payload.details as Record<string, unknown>) : null;
  const fromDetails = Number(details?.retryAfterMs);
  if (Number.isFinite(fromDetails) && fromDetails > 0) return fromDetails;
  const header = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  return undefined;
}

export class AccountApiError extends Error {
  readonly code: AccountErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryAfterMs?: number;
  constructor(error: AccountError) {
    super(error.message);
    this.name = "AccountApiError";
    this.code = error.code;
    this.status = error.status;
    this.retryAfterMs = error.retryAfterMs;
    this.details = error.details;
  }
}

export function isAccountApiError(value: unknown): value is AccountApiError {
  return value instanceof AccountApiError;
}

export function accountErrorMessage(error: unknown): string {
  if (isAccountApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return RUSSIAN_FALLBACKS.unknown;
}

/** Server text never lands in the UI as-is: it is mapped to a stable RU message. */
export function humanizeAccountError(error: unknown): AccountError {
  if (isAccountApiError(error)) {
    const fallback = RUSSIAN_FALLBACKS[error.code];
    const message = error.code === "unknown" || !error.message ? fallback : error.message;
    return { code: error.code, status: error.status, message, details: error.details, retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof Error) {
    return { code: "network", status: 0, message: RUSSIAN_FALLBACKS.network };
  }
  return { code: "unknown", status: 0, message: RUSSIAN_FALLBACKS.unknown };
}

type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  /** Only account-owned writes need the CSRF double-submit header. */
  csrf?: boolean;
  /** Locator of the anonymous session being linked; never proof of ownership. */
  sessionId?: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

async function call<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.sessionId) headers[SESSION_HEADER] = options.sessionId;
  if (options.csrf) {
    const token = csrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers,
      cache: "no-store",
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AccountApiError({ code: "network", status: 0, message: RUSSIAN_FALLBACKS.network });
  }
  const text = await response.text().catch(() => "");
  let payload: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  if (!response.ok) {
    const code = codeFromPayload(response.status, payload);
    const serverMessage = typeof payload.error === "string" ? payload.error : "";
    // Short Russian sentences from the backend are safe to show; raw codes are not.
    const showServer = serverMessage && /[а-яё]/i.test(serverMessage) && serverMessage.length < 300;
    throw new AccountApiError({
      code,
      status: response.status,
      message: showServer ? serverMessage : RUSSIAN_FALLBACKS[code],
      details: payload.details,
      retryAfterMs: retryAfterMs(response, payload),
    });
  }
  return payload as T;
}

/* ------------------------------------------------------------------ */
/* Auth endpoints                                                      */
/* ------------------------------------------------------------------ */

export async function fetchMe(options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}) {
  return call<{ authenticated: boolean; user?: AccountUser | null }>("/api/auth/me", options);
}

export async function register(input: { email: string }, options: { fetchImpl?: typeof fetch } = {}) {
  return call<{ status?: string; message?: string }>("/api/auth/register", {
    method: "POST",
    body: { email: normalizeEmail(input.email) },
    fetchImpl: options.fetchImpl,
  });
}

export async function verify(input: { email: string; code: string }, options: { fetchImpl?: typeof fetch } = {}) {
  return call<{ status?: string; message?: string }>("/api/auth/verify", {
    method: "POST",
    body: { email: normalizeEmail(input.email), code: input.code.trim() },
    fetchImpl: options.fetchImpl,
  });
}

export async function resendVerification(input: { email: string }, options: { fetchImpl?: typeof fetch } = {}) {
  return call<{ status?: string; message?: string }>("/api/auth/verification/resend", {
    method: "POST",
    body: { email: normalizeEmail(input.email) },
    fetchImpl: options.fetchImpl,
  });
}

export async function login(input: { email: string; password: string }, options: { fetchImpl?: typeof fetch } = {}) {
  return call<{ user: AccountUser }>("/api/auth/login", {
    method: "POST",
    body: { email: normalizeEmail(input.email), password: input.password },
    fetchImpl: options.fetchImpl,
  });
}

export async function logout(options: { fetchImpl?: typeof fetch } = {}) {
  return call<{ status?: string }>("/api/auth/logout", { method: "POST", body: {}, csrf: true, fetchImpl: options.fetchImpl });
}

export async function forgotPassword(input: { email: string }, options: { fetchImpl?: typeof fetch } = {}) {
  return call<{ status?: string; message?: string }>("/api/auth/password/forgot", {
    method: "POST",
    body: { email: normalizeEmail(input.email) },
    fetchImpl: options.fetchImpl,
  });
}

export async function resetPassword(
  input: { email: string; code: string; password: string },
  options: { fetchImpl?: typeof fetch } = {}
) {
  return call<{ status?: string; message?: string }>("/api/auth/password/reset", {
    method: "POST",
    body: { email: normalizeEmail(input.email), code: input.code.trim(), password: input.password },
    fetchImpl: options.fetchImpl,
  });
}

/**
 * Attach the anonymous own session to the signed-in account.
 * Ownership is proven by the HttpOnly session-proof cookie set by the backend,
 * not by the header value; the header only names the session that is being
 * linked.
 */
export async function linkSession(
  input: { sessionId: string },
  options: { fetchImpl?: typeof fetch } = {}
) {
  return call<{ status?: string; session?: OwnSession; message?: string }>("/api/auth/link-session", {
    method: "POST",
    body: {},
    csrf: true,
    sessionId: input.sessionId,
    fetchImpl: options.fetchImpl,
  });
}

/* ------------------------------------------------------------------ */
/* Account endpoints                                                   */
/* ------------------------------------------------------------------ */

export async function fetchAccount(options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}) {
  return call<AccountOverview>("/api/account", options);
}

export async function deleteAccount(
  input: { password: string },
  options: { fetchImpl?: typeof fetch } = {}
) {
  return call<{ status?: string }>("/api/account", {
    method: "DELETE",
    body: { password: input.password },
    csrf: true,
    fetchImpl: options.fetchImpl,
  });
}
