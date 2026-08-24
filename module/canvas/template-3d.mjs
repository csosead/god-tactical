/**
 * GOD Tactical — Template 3D (core)
 * Height-aware helpers for the `direct3D` template rework (see items.mjs's
 * direct3D doc comment). Pure geometry only — the canvas draw layer
 * (template-canvas.mjs) calls these to SHRINK a Direct template's effective
 * reach/footprint before it computes coverage cells, so a shot/reach aimed
 * up onto a platform (or down into a pit) covers less ground than the same
 * template on flat floor.
 *
 * The single idea, one formula: the configured reach is a 3D budget. Climbing
 * or dropping to the target's height eats into it along the hypotenuse
 * (Euclidean, per the design decision) — whatever's left is the horizontal
 * reach the flat template is allowed to keep:
 *
 *     effectiveHorizontal = √( reach² − Δheight² )      (0 if Δheight ≥ reach)
 *
 * Both attackType branches (ranged projectile vs melee reach) shrink the SAME
 * way here — the difference between them (a diagonal projectile LINE to the
 * endpoint height vs. a melee reach the height eats into) only matters for
 * per-height HIT resolution, layered on later; the footprint shrink is common
 * to both, so this module stays branch-free.
 *
 * Units: elevations and region heights are in the scene's own distance units
 * (metres here — see config.mjs's METERS_PER_CELL); template reach/size are in
 * CELLS. Everything combined in `euclideanReach` is converted to CELLS first
 * (via `canvas.scene.grid.distance`, metres-per-cell) so the √ is unit-clean.
 */

import { eyeHeightForToken, computeBlindSpot, buildBlindSpotContext } from "./blind-spot.mjs";
import { intersectSegments, testWallAgainstRay, pointInPolygonTree } from "./blind-spot-geometry.mjs";
import { gridToWorld, worldToGrid } from "./template-geometry.mjs";
import { getTokenState, getRegionState } from "../state.mjs";
import { aimHeightDamageTier } from "../combat/aim-height-damage.mjs";

/** Shooter floor + eye height off GodState, falling back to a live read if
 *  the state layer can't resolve the token — the one pattern nearly every
 *  function below needs. */
function _shooterEyeState(shooterToken) {
  const st = getTokenState(shooterToken);
  const floor = st ? st.elevationM : (shooterToken?.document?.elevation ?? 0);
  const eyeH = st ? st.eyeHeightM : eyeHeightForToken(shooterToken);
  return { floor, eyeZ: floor + eyeH };
}

/** Target feet/head span off GodState, same fallback convention. */
function _targetBodyState(targetToken) {
  const st = getTokenState(targetToken);
  const feet = st ? st.elevationM : (targetToken?.document?.elevation ?? 0);
  const head = feet + (st ? st.eyeHeightM : eyeHeightForToken(targetToken));
  return { feet, head };
}

/** The ranged beam is a THIN horizontal plane at `aimZ` — the height it travels at: the dialed wheel
 *  height, the snapped target's own elevation, or the shooter's level (see template-canvas.mjs's
 *  _aimElevation). A token is hit when that height passes through its body span `[feet, head]`, so
 *  "aim at level N" hits units AT level N and not the one above. This tolerance (metres) only absorbs
 *  float rounding on the feet/head edges — it is NOT a slab. (It replaced a 2 m slab whose thickness
 *  bled a hit onto the next level up when levels sit close together — the GM's "hits a level below"
 *  report.) A ground-standing unit is still caught: aiming at a surface/token puts the plane at its
 *  feet, which lies inside [feet, head] for any height, short units included. */
const BEAM_PLANE_TOL_M = 0.3;

/** Assumed height (metres) of a STANDARD creature standing on any cell, used by
 *  meleeReachClip's floor-independent reach test. The footprint dead zone is computed as "could I
 *  reach a standard creature standing here", not "the bare floor point" (too harsh — a hammer
 *  couldn't reach a foe at the base of a 3 m ledge whose head is 1 m below your feet) and not "the
 *  actual token's body" (occupancy-dependent — a 0.25 m swarm nudged a boundary cell into a hit).
 *  A fixed value keeps it occupancy-independent while still crediting the target its height. Kept
 *  deliberately low (1 m) — a full 2 m assumed body made low units too easy to reach down onto. */
