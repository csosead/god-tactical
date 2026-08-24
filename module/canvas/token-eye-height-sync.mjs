/**
 * GOD Tactical — Token Eye Height Sync
 * Keeps the "Wall Height" module's per-token `flags['wall-height'].tokenHeight`
 * in lockstep with THIS system's own size-tiered eye-height table
 * (EYE_HEIGHT_METERS_BY_SIZE, see blind-spot.mjs) — the same number
 * vision-obstruction.mjs's blind-spot rule and blind-spot.mjs's attack/cover
 * gate already use internally.
 *
 * Why this exists: Wall Height computes its OWN idea of a token's eye height
 * (`Token#losHeight`, see wall-height/scripts/utils.js's getTokenLOSheight)
 * completely independently of this system's size table, UNLESS the
 * `tokenHeight` flag is set — that flag wins over both of Wall Height's own
 * code paths:
 *   - `Auto LOS Height` OFF → falls back to a world-wide FLAT default
 *     (`Default Token Height`, 0.4 m in this world) for every token
 *     regardless of size.
 *   - `Auto LOS Height` ON → derives a height from the TOKEN'S GRID FOOTPRINT
 *     (width/height in grid squares × grid distance × a 0.89 multiplier) —
 *     coincidentally NOT this system's size tier at all, just how many
 *     squares the token happens to occupy on the map. Confirmed live: a 1x1
 *     "medium" NPC (this system's table says 2 m) measured a real
 *     `token.losHeight` of ~0.445 m either way (elevation + 1×0.5m×0.89) —
 *     ankle height, not the ~2 m a medium creature should stand.
 * That mismatch is what let "high ground always sees down" (the
 * ELEVATION-BLOCKING rule, correctly using this system's 2 m table) disagree
 * with the actual WALL-BLOCKING math (Wall Height's own `_testEdgeInclusion`,
 * using its own ~0.445 m number) for the exact same creature.
 *
 * The fix is to keep `tokenHeight` always populated from THIS system's own
 * table — since that flag is checked FIRST in both of Wall Height's branches
 * (`token.document.flags['wall-height']?.tokenHeight || <auto-or-default>`),
 * once it's set, `Auto LOS Height` can be toggled on or off by anyone at any
 * time and it will never be consulted at all for a token this file has
 * touched — there's nothing to "leave off" or "lock" on Wall Height's side,
 * the flag makes the setting structurally irrelevant rather than merely
 * discouraged. Nothing here disables the setting or blocks it from being
 * re-enabled; it simply stops being read.
 */

import { eyeHeightForToken } from "./blind-spot.mjs";
import { getTokenState } from "../state.mjs";

const FLAG_SCOPE = "wall-height";
const FLAG_KEY = "tokenHeight";

function _isActiveGM() {
  return game.user === game.users.activeGM;
}

/** A PLACED token document — GodState already has (or can derive) a
 *  quantized snapshot for it, keyed by its own id, so read the eye height
 *  from there instead of re-deriving it inline; falls back to the direct
 *  table lookup if the state layer can't resolve it for some reason. */
function _desiredHeightForDocument(tokenDoc) {
  return getTokenState(tokenDoc)?.eyeHeightM ?? eyeHeightForToken(tokenDoc);
}

/** An Actor's prototypeToken has no canvas presence at all (nothing to
 *  cache/invalidate against), so it stays a direct table lookup — the same
 *  `eyeHeightForToken` GodState itself calls internally, so the two never
 *  disagree. */
function _desiredHeightForPrototype(actor) {
  return eyeHeightForToken({ actor });
}

async function _syncTokenDocument(tokenDoc) {
  const desired = _desiredHeightForDocument(tokenDoc);
  const current = tokenDoc.flags?.[FLAG_SCOPE]?.[FLAG_KEY];
  if (current === desired) return;
  await tokenDoc.update({ [`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: desired });
}

async function _syncPrototypeToken(actor) {
  const desired = _desiredHeightForPrototype(actor);
  const current = actor.prototypeToken?.flags?.[FLAG_SCOPE]?.[FLAG_KEY];
  if (current === desired) return;
  await actor.update({ [`prototypeToken.flags.${FLAG_SCOPE}.${FLAG_KEY}`]: desired });
}

/** One-time (idempotent — only writes where the flag actually disagrees with
 *  the size table) backfill for every token already on every scene, plus
 *  every actor's prototypeToken so a freshly-dragged-out token already
 *  carries the right value on its very first `createToken` instead of
 *  waiting a tick for the hook below. Safe to run every load. */
export async function migrateTokenEyeHeights() {
  for (const scene of game.scenes) {
    const updates = [];
    for (const tokenDoc of scene.tokens) {
      const desired = _desiredHeightForDocument(tokenDoc);
      const current = tokenDoc.flags?.[FLAG_SCOPE]?.[FLAG_KEY];
      if (current !== desired) updates.push({ _id: tokenDoc.id, [`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: desired });
    }
    if (updates.length) {
      await scene.updateEmbeddedDocuments("Token", updates);
      console.log(`god-tactical | Synced ${updates.length} token eye height(s) (Wall Height tokenHeight) on scene "${scene.name}"`);
    }
  }
  for (const actor of game.actors) {
    await _syncPrototypeToken(actor);
  }
}

export function registerTokenEyeHeightSync() {
  // A freshly-placed token — stamp it immediately so it never has a chance
  // to render one frame with Wall Height's own auto/default height.
  Hooks.on("createToken", (tokenDoc) => {
    if (!_isActiveGM()) return;
    _syncTokenDocument(tokenDoc);
  });

  // The actor's size tier changed — re-stamp its prototypeToken (future
  // placements) and every already-placed token backed by this actor, across
  // every scene (not just the active one — a token on an inactive scene
  // would otherwise silently keep a stale height until someone happens to
  // open that scene and re-trigger something).
  Hooks.on("updateActor", (actor, changes) => {
    if (!_isActiveGM()) return;
    if (!foundry.utils.hasProperty(changes, "system.size")) return;
    _syncPrototypeToken(actor);
    for (const scene of game.scenes) {
      for (const tokenDoc of scene.tokens) {
        if (tokenDoc.actor?.id === actor.id) _syncTokenDocument(tokenDoc);
      }
    }
  });

  // Gated on `activeGM`, not `game.user.isGM` — this world routinely has
  // multiple simultaneous GM-role clients connected (Gamemaster/Player2/
  // Player3), and an ungated `isGM` migration here would race the same way
  // region-light-walls.mjs's did before it switched to this same check (see
  // BLIND-SPOT-NOTES.md) — every connected GM client would run the full
  // scene-by-scene update in parallel, multiplying writes instead of running
  // once.
  Hooks.once("ready", () => {
    if (!_isActiveGM()) return;
    migrateTokenEyeHeights();
  });
}
