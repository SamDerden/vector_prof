import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

function read(name: string) {
  return fs.readFileSync(path.join(migrations, name), "utf8");
}

test("PM migration 013 stays in place and login codes are migration 014", () => {
  const files = fs.readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort();
  assert.equal(files[12], "013_pm_features.sql");
  assert.equal(files[13], "014_login_codes.sql");
  assert.equal(files.filter((file) => file.startsWith("013_")).length, 1);

  const pm = read("013_pm_features.sql");
  const login = read("014_login_codes.sql");
  const accounts = read("012_account_auth.sql");
  assert.match(pm, /CREATE TABLE IF NOT EXISTS assistant_conversations/);
  assert.match(pm, /CREATE TABLE IF NOT EXISTS feedback/);
  assert.match(accounts, /purpose IN \('verify', 'reset'\)/);
  assert.doesNotMatch(accounts, /'login'/);
  assert.match(login, /DROP CONSTRAINT IF EXISTS auth_challenges_purpose_check/);
  assert.match(login, /purpose IN \('verify', 'reset', 'login'\)/);
  assert.doesNotMatch(login.replace(/--.*$/gm, ""), /^\s*(DROP TABLE|DELETE FROM|TRUNCATE|UPDATE)\b/im);
});
