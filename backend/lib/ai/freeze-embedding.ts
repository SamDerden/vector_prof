import { createHash } from "node:crypto";

import type { NormalizedCatalog } from "./catalog.ts";

export const FREEZE_INDEX_SCHEMA = "freeze_embedding_v1";
export const FREEZE_EMBEDDING_DIMENSIONS = 2560;

export type FreezeIndexEntry = {
  chunkId: string;
  type: string;
  vector: number[];
  metadata: Record<string, unknown>;
};

export type FreezeEmbeddingIndex = {
  schema_version: typeof FREEZE_INDEX_SCHEMA;
  catalog_version: string;
  catalog_origin: string;
  embedding_model: string;
  dimensions: number;
  profession_count: number;
  chunk_count: number;
  vector_source: "provider" | "mock";
  entries: FreezeIndexEntry[];
};

export function describeFreezeChunks(catalog: NormalizedCatalog) {
  const chunks = catalog.chunks ?? [];
  const professionIds = new Set(
    chunks.flatMap((chunk) => {
      const id = chunk.metadata?.profession_id;
      return chunk.type === "profession_core" && typeof id === "string" ? [id] : [];
    })
  );
  return {
    catalogVersion: catalog.version,
    professionCount: catalog.professions.length,
    chunkCount: chunks.length,
    indexedProfessions: professionIds.size,
    missingProfessionIds: catalog.professions
      .map((profession) => profession.profession_id)
      .filter((id) => !professionIds.has(id)),
  };
}

/** Deterministic local vector. It is not an EmbeddingsGigaR vector. */
export function mockVector(text: string, dimensions = 8): number[] {
  const digest = createHash("sha256").update(text).digest();
  return Array.from({ length: dimensions }, (_, index) => {
    const byte = digest[index % digest.length] ?? 0;
    return Number(((byte / 255) * 2 - 1).toFixed(6));
  });
}

export function buildFreezeIndex(input: {
  catalog: NormalizedCatalog;
  origin: string;
  model: string;
  dimensions: number;
  vectorSource: "provider" | "mock";
  vectors: number[][];
}): FreezeEmbeddingIndex {
  const chunks = input.catalog.chunks ?? [];
  if (input.vectors.length !== chunks.length) throw new Error("Embedding count mismatch");
  const entries = chunks.map((chunk, index) => {
    const vector = input.vectors[index] ?? [];
    if (vector.length !== input.dimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new Error("Invalid embedding vector");
    }
    const professionId = chunk.metadata?.profession_id;
    const industryId = chunk.metadata?.industry_id;
    const suffix = typeof professionId === "string" ? professionId : typeof industryId === "string" ? industryId : String(index);
    return {
      chunkId: `${chunk.type}:${suffix}`,
      type: chunk.type,
      vector,
      metadata: { ...chunk.metadata, text_preview: chunk.text },
    };
  });
  return {
    schema_version: FREEZE_INDEX_SCHEMA,
    catalog_version: input.catalog.version,
    catalog_origin: input.origin,
    embedding_model: input.model,
    dimensions: input.dimensions,
    profession_count: input.catalog.professions.length,
    chunk_count: entries.length,
    vector_source: input.vectorSource,
    entries,
  };
}

export function validateFreezeEmbeddingIndex(index: FreezeEmbeddingIndex, catalog: NormalizedCatalog) {
  const described = describeFreezeChunks(catalog);
  const problems: string[] = [];
  if (index.schema_version !== FREEZE_INDEX_SCHEMA) problems.push("schema");
  if (index.catalog_version !== catalog.version) problems.push("catalog version");
  if (index.profession_count !== described.professionCount) problems.push("profession count");
  if (index.chunk_count !== described.chunkCount || index.entries.length !== described.chunkCount) problems.push("chunk count");
  if (described.missingProfessionIds.length > 0) problems.push("missing profession chunks");
  if (index.vector_source === "provider" && index.dimensions !== FREEZE_EMBEDDING_DIMENSIONS) problems.push("dimensions");
  if (index.vector_source === "mock") problems.push("mock vectors are not provider embeddings");
  const indexed = new Set(index.entries.flatMap((entry) => {
    const id = entry.metadata.profession_id;
    return entry.type === "profession_core" && typeof id === "string" ? [id] : [];
  }));
  if ([...indexed].some((id) => !catalog.professions.some((profession) => profession.profession_id === id))) {
    problems.push("index contains a profession outside the catalog");
  }
  return problems;
}
