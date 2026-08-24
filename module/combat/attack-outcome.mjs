/**
 * GOD Tactical — Attack outcome (COMBAT-REDESIGN follow-up)
 * Combines the THREE independent damage-halving factors an attack can carry into ONE
 * indicator/multiplier, replacing separate cover/height composition:
 *   - cover level "half" (blind-spot.mjs's computeCover — a wall/parapet the target stands
 *     next to, or the shooter's own angle doesn't fully clear)
 *   - aim-height tier "half" (aim-height-damage.mjs — Target Z mismatch on a line/wide_line/
 *     cone, Натиск or Залп alike; Натиск's own zero-threshold scopes to its weapon's reach
 *     instead of Залп's flat allowance, but the tier vocabulary — full/half/zero — is the same)
 *   - "hears but doesn't see" (blind-spot.mjs's hearsButDoesNotSee — blind-fire at a target
 *     placed by sound alone; ranged only)
 *
 * Two HARD zero overrides stay separate from the halving count — a shot/swing that flat-out
 * can't land (full cover: a wall the shooter's angle never clears at all) or flat-out can't be
 * aimed right (height gap past the aim-height tier's own zero-threshold) is a clean miss
 * regardless of anything else, not "one more half stacked on".
 *
 * Everything ELSE is a plain COUNT of how many of the three "half" factors are active:
 *   0 → FULL   (×1)    — red
 *   1 → HALF   (×1/2)  — orange
 *   2 → QUARTER(×1/4)  — green
 *   3 → ZERO   (×0)    — grey ✕ — deliberately NOT ×1/8: three independent factors all going
 *                         wrong at once reads as "nothing lands", a clean discrete state instead
 *                         of an ever-shrinking fraction nobody could read at a glance (GM's call).
 */

export const OUTCOME_TIER = Object.freeze({ FULL: "full", HALF: "half", QUARTER: "quarter", ZERO: "zero" });
const TIER_MULTIPLIER = { full: 1, half: 0.5, quarter: 0.25, zero: 0 };

/**
 * @param {object} p
 * @param {"none"|"half"|"full"} p.coverLevel
 * @param {"full"|"half"|"zero"|null} [p.heightTier] — null when no ranged Target Z applies
 * @param {boolean} [p.hearNotSee]
 * @returns {"full"|"half"|"quarter"|"zero"}
 */
export function combineAttackOutcome({ coverLevel, heightTier, hearNotSee } = {}) {
  if (coverLevel === "full") return OUTCOME_TIER.ZERO;
  if (heightTier === "zero") return OUTCOME_TIER.ZERO;

  let halves = 0;
  if (coverLevel === "half") halves++;
  if (heightTier === "half") halves++;
  if (hearNotSee) halves++;

  if (halves >= 3) return OUTCOME_TIER.ZERO;
  if (halves === 2) return OUTCOME_TIER.QUARTER;
  if (halves === 1) return OUTCOME_TIER.HALF;
  return OUTCOME_TIER.FULL;
}

/** Applies an outcome tier to an already-computed base damage number — floor(1) on any
 *  non-zero tier (same convention as the retired per-factor applyCover/applyRangedHeightDamage),
 *  0 for ZERO. */
export function applyOutcomeTier(damage, tier) {
  const d = Math.max(0, Math.trunc(Number(damage) || 0));
  const m = TIER_MULTIPLIER[tier];
  if (m === undefined || m === 0) return 0;
  return Math.max(1, Math.floor(d * m));
}
