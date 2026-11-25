import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFreezeIndex, describeFreezeChunks, mockVector, validateFreezeEmbeddingIndex } from "../lib/ai/freeze-embedding.ts";
import { loadRuntimeCatalog } from "../lib/runtime-catalog.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = loadRuntimeCatalog(root);
const catalog = runtime.catalog;
const described = describeFreezeChunks(catalog);
const dryRun = process.argv.includes("--dry-run");
const apply = process.argv.includes("--apply");
const mockFlag = process.argv.indexOf("--mock-out");
const mockOut = mockFlag >= 0 ? process.argv[mockFlag + 1] : "";

if (!dryRun && !apply && !mockOut) {
  console.error("Refusing to call the embedding gateway. Use --dry-run, --mock-out <file>, or --apply.");
  process.exit(2);
}

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    origin: runtime.origin,
    catalogVersion: described.catalogVersion,
    professionCount: described.professionCount,
    chunkCount: described.chunkCount,
    indexedProfessions: described.indexedProfessions,
    missingProfessions: described.missingProfessionIds.length,
    model: "EmbeddingsGigaR",
    dimensions: 2560,
    network: false,
  }));
  process.exit(0);
}

const chunks = catalog.chunks ?? [];
let vectors;
let model;
let source;
let dimensions;
if (mockOut) {
  dimensions = 8;
  model = "mock-deterministic";
  source = "mock";
  vectors = chunks.map((chunk) => mockVector(chunk.text, dimensions));
} else {
  const base = (process.env.LLM_BASE_URL || process.env.AI_API_BASE_URL || "").replace(/\/+$/, "");
  const key = process.env.LLM_API_KEY || process.env.AI_API_KEY;
  model = process.env.LLM_EMBEDDINGS_MODEL || "";
  if (!base || !key || model !== "EmbeddingsGigaR") {
    throw new Error("Refusing --apply without the configured EmbeddingsGigaR gateway.");
  }
  source = "provider";
  vectors = [];
  for (let offset = 0; offset < chunks.length; offset += 16) {
    const batch = chunks.slice(offset, offset + 16);
    const response = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: batch.map((chunk) => chunk.text) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Embeddings API HTTP ${response.status}`);
    const result = await response.json();
    const rows = Array.isArray(result.data) ? [...result.data].sort((left, right) => left.index - right.index) : [];
    if (rows.length !== batch.length) throw new Error("Embedding count mismatch");
    vectors.push(...rows.map((row) => row.embedding));
  }
  dimensions = vectors[0]?.length ?? 0;
}

const index = buildFreezeIndex({
  catalog,
  origin: runtime.origin,
  model,
  dimensions,
  vectorSource: source,
  vectors,
});
const problems = validateFreezeEmbeddingIndex(index, catalog).filter((problem) => problem !== "mock vectors are not provider embeddings" || source === "provider");
if (source === "provider" && problems.length > 0) throw new Error(`Index validation failed: ${problems.join(", ")}`);
if (source === "mock" && problems.some((problem) => problem !== "mock vectors are not provider embeddings")) {
  throw new Error(`Mock index validation failed: ${problems.join(", ")}`);
}

const target = path.resolve(root, mockOut || "data/catalog.index.json");
const relativeTarget = path.relative(root, target);
if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
  throw new Error("Index output must stay inside the backend directory.");
}
if (source === "mock" && target.endsWith(`${path.sep}data${path.sep}catalog.index.json`)) {
  throw new Error("Refusing to replace the provider index with mock vectors.");
}
const temporary = `${target}.tmp`;
const previous = `${target}.previous`;
await fs.writeFile(temporary, JSON.stringify(index));
const written = JSON.parse(await fs.readFile(temporary, "utf8"));
if (written.catalog_version !== catalog.version || written.entries.length !== chunks.length) {
  await fs.rm(temporary, { force: true });
  throw new Error("Temporary index failed verification.");
}
if (source === "provider") {
  await fs.rm(previous, { force: true });
  await fs.rename(target, previous).catch(() => undefined);
}
try {
  await fs.rename(temporary, target);
} catch (error) {
  if (source === "provider") await fs.rename(previous, target).catch(() => undefined);
  throw error;
}
console.log(JSON.stringify({
  wrote: path.relative(root, target),
  vectorSource: source,
  professionCount: index.profession_count,
  chunkCount: index.chunk_count,
  dimensions: index.dimensions,
  model: index.embedding_model,
}));
