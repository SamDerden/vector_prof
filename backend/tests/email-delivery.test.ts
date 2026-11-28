import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAccountApi, createMemoryAccountStore } from "../lib/auth/account-api.ts";
import { spawnSync } from "node:child_process";

import { createEmailDelivery, DeliveryError, emailTransportPlan, productionDeliveryReady, smtpExchange, smtpReplyComplete, type EmailMessage } from "../lib/auth/email-delivery.ts";
import { NextRequest } from "next/server";

const message: EmailMessage = { to: "student@example.test", purpose: "verify", code: "123456" };

test("email transport stays closed in production until http or smtp is configured", () => {
  assert.equal(productionDeliveryReady({ NODE_ENV: "production" }), false);
  assert.equal(emailTransportPlan({ NODE_ENV: "production" }).transport, "unconfigured");
  assert.equal(productionDeliveryReady({ NODE_ENV: "production", AUTH_DELIVERY_URL: "http://127.0.0.1:9/deliver" }), true);
  assert.equal(emailTransportPlan({
    NODE_ENV: "production",
    AUTH_EMAIL_TRANSPORT: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "2525",
    SMTP_FROM: "vector@example.test",
  }).transport, "smtp");
});

test("http delivery retries and does not put the code into the error", async () => {
  let calls = 0;
  const delivery = createEmailDelivery({
    NODE_ENV: "production",
    AUTH_EMAIL_TRANSPORT: "http",
    AUTH_DELIVERY_URL: "http://127.0.0.1:9/deliver",
  }, async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 503 };
    return { ok: true, status: 202 };
  });
  await delivery.send(message);
  assert.equal(calls, 3);
  await assert.rejects(
    () => createEmailDelivery({
      NODE_ENV: "production",
      AUTH_EMAIL_TRANSPORT: "http",
      AUTH_DELIVERY_URL: "http://127.0.0.1:9/deliver",
    }, async () => ({ ok: false, status: 400 })).send(message),
    (error: unknown) => error instanceof Error && error.message === "delivery_failed" && !error.message.includes(message.code)
  );
});

test("local file delivery writes only the code outside JSON responses", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vector-mail-"));
  const store = createMemoryAccountStore();
  const seen: string[] = [];
  const api = createAccountApi({
    store,
    env: { NODE_ENV: "test", AUTH_REGISTRATION_ENABLED: "true", AUTH_CHALLENGE_SECRET: "pepper" },
    async deliver(email, purpose, code) {
      seen.push(code);
      await createEmailDelivery({ NODE_ENV: "test", AUTH_EMAIL_TRANSPORT: "file", AUTH_EMAIL_FILE_DIR: directory }).send({ to: email, purpose, code });
      throw new Error("mailbox unavailable");
    },
  });
  const response = await api.register(new NextRequest("http://127.0.0.1/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: message.to, password: "correct-horse-battery" }),
  }));
  const body = await response.json() as { status?: string; code?: string };
  assert.equal(response.status, 202);
  assert.equal(body.status, "accepted");
  assert.equal(body.code, undefined);
  assert.equal(seen.length, 1);
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, files[0] ?? ""), "utf8"), seen[0]);
  assert.equal(JSON.stringify(body).includes(seen[0] ?? "missing"), false);
});

test("smtp dialogue sends the code without logging credentials", async () => {
  const sent: string[] = [];
  const replies = ["220 local\r\n", "250 hello\r\n", "235 ok\r\n", "250 from\r\n", "250 to\r\n", "354 go\r\n", "250 queued\r\n"];
  await smtpExchange({
    write: (chunk) => sent.push(chunk),
    read: async () => replies.shift() ?? "",
    close: () => undefined,
  }, {
    transport: "smtp",
    host: "127.0.0.1",
    port: 2525,
    from: "vector@example.test",
    user: "mailer",
    password: "local-only-secret",
    secure: false,
  }, message);
  const transcript = sent.join("");
  assert.match(transcript, /AUTH PLAIN /);
  assert.match(transcript, new RegExp(message.code));
  assert.equal(transcript.includes("local-only-secret"), false);
});

test("smtp reply is complete only on the final line", () => {
  assert.equal(smtpReplyComplete("250-smtp.mail.ru\r\n"), false);
  assert.equal(smtpReplyComplete("250-smtp.mail.ru\r\n250 AUTH PLAIN\r\n"), true);
  assert.equal(smtpReplyComplete("220 ready\r\n"), true);
});

test("smtp classifies auth and recipient failures without exposing the password", async () => {
  const plan = {
    transport: "smtp" as const,
    host: "smtp.mail.ru",
    port: 465,
    from: "vector@example.test",
    user: "mailer",
    password: "local-only-secret",
    secure: true,
  };
  await assert.rejects(
    () => smtpExchange({ write: () => undefined, read: async () => "535 denied\r\n", close: () => undefined }, plan, message),
    (error: unknown) => error instanceof DeliveryError && error.category === "auth" && !String(error).includes("local-only-secret")
  );
  const replies = ["220 local\r\n", "250 hello\r\n", "235 ok\r\n", "250 from\r\n", "550 unknown\r\n"];
  await assert.rejects(
    () => smtpExchange({
      write: () => undefined,
      read: async () => replies.shift() ?? "",
      close: () => undefined,
    }, plan, message),
    (error: unknown) => error instanceof DeliveryError && error.category === "recipient"
  );
});

test("smtp test command does not connect or print the password", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vector-smtp-"));
  const envFile = path.join(directory, "smtp.env");
  fs.writeFileSync(envFile, [
    "AUTH_EMAIL_TRANSPORT=smtp",
    "SMTP_HOST=smtp.mail.ru",
    "SMTP_PORT=465",
    "SMTP_SECURE=true",
    "SMTP_USER=vector@mail.ru",
    "SMTP_FROM=vector@mail.ru",
    "SMTP_PASSWORD=super-secret-value",
    "SMTP_TEST_TO=student@example.test",
    "",
  ].join("\n"));
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "scripts/smtp-mailru-test.mjs",
    "--env-file",
    envFile,
  ], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8" });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.status, 0);
  assert.match(output, /не отправлялось/);
  assert.equal(output.includes("super-secret-value"), false);
});
