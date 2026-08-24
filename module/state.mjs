/**
 * GOD Tactical — State (the Pure Data layer)
 * A single quantized snapshot of "what does this token/region look like
 * right now", so the rest of the system's geometry math (blind-spot.mjs,
 * template-3d.mjs, region-light-walls.mjs, …) reads plain numbers instead of
 * re-reading live Foundry Documents — each Token/Region's continuous
 * position/elevation is quantized exactly ONCE, here, via quantize.mjs, so
 * every consumer agrees on the same value instead of each accumulating its
 * own independent float noise from the v14 upgrade.
 *
 * Design: PULL + memoized cache, hooks only INVALIDATE, never write. Every
 * handler registerGodState() installs does exactly one thing — delete an
 * entry from a plain Map — and none of them ever call .update()/.create()/
 * .delete() on a Document. That structurally rules out the "a hook handler
 * triggers a Document write, which re-fires the same hook" class of bug that
 * caused this project's historical Region-elevation `tokenEnter`/`tokenExit`
 * infinite loop (see the foundry-v14-upgrade-fixes project notes) — there is
 * nothing in this file that can re-trigger anything. registerGodState() must
 * run FIRST in Hooks.once("init", …) (see god-tactical.mjs), ahead of every
 * Phase-2 consumer's own registration, so a cache invalidation for a given
 * Foundry event always fires before that consumer's own handler for the same
 * event — the consumer can never observe a stale cache entry for the change
 * that just happened.
 *
 * Snapshots are frozen plain objects — never a Document/PlaceableObject
 * reference — so a consumer holding one genuinely cannot "know" it's inside
 * Foundry: nothing on the object can be mutated, and nothing on it points
 * back into the engine.
 */

import { sizeTierForToken, eyeHeightForToken } from "./canvas/blind-spot.mjs";
import {
  quantizeHalf,
  quantizeElevationMeters,
  quantizeElevationMetersOrNull,
  worldToQuantizedCellPoint,
} from "./canvas/quantize.mjs";

const _tokenCache = new Map(); // tokenId -> frozen snapshot
const _regionCache = new Map(); // regionId -> frozen snapshot

/** Accepts a placed Token, a TokenDocument (rendered or not), or a canvas
 *  token id string, and resolves it down to whichever of {Token,
 *  TokenDocument} carries the richest live data available right now. */
function _resolveToken(tokenOrId) {
  if (typeof tokenOrId === "string") return canvas.tokens?.get(tokenOrId) ?? null;
  if (tokenOrId?.object) return tokenOrId.object; // a rendered TokenDocument -> its placed Token
  return tokenOrId ?? null;
}

/** Cheap fingerprint of every raw Document field _deriveTokenState reads to derive position/
 *  size/elevation — used by getTokenState to self-heal the cache on every read (see there) so
 *  correctness never again depends on a hook firing at exactly the right moment relative to a
 *  move animation. Deliberately built from the same raw doc fields _deriveTokenState itself
 *  uses, not from any rendered/animated value — a fingerprint built off `token.center` would
 *  just reproduce the exact staleness this exists to catch. */
function _rawTokenFingerprint(doc) {
  return `${doc?.x ?? 0}:${doc?.y ?? 0}:${doc?.elevation ?? 0}:${doc?.width ?? 1}:${doc?.height ?? 1}`;
}

function _deriveTokenState(token) {
  const doc = token?.document ?? token;
  const scene = doc?.parent ?? canvas.scene;
  const gridSizeX = scene?.grid?.sizeX || canvas.grid?.sizeX || 100;
  const gridSizeY = scene?.grid?.sizeY || canvas.grid?.sizeY || 100;
  const metersPerCell = scene?.grid?.distance || canvas.scene?.grid?.distance || 1;

  // ALWAYS reconstructed from the Document's own top-left + footprint — deliberately NEVER
  // `token.center` (the rendered, placed Token's own live pixel centre), even when a placed
  // Token is available. `token.center` visually LAGS the Document during Foundry's ~2-3s
  // move-animation tween (same class of gotcha already documented for TokenDocument.elevation,
  // see the Lift-H notes) — reading it at the wrong moment bakes a mid-animation position into
  // this snapshot, and nothing about finishing the animation ever invalidates that snapshot
  // again on its own. The Document's x/y, by contrast, is already the final committed value the
  // instant `updateToken` fires — reproduced live 2026-08-16 (getTokenState placed a moved
  // token ~1.7m from its real position from a `token.center` read, flipping a "sees" into a
  // false "hears not sees" mid-combat). Trade-off accepted: square-grid math only, no
  // hex-centre reconstruction — this project has no hex scenes; revisit if one shows up.
  const center = { x: (doc?.x ?? 0) + ((doc?.width ?? 1) * gridSizeX) / 2, y: (doc?.y ?? 0) + ((doc?.height ?? 1) * gridSizeY) / 2 };
  const cellPt = worldToQuantizedCellPoint(center.x, center.y, gridSizeX, gridSizeY);

  return Object.freeze({
    tokenId: token?.id ?? doc?.id ?? null,
    sceneId: scene?.id ?? null,
    xCells: cellPt.col,
    yCells: cellPt.row,
    elevationM: quantizeElevationMeters(doc?.elevation ?? 0),
    widthCells: quantizeHalf(doc?.width ?? 1),
    heightCells: quantizeHalf(doc?.height ?? 1),
    sizeTier: sizeTierForToken(token),
    eyeHeightM: eyeHeightForToken(token),
    gridSizeX,
    gridSizeY,
    metersPerCell,
    _fp: _rawTokenFingerprint(doc),
  });
}

