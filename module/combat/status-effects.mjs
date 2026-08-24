/**
 * GOD Tactical — Status Effects (Token HUD) + deferred activation seam
 *
 * Registers our own CONFIG.statusEffects set (replacing Foundry's default D&D
 * list) and provides isStatusActive() as the single point of integration for
 * future damage/action-gating code.
 */

import { GOD } from "../config.mjs";

const FLAG_SCOPE = "god-tactical";
const PENDING_FLAG = "pendingSince";

/* -------------------------------------------- */

export function registerStatusEffects() {
  // Full replacement, not a merge — the default D&D statuses are not used by this system.
  CONFIG.statusEffects = GOD.STATUS_EFFECTS.map((s) => ({
    id: s.id,
    name: s.name,
    img: s.img,
  }));

  // Round N+1 activation rule: a status applied during round N is marked pending
  // until the start of round N+1 (simultaneous hidden planning isn't broken by an
  // instantly-active status). Outside combat, statuses are active immediately.
  Hooks.on("createActiveEffect", (effect, options, userId) => {
    if (userId !== game.user.id) return; // only the client performing the create should act
    if (!(effect.parent instanceof Actor)) return;
    if (!effect.statuses?.size) return;
    if (!game.combat?.started) return;
    // render:false — setFlag()'s own update() would otherwise trigger the actor sheet's
    // default full re-render right after createActiveEffect's suppressed one (see
    // preCreateActiveEffect/_patchEffectInsert in actor-sheet.mjs / npc-sheet.mjs), blowing
    // away the sheet's scroll position on every status applied during combat.
    effect.update({ [`flags.${FLAG_SCOPE}.${PENDING_FLAG}`]: game.combat.round }, { render: false });
  });

  // On round change, clear the pending flag on effects whose round has come — this is
  // a seam for a future "pending but not yet active" muted-icon indicator, not required
  // for isStatusActive() itself (which compares the round directly).
  Hooks.on("updateCombat", async (combat, changed) => {
    if (!("round" in changed)) return;
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor) continue;
      const toClear = actor.effects.filter((e) => {
        const since = e.getFlag(FLAG_SCOPE, PENDING_FLAG);
        return since != null && combat.round > since;
      });
      // render:false — same scroll-reset concern as the setFlag() above.
      for (const effect of toClear) {
        await effect.update({ [`flags.${FLAG_SCOPE}.-=${PENDING_FLAG}`]: null }, { render: false });
      }
    }
  });
}

/* -------------------------------------------- */

/**
 * Single source of truth for "is this status active right now" — all future
 * damage/action code must call this instead of reading `actor.statuses.has(id)`
 * directly, so the round N+1 deferred-activation rule is respected everywhere.
 *
 * @param {Actor} actor
 * @param {string} statusId
 * @returns {boolean}
 */
export function isStatusActive(actor, statusId) {
  const effect = actor.effects.find((e) => e.statuses.has(statusId));
  if (!effect) return false;
  if (!game.combat?.started) return true;
  const pendingSince = effect.getFlag(FLAG_SCOPE, PENDING_FLAG);
  if (pendingSince == null) return true;
  return game.combat.round > pendingSince;
}
