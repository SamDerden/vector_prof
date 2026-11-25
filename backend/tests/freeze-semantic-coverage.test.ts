import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assessEmbeddingIndex,
  embeddingStartupPlan,
  embeddingVectorsUsable,
} from "../lib/ai/index-contract.ts";
import { loadRuntimeCatalog, resetRuntimeCatalogCache } from "../lib/runtime-catalog.ts";

const index = JSON.parse(fs.readFileSync(new URL("../data/catalog.index.json", import.meta.url), "utf8")) as {
  catalog_version: string;
  model?: string;
  dimensions: number;
  entries: Array<{ type: string; vector?: number[]; metadata?: { profession_id?: string } }>;
};
const legacy = JSON.parse(fs.readFileSync(new URL("../data/catalog.normalized.json", import.meta.url), "utf8")) as {
  version: string;
  professions: Array<{ profession_id: string }>;
};

test("EmbeddingsGigaR index covers the legacy snapshot and not the 152-profession freeze", () => {
  resetRuntimeCatalogCache();
  const runtime = loadRuntimeCatalog();
  const indexed = new Set(
    index.entries.flatMap((entry) => entry.metadata?.profession_id ? [entry.metadata.profession_id] : [])
  );
  const freezeIds = new Set(runtime.catalog.professions.map((profession) => profession.profession_id));
  const outside = [...indexed].filter((id) => !freezeIds.has(id)).sort();

  assert.equal(index.model, "EmbeddingsGigaR");
  assert.equal(index.dimensions, 2560);
  assert.equal(index.entries.length, 71);
  assert.equal(index.entries.filter((entry) => entry.type === "profession_core").length, 30);
  assert.equal(indexed.size, 30);
  assert.equal(index.catalog_version, legacy.version);
  assert.notEqual(index.catalog_version, runtime.catalog.version);
  assert.equal(runtime.origin, "data_freeze_1");
  assert.equal(runtime.catalog.professions.length, 152);
  assert.deepEqual(outside, ["prof_016", "prof_028", "prof_029"]);
  assert.equal([...freezeIds].filter((id) => !indexed.has(id)).length, 125);
  assert.equal(embeddingVectorsUsable({
    catalogVersionMatches: false,
    recordedModel: "EmbeddingsGigaR",
    configuredModel: "EmbeddingsGigaR",
    allowMock: false,
    vectors: [index.entries[0]?.vector ?? []],
  }), false);

  const decision = assessEmbeddingIndex({
    index,
    catalogVersion: runtime.catalog.version,
    chunkCount: runtime.catalog.chunks.length,
    configuredModel: "EmbeddingsGigaR",
  });
  assert.equal(decision.action, "rebuild");
  assert.equal(embeddingStartupPlan({ origin: "data_freeze_1", decision }), "incomplete-lexical");
  assert.equal(embeddingStartupPlan({
    origin: "data_freeze_1",
    decision: { action: "refuse", reason: "model unset" },
  }), "incomplete-lexical");
  assert.equal(embeddingStartupPlan({ origin: "legacy_normalized", decision }), "rebuild-legacy");
});
