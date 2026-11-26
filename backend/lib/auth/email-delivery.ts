import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

export type EmailPurpose = "verify" | "reset" | "login";

export type EmailMessage = {
  to: string;
  purpose: EmailPurpose;
  code: string;
  subject?: string;
  text?: string;
};

export type EmailPlan =
  | { transport: "http"; url: string; token: string | null }
  | { transport: "smtp"; host: string; port: number; from: string; user: string | null; password: string | null; secure: boolean }
  | { transport: "file"; directory: string }
  | { transport: "unconfigured"; reason: string };

export type DeliveryCategory = "auth" | "tls" | "connection" | "limit" | "recipient" | "protocol" | "unconfigured";

export class DeliveryError extends Error {
  retryable: boolean;
  category: DeliveryCategory;

  constructor(retryable: boolean, category: DeliveryCategory = "protocol") {
    super("delivery_failed");
    this.name = "DeliveryError";
    this.retryable = retryable;
    this.category = category;
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

export function emailTransportPlan(env: NodeJS.ProcessEnv): EmailPlan {
  const requested = (env.AUTH_EMAIL_TRANSPORT ?? "").trim().toLowerCase();
  const url = (env.AUTH_DELIVERY_URL ?? "").trim();
  const smtpHost = (env.SMTP_HOST ?? "").trim();
  if (requested === "http" || (!requested && url)) {
    if (!url) return { transport: "unconfigured", reason: "AUTH_DELIVERY_URL is required for http delivery" };
    return { transport: "http", url, token: (env.AUTH_DELIVERY_TOKEN ?? "").trim() || null };
  }
  if (requested === "smtp" || (!requested && smtpHost)) {
    const port = Number(env.SMTP_PORT ?? (env.SMTP_SECURE === "true" ? 465 : 587));
    const from = (env.SMTP_FROM ?? "").trim();
    if (!smtpHost || !from || !Number.isInteger(port) || port <= 0) {
      return { transport: "unconfigured", reason: "SMTP_HOST, SMTP_PORT and SMTP_FROM are required" };
    }
    return {
      transport: "smtp",
      host: smtpHost,
      port,
      from,
      user: (env.SMTP_USER ?? "").trim() || null,
      password: env.SMTP_PASSWORD ?? null,
      secure: env.SMTP_SECURE === "true",
    };
  }
  if (requested === "file" || (!requested && env.NODE_ENV !== "production")) {
    return { transport: "file", directory: (env.AUTH_EMAIL_FILE_DIR ?? "").trim() || path.join(process.cwd(), ".auth-dev-outbox") };
  }
  return { transport: "unconfigured", reason: "email transport is not configured" };
}

export function productionDeliveryReady(env: NodeJS.ProcessEnv) {
  const plan = emailTransportPlan(env);
  return plan.transport === "http" || plan.transport === "smtp";
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendWithRetry(send: () => Promise<void>, attempts = 3, delayMs = 200) {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await send();
      return;
    } catch (error) {
      last = error;
      const retryable = error instanceof DeliveryError ? error.retryable : true;
      if (!retryable || attempt === attempts) break;
      await wait(delayMs * attempt);
    }
  }
  if (last instanceof DeliveryError) throw last;
  throw new DeliveryError(false);
}

function fileName(message: EmailMessage) {
  const name = createHash("sha256").update(`${message.purpose}:${message.to}`).digest("hex").slice(0, 16);
  return `${message.purpose}-${name}.txt`;
}

async function sendHttp(plan: Extract<EmailPlan, { transport: "http" }>, message: EmailMessage, fetchImpl: FetchLike) {
  try {
    const response = await fetchImpl(plan.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(plan.token ? { authorization: `Bearer ${plan.token}` } : {}),
      },
      body: JSON.stringify({ email: message.to, purpose: message.purpose, code: message.code }),
    });
    if (response.ok) return;
    throw new DeliveryError(response.status === 429 || response.status >= 500);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(true);
  }
}

function sendFile(plan: Extract<EmailPlan, { transport: "file" }>, message: EmailMessage) {
  mkdirSync(plan.directory, { recursive: true });
  writeFileSync(path.join(plan.directory, fileName(message)), message.code, { mode: 0o600 });
}

type SmtpSocket = {
  write: (chunk: string) => void;
  read: () => Promise<string>;
  close: () => void;
};

/** An SMTP reply is complete when its last line is `123 text`, not a `123-` continuation. */
export function smtpReplyComplete(buffer: string) {
  if (!buffer.endsWith("\n")) return false;
  const lines = buffer.split(/\r?\n/).filter((line) => line.length > 0);
  return /^\d{3} /.test(lines.at(-1) ?? "");
}

