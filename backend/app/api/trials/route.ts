
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import { loadRuntimeCatalog } from "@/lib/runtime-catalog";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Регион по умолчанию: Екатеринбург
  const defaultRegion = "\u0415\u043a\u0430\u0442\u0435\u0440\u0438\u043d\u0431\u0443\u0440\u0433";
  const region = searchParams.get("region") ?? defaultRegion;

  // Валидация limit: целое число от 1 до 100
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);

  if (
    rawLimit !== null &&
    rawLimit.trim() === ""
  ) {
    return jsonError("limit must be an integer between 1 and 100", 400);
  }

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return jsonError("limit must be an integer between 1 and 100", 400);
  }

  try {

    // Получаем только активные профессиональные пробы
    const result = await query(
      `
      SELECT
        t.id,
        t.title,
        t.description,
        t.format,
        t.age_min,
        t.age_max,
        t.organization_id,
        o.name AS organization_name,
        t.region_id,
        r.name AS region_name,
        t.source_id,
        t.verified_at
      FROM professional_trials t
      LEFT JOIN organizations o
        ON o.id = t.organization_id
      LEFT JOIN regions r
        ON r.id = t.region_id
      WHERE
        t.is_active = TRUE
        AND (r.name = $1 OR $1 = '')
      ORDER BY t.title
      LIMIT $2
      `,
      [region, limit]
    );

    return NextResponse.json({
      data: result.rows,
      count: result.rowCount
    });

  } catch (error) {
    try {
      const runtime = loadRuntimeCatalog();
      const open = runtime.catalog.trials.filter((trial) => (trial as { availability_status?: string }).availability_status !== "прошло");
      const data = open.slice(0, limit).map((trial) => ({
        id: null,
        trial_id: trial.trial_id,
        title: trial.title,
        description: trial.description_1_4 ?? null,
        format: trial.format ?? null,
        age_min: trial.age_min ?? null,
        age_max: trial.age_max ?? null,
        organization_name: trial.organization_name ?? trial.organization?.name ?? null,
        municipality: trial.municipality ?? null,
        source: runtime.origin,
      }));
      return NextResponse.json({ data, count: data.length, source: runtime.origin });
    } catch {
      return handleError(error);
    }
  }
}