export const ASSUMED_TARGET_HEIGHT_M = 1;

/** Thin regionDoc-flavoured wrapper — the actual even-odd walk lives in blind-spot-
 *  geometry.mjs's pointInPolygonTree (shared with blind-spot.mjs's region-containment
 *  cover check) so both modules agree on one implementation. */
function _pointInRegion2D(regionDoc, x, y) {
  return pointInPolygonTree(regionDoc?.polygonTree, x, y);
}

/**
 * The target ELEVATION (scene distance units) a template endpoint at `point`
 * (world pixels) aims onto: the highest `elevation.top` among every Region
 * whose 2D footprint contains the point, or 0 when the point is over open
 * ground with no Region under it. A Region with a null/undefined top (an
 * unbounded/"infinitely tall" Region — not a normal platform) is skipped for
 * height purposes rather than treated as +∞.
 *
 * NOTE (pits / below-ground): only the platform case (aim UP onto a Region's
 * top) is resolved here for v1. Aiming DOWN into a pit — resolving to a
 * Region's `elevation.bottom` when it's below the shooter — is a deliberate
 * follow-up; today a pit Region simply contributes its `top` like any other.
 */
export function resolveTargetElevation(point) {
  let best = 0;
  for (const region of canvas.scene?.regions ?? []) {
    const top = getRegionState(region)?.topM;
    if (typeof top !== "number") continue;
    if (!_pointInRegion2D(region, point.x, point.y)) continue;
    if (top > best) best = top;
  }
  return best;
}

/**
 * The highest Region `elevation.top` encountered anywhere along the segment
 * a→b (world pixels), sampled at `samples`+1 evenly-spaced points. Used
 * instead of a single endpoint lookup so a Direct LINE's shrink can't be
 * cheated by floating the free cursor over a ground cell while the line's
 * actual path still climbs onto/through a raised Region toward the real
 * target (confirmed live: a shooter on the floor could otherwise draw a
 * full-length line at a token standing on a +5 m platform just by keeping the
 * cursor over a 0-elevation cell, since the endpoint-under-cursor read 0).
 * Whatever raised ground the line has to cross is what the reach must pay for.
 */