function networkCategory(error: unknown): DeliveryCategory {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code.includes("CERT") || code === "EPROTO" || code.startsWith("ERR_TLS")) return "tls";
  return "connection";
}

async function readSmtp(socket: net.Socket | tls.TLSSocket) {
  let buffer = "";
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new DeliveryError(true, "connection"));
    }, 20_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!smtpReplyComplete(buffer)) return;
      cleanup();
      resolve(buffer);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error instanceof DeliveryError ? error : new DeliveryError(true, networkCategory(error)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function replyCategory(line: string, stage: "auth" | "rcpt" | "other"): DeliveryCategory {
  const code = Number(line.slice(0, 3));
  if (stage === "auth" || code === 530 || code === 534 || code === 535) return "auth";
  if (stage === "rcpt" && code >= 500) return "recipient";
  if (code === 421 || code === 450 || code === 451 || code === 452) return "limit";
  return "protocol";
}

function headerValue(value: string) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export async function smtpExchange(socket: SmtpSocket, plan: Extract<EmailPlan, { transport: "smtp" }>, message: EmailMessage) {
  const expect = async (ok: (line: string) => boolean, stage: "auth" | "rcpt" | "other" = "other") => {
    const line = await socket.read();
    if (!ok(line)) throw new DeliveryError(line.startsWith("4"), replyCategory(line, stage));
    return line;
  };
  await expect((line) => line.startsWith("220"));
  socket.write("EHLO vector.local\r\n");
  await expect((line) => line.startsWith("250"));
  if (plan.user) {
    if (!plan.password) throw new DeliveryError(false, "auth");
    const token = Buffer.from(`\u0000${plan.user}\u0000${plan.password}`).toString("base64");
    socket.write(`AUTH PLAIN ${token}\r\n`);
    await expect((line) => line.startsWith("235"), "auth");
  } else if (plan.host !== "127.0.0.1") {
    throw new DeliveryError(false, "auth");
  }
  socket.write(`MAIL FROM:<${plan.from}>\r\n`);
  await expect((line) => line.startsWith("250"));
  socket.write(`RCPT TO:<${message.to}>\r\n`);
  await expect((line) => line.startsWith("250"), "rcpt");
  socket.write("DATA\r\n");
  await expect((line) => line.startsWith("354"));
  const subject = message.subject ?? (
    message.purpose === "reset" ? "Код для нового пароля"
      : message.purpose === "login" ? "Код для входа"
        : "Код подтверждения"
  );
  const text = (message.text ?? message.code).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  socket.write(`Subject: ${headerValue(subject)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.\r\n`);
  await expect((line) => line.startsWith("250"));
  socket.write("QUIT\r\n");
}

export async function deliverSmtpOnce(plan: Extract<EmailPlan, { transport: "smtp" }>, message: EmailMessage) {
  const socket = await openSmtp(plan);
  try {
    await smtpExchange(socket, plan, message);
  } finally {
    socket.close();
  }
}

async function openSmtp(plan: Extract<EmailPlan, { transport: "smtp" }>): Promise<SmtpSocket> {
  const socket = plan.secure
    ? tls.connect({ host: plan.host, port: plan.port, servername: plan.host })
    : net.connect({ host: plan.host, port: plan.port });
  await new Promise<void>((resolve, reject) => {
    const ready = plan.secure ? "secureConnect" : "connect";
    const onReady = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off(ready, onReady);
      reject(error instanceof DeliveryError ? error : new DeliveryError(true, networkCategory(error)));
    };
    socket.once(ready, onReady);
    socket.once("error", onError);
  });
  return {
    write: (chunk) => socket.write(chunk),
    read: () => readSmtp(socket),
    close: () => socket.end(),
  };
}

export function createEmailDelivery(env: NodeJS.ProcessEnv, fetchImpl: FetchLike = fetch) {
  const plan = emailTransportPlan(env);
  return {
    plan,
    async send(message: EmailMessage) {
      if (plan.transport === "unconfigured") throw new DeliveryError(false);
      await sendWithRetry(async () => {
        if (plan.transport === "http") await sendHttp(plan, message, fetchImpl);
        else if (plan.transport === "file") sendFile(plan, message);
        else if (plan.transport === "smtp") {
          const socket = await openSmtp(plan);
          try {
            await smtpExchange(socket, plan, message);
          } finally {
            socket.close();
          }
        }
      });
    },
  };
}
