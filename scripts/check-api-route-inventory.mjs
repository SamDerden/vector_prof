import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = path.join(root, "backend", "app", "api");
const inventoryPath = path.join(root, "docs", "API_ROUTE_INVENTORY.md");
const inventory = readFileSync(inventoryPath, "utf8");
const mainStart = inventory.indexOf("## Маршруты main");
const mainEnd = inventory.indexOf("\n## ", mainStart + 1);
if (mainStart < 0 || mainEnd < 0) {
  console.error("docs/API_ROUTE_INVENTORY.md has no main route section");
  process.exit(1);
}
const mainSection = inventory.slice(mainStart, mainEnd);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name === "route.ts" || name === "route.js") acc.push(full);
  }
  return acc;
}

const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const fromSource = [];
for (const file of walk(apiRoot)) {
  const source = readFileSync(file, "utf8");
  const relativeDir = path.relative(apiRoot, path.dirname(file)).split(path.sep);
  const segments = relativeDir.map((segment) =>
    segment.startsWith("[") && segment.endsWith("]") ? `:${segment.slice(1, -1)}` : segment
  );
  const url = `/api/${segments.join("/")}`;
  for (const method of httpMethods) {
    const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`);
    if (exported.test(source)) fromSource.push(`${method} ${url}`);
  }
}

const fromDoc = [];
for (const line of mainSection.split(/\r?\n/)) {
  const match = line.match(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|/);
  if (match) fromDoc.push(`${match[1]} ${match[2]}`);
}

const missingInDoc = fromSource.filter((route) => !fromDoc.includes(route));
const missingInSource = fromDoc.filter((route) => !fromSource.includes(route));
if (missingInDoc.length || missingInSource.length) {
  if (missingInDoc.length) console.error("handlers missing from the main table:\n" + missingInDoc.join("\n"));
  if (missingInSource.length) console.error("table rows without a handler:\n" + missingInSource.join("\n"));
  process.exit(1);
}
if (mainSection.includes("/api/auth/login/code")) {
  console.error("login-code routes are listed as available on main");
  process.exit(1);
}
console.log(`api route inventory matches ${fromSource.length} handlers`);