export function maxRegionElevationAlongSegment(a, b, samples = 24) {
  let best = resolveTargetElevation(a);
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const e = resolveTargetElevation({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    if (e > best) best = e;
  }
  return best;
}

/** The shooter's own eye level in scene distance units: its token elevation
 *  plus the size-tiered eye height blind-spot.mjs already keeps
 *  (`eyeHeightForToken`), so a 2 m-tall creature's shots originate at 2 m, not
 *  at its feet — the same height every other 3D check in this system uses. */
export function shooterEyeElevation(token) {
  return _shooterEyeState(token).eyeZ;
}

/**
 * Ranged 3D-projectile-beam hit test: which tokens does a shot aimed in the cursor's
 * DIRECTION, at the HEIGHT the cursor points at, pass through — within `reachCells`?
 *
 * The beam travels LEVEL at `aimZ` (the surface height under the cursor + 1 m) the whole
 * length of the shot — it does NOT interpolate a rising/falling ray between the shooter's
 * eye and the exact cursor point. That earlier ray model made WHO gets hit depend on how far
 * along the line the cursor happened to sit: a ground token under the line wasn't flagged
 * until the cursor was dragged near/behind it, and an elevated target was only hit when the
 * cursor sat BEYOND it, never in front — both unintuitive (reported live). With a level beam,
 * DIRECTION + aim height decide the hit, not the cursor's distance.
 *
 * The beam is a THIN horizontal plane at `aimZ` (see BEAM_PLANE_TOL_M) — a token is hit when that
 * height passes through its body span [feet, head]. "Aim at level N → hit units AT level N", not the
 * one above: no slab thickness to bleed upward. A ground-standing unit is still caught because aiming
 * at its surface/token puts the plane at its feet, inside [feet, head] for any height (short tiers
 * included). The "fly over a low target when aiming high" property survives: a plane raised to +5
 * doesn't touch a height-0 token's [0, ~1] body.
 *
 * Per token: project onto the beam's 2D direction — skip if behind, or if its sideways
 * offset exceeds its own radius plus the line's half-width. Then hit iff `aimZ` lies within its body
 * span [elevation, elevation + size-height] (± tolerance), the 3D flight distance is within reach,
 * and no wall/parapet blocks the shot (precise computeBlindSpot).
 */
export function beamHitTokenIds(shooterToken, originWorld, aimWorld, reachCells, maxAlongCells = Infinity, aimZOverride) {
  const grid = canvas.scene?.grid;
  const gridSize = grid?.sizeX || 100;
  const metresPerCell = grid?.distance || 1;
  const toM = (px) => (px / gridSize) * metresPerCell;

  const eyeZ = _shooterEyeState(shooterToken).eyeZ;
  // The height the beam travels AT — the caller normally passes it (the dialed/snapped _aimElevation);
  // the ground-under-cursor fallback is only for a bare call with no explicit height.
  const aimZ = aimZOverride ?? resolveTargetElevation(aimWorld);
  const reachM = reachCells * metresPerCell;
  const maxAlongM = Number.isFinite(maxAlongCells) ? maxAlongCells * metresPerCell : Infinity; // wall cut-off
  const lineHalfWidthM = toM(gridSize * 0.6); // matches the 1.2-cell line corridor

  const ox = toM(originWorld.x), oy = toM(originWorld.y);
  const dx = toM(aimWorld.x) - ox, dy = toM(aimWorld.y) - oy;
  const horiz = Math.hypot(dx, dy);
  if (horiz < 1e-6) return [];
  const ux = dx / horiz, uy = dy / horiz;

  const ctx = buildBlindSpotContext();
  const hits = [];
  for (const token of canvas.tokens?.placeables ?? []) {
    if (token.id === shooterToken?.id) continue;
    const at = token.actor?.type;
    if (at !== "character" && at !== "npc" && at !== "creature") continue;

    const st = getTokenState(token);
    const tokenXM = st ? st.xCells * st.metersPerCell : toM(token.center.x);
    const tokenYM = st ? st.yCells * st.metersPerCell : toM(token.center.y);
    const rx = tokenXM - ox, ry = tokenYM - oy;
    const along = rx * ux + ry * uy;           // along-beam horizontal distance (m)
    if (along <= 0) continue;                   // behind the shooter
    if (along > maxAlongM + 1e-6) continue;     // past a wall the beam is cut at
    const perp = Math.abs(rx * -uy + ry * ux);  // sideways offset from the beam (m)
    const halfWidthM = st ? (st.widthCells * st.metersPerCell) / 2 : toM((token.w ?? gridSize) / 2);
    if (perp > halfWidthM + lineHalfWidthM) continue;

    const feet = st ? st.elevationM : (token.document.elevation ?? 0);
    const head = feet + (st ? st.eyeHeightM : eyeHeightForToken(token));
    // Thin plane at aimZ: hit only if that height passes through the body span [feet, head]. Aiming at
    // a level catches units AT it, not the one above (no slab thickness bleeding upward).
    if (aimZ < feet - BEAM_PLANE_TOL_M || aimZ > head + BEAM_PLANE_TOL_M) continue;

    if (Math.hypot(along, aimZ - eyeZ) > reachM + 1e-6) continue; // out of flight range
    if (computeBlindSpot(shooterToken, token, ctx).blocked) continue; // wall/parapet in the way

    hits.push(token.id);
  }
  return hits;
}

/**
 * Would the shooter hit `target` if this weapon were aimed straight at it — the danger zone's
 * per-token predictor for line/wide_line/cone AND melee/delivered-AOE circle/square alike (one
 * shared test, 2026-08-17). Mirrors the REAL hit model exactly instead of its own approximation:
 * a HORIZONTAL-only reach check (no vertical component — climbing/dropping to a target's height
 * costs nothing, matching the flat 2D footprint every hit test has used since the 2026-08-14
 * redesign), a wall/parapet blocks outright, and the height itself must not be a clean MISS —
 * `aimHeightDamageTier` (band/flag-gated, aim-height-damage.mjs), the exact function a real roll
 * uses, decides that.
 *
 * REPLACES the old separate `beamHitsTarget`/`meleeCanReachTarget`, each of which charged 3D
 * Euclidean distance (horizontal + vertical climb) against the weapon's flat declared range —
 * `meleeCanReachTarget` via a delegated call into `meleeReachClip`, the OLD per-cell reach-shrink
 * model that stopped being the real hit test back in the 2026-08-16 circle/square unification (its
 * only remaining caller WAS this function). Both drifted from the real hit whenever a steep aim
 * angle "ate into" a reach budget the real flat-footprint test never charged for — GM repro
 * 2026-08-17: a 10m crossbow aimed at height 12 over 5m of horizontal ground read "out of range" in
 * the danger zone while the real shot (flat 2D reach + height as a pure post-hit modifier) landed a
 * full hit. Pass a shared `ctx` (buildBlindSpotContext) to avoid rescanning walls per call; `aimInfo`
 * carries the SAME shape `directionalAimInfo` returns (attackType/canHitLowFlight/canHitHighFlight)
 * plus an explicit `gapZeroM`, so the tier check is byte-for-byte what a real roll would compute.
 */
export function wouldHitIfAimed(shooterToken, target, reachCells, ctx, aimInfo = {}) {
  const grid = canvas.scene?.grid;
  const gridSize = grid?.sizeX || 100;
  const metresPerCell = grid?.distance || 1;
  const reachM = reachCells * metresPerCell;

  const targetSt = getTokenState(target);
  const aimXY = targetSt ? { x: targetSt.xCells * targetSt.gridSizeX, y: targetSt.yCells * targetSt.gridSizeY } : target.center;
  const shooterSt = getTokenState(shooterToken);
  const originXY = shooterSt ? { x: shooterSt.xCells * shooterSt.gridSizeX, y: shooterSt.yCells * shooterSt.gridSizeY } : shooterToken.center;
  const horizM = Math.hypot(aimXY.x - originXY.x, aimXY.y - originXY.y) / gridSize * metresPerCell;
  if (horizM > reachM + 1e-6) return false; // out of horizontal reach — no vertical charge

  if (computeBlindSpot(shooterToken, target, ctx ?? buildBlindSpotContext()).blocked) return false; // wall/parapet

  // Aim the height at the MOST REACHABLE point of the target's body (snapAimHeight — clamp the
  // shooter's eye line into [feet, head]), matching the live token-snap in template-canvas.mjs's
  // _aimElevation, unless a manual wheel override is in play (aimInfo.aimZOverride).
  const aimZ = aimInfo.aimZOverride ?? snapAimHeight(shooterToken, target);
  const feet = targetSt ? targetSt.elevationM : (target.document?.elevation ?? 0);
  const bodyH = targetSt ? targetSt.eyeHeightM : eyeHeightForToken(target);
  const tier = aimHeightDamageTier(
    { targetZ: aimZ, attackType: aimInfo.attackType, canHitLowFlight: aimInfo.canHitLowFlight, canHitHighFlight: aimInfo.canHitHighFlight },
    { floorZ: feet, heightM: bodyH },
    aimInfo.gapZeroM,
  ).tier;
  return tier !== "zero";
}

/**
 * Навесной (lobbed / Vertical) counterpart: a thrown AOE ARCS over walls and drops onto any
 * height, so its DELIVERY threat is purely HORIZONTAL — is the target within `reachCells` (throw
 * range + blast radius) on the flat, regardless of walls between? No wall LoS (computeBlindSpot),
 * unlike wouldHitIfAimed above — a parapet that would block a straight shot doesn't stop a lob.
 * Nearest of the target's own cells, so a large/multi-cell target uses its near edge.
 *
 * The height TIER check (2026-08-17) was added to close a long-standing open gap: the real landed
 * footprint has carried the same band/flag-gated height modifier as any other AOE since the
 * 2026-08-16 evening revision, but this predictor stayed purely horizontal until now — `aimInfo`
 * plays the same role wouldHitIfAimed's does.
 */
export function navesnoyCanReachTarget(shooterToken, target, reachCells, aimInfo = {}) {
  const grid = canvas.scene?.grid;
  const gridSize = grid?.sizeX || 100;
  const reachSq = reachCells > 0 && Number.isFinite(reachCells) ? (reachCells + 1e-6) * (reachCells + 1e-6) : Infinity;
  const shooterSt = getTokenState(shooterToken);
  const origin = shooterSt ? { x: shooterSt.xCells * shooterSt.gridSizeX, y: shooterSt.yCells * shooterSt.gridSizeY } : shooterToken.center;
  const tl = worldToGrid(target.x, target.y);
  const w = target.document?.width ?? 1, h = target.document?.height ?? 1;
  let withinReach = false;
  for (let dc = 0; dc < w && !withinReach; dc++) for (let dr = 0; dr < h; dr++) {
    const c = gridToWorld(tl.col + dc, tl.row + dr);
    const dCells = Math.hypot(c.x - origin.x, c.y - origin.y) / gridSize;
    if (dCells * dCells <= reachSq) { withinReach = true; break; }
  }
  if (!withinReach) return false;

  const targetSt = getTokenState(target);
  const aimZ = aimInfo.aimZOverride ?? snapAimHeight(shooterToken, target);
  const feet = targetSt ? targetSt.elevationM : (target.document?.elevation ?? 0);
  const bodyH = targetSt ? targetSt.eyeHeightM : eyeHeightForToken(target);
  const tier = aimHeightDamageTier(
    { targetZ: aimZ, attackType: aimInfo.attackType, canHitLowFlight: aimInfo.canHitLowFlight, canHitHighFlight: aimInfo.canHitHighFlight },
    { floorZ: feet, heightM: bodyH },
    aimInfo.gapZeroM,
  ).tier;
  return tier !== "zero";
}

/**
 * The height a directional template snaps to when AIMED at `targetToken`: the point of the target's
 * body span [feet, head] closest to the shooter's eye line — clamp(shooterEyeZ, feet, head). Aiming
 * at a unit should hit the MOST reachable part of it; snapping to the bare feet made a short unit
 * (swarm, body ~[0,1]) on the ground unreachable when the shooter stood above, because the plane sat
 * at the far bottom of its body and the vertical drop blew the reach — you had to nudge up a metre by
 * hand. Clamping to the eye line picks the part actually in reach (shooter above → the head, below →
 * the feet, level → eye height). Shared by _aimElevation (the live snap) and wouldHitIfAimed (the
 * danger-zone amber), so the ring and the shot agree. No shooter bound → the body top (a sane
 * mid/high point, since there's no eye line and no reach to satisfy).
 */
export function snapAimHeight(shooterToken, targetToken) {
  const { feet, head } = _targetBodyState(targetToken);
  if (!shooterToken) return head;
  const eyeZ = _shooterEyeState(shooterToken).eyeZ;
  return Math.max(feet, Math.min(head, eyeZ));
}

/**
 * Ids of every VISIBLE character/npc/creature token whose body span [feet, head] crosses the plane
 * at `aimZ` (± BEAM_PLANE_TOL_M) — "would a directional template set to this height catch this unit
 * IF it stood in the footprint", independent of position / reach / walls. Powers the blue height-fit
 * planning ring (see template-canvas.mjs), which makes the vertical readable on a top-down map: you
 * can tell whether a tall unit like Костедав fits a veer placed at 4 m before it ever moves in.
 * Excludes the shooter. Allies included on purpose — support/buff templates need the same prediction.
 */
export function bodyCrossesPlaneTokenIds(shooterToken, aimZ, reachCells) {
  // If the plane sits farther from the shooter's eye than the weapon's reach even STRAIGHT up/down,
  // no footprint cell can be reached (hypot ≥ the vertical gap already blows the budget) — the whole
  // template is dead at this height. Then nobody can be caught, so show no height-fit rings: they'd
  // promise a hit the red dead zone already denies (the GM's swarm-3m-below-a-ledge case).
  if (reachCells != null) {
    const metresPerCell = canvas.scene?.grid?.distance || 1;
    const reachM = (Number.isFinite(reachCells) ? reachCells : Infinity) * metresPerCell;
    const eyeZ = _shooterEyeState(shooterToken).eyeZ;
    if (Math.abs(aimZ - eyeZ) > reachM + 1e-6) return [];
  }
  const ids = [];
  for (const token of canvas.tokens?.placeables ?? []) {
    if (token.id === shooterToken?.id) continue;
    if (!token.visible) continue;
    const at = token.actor?.type;
    if (at !== "character" && at !== "npc" && at !== "creature") continue;
    const { feet, head } = _targetBodyState(token);
    if (aimZ >= feet - BEAM_PLANE_TOL_M && aimZ <= head + BEAM_PLANE_TOL_M) ids.push(token.id);
  }
  return ids;
}

/**
 * Distance (in CELLS) from `originWorld` at which a ranged beam — travelling LEVEL at
 * `aimZ` in the cursor's direction — is first stopped by a SIGHT-blocking wall taller than
 * the beam, or Infinity if nothing blocks it within `reachCells`. The caller shortens the
 * drawn line (and its hit range) to this, so a shot visibly CUTS at a wall it can't clear.
 *
 * A wall (2D segment with a Wall-Height [bottom, top] band; region auto-walls included via
 * buildBlindSpotContext) stops the beam iff the level ray at `aimZ` crosses it AND `aimZ`
 * falls inside its band AND its `top` is ABOVE where the shooter STANDS. That last clause
 * is the height rule the user asked for and the fix for "cutting on your own ledge": a wall
 * whose top the shooter is already at or above is one the shot leaves from above and clears
 * (its own +1 platform edge, a low crate), so it never cuts; only walls genuinely taller
 * than the shooter's footing — the platform faces and full walls ahead — do. Full-height
 * walls (no band) always cut. Crossings right at the origin (t≈0) are ignored.
 */
export function beamWallClip(originWorld, aimWorld, shooterToken, reachCells, aimZ, ctx) {
  const grid = canvas.scene?.grid;
  const gridSize = grid?.sizeX || 100;
  if (!(reachCells > 0)) return Infinity;
  const context = ctx ?? buildBlindSpotContext();
  const shooterFloor = _shooterEyeState(shooterToken).floor;

  const dx = aimWorld.x - originWorld.x, dy = aimWorld.y - originWorld.y;
  const horiz = Math.hypot(dx, dy);
  if (horiz < 1e-6) return Infinity;
  const ux = dx / horiz, uy = dy / horiz;
  const reachPx = reachCells * gridSize;
  const eye = { x: originWorld.x, y: originWorld.y, z: aimZ };
  const target = { x: originWorld.x + ux * reachPx, y: originWorld.y + uy * reachPx, z: aimZ };

  let nearestT = Infinity;
  for (const w of context.fullWalls ?? []) {
    const hit = intersectSegments(eye, target, w.a, w.b);
    if (hit && hit.t > 1e-4 && hit.t < nearestT) nearestT = hit.t;
  }
  for (const w of context.walls ?? []) {
    const hit = testWallAgainstRay(eye, target, w);
    if (hit && hit.blocked && hit.t > 1e-4 && hit.t < nearestT && (w.top ?? Infinity) > shooterFloor) {
      nearestT = hit.t;
    }
  }
  return Number.isFinite(nearestT) ? nearestT * reachCells : Infinity;
}

/**
 * The line-footprint cells that fall BEYOND a ranged beam's reach — its red "dead zone"
 * tail. The beam travels level at `aimZ` (see beamHitTokenIds), so its flight distance to
 * a cell is `hypot(alongHorizontal, aimZ − eyeZ)` — the constant vertical climb from the
 * eye to the aim height plus how far along the line the cell sits. A cell is dead once
 * that exceeds `reachCells`, which (since the vertical term is constant) is a clean band
 * straight across the line where the shot runs out. Cells behind the shooter are ignored.
 */
export function beamDeadZoneCells(cells, originWorld, aimWorld, shooterToken, reachCells, aimZOverride) {
  if (!cells?.length) return [];
  const grid = canvas.scene?.grid;
  const gridSize = grid?.sizeX || 100;
  const metresPerCell = grid?.distance || 1;
  const toM = (px) => (px / gridSize) * metresPerCell;

  const eyeZ = _shooterEyeState(shooterToken).eyeZ;
  const aimZ = aimZOverride ?? resolveTargetElevation(aimWorld); // the plane height (see _aimElevation); wheel/snap wins
  const reachM = reachCells * metresPerCell;
  const vert = aimZ - eyeZ; // constant vertical climb from eye to the level beam height

  const ox = toM(originWorld.x), oy = toM(originWorld.y);
  const dx = toM(aimWorld.x) - ox, dy = toM(aimWorld.y) - oy;
  const horiz = Math.hypot(dx, dy);
  if (horiz < 1e-6) return [];
  const ux = dx / horiz, uy = dy / horiz;

  const dead = [];
  for (const c of cells) {
    const center = gridToWorld(c.col, c.row);
    const along = (toM(center.x) - ox) * ux + (toM(center.y) - oy) * uy;
    if (along <= 0) continue;
    if (Math.hypot(along, vert) > reachM + 1e-6) dead.push(c);
  }
  return dead;
}

/**
 * Wall clip for a directional footprint (line/wide_line/cone) — shared by BOTH Натиск (melee)
 * and Залп (ranged) now (2026-08-15: melee's reach-shrink dead zone, `directionalReachClip`,
 * was RETIRED — no more hard reach cutoff eating cells off the far end by height; a swing can
 * be aimed at any height within the weapon-length-bounded dial range, same idea ranged already
 * uses, see aim-height-damage.mjs). This was already the ranged-only function (retired the
 * per-cell trajectory ramp/hold model 2026-08-15 the same way, see that commit) — height
 * mismatch for EITHER trajectory is now a pure damage-tier concern, computed AFTER a plain hit
 * (aimHeightDamageTier), never painted on the template itself.
 *
 * All that's left here is the one part that was never about height at all: an ordinary
 * full-height wall (`ctx.fullWalls`) still blocks line of sight to a cell outright, carved out
 * of the footprint exactly like every other AOE shape.
 */
export function directionalWallClip(cells, originWorld, ctx) {
  const context = ctx ?? buildBlindSpotContext();
  const fullWalls = context.fullWalls ?? [];
  const reachable = [];
  for (const c of cells ?? []) {
    const w = gridToWorld(c.col, c.row);
    if (!fullWalls.some((wall) => intersectSegments(originWorld, w, wall.a, wall.b))) reachable.push(c);
  }
  return { reachable };
}

/**
 * Clip a template's OUTLINE polygon (flat [x0,y0,x1,y1,…] world points) to the part
 * actually reachable from `originWorld` past SIGHT-blocking walls — so a MELEE direct3D
 * shape visually STOPS at the wall (changes shape) instead of spilling its outline onto
 * ground it can't touch. Intersects the shape polygon with Foundry's own sight visibility
 * sweep from the origin, height-aware through the `source: {object: shooter}` Wall Height
 * hook.
 *
 * MELEE ONLY, on purpose: the sweep approximates the reach as a flat plane at the
 * shooter's eye height, which is exactly right for a melee reach (a swing tops out around
 * eye height, so a [0,5] parapet it can't see over is also one it can't hit past, and a
 * [0,1] lip it clears it can also reach onto). It is WRONG for a ranged shot that RISES
 * along its trajectory above eye height (the documented over-clip — a floor archer onto a
 * raised platform), so the caller must NOT apply this to ranged beams; those keep their
 * full aiming line and resolve height per-shot in beamHitTokenIds.
 *
 * Returns the clipped flat points, an empty array if nothing is visible, or the input
 * unchanged if the sweep/clip can't run (fail-open — a missing clip is a cosmetic gap,
 * never a thrown error inside the render loop).
 */
export function clipOutlineByWalls(polygonPoints, originWorld, shooterToken) {
  const backend = CONFIG.Canvas?.polygonBackends?.sight;
  if (!backend || !polygonPoints || polygonPoints.length < 6) return polygonPoints;

  // Bound the sweep to the shape's own extent (+1 cell) instead of sweeping to the canvas
  // edges every render — cheaper, same result once intersected back against the shape.
  let r2 = 0;
  for (let i = 0; i < polygonPoints.length; i += 2) {
    const dx = polygonPoints[i] - originWorld.x, dy = polygonPoints[i + 1] - originWorld.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) r2 = d2;
  }
  const radius = Math.sqrt(r2) + (canvas.grid?.sizeX ?? 100);
  const source = shooterToken ? { object: shooterToken } : undefined;

  try {
    const sweep = backend.create(originWorld, { type: "sight", source, radius });
    const clipped = new PIXI.Polygon(polygonPoints).intersectPolygon(sweep);
    return clipped?.points ?? [];
  } catch (e) {
    console.warn("god-tactical | template outline clip failed, drawing unclipped —", e);
    return polygonPoints;
  }
}

