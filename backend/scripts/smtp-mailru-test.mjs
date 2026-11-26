import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deliverSmtpOnce, DeliveryError, emailTransportPlan } from "../lib/auth/email-delivery.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFlag = process.argv.indexOf("--env-file");
const envPath = path.resolve(envFlag >= 0 ? process.argv[envFlag + 1] ?? "" : path.join(root, ".env.smtp-test.local"));
const send = process.argv.includes("--send");

const required = ["AUTH_EMAIL_TRANSPORT", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_FROM", "SMTP_PASSWORD", "SMTP_TEST_TO"];

function loadEnv(file) {
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function reason(error) {
  if (error instanceof DeliveryError) {
    if (error.category === "auth") return "Авторизация отклонена. Проверьте адрес ящика и пароль внешнего приложения.";
    if (error.category === "tls") return "TLS-соединение не установлено.";
    if (error.category === "connection") return "Нет соединения с SMTP-сервером.";
    if (error.category === "limit") return "SMTP-сервер ограничил отправку. Повтор автоматически не выполняется.";
    if (error.category === "recipient") return "SMTP-сервер отклонил получателя.";
    if (error.category === "unconfigured") return "SMTP-транспорт не настроен.";
    return "SMTP-сервер вернул неожиданный ответ.";
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code ?? "") : "";
  if (code.includes("CERT") || code === "EPROTO" || code.startsWith("ERR_TLS")) return "TLS-соединение не установлено.";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ECONNRESET") {
    return "Нет соединения с SMTP-сервером.";
  }
  return "SMTP-отправка не выполнена.";
}

if (!fs.existsSync(envPath)) {
  console.error(`Файл настроек не найден: ${envPath}`);
  process.exit(2);
}

const fileEnv = loadEnv(envPath);
const missing = required.filter((key) => !String(fileEnv[key] ?? "").trim());
if (missing.length > 0) {
  console.error(`Заполните поля: ${missing.join(", ")}`);
  console.error("Отправка не выполнялась.");
  process.exit(2);
}

const env = {
  AUTH_EMAIL_TRANSPORT: fileEnv.AUTH_EMAIL_TRANSPORT,
  SMTP_HOST: fileEnv.SMTP_HOST,
  SMTP_PORT: fileEnv.SMTP_PORT,
  SMTP_SECURE: fileEnv.SMTP_SECURE,
  SMTP_USER: fileEnv.SMTP_USER,
  SMTP_FROM: fileEnv.SMTP_FROM,
  SMTP_PASSWORD: fileEnv.SMTP_PASSWORD,
};
const plan = emailTransportPlan(env);
if (plan.transport !== "smtp" || !plan.secure || plan.port !== 465) {
  console.error("Нужны AUTH_EMAIL_TRANSPORT=smtp, SMTP_SECURE=true и SMTP_PORT=465.");
  console.error("Отправка не выполнялась.");
  process.exit(2);
}

if (!send) {
  console.log("Параметры заполнены. Соединение не открывалось, письмо не отправлялось.");
  console.log("Одно письмо уйдёт только после команды с --send.");
  process.exit(0);
}

try {
  await deliverSmtpOnce(plan, {
    to: fileEnv.SMTP_TEST_TO,
    purpose: "verify",
    code: "",
    subject: "Вектор — проверка отправки",
    text: "Это тестовое письмо системы «Вектор».\r\nЕсли вы получили его, SMTP-отправка работает.\r\nНикаких действий предпринимать не нужно.",
  });
  console.log("SMTP-сервер принял одно тестовое письмо. Проверьте папки «Входящие» и «Спам»; доставку это само по себе не подтверждает.");
} catch (error) {
  console.error(reason(error));
  process.exit(1);
}
