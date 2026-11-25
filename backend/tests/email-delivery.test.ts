import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAccountApi, createMemoryAccountStore } from "../lib/auth/account-api.ts";
import { createEmailDelivery, emailTransportPlan, productionDeliveryReady, smtpExchange, type EmailMessage } from "../lib/auth/email-delivery.ts";
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