/** √(reach² − Δh²), clamped to ≥ 0 — both arguments in the SAME unit (cells).
 *  When the vertical gap meets or exceeds the reach, nothing horizontal is
 *  left (you can only reach straight up/down). */
export function euclideanReach(reachCells, deltaHeightCells) {
  const r2 = reachCells * reachCells;
  const d2 = deltaHeightCells * deltaHeightCells;
  if (d2 >= r2) return 0;
  return Math.sqrt(r2 - d2);
}

/**
 * The height-adjusted effective reach (in CELLS) for a `direct3D` template:
 * the configured `reachCells` shrunk by the Euclidean vertical budget between
 * the shooter's own FLOOR level (`document.elevation`) and the target
 * elevation under `endpointPoint`. Returns `reachCells` unchanged when the two
 * floors are level (flat ground → identical to the old 2D behaviour).
 *
 * Floor-to-floor, NOT eye-to-floor, on purpose: comparing the shooter's EYE
 * height against the target's ground would shrink even a flat-ground reach
 * (your eyes always sit ~1.7 m above your feet), which reads as "my melee
 * lost range for no reason." The vertical gap that should cost reach is the
 * platform/pit level difference between where the two stand. Creature SIZE
 * (a tall body spans more height, so it's reachable/hittable across a wider
 * band) enters later, in per-height hit resolution — not here in the flat
 * footprint shrink. `shooterEyeElevation` stays exported for the ranged
 * projectile-line case, where the shot really does originate at eye level.
 */
