/**
 * GOD Tactical — Attack cover targets (COMBAT-REDESIGN, part b1)
 * Bridges the attacker's roll to the tokens caught under THEIR own AOE template: for a
 * shooter token, finds every other character/npc/creature token the shooter's own
 * template stroke(s) cover, computes each one's THREE independent damage-halving factors
 * (cover, aim-height tier — Натиск or Залп, see aim-height-damage.mjs — "hears but doesn't
 * see") and combines them into one outcome tier (attack-outcome.mjs) + the resulting damage.
 * Same "which tokens does this stroke cover" logic as region-cover-overlay.mjs, but returning
 * the per-target damage numbers for
 * the chat card instead of drawing rings. Read-only — it does NOT apply anything to actors
 * (that's b2, wounds.mjs, with confirmation).
 */

import { computeCover, coverFromPoint, buildBlindSpotContext, eyeHeightForToken, hearsButDoesNotSee } from "./blind-spot.mjs";
import { hitTokenIdsForShooter, isLobbedShooter, isRangedShooter, directionalAimInfo, lobbedBlastEye, hitTokenIdsForStroke, getStrokeById, lobbedBlastEyeForStroke } from "./template-canvas.mjs";
import { aimHeightDamageTier, HEIGHT_GAP_ZERO_M } from "../combat/aim-height-damage.mjs";
import { combineAttackOutcome, applyOutcomeTier } from "../combat/attack-outcome.mjs";

/**
 * @param {Token}  shooterToken — the attacking token (its id must match a stroke's tokenId)
 * @param {number} damage       — the attack's pre-modifier damage (computeAttackDamage)
 * @param {object} [options]
 * @param {string} [options.onlyTokenId] — when given, every other token the shooter's
 *   template covers is dropped from the result — used by action-log.mjs's live-target-
 *   tag click ("roll THIS one target, not everything under the template right now") via
 *   roll-dialog.mjs/npc-attack.mjs's own onlyTargetTokenId passthrough. Cover/height/
 *   hearNotSee are still computed the normal way for that one target — this only trims
 *   the RESULT LIST, it changes nothing about how any single target's own numbers work.
 * @returns {Array<{tokenId:string, name:string, level:"none"|"half"|"full",
 *   heightTier:("full"|"half"|"zero"|null), hearNotSee:boolean,
 *   outcomeTier:"full"|"half"|"quarter"|"zero", damage:number}>}
 *   one entry per covered target. `outcomeTier` is stored (not just baked into `damage`) so a
 *   later damage recompute with no live template to re-query — e.g. roll-dialog.mjs's
 *   competency-confirm — can re-apply it via applyOutcomeTier instead of losing it. Empty when
 *   the shooter has no visible template down, or nobody's caught in it.
 */
export function coverTargetsForShooter(shooterToken, damage, { onlyTokenId = null } = {}) {
  if (!shooterToken || !canvas?.tokens?.placeables) return [];

  // Who does this shooter's template actually HIT — footprint cells AND ranged-beam plane
  // hits (a beam has empty `cells`), the exact set that pulses red on the canvas.
  let hitIds = hitTokenIdsForShooter(shooterToken.id);
  if (onlyTokenId) hitIds = new Set(hitIds.has(onlyTokenId) ? [onlyTokenId] : []);
  if (!hitIds.size) return [];

  // A Навесной (lobbed) attack arcs OVER walls to REACH its landing point, but its cover works
  // like any other template of the same shape once it's down — judged from the LANDING POINT
  // (lobbedBlastEye), not from the shooter's own body (see isLobbedShooter). "Hears but doesn't
  // see" is a perception check, not a projectile-path one, so it's unaffected either way.
  const lobbed = isLobbedShooter(shooterToken.id);
  const ranged = isRangedShooter(shooterToken.id);
  const ctx = buildBlindSpotContext();
  // Target Z (+ weapon reach) of the shooter's current directional (line/wide_line/cone)
  // attack, if any — the template's own geometry no longer encodes height for EITHER
  // trajectory (see directionalWallClip), so a hit target's height-tier is computed here,
  // AFTER the plain cell-membership hit, same pass as cover. null for every other attack
  // shape. Залп uses the flat HEIGHT_GAP_ZERO_M zero-threshold; Натиск scopes it to half its
  // OWN weapon's reach instead (aim-height-damage.mjs's header) — no flight, no forgiveness.
  const aim = directionalAimInfo(shooterToken.id);
  const gapZeroM = aim?.attackType === "ranged" ? HEIGHT_GAP_ZERO_M : (aim?.weaponReachM ?? 0) / 2;
  const out = [];
  for (const id of hitIds) {
    const token = canvas.tokens.get(id);
    if (!token || token.id === shooterToken.id) continue;
    const actorType = token.actor?.type;
    if (actorType !== "character" && actorType !== "npc" && actorType !== "creature") continue;

    let level = "none";
    try {
      if (lobbed) {
        const eye = lobbedBlastEye(shooterToken.id);
        if (eye) level = coverFromPoint(eye, token, { fullWalls: ctx.fullWalls, walls: ctx.walls }).level;
      } else {
        level = computeCover(shooterToken, token, { fullWalls: ctx.fullWalls, walls: ctx.walls }).level;
      }
    } catch (e) {
      console.error("god-tactical | coverTargetsForShooter: cover computation failed for", token.name, e);
    }

    let heightTier = null;
    if (aim) {
      heightTier = aimHeightDamageTier({
        targetZ: aim.targetZ,
        attackType: aim.attackType,
        canHitLowFlight: aim.canHitLowFlight,
        canHitHighFlight: aim.canHitHighFlight,
      }, {
        floorZ: token.document.elevation ?? 0,
        heightM: eyeHeightForToken(token),
      }, gapZeroM).tier;
    }

    let hearNotSee = false;
    if (ranged) {
      try {
        hearNotSee = hearsButDoesNotSee(shooterToken, token, { fullWalls: ctx.fullWalls, walls: ctx.walls });
      } catch (e) {
        console.error("god-tactical | coverTargetsForShooter: hearsButDoesNotSee failed for", token.name, e);
      }
    }

    const outcomeTier = combineAttackOutcome({ coverLevel: level, heightTier, hearNotSee });
    const targetDamage = applyOutcomeTier(damage, outcomeTier);
    out.push({ tokenId: id, name: token.name, level, heightTier, hearNotSee, outcomeTier, damage: targetDamage });
  }
  return out;
}

