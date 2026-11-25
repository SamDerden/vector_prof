import assert from "node:assert/strict";
import test from "node:test";

import { planProfessionSync, summarizePlan, type ExistingProfession } from "../lib/freeze-profession-sync.ts";
import { loadRuntimeCatalog, resetRuntimeCatalogCache } from "../lib/runtime-catalog.ts";

const preserved: ExistingProfession = {
  id: "11111111-1111-4111-8111-111111111111",
  externalId: "prof_016",
  title: "Служебная профессия вне freeze",
  description: null,
  graphProfessionId: "prof_016",
};

test("freeze sync keeps existing UUIDs, inserts the rest once, and preserves professions outside the freeze", () => {
  resetRuntimeCatalogCache();
  const freeze = loadRuntimeCatalog().catalog.professions.map((profession) => ({
    professionId: profession.profession_id,
    name: profession.name,
    description: profession.what_kid_does || null,
  }));
  assert.equal(freeze.length, 152);
  const known = freeze.find((item) => item.professionId === "prof_004");
  assert.ok(known);
  const existing: ExistingProfession[] = [
    preserved,
    {
      id: "22222222-2222-4222-8222-222222222222",
      externalId: "prof_004",
      title: known.name,
      description: known.description,
      graphProfessionId: "prof_004",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      externalId: null,
      title: freeze.find((item) => item.professionId === "prof_005")?.name ?? "",
      description: null,
      graphProfessionId: null,
    },
  ];
  const plan = planProfessionSync(existing, freeze);
  const summary = summarizePlan(plan);
  assert.deepEqual(summary.conflicts, []);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.attach, 1);
  assert.equal(summary.insert, 150);
  assert.deepEqual(plan.preserved.map((row) => row.externalId), ["prof_016"]);

  const projected: ExistingProfession[] = existing.map((row) => ({ ...row }));
  let sequence = 0;
  for (const action of plan.actions) {
    if (action.kind === "insert") {
      sequence += 1;
      projected.push({
        id: `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`,
        externalId: action.professionId,
        title: action.title,
        description: action.description,
        graphProfessionId: action.professionId,
      });
    } else if (action.kind === "attach" || action.kind === "update") {
      const row = projected.find((item) => item.id === action.id);
      if (!row) continue;
      if (action.kind === "attach") row.externalId = action.professionId;
      row.title = action.title;
      row.description = action.description;
      if (action.setGraph) row.graphProfessionId = action.professionId;
    }
  }
  const again = summarizePlan(planProfessionSync(projected, freeze));
  assert.deepEqual(again.conflicts, []);
  assert.equal(again.insert, 0);
  assert.equal(again.attach, 0);
  assert.equal(again.update, 0);
  assert.equal(again.conflict, 0);
  assert.equal(again.unchanged, 152);
  assert.equal(again.preserved, 1);
});
