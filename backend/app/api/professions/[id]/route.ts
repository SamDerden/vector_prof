
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { loadRuntimeCatalog } from "@/lib/runtime-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  _request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const runtime = loadRuntimeCatalog();
    const catalogProfession = runtime.catalog.professions.find((item) => item.profession_id === id);
    if (catalogProfession) {
      let storedId: string | null = null;
      try {
        const stored = await query<{ id: string }>(
          "SELECT id::text AS id FROM professions WHERE external_id = $1 LIMIT 1",
          [catalogProfession.profession_id]
        );
        storedId = stored.rows[0]?.id ?? null;
      } catch {
        storedId = null;
      }
      return NextResponse.json({
        data: {
          id: storedId,
          external_id: catalogProfession.profession_id,
          title: catalogProfession.name,
          description: catalogProfession.what_kid_does,
          industry_name: catalogProfession.industry_name,
          riasec: catalogProfession.riasec_profile,
          demand_level_region: catalogProfession.demand_level,
          salary_median_region: catalogProfession.salary_median_rub,
          vacancies_count: catalogProfession.vacancies_count,
          source: runtime.origin,
          skills: catalogProfession.skills.map((skill) => ({
            skill_id: skill.skill_id,
            name: skill.name,
            type: skill.type ?? null,
            description_kid: skill.description_kid ?? null,
            importance: skill.importance ?? null,
          })),
          education_programs: catalogProfession.programs.map((program) => ({
            program_id: program.program_id,
            title: program.name,
            level: program.level ?? null,
            specialty_code: program.specialty_code ?? null,
            duration_years: program.duration_years ?? null,
            organization_name: program.organization_name ?? program.organization?.name ?? null,
            fit_level: program.fit_level ?? null,
          })),
          trials: catalogProfession.trials.map((trial) => ({
            trial_id: trial.trial_id,
            title: trial.title,
            description: trial.description_1_4 ?? null,
            format: trial.format ?? null,
            duration_minutes: trial.duration_minutes ?? null,
            age_min: trial.age_min ?? null,
            age_max: trial.age_max ?? null,
            municipality: trial.municipality ?? null,
            cost: trial.cost ?? null,
            source_url: trial.source_url ?? null,
            organization_name: trial.organization_name ?? trial.organization?.name ?? null,
          })),
          vacancy_history: [],
        },
      });
    }

    // UUID rows that predate the freeze stay readable when PostgreSQL has them.
    // 1. Основная информация о профессии
    // Поддерживаем внешний ID Алисы (prof_001)
    // и внутренний UUID PostgreSQL.

    const professionResult = await query(
      `
      SELECT
        p.id,
        p.external_id,
        p.title,
        p.description,
        i.name AS industry_name,
        p.riasec,
        p.demand_level_region,
        p.salary_median_region,
        p.vacancies_count
      FROM professions p
      LEFT JOIN industries i
        ON p.industry_id = i.id
      WHERE
        p.external_id = $1
        OR p.id::text = $1
      LIMIT 1
      `,
      [id]
    );

    if (professionResult.rows.length === 0) {
      return NextResponse.json(
        { error: "Profession not found" },
        { status: 404 }
      );
    }

    const profession = professionResult.rows[0];
    const professionId = profession.id;

    // 2. Навыки профессии

    const skillsResult = await query(
      `
      SELECT
        s.external_id AS skill_id,
        s.name,
        s.type,
        s.description_kid,
        ps.importance
      FROM profession_skills ps
      JOIN skills s
        ON ps.skill_id = s.id
      WHERE ps.profession_id = $1
      ORDER BY
        ps.importance DESC NULLS LAST,
        s.name ASC
      `,
      [professionId]
    );

    // 3. Образовательные программы

    const programsResult = await query(
      `
      SELECT
        ep.external_id AS program_id,
        ep.title,
        ep.institution,
        ep.level,
        ep.specialty_code,
        ep.duration_years,
        o.name AS organization_name,
        pp.fit_level
      FROM program_professions pp
      JOIN education_programs ep
        ON pp.program_id = ep.id
      LEFT JOIN organizations o
        ON ep.organization_id = o.id
      WHERE pp.profession_id = $1
      ORDER BY ep.title ASC
      `,
      [professionId]
    );

    // 4. Профессиональные пробы

    const trialsResult = await query(
      `
      SELECT
        pt.external_id AS trial_id,
        pt.title,
        pt.description,
        pt.format,
        pt.duration_minutes,
        pt.age_min,
        pt.age_max,
        pt.municipality,
        pt.cost,
        pt.source_url,
        o.name AS organization_name,
        tp.skills_checked
      FROM trial_professions tp
      JOIN professional_trials pt
        ON tp.trial_id = pt.id
      LEFT JOIN organizations o
        ON pt.organization_id = o.id
      WHERE tp.profession_id = $1
        AND pt.is_active = TRUE
      ORDER BY pt.title ASC
      `,
      [professionId]
    );

    // 5. История вакансий

    const vacanciesResult = await query(
      `
      SELECT
        snapshot_date,
        vacancies_count,
        salary_median,
        source_external_id
      FROM vacancy_snapshots
      WHERE profession_id = $1
      ORDER BY snapshot_date DESC
      `,
      [professionId]
    );

    // 6. Формируем единую карточку

    return NextResponse.json({
      data: {
        ...profession,
        skills: skillsResult.rows,
        education_programs: programsResult.rows,
        trials: trialsResult.rows,
        vacancy_history: vacanciesResult.rows
      }
    });

  } catch (error) {
    console.error(
      "Failed to fetch profession details:",
      error
    );

    return NextResponse.json(
      { error: "Failed to fetch profession details" },
      { status: 500 }
    );
  }
}
