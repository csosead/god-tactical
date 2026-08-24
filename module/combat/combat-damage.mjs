/**
 * GOD Tactical — Attack damage (COMBAT-REDESIGN)
 * Pure, Foundry-free computation of an attack's damage under the redesigned model
 * (see repo COMBAT-REDESIGN.md). Damage is a CLASS property (`base`) plus a bonus derived
 * from the KEPT d100 ROLL result (not the skill value), gated by the roll's outcome tier —
 * NOT the retired per-weapon `damage1..4` / ones-digit lookup. Kept dependency-free so it's
 * unit-testable without a live canvas (tests/combat-damage.test.mjs).
 *
 * Ladder (base B, bonus b = ceil(roll / 20) — the bonus rises the higher you roll WITHOUT
 * busting your skill; a fail rolled ABOVE skill gets no bonus):
 *   fiasco  → 1          (a hit gone bad — the only tier that dips below base)
 *   fail    → B          (rolled above skill → no bonus)
 *   success → B + ceil(roll/20)
 *   triumph → B + b + B  (an extra base on top. NOTE: the live attack flow feeds the SKILL's
 *                         MAX bonus as `b` here — ceil(skill/20), "peak of the skill" (model
 *                         B) — NOT the rolled bonus; the caller decides which bonus, this fn
 *                         just does the tier arithmetic. See roll-dialog.mjs's competency-
 *                         confirm. triumph does NOT ignore cover — separate deterministic
 *                         step, see COMBAT-REDESIGN.md)
 * Floor is 1: any landed hit deals ≥ 1 (the later cover/defense reductions floor at 1 too).
 */

/** Rolled skills that count as an ATTACK and therefore produce damage. Kept as an
 *  extensible set on purpose — magic / other skills will be added here once their damage
 *  concept is decided (deliberate tail, per design). Melee = `impulse`, ranged =
 *  `sensorics` (2026-08-19 characteristic restructure — Контакт/Наводка retired, see
 *  config.mjs's GOD.SKILL_MAP; баллистика maps to `sensorics` now, see config.mjs). */
export const ATTACK_SKILLS = new Set(["impulse", "sensorics"]);

/** True iff a roll made with this skill key deals attack damage. `self`/social/etc. → false. */
export function isAttackSkill(skillKey) {
  return ATTACK_SKILLS.has(skillKey);
}

/** Damage bonus from the KEPT d100 result: `roll / 20` rounded UP — 05 → +1, 48 → +3, 95 → +5.
 *  The bonus grows the higher you roll under your skill; a non-positive / blank roll → 0.
 *  Only meaningful on a success tier (there the roll is ≤ skill); fail/fiasco ignore it. */
export function rollBonus(rollValue) {
  const r = Number(rollValue);
  if (!Number.isFinite(r) || r <= 0) return 0;
  return Math.ceil(r / 20);
}

/** Which of the Class item's 4 base-damage fields (baseMelee/baseRanged/
 *  baseMetaphysicalMelee/baseMetaphysicalRanged, items.mjs's ClassDataModel) an attack
 *  roll should read, from the triggering weapon/ability item's `damageNature` +
 *  `attackType`. `attackType` ("melee"|"ranged"|"self") is the more reliable melee/ranged
 *  signal when a real item started the roll (module/rolls/roll-dialog.mjs's Attack
 *  button, see weapon-sheet.mjs/ability-sheet.mjs); falls back to deriving it from the
 *  skill key (impulse→melee, sensorics→ranged, see ATTACK_SKILLS above) for a roll
 *  started with no item context at all (e.g. clicking a skill row directly on the actor
 *  sheet). `damageNature` defaults to "physical" when omitted, matching the item
 *  schema's own default. */
export function classBaseField({ skillKey, attackType, damageNature } = {}) {
  const ranged = attackType ? attackType === "ranged" : skillKey === "sensorics";
  const metaphysical = damageNature === "metaphysical";
  if (metaphysical) return ranged ? "baseMetaphysicalRanged" : "baseMetaphysicalMelee";
  return ranged ? "baseRanged" : "baseMelee";
}

/** Which of an NPC actor's 4 flat damage fields (system.damage.melee/ranged/
 *  metaphysicalMelee/metaphysicalRanged, data-models.mjs's NPCDataModel) dealNpcDamage
 *  (module/rolls/npc-attack.mjs) should read, from the triggering weapon/ability item's
 *  `damageNature` + `attackType`. Same shape as classBaseField above, just NPC field
 *  names have no "base" prefix (an NPC's number IS the dealt damage — no roll, no
 *  bonus). No skillKey fallback here (unlike classBaseField): an NPC action with no item
 *  context (the sheet's own quick "deal-damage" icon) has nothing to infer melee/ranged
 *  from, so it defaults to melee like an omitted attackType always does. */
export function npcDamageField({ attackType, damageNature } = {}) {
  const ranged = attackType === "ranged";
  const metaphysical = damageNature === "metaphysical";
  if (metaphysical) return ranged ? "metaphysicalRanged" : "metaphysicalMelee";
  return ranged ? "ranged" : "melee";
}

const TIERS = new Set(["fiasco", "fail", "success", "triumph"]);

/** Damage from an already-resolved base + bonus for a given outcome tier, floored at 1.
 *  The tier-only core — used both by computeAttackDamage (fresh roll) and by the chat
 *  card's competency re-roll (tier flips success→triumph off the stored base/bonus). */
export function damageForTier({ base, bonus, outcome }) {
  if (!TIERS.has(outcome)) throw new Error(`damageForTier: unknown outcome "${outcome}"`);
  const B = Math.max(0, Math.trunc(Number(base) || 0));
  const b = Math.max(0, Math.trunc(Number(bonus) || 0));

  let dmg;
  switch (outcome) {
    case "fiasco":  dmg = 1;         break;
    case "fail":    dmg = B;         break;
    case "success": dmg = B + b;     break;
    case "triumph": dmg = B + b + B; break;
  }
  return Math.max(1, dmg);
}

/**
 * Damage a single landed attack deals, BEFORE cover and active defense.
 * @param {object}  p
 * @param {number}  p.base    — class base damage (coerced to a non-negative integer)
 * @param {number}  p.roll    — the KEPT d100 result (godResult.chosen), 1..100
 * @param {string}  p.outcome — outcomeKey: "fiasco" | "fail" | "success" | "triumph"
 * @returns {number} damage, floored at 1
 */
export function computeAttackDamage({ base, roll, outcome } = {}) {
  return damageForTier({ base, bonus: rollBonus(roll), outcome });
}
