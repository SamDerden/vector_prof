import { readSessionId } from "./session-store";
import { normalizeEmail, type AccountOverview, type AccountUser, type OwnSession } from "./auth-api";

/**
 * The account overview payload is documented only at a high level
 * (`GET /api/account` → own sessions, class/municipality, progress flags),
 * so the UI normalizes defensively: an unknown or renamed field must never
 * crash the cabinet or invent data.
 */

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export type SessionCard = {
  id: string;
  trackType: string | null;
  grade: number | null;
  municipality: string | null;
  mode: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  linked: boolean;
  hasDiagnostic: boolean;
  hasRecommendation: boolean;
  hasRoute: boolean;
  /** Number 0..3 of completed stages, derived only from explicit flags. */
  progress: number;
};

const TRACK_LABELS: Record<string, string> = {
  explore: "Не знаю, с чего начать",
  interests: "У меня есть интересы",
  known_direction: "Знаю направление",
};

export function trackLabel(value: string | null): string {
  if (!value) return "Трек не выбран";
  return TRACK_LABELS[value] ?? value;
}

export function normalizeSession(raw: unknown): SessionCard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id =
    asString(item.sessionId) ??
    asString(item.session_id) ??
    asString(item.id) ??
    (asString(item.sessionUuid) ?? null);
  if (!id) return null;
  const flags = item.progress && typeof item.progress === "object" ? (item.progress as Record<string, unknown>) : item;
  const hasDiagnostic = asBoolean(flags.hasDiagnostic) ?? asBoolean(flags.diagnostic) ?? false;
  const hasRecommendation = asBoolean(flags.hasRecommendation) ?? asBoolean(flags.recommendation) ?? false;
  const hasRoute = asBoolean(flags.hasRoute) ?? asBoolean(flags.educationRoute) ?? false;
  return {
    id,
    trackType: asString(item.trackType) ?? asString(item.track_type),
    grade: asNumber(item.schoolGrade) ?? asNumber(item.school_grade) ?? asNumber(item.grade),
    municipality: asString(item.municipality),
    mode: asString(item.sessionMode) ?? asString(item.session_mode),
    createdAt: asString(item.createdAt) ?? asString(item.created_at),
    updatedAt: asString(item.updatedAt) ?? asString(item.updated_at) ?? asString(item.lastActivityAt),
    expiresAt: asString(item.expiresAt) ?? asString(item.expires_at),
    linked: Boolean(asString(item.accountLinkedAt) ?? asString(item.account_linked_at)) || Boolean(asBoolean(item.linked)),
    hasDiagnostic,
    hasRecommendation,
    hasRoute,
    progress: [hasDiagnostic, hasRecommendation, hasRoute].filter(Boolean).length,
  };
}

export function normalizeOverview(raw: AccountOverview | null): {
  user: AccountUser | null;
  sessions: SessionCard[];
  grade: number | null;
  municipality: string | null;
  progress: Record<string, unknown> | null;
  limits: { maxSessions?: number } | null;
} {
  if (!raw) return { user: null, sessions: [], grade: null, municipality: null, progress: null, limits: null };
  const rawSessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const sessions = rawSessions
    .map((item) => normalizeSession(item))
    .filter((item): item is SessionCard => item !== null)
    .sort((a, b) => {
      const left = a.updatedAt ?? a.createdAt ?? "";
      const right = b.updatedAt ?? b.createdAt ?? "";
      return right.localeCompare(left);
    });
  const profile = raw.profile && typeof raw.profile === "object" ? raw.profile : null;
  return {
    user: raw.user ?? null,
    sessions,
    grade: asNumber(profile?.schoolGrade) ?? asNumber((raw as Record<string, unknown>).schoolGrade),
    municipality: asString(profile?.municipality) ?? asString((raw as Record<string, unknown>).municipality),
    progress: raw.progress && typeof raw.progress === "object" ? raw.progress : null,
    limits: raw.limits && typeof raw.limits === "object" ? (raw.limits as { maxSessions?: number }) : null,
  };
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", year: "numeric" }).format(date);
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function shortSessionId(value: string): string {
  return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

/** Anonymous own session kept in localStorage; null when this browser has none. */
export function localOwnSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return readSessionId({ mode: "own" }, window.localStorage);
  } catch {
    return null;
  }
}

export function maskedIdentifier(user: AccountUser | null): string {
  if (!user) return "";
  if (user.email) {
    const email = normalizeEmail(user.email);
    const [name, domain] = email.split("@");
    if (!domain) return email;
    const visible = name.slice(0, 2);
    return `${visible}${"•".repeat(Math.max(1, name.length - 2))}@${domain}`;
  }
  if (user.phone) {
    const tail = user.phone.slice(-4);
    return `•••• ••${tail}`;
  }
  return "";
}

export function userStatusLabel(user: AccountUser | null): string {
  if (!user) return "";
  if (user.status === "active") return "Подтверждён";
  if (user.status === "pending") return "Ожидает подтверждения";
  return user.status;
}
