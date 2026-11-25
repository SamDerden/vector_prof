import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import { buildFreezeIndex, describeFreezeChunks, mockVector, validateFreezeEmbeddingIndex } from "../lib/ai/freeze-embedding.ts";
import { loadRuntimeCatalog, resetRuntimeCatalogCache } from "../lib/runtime-catalog.ts";

test("freeze embedding builder describes 152 professions and keeps mock vectors out of the provider index", () => {
  resetRuntimeCatalogCache();
  const runtime = loadRuntimeCatalog();
  const described = describeFreezeChunks(runtime.catalog);
  assert.equal(described.professionCount, 152);
  assert.equal(described.indexedProfessions, 152);
  assert.deepEqual(described.missingProfessionIds, []);
  const mock = buildFreezeIndex({
    catalog: runtime.catalog,
    origin: runtime.origin,
    model: "mock-deterministic",
    dimensions: 8,
    vectorSource: "mock",
    vectors: runtime.catalog.chunks.map((chunk) => mockVector(chunk.text, 8)),
  });
  assert.equal(mock.vector_source, "mock");
  assert.ok(validateFreezeEmbeddingIndex(mock, runtime.catalog).includes("mock vectors are not provider embeddings"));
  assert.deepEqual(mockVector("same", 4), mockVector("same", 4));
  assert.notDeepEqual(mockVector("same", 4), mockVector("other", 4));

  const indexPath = new URL("../data/catalog.index.json", import.meta.url);
  const before = fs.statSync(indexPath).mtimeMs;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/build-embedding-index.mjs", "--dry-run"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { professionCount: number; network: boolean; chunkCount: number };
  assert.equal(report.professionCount, 152);
  assert.equal(report.network, false);
  assert.ok(report.chunkCount >= 152);
  assert.equal(fs.statSync(indexPath).mtimeMs, before);
});
