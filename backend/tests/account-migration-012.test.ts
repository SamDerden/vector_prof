import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(new URL("../migrations/012_account_auth.sql", import.meta.url), "utf8");
const earlier = fs.readFileSync(new URL("../migrations/001_initial_schema.sql", import.meta.url), "utf8");

test("account migration is additive and does not delete existing rows", () => {
  const statements = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(statements, /^\s*(DROP|DELETE|TRUNCATE|UPDATE)\b/im);
  assert.doesNotMatch(statements, /\bALTER COLUMN\b/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS accounts/);
  assert.match(sql, /email TEXT NOT NULL UNIQUE/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auth_sessions[\s\S]*ON DELETE CASCADE/);
  assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auth_challenges[\s\S]*ON DELETE CASCADE/);
  assert.match(sql, /purpose TEXT NOT NULL CHECK \(purpose IN \('verify', 'reset'\)\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts\(id\) ON DELETE SET NULL/);
  assert.match(earlier, /CREATE TABLE IF NOT EXISTS sessions/);
});