export function direct3DEffectiveReach(shooterToken, endpointPoint, reachCells) {
  const grid = canvas.scene?.grid;
  const metresPerCell = grid?.distance || 1;
  const targetElev = resolveTargetElevation(endpointPoint);         // scene units
  const shooterElev = _shooterEyeState(shooterToken).floor;         // scene units (floor)
  const deltaCells = Math.abs(targetElev - shooterElev) / metresPerCell;
  return euclideanReach(reachCells, deltaCells);
}

/**
 * Line variant of `direct3DEffectiveReach`: the vertical gap is measured
 * against the HIGHEST Region the line has to cross on its way out (sampled
 * origin→full-reach tip via `maxRegionElevationAlongSegment`), not the point
 * under a single endpoint. This is the non-gameable version for a directional
 * Direct template — floating the cursor low no longer avoids the shrink,
 * because the line's own path is what's sampled, not the cursor.
 * `fullReachTip` must be the tip at the UNSHRUNK reach (origin + aim-direction
 * × reachCells), so the sampled span covers everywhere the shot could land.
 */
export function direct3DEffectiveReachLine(shooterToken, origin, fullReachTip, reachCells) {
  const grid = canvas.scene?.grid;
  const metresPerCell = grid?.distance || 1;
  const targetElev = maxRegionElevationAlongSegment(origin, fullReachTip);  // scene units
  const shooterElev = _shooterEyeState(shooterToken).floor;                 // scene units (floor)
  const deltaCells = Math.abs(targetElev - shooterElev) / metresPerCell;
  return euclideanReach(reachCells, deltaCells);
}
