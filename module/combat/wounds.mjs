/**
 * GOD Tactical — Lives Track (Жизни)
 *
 * Single source of truth for the wound/lives state of an actor, shared by the character
 * sheet and the NPC sheet so they can never drift apart. Each species (Race/Creature
 * item) carries a `woundSteps` cell count (1 by default — one heart, alive/dead — but
 * raisable per species if a GM wants a tougher creature to take more hits). Filling
 * every cell incapacitates the actor. Also exposes the "GRIT" bonus cell count — a
 * character's own base pool (GOD.BASE_GRIT, CharacterDataModel.baseGrit) — rendered as
 * a separate block.
 */

/** Hover tooltip for a wound-step box. */
export function woundBoxTitle(box) {
  return box.filled ? "Жизнь потеряна" : "Жив";
}

/**
 * Full wound state for an actor, or null if it has no species card (Race/Creature).
 *  - boxes: [{ index, filled }]
 *  - incapacitated: ladder full (all hearts spent — the actor is dead/down)
 */
export function computeWoundState(actor) {
  const speciesItem = actor?.items?.find((it) => it.type === "race" || it.type === "creature");
  if (!speciesItem) return null;

  const max = Math.max(1, speciesItem.system.woundSteps ?? 1);
  const wounds = actor.system.wounds ?? [];

  const boxes = [];
  for (let i = 0; i < max; i++) {
    // Wounds fill right→left — the rightmost `wounds.length` cells are marked.
    const filled = i >= max - wounds.length;
    boxes.push({ index: i, filled });
  }

  return {
    max,
    boxes,
    incapacitated: wounds.length >= max,
  };
}

/**
 * Total "GRIT" cells for an actor. Armor doesn't grant GRIT at all anymore (a fully
 * retired mechanic, not just an NPC/Character split) — the total is a flat number for
 * every actor type now:
 *  - Character: own base pool (GOD.BASE_GRIT, CharacterDataModel.baseGrit).
 *  - Anything else (NPC, and Creature — CreatureDataModel extends NPCDataModel, see
 *    data-models.mjs, and both use GODNPCSheet/npc-sheet.hbs — see god-tactical.mjs's
 *    registerSheet calls): a flat GM-set number (NPCDataModel.gritMax). Checked by
 *    actor.type !== "character" rather than === "npc" specifically, so this doesn't
 *    silently break again for the next NPC-like actor type that gets bolted onto
 *    NPCDataModel the same way Creature was.
 * Returns null if the total is 0 (gritMax left at 0 — a Character always has at least
 * its base pool, so this is effectively always non-null for them).
 *
 * Rendered as a numeric counter (2026-08-24 — replaced the old one-box-per-point fang
 * row, which stretched the card taller as baseGrit grew instead of staying a fixed
 * footprint), but the underlying two independent counts are unchanged:
 *  - gritFilled (dim): "spent", anchored to the right edge.
 *  - gritCracked (red): "broken", anchored to the left edge.
 * A cell within both ranges reads as cracked (worse state wins) — `filled` below is
 * the box-count that actually shows as filled AFTER that overlap resolves, which can
 * be less than the raw stored gritFilled once cracked eats into the same cells.
 *  - count:   total cells
 *  - whole:   undamaged, unspent — the number a player reads as "GRIT I have left"
 *  - filled:  spent (click to restore)
 *  - cracked: broken (click to repair)
 */
export function getGritCells(actor) {
  const count = actor?.type === "character" ? (actor?.system?.baseGrit ?? 0) : (actor?.system?.gritMax ?? 0);
  if (count <= 0) return null;

  const filledRaw = Math.min(count, actor.system.gritFilled ?? 0);
  const cracked = Math.min(count, actor.system.gritCracked ?? 0);

  let filled = 0;
  for (let i = 0; i < count; i++) {
    if (i >= cracked && i >= count - filledRaw) filled++;
  }
  const whole = count - cracked - filled;

  return { count, whole, filled, cracked };
}