/** The quantized snapshot for one token — a placed Token, its TokenDocument,
 *  or a canvas token id string. Memoized per token id, hook-invalidated
 *  (registerGodState()) AND self-healing on every read: a cheap raw-field
 *  fingerprint (_rawTokenFingerprint) is compared against the live Document
 *  before trusting the cached snapshot, so correctness never depends on a
 *  hook having fired at exactly the right moment. Added 2026-08-16 evening
 *  after the hook-only design (delete-on-update, rebuild-on-next-read) proved
 *  to still race the Document occasionally in live multi-client play even
 *  after switching the hook itself to rebuild eagerly off the Document —
 *  reproduced repeatedly enough (across full app restarts, ruling out any
 *  browser/Electron file cache) that "trust the hook fired correctly" wasn't
 *  a safe enough invariant on its own; this makes every read defensive
 *  instead, at the cost of one cheap string comparison per call.
 *  Returns null only when the input can't be resolved to any token at all.
 *  Input with no stable id (e.g. a bare `{ actor }` prototype-token wrapper)
 *  is computed fresh every call — there is nothing on canvas to invalidate
 *  against, so it's cheap and always current by construction. */
export function getTokenState(tokenOrId) {
  const token = _resolveToken(tokenOrId);
  if (!token) return null;
  const id = token.id ?? token.document?.id;
  if (!id) return _deriveTokenState(token);
  const doc = token.document ?? token;
  const liveFp = _rawTokenFingerprint(doc);
  let snap = _tokenCache.get(id);
  if (!snap || snap._fp !== liveFp) {
    snap = _deriveTokenState(token);
    _tokenCache.set(id, snap);
  }
  return snap;
}

function _deriveRegionState(regionDoc) {
  return Object.freeze({
    regionId: regionDoc.id,
    sceneId: regionDoc.parent?.id ?? null,
    topM: quantizeElevationMetersOrNull(regionDoc.elevation?.top),
    bottomM: quantizeElevationMetersOrNull(regionDoc.elevation?.bottom),
  });
}

/** The quantized snapshot for one Region's elevation band. Same memoized/
 *  invalidate-only-on-hook pattern as getTokenState. */
export function getRegionState(regionDoc) {
  if (!regionDoc?.id) return null;
  let snap = _regionCache.get(regionDoc.id);
  if (!snap) {
    snap = _deriveRegionState(regionDoc);
    _regionCache.set(regionDoc.id, snap);
  }
  return snap;
}

export function registerGodState() {
  // Every handler below is READ-ONLY against Foundry — a Map delete/set/clear,
  // never a Document write — so none of them can re-trigger the very hook
  // that invoked them (see file header).
  //
  // updateToken is the one exception to "invalidate, never recompute here"
  // the file header describes: it EAGERLY rebuilds the entry, from the bare
  // `tokenDoc` (its Document, not `tokenDoc.object`) rather than merely
  // deleting it. Passing the Document instead of the placed Token makes
  // `_deriveTokenState` take its doc-x/y-reconstruction branch (token?.center
  // is undefined on a bare Document) instead of the richer but ANIMATED
  // `token.center` — the position this hook fires with is already the final,
  // fully-committed value, whereas the placed Token's `.center` can still be
  // mid-tween for another ~2-3s. A plain delete-and-let-the-next-caller-
  // rebuild-it (the pattern every other hook here still uses) risks that next
  // caller landing DURING the tween and freezing the cache on a wrong
  // in-between position until something else moves the same token again —
  // reproduced live (see _deriveTokenState's comment above). Square-grid
  // reconstruction only (no hex-center math) — matches this system's own
  // existing scenes; revisit if a hex scene ever needs this.
  Hooks.on("updateToken", (tokenDoc) => _tokenCache.set(tokenDoc.id, _deriveTokenState(tokenDoc)));
  Hooks.on("createToken", (tokenDoc) => _tokenCache.delete(tokenDoc.id));
  Hooks.on("deleteToken", (tokenDoc) => _tokenCache.delete(tokenDoc.id));
  Hooks.on("updateRegion", (regionDoc) => _regionCache.delete(regionDoc.id));
  Hooks.on("deleteRegion", (regionDoc) => _regionCache.delete(regionDoc.id));
  Hooks.on("canvasReady", () => {
    _tokenCache.clear();
    _regionCache.clear();
  });
  Hooks.on("updateScene", (_scene, changes) => {
    // A grid-size/distance change invalidates every cached pixel<->cell and
    // metres conversion, scene-wide — simplest correct response is to drop
    // everything rather than track which cache entries came from which scene.
    if (foundry.utils.hasProperty(changes, "grid")) {
      _tokenCache.clear();
      _regionCache.clear();
    }
  });
}

export const GodState = { getTokenState, getRegionState, registerGodState };