/**
 * Per-stroke counterpart to coverTargetsForShooter above — computes hit targets + damage
 * tiers from ONE SPECIFIC stroke's own footprint/fields, never the shooter's aggregated-
 * or most-recently-placed one. Needed once the Планер can log more than one attack for the
 * same token in the same phase (Натиск + Опрокидывание together, say):
 * coverTargetsForShooter's shooter-id-keyed helpers (hitTokenIdsForShooter,
 * directionalAimInfo, isLobbedShooter, etc.) all explicitly assume "only one attack is
 * ever being resolved at a time" (their own doc comments in template-canvas.mjs) and
 * collapse onto whichever stroke was placed LAST — fine for an actual roll (there IS only
 * one being resolved), wrong for a live per-tag Планер preview showing several logged
 * attacks at once. This reads everything straight off the stroke instead, so it can never
 * pick up another attack's data by accident. Only ever used by action-log.mjs's
 * _targetsHTML — the real roll-resolution path (roll-dialog.mjs/npc-attack.mjs) still
 * calls coverTargetsForShooter, untouched.
 * @param {string} strokeId — resolved via template-canvas.mjs's getStrokeById (this
 *   user's own strokes only, same scope the Планер's log already lives in).
 * @param {number} damage
 * @returns same shape as coverTargetsForShooter. Empty if the stroke's gone (undone) or
 *   isn't an AOE shape.
 */
export function coverTargetsForStroke(strokeId, damage) {
  const stroke = getStrokeById(strokeId);
  if (!stroke) return [];
  const shooterToken = canvas.tokens?.get(stroke.tokenId);
  if (!shooterToken) return [];

  const hitIds = hitTokenIdsForStroke(stroke);
  if (!hitIds.size) return [];

  const lobbed = !!lobbedBlastEyeForStroke(stroke);
  const ranged = stroke.attackType === "ranged";
  const ctx = buildBlindSpotContext();
  const gapZeroM = stroke.attackType === "ranged" ? HEIGHT_GAP_ZERO_M : (stroke.weaponReachM ?? 0) / 2;
  const out = [];
  for (const id of hitIds) {
    const token = canvas.tokens.get(id);
    if (!token || token.id === shooterToken.id) continue;
    const actorType = token.actor?.type;
    if (actorType !== "character" && actorType !== "npc" && actorType !== "creature") continue;

    let level = "none";
    try {
      if (lobbed) {
        const eye = lobbedBlastEyeForStroke(stroke);
        if (eye) level = coverFromPoint(eye, token, { fullWalls: ctx.fullWalls, walls: ctx.walls }).level;
      } else {
        level = computeCover(shooterToken, token, { fullWalls: ctx.fullWalls, walls: ctx.walls }).level;
      }
    } catch (e) {
      console.error("god-tactical | coverTargetsForStroke: cover computation failed for", token.name, e);
    }

    let heightTier = null;
    if (stroke.targetZ != null) {
      heightTier = aimHeightDamageTier({
        targetZ: stroke.targetZ,
        attackType: stroke.attackType,
        canHitLowFlight: stroke.canHitLowFlight ?? false,
        canHitHighFlight: stroke.canHitHighFlight ?? false,
      }, {
        floorZ: token.document.elevation ?? 0,
        heightM: eyeHeightForToken(token),
      }, gapZeroM).tier;
    }

    let hearNotSee = false;
    if (ranged) {
      try {
        hearNotSee = hearsButDoesNotSee(shooterToken, token, { fullWalls: ctx.fullWalls, walls: ctx.walls });
      } catch (e) {
        console.error("god-tactical | coverTargetsForStroke: hearsButDoesNotSee failed for", token.name, e);
      }
    }

    const outcomeTier = combineAttackOutcome({ coverLevel: level, heightTier, hearNotSee });
    const targetDamage = applyOutcomeTier(damage, outcomeTier);
    out.push({ tokenId: id, name: token.name, level, heightTier, hearNotSee, outcomeTier, damage: targetDamage });
  }
  return out;
}
