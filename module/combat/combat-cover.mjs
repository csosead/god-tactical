/**
 * GOD Tactical — Cover (COMBAT-REDESIGN)
 * Pure, Foundry-free core of the deterministic cover model (see repo COMBAT-REDESIGN.md).
 * Cover is decided by EXPOSURE: the fraction of the target's body reachable by clear rays
 * from the shooter (rays to footprint corners × head/mid heights, cast in 3D by
 * blind-spot.mjs — the Foundry-dependent part). This module holds only the parts that
 * don't need a canvas: the size→body-height table, the exposure→level thresholds, and the
 * damage reduction — so they're unit-testable (tests/combat-cover.test.mjs).
 *
 * Levels (per shooter↔target, angle-dependent). Cover starts only once HALF the body's sample
 * rays are blocked (≥ 4 of 8) — a lone corner grazing a wall's edge is an open shot, not cover:
 *   none  — exposure > 50%           → full damage (fewer than half the sample rays blocked)
 *   half  — 25% < exposure ≤ 50%     → damage ÷2 (round DOWN, favours the covered target)
 *   full  — exposure ≤ 25%           → NO SHOT (attack can't land here)
 * Swarm: any real (≥ half) cover disperses it straight to full; under half → no cover, like anyone.
 */

/** Standing body height per size tier, in metres — mirrors blind-spot.mjs's
 *  EYE_HEIGHT_METERS_BY_SIZE (kept here too so this module stays canvas-free; keep the two
 *  in sync). Used to place the head (`H`) and mid (`H/2`) sample points above the target's
 *  feet for the ray casts. */
export const BODY_HEIGHT_BY_SIZE = {
  swarm: 1,
  small: 1.5,
  medium: 2,
  large: 3,
  veryLarge: 4,
  incrediblyLarge: 6,
};

export const COVER = Object.freeze({ NONE: "none", HALF: "half", FULL: "full" });

/**
 * Cover level from an exposure fraction.
 * @param {number}  exposure      — fraction of sampled body points with a clear ray, 0..1
 * @param {object} [opts]
 * @param {boolean} [opts.isSwarm] — swarm collapses any partial cover straight to full
 * @returns {"none"|"half"|"full"}
 */
export function coverLevelFromExposure(exposure, { isSwarm = false } = {}) {
  const e = Number.isFinite(exposure) ? Math.min(1, Math.max(0, exposure)) : 0;
  // Cover needs at least HALF the sampled body blocked (≥ 4 of 8 rays) before ANY cover applies:
  // a single footprint corner grazing a wall's edge (≤ 3 of 8 rays blocked, ≥ 62.5% exposed) is an
  // OPEN shot, not half cover — the "a tip-graze between shooter and target reads as cover" fix.
  if (e > 0.5) return COVER.NONE;             // < half the body's rays blocked → open shot
  // Swarm: any REAL (≥ half) cover disperses it straight into an untargetable full.
  if (isSwarm) return COVER.FULL;
  if (e > 0.25) return COVER.HALF;            // 4–5 of 8 blocked → 2/4, damage ÷2
  return COVER.FULL;                          // ≥ 6 of 8 blocked → no shot
}

/** True when this cover level means the attack cannot land at all (no shot). */
export function coverBlocksShot(level) {
  return level === COVER.FULL;
}

/**
 * Apply a cover level to a computed damage number.
 * @returns {number} 0 when the shot is fully blocked (no hit); the halved-and-floored
 *  value (min 1) under half cover; the unchanged damage under no cover.
 */
export function applyCover(damage, level) {
  const d = Math.max(0, Math.trunc(Number(damage) || 0));
  switch (level) {
    case COVER.FULL: return 0;                    // no shot
    case COVER.HALF: return Math.max(1, Math.floor(d / 2)); // ÷2 rounded down, favours target
    default:         return d;                    // no cover
  }
}

/**
 * Exposure fraction from per-sample-point ray results.
 * @param {boolean[]} exposedPoints — one flag per sampled body point (footprint corner ×
 *   head/mid), true = that point's ray reached the target unobstructed.
 * @returns {number} 0..1 (0 when there are no points to sample)
 */
export function exposureFromPoints(exposedPoints) {
  if (!Array.isArray(exposedPoints) || exposedPoints.length === 0) return 0;
  const clear = exposedPoints.reduce((n, p) => n + (p ? 1 : 0), 0);
  return clear / exposedPoints.length;
}
