import { test } from "node:test";
import assert from "node:assert/strict";
import { rollBonus, computeAttackDamage, damageForTier, isAttackSkill } from "../module/combat/combat-damage.mjs";

test("isAttackSkill — only импульс/восприятие count (extensible tail for magic later)", () => {
  assert.equal(isAttackSkill("impulse"), true);
  assert.equal(isAttackSkill("sensorics"), true);
  assert.equal(isAttackSkill("logic"), false);
  assert.equal(isAttackSkill("agility"), false);
  assert.equal(isAttackSkill(undefined), false);
});

test("rollBonus = ceil(roll / 20) — bonus comes from the ROLL, not the skill", () => {
  assert.equal(rollBonus(5), 1);    // 05 → +1 (the screenshot case)
  assert.equal(rollBonus(20), 1);   // band edge 01–20 → +1
  assert.equal(rollBonus(21), 2);   // 21–40 → +2
  assert.equal(rollBonus(48), 3);
  assert.equal(rollBonus(95), 5);
});

test("rollBonus floors non-positive / blank / non-numeric to 0", () => {
  for (const v of [0, -10, null, undefined, "", NaN, "abc"]) {
    assert.equal(rollBonus(v), 0, `rollBonus(${String(v)})`);
  }
});

test("rollBonus with divisor 10 (Dodge, book: ловкость/10 — twice as steep as Fortitude's ÷20)", () => {
  assert.equal(rollBonus(5, 10), 1);    // 01–10 → +1
  assert.equal(rollBonus(10, 10), 1);
  assert.equal(rollBonus(11, 10), 2);   // 11–20 → +2
  assert.equal(rollBonus(48, 10), 5);
  assert.equal(rollBonus(95, 10), 10);
});

test("damage ladder — base 4, roll 05 (bonus 1) → success 5", () => {
  const p = { base: 4, roll: 5 };
  assert.equal(computeAttackDamage({ ...p, outcome: "fiasco" }), 1);
  assert.equal(computeAttackDamage({ ...p, outcome: "fail" }), 4);   // no bonus
  assert.equal(computeAttackDamage({ ...p, outcome: "success" }), 5); // 4 + 1
  assert.equal(computeAttackDamage({ ...p, outcome: "triumph" }), 9); // 4 + 1 + 4
});

test("higher roll under skill → bigger bonus (base 4, roll 48 → success 7)", () => {
  assert.equal(computeAttackDamage({ base: 4, roll: 48, outcome: "success" }), 7);  // 4 + 3
  assert.equal(computeAttackDamage({ base: 4, roll: 48, outcome: "triumph" }), 11); // 4 + 3 + 4
});

test("damageForTier — tier-only core off a precomputed bonus", () => {
  assert.equal(damageForTier({ base: 4, bonus: 1, outcome: "success" }), 5);
  assert.equal(damageForTier({ base: 4, bonus: 1, outcome: "triumph" }), 9);
  assert.equal(damageForTier({ base: 4, bonus: 3, outcome: "fail" }), 4); // bonus ignored on fail
  assert.throws(() => damageForTier({ base: 4, bonus: 1, outcome: "nope" }));
});

test("fiasco is always exactly 1; floor 1 on a landed hit even at base 0", () => {
  assert.equal(computeAttackDamage({ base: 99, roll: 95, outcome: "fiasco" }), 1);
  assert.equal(computeAttackDamage({ base: 0, roll: 0, outcome: "fail" }), 1);
  assert.equal(computeAttackDamage({ base: 0, roll: 0, outcome: "success" }), 1);
});
