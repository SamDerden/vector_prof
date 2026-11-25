export type ExistingProfession = {
  id: string;
  externalId: string | null;
  title: string;
  description: string | null;
  graphProfessionId: string | null;
};

export type FreezeProfession = {
  professionId: string;
  name: string;
  description: string | null;
};

export type SyncAction =
  | { kind: "insert"; professionId: string; title: string; description: string | null }
  | { kind: "update"; professionId: string; id: string; title: string; description: string | null; setGraph: boolean }
  | { kind: "attach"; professionId: string; id: string; title: string; description: string | null; setGraph: boolean }
  | { kind: "unchanged"; professionId: string; id: string }
  | { kind: "conflict"; professionId: string; reason: string };

export type SyncPlan = {
  actions: SyncAction[];
  preserved: Array<{ id: string; externalId: string | null; title: string }>;
};

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

function titleKey(value: string) {
  return value.trim().toLocaleLowerCase("ru");
}

function push(map: Map<string, ExistingProfession[]>, key: string, row: ExistingProfession) {
  map.set(key, [...(map.get(key) ?? []), row]);
}

/** Plan inserts and in-place updates. Existing UUIDs stay put, and rows outside the freeze are not deleted. */
export function planProfessionSync(existing: ExistingProfession[], freeze: FreezeProfession[]): SyncPlan {
  const freezeIds = new Set(freeze.map((item) => item.professionId));
  if (freezeIds.size !== freeze.length) throw new Error("Freeze profession ids are not unique");
  const titleGroups = new Map<string, string[]>();
  for (const item of freeze) {
    const key = titleKey(item.name);
    titleGroups.set(key, [...(titleGroups.get(key) ?? []), item.professionId]);
  }
  const duplicateTitles = new Set(
    [...titleGroups.values()].filter((ids) => ids.length > 1).flat()
  );
  const byExternal = new Map<string, ExistingProfession[]>();
  const byGraph = new Map<string, ExistingProfession[]>();
  const byTitle = new Map<string, ExistingProfession[]>();
  for (const row of existing) {
    if (row.externalId) push(byExternal, row.externalId, row);
    if (row.graphProfessionId) push(byGraph, row.graphProfessionId, row);
    push(byTitle, titleKey(row.title), row);
  }

  const actions: SyncAction[] = [];
  const consumed = new Set<string>();
  for (const item of freeze) {
    if (duplicateTitles.has(item.professionId)) {
      actions.push({ kind: "conflict", professionId: item.professionId, reason: "duplicate title in freeze" });
      continue;
    }
    const external = byExternal.get(item.professionId) ?? [];
    if (external.length > 1) {
      actions.push({ kind: "conflict", professionId: item.professionId, reason: "duplicate external_id" });
      continue;
    }
    const graphOwners = byGraph.get(item.professionId) ?? [];
    if (external.length === 1) {
      const row = external[0];
      const graphBlocked = graphOwners.some((owner) => owner.id !== row.id)
        || (row.graphProfessionId !== null && row.graphProfessionId !== item.professionId);
      const sameTitle = titleKey(row.title) === titleKey(item.name);
      const titleBlocked = !sameTitle && (byTitle.get(titleKey(item.name)) ?? []).some((owner) => owner.id !== row.id);
      if (graphBlocked) {
        actions.push({ kind: "conflict", professionId: item.professionId, reason: "graph id belongs to another row" });
        continue;
      }
      if (titleBlocked) {
        actions.push({ kind: "conflict", professionId: item.professionId, reason: "title belongs to another row" });
        continue;
      }
      consumed.add(row.id);
      const setGraph = row.graphProfessionId === null;
      const textChanged = row.title !== item.name || (row.description ?? null) !== (item.description ?? null);
      if (!setGraph && !textChanged) actions.push({ kind: "unchanged", professionId: item.professionId, id: row.id });
      else actions.push({ kind: "update", professionId: item.professionId, id: row.id, title: item.name, description: item.description, setGraph });
      continue;
    }
    const titled = byTitle.get(titleKey(item.name)) ?? [];
    if (titled.length > 1) {
      actions.push({ kind: "conflict", professionId: item.professionId, reason: "title matches several rows" });
      continue;
    }
    if (titled.length === 1) {
      const row = titled[0];
      if (row.externalId && row.externalId !== item.professionId) {
        actions.push({ kind: "conflict", professionId: item.professionId, reason: "title already has another external_id" });
        continue;
      }
      if (graphOwners.some((owner) => owner.id !== row.id) || (row.graphProfessionId !== null && row.graphProfessionId !== item.professionId)) {
        actions.push({ kind: "conflict", professionId: item.professionId, reason: "graph id belongs to another row" });
        continue;
      }
      consumed.add(row.id);
      actions.push({ kind: "attach", professionId: item.professionId, id: row.id, title: item.name, description: item.description, setGraph: row.graphProfessionId === null });
      continue;
    }
    if (graphOwners.length > 0) {
      actions.push({ kind: "conflict", professionId: item.professionId, reason: "graph id belongs to another row" });
      continue;
    }
    actions.push({ kind: "insert", professionId: item.professionId, title: item.name, description: item.description });
  }

  return {
    actions,
    preserved: existing.filter((row) => !consumed.has(row.id)).map((row) => ({
      id: row.id,
      externalId: row.externalId,
      title: row.title,
    })),
  };
}

export function summarizePlan(plan: SyncPlan) {
  const count = (kind: SyncAction["kind"]) => plan.actions.filter((action) => action.kind === kind).length;
  return {
    insert: count("insert"),
    update: count("update"),
    attach: count("attach"),
    unchanged: count("unchanged"),
    conflict: count("conflict"),
    preserved: plan.preserved.length,
    conflicts: plan.actions.flatMap((action) => action.kind === "conflict"
      ? [{ professionId: action.professionId, reason: action.reason }]
      : []),
  };
}

export async function applyProfessionSync(db: Queryable, plan: SyncPlan) {
  const inserted: string[] = [];
  let updated = 0;
  let attached = 0;
  for (const action of plan.actions) {
    if (action.kind === "insert") {
      const result = await db.query(
        `INSERT INTO professions (external_id, title, description, graph_profession_id)
         VALUES ($1, $2, $3, $1)
         RETURNING id::text AS id`,
        [action.professionId, action.title, action.description]
      );
      inserted.push(String(result.rows[0]?.id ?? ""));
    } else if (action.kind === "update") {
      await db.query(
        `UPDATE professions
            SET title = $2,
                description = $3,
                graph_profession_id = CASE WHEN $4::boolean THEN COALESCE(graph_profession_id, $5) ELSE graph_profession_id END
          WHERE id = $1
            AND external_id = $5`,
        [action.id, action.title, action.description, action.setGraph, action.professionId]
      );
      updated += 1;
    } else if (action.kind === "attach") {
      await db.query(
        `UPDATE professions
            SET external_id = $2,
                title = $3,
                description = $4,
                graph_profession_id = CASE WHEN $5::boolean THEN COALESCE(graph_profession_id, $2) ELSE graph_profession_id END
          WHERE id = $1
            AND external_id IS NULL`,
        [action.id, action.professionId, action.title, action.description, action.setGraph]
      );
      attached += 1;
    }
  }
  return { inserted, updated, attached };
}
