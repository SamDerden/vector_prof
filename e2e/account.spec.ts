import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const password = "correct-horse-battery";

function verificationCode(email: string) {
  const name = createHash("sha256").update(`verify:${email}`).digest("hex").slice(0, 16);
  const file = path.join("backend", ".auth-dev-outbox", `verify-${name}.txt`);
  return fs.readFileSync(file, "utf8").trim();
}

test("register, verify, login, reload and logout stay on the same account", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;
  await page.goto("/account");
  await page.getByRole("tab", { name: "Регистрация" }).click();
  await page.locator("#account-register-email").fill(email);
  await page.locator("#account-register-password").fill(password);
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await expect(page.getByText("Запрос принят")).toBeVisible();
  await page.getByRole("button", { name: "Ввести код подтверждения →" }).click();
  await page.locator("#account-code").fill(verificationCode(email));
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page.getByRole("heading", { name: "Вход в аккаунт" })).toBeVisible();
  await page.locator("#account-login-email").fill(email);
  await page.locator("#account-login-password").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(email.split("@")[0]) })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: new RegExp(email.split("@")[0]) })).toBeVisible();
  const logout = await page.evaluate(async () => {
    const token = document.cookie.split("; ").find((item) => item.startsWith("vector_csrf="))?.split("=")[1] ?? "";
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "" },
      credentials: "include",
      body: "{}",
    });
    return { status: response.status, hadToken: token.length > 0 };
  });
  expect(logout.hadToken).toBe(true);
  expect(logout.status).toBe(403);
  await page.getByRole("button", { name: "Выйти из аккаунта" }).click();
  await expect(page.getByRole("heading", { name: "Вход в аккаунт" })).toBeVisible();
});

test("accounts do not see each other and the catalog API stays on the freeze", async ({ playwright }) => {
  const catalog = await playwright.request.newContext();
  const professions = await catalog.get("http://127.0.0.1:3100/api/professions");
  expect(professions.status()).toBe(200);
  const body = await professions.json();
  expect(body.source).toBe("data_freeze_1");
  expect(body.count).toBe(152);
  expect(body.data).toHaveLength(152);
  await catalog.dispose();

  async function signIn(email: string) {
    const context = await playwright.request.newContext();
    const registered = await context.post("http://127.0.0.1:3100/api/auth/register", { data: { email, password } });
    expect(registered.status()).toBe(202);
    const verified = await context.post("http://127.0.0.1:3100/api/auth/verify", {
      data: { email, code: verificationCode(email) },
    });
    expect(verified.status()).toBe(200);
    const login = await context.post("http://127.0.0.1:3100/api/auth/login", { data: { email, password } });
    expect(login.ok()).toBe(true);
    return context;
  }

  const stamp = Date.now();
  const first = await signIn(`e2e-a-${stamp}@example.test`);
  const second = await signIn(`e2e-b-${stamp}@example.test`);
  const firstAccount = await (await first.get("http://127.0.0.1:3100/api/account")).json();
  const secondAccount = await (await second.get("http://127.0.0.1:3100/api/account")).json();
  expect(firstAccount.user.email).toBe(`e2e-a-${stamp}@example.test`);
  expect(secondAccount.user.email).toBe(`e2e-b-${stamp}@example.test`);
  expect(firstAccount.sessions).toEqual([]);
  expect(secondAccount.sessions).toEqual([]);
  const anonymous = await (await playwright.request.newContext()).get("http://127.0.0.1:3100/api/account");
  expect(anonymous.status()).toBe(401);
  await first.dispose();
  await second.dispose();
});
