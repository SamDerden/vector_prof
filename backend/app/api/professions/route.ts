import { NextResponse } from "next/server";

import { query } from "@/lib/db";
import { loadRuntimeCatalog, publicProfessionRows } from "@/lib/runtime-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const runtime = loadRuntimeCatalog();
  const data = publicProfessionRows(runtime);
  try {
    const ids = data.map((profession) => profession.profession_id);
    const stored = await query(
      "SELECT id::text AS id, external_id FROM professions WHERE external_id = ANY($1::text[])",
      [ids]
    );
    const uuids = new Map(stored.rows.map((row) => [String(row.external_id), String(row.id)]));
    for (const profession of data) {
      const id = uuids.get(profession.profession_id);
      if (id) profession.id = id;
    }
  } catch {
    // The freeze catalog is the source of truth. A missing or older professions table must not hide it.
  }
  return NextResponse.json({
    data,
    count: data.length,
    source: runtime.origin,
  });
}
