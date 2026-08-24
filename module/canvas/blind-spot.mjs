/**
 * GOD Tactical — Blind Spot (height-based line of sight)
 * Foundry-facing wrapper around blind-spot-geometry.mjs: builds the
 * shooter's eye point and the target's aim point from their tokens'
 * elevation, and answers whether line of sight is blocked outright.
 * computeBlindSpot returns the blocking detail only; the tactical cover a
 * clear shot still has to punch through is a SEPARATE raycast (computeCover /
 * coverAgainstEye below), never folded in here.
 *
 * Pipeline (see computeBlindSpot):
 *  1. Ordinary full-height walls (no Wall Height "top" flag) — block at
 *     every elevation, plain 2D crossing test, no trigonometry. Checked
 *     FIRST since it's the cheapest test and short-circuits everything else.
 *  2. Height-limited parapets (tagged with flags['wall-height'].top, the
 *     soft-dependency "Wall Height" module's own convention) — the 3D
 *     nearest-first walk (see blind-spot-geometry.mjs's findBlockingWall).
 *     A wall is EITHER a full wall OR a parapet candidate, never both — the
 *     "top" flag is what sorts it into one bucket or the other, so the two
 *     passes never double-check (or disagree about) the same wall.
 *
 * (The retired Region-tag cover model — flags['god-tactical'].coverValue,
 * 0.25/0.5/1.0, once read here — was removed with the COMBAT-REDESIGN move to
 * raycast cover; nothing reads a per-Region cover value any more.)
 *
 * This deliberately does NOT call Foundry's native
 * CONFIG.Canvas.polygonBackends.sight / canvas.walls.checkCollision for the
 * full-wall pass. Every wall a GM tags for this system's own parapet math
 * also carries `sight: NORMAL` (so Wall Height's OWN vision/fog blocking
 * still works for it) — which means the native sight-collision sweep would
 * flag it as blocking too, using Wall Height's own coarser rule (observer's
 * OWN elevation vs. the wall's band) rather than this module's ray-height-
 * at-the-crossing-point math. Feeding the native sweep the same walls we're
 * about to run our own trigonometry on would silently override our nuanced
 * answer with its cruder one — exactly the "sniper leans out vs. steps
 * back" distinction this system exists to capture. Filtering the native
 * sweep down to just the non-parapet walls isn't exposed by Foundry's
 * public collision API, so the full-wall pass below reuses the same
 * intersectSegments primitive instead — plain, already unit-tested, and
 * guaranteed consistent with the parapet pass. Known gap: one-directional
 * ("window") walls are treated as blocking from both sides here, since
 * replicating Foundry's own facing math wasn't worth the risk of getting
 * the sign backwards without a live canvas to test against — flag if you
 * actually use one-directional walls and this needs tightening.
 */

import { findBlockingWall, crossesAnyWall, intersectSegments, testWallAgainstRay, pointInPolygonTree } from "./blind-spot-geometry.mjs";
import { coverLevelFromExposure, exposureFromPoints, COVER } from "../combat/combat-cover.mjs";
import { detectionModeList } from "./detection-modes-compat.mjs";
import { getTokenState, getRegionState } from "../state.mjs";

/** Height of the "waist-high cover" sample as a fraction of the target's body height — a
 *  knee/shin point below the head/mid samples. If a wall hides the target's body at THIS
 *  level (even one a taller shooter can see the torso over), the target still gets at least
 *  half cover. 0.25 → a ~1 m wall covers a 1.5 m human, a ~0.5 m curb does not. */
const LOW_BODY_RATIO = 0.25;

/** How far (metres) a target's actual head can clear a height-limited wall's top before that
 *  wall stops counting as their waist-high cover at all, no matter what LOW_BODY_RATIO's
 *  proportional knee point says. LOW_BODY_RATIO scales the knee height to the target's OWN
 *  bodyH — for a 4 m creature that puts "knee" at exactly 4×0.25=1 m, i.e. exactly a 1 m
 *  wall's own top, so the same wall that barely covers a 1.5 m human's shins reads as
 *  covering a giant's "knee" too, even though 3 of its 4 metres tower over the wall in plain
 *  view. Once the gap between the target's real head and the wall's top reaches this many
 *  metres, the wall is tactically irrelevant to that target's silhouette and must not grant
 *  cover — 2026-08-17, GM report (Костедав, 4 m, behind a 1 m wall). */
const MIN_COVER_EXPOSURE_M = 2;

/** How close (in grid cells) a wall's crossing must sit to the target for it to count as the
 *  TARGET'S waist-high cover — i.e. the target must be standing next to it, not merely in its
 *  vicinity. Stops a wall the SHOOTER hides behind (or any mid-field wall) from giving cover to
 *  an enemy standing in the open beyond it.
 *
 *  History: was 1.5 (0.75 m on this 0.5 m/cell map), which let a target ~0.6 m clear of a rack
 *  still read as ½ cover; tightened to 1.0 on 2026-08-14. 2026-08-16 evening, two more fixes:
 *  (1) the comparison itself moved from raw pixel `Math.hypot` to GRID-measured distance
 *  (`_worldDistanceM`) — raw Euclidean under-measures a diagonal approach relative to this
 *  game's own alternating-diagonal movement rule (the same class of bug already fixed in
 *  `hearsButDoesNotSee`'s range check, 2026-08-15), so a target could read as "next to" a low
 *  obstacle on one approach angle and not another for the same number of grid cells. (2) THIS
 *  distance is measured from the target's own footprint CORNER, not its cell center — a corner
 *  sits a HALF CELL closer to any wall the token faces than the token's center does, so the
 *  1.0 value effectively covered a full EMPTY cell of gap between target and obstacle as
 *  "pressed up against it" (confirmed live: a target with one clear empty cell between itself
 *  and a crate still measured exactly ~1.0 cell corner-to-wall). Tightened 1.0 → 0.5 to cancel
 *  that corner/center offset — a target genuinely touching/adjacent to the wall still measures
 *  ~0 either way, but a full empty cell of separation (~1.0 from the corner) no longer
 *  qualifies. */
const COVER_ADJACENCY_CELLS = 0.5;

const WALL_HEIGHT_SCOPE = "wall-height";

// Must match region-light-walls.mjs's own (unexported) FLAG_SCOPE/WALL_OWNER_FLAG — that
// module stamps this flag on every auto-wall it generates so a Region can be rebuilt/cleared,
// and it's reused here to trace a height-limited wall back to its source Region for cover.
const GOD_FLAG_SCOPE = "god-tactical";
const REGION_OWNER_FLAG = "autoWallForRegion";

/** Standing eye height above a token's own elevation, in metres — this
 *  system measures everything in real-world metres, NOT feet (0.5 m/cell,
 *  see config.mjs's METERS_PER_CELL). ~1.7 m is an average adult eye height;
 *  pass `options.eyeHeight` to override per call (e.g. a prone or crouched
 *  shooter). Used as-is for any token without a recognized NPCDataModel.size
 *  (PCs, or a legacy/blank size value) — see EYE_HEIGHT_METERS_BY_SIZE for
 *  everything else. */
export const DEFAULT_EYE_HEIGHT = 1.7;


/** Assumed standing/eye height per NPCDataModel.size tier (data-models.mjs; same tier
 *  names as GOD.NPC_SIZE_TIERS, config.mjs), in metres — width alone can't stand in
 *  for this, since several tiers (swarm/small/medium) share the same 1x1 token
 *  footprint. */
const EYE_HEIGHT_METERS_BY_SIZE = {
  swarm: 1,
  small: 1.5,
  medium: 2,
  large: 3,
  veryLarge: 4,
  incrediblyLarge: 6,
};

/** The size tier that governs a token's height. An NPC/Creature carries it directly on
 *  `system.size`; a Character has no own size field, so it inherits its attached RACE's
 *  size (a "small" race → the `small` tier). Null when neither is set. */
export function sizeTierForToken(token) {
  const actor = token?.actor;
  if (!actor) return null;
  const own = actor.system?.size;
  if (own) return own;
  return actor.items?.find((i) => i.type === "race")?.system?.size ?? null;
}

/** Eye height for a token acting as a shooter — resolved from its size tier (NPC/Creature
 *  `system.size`, or a Character's race size — see sizeTierForToken) against
 *  EYE_HEIGHT_METERS_BY_SIZE; anything with no recognized tier falls back to the flat
 *  DEFAULT_EYE_HEIGHT. Exported — wall-height-sync.mjs writes this same number into Foundry's
 *  own flags['wall-height'].tokenHeight so native vision/fog-of-war (which otherwise only
 *  knows a flat world-wide default, see that module's header comment) agrees with this
 *  system's own blind-spot math instead of using a different height. */
export function eyeHeightForToken(token) {
  const meters = EYE_HEIGHT_METERS_BY_SIZE[sizeTierForToken(token)];
  return meters !== undefined ? meters : DEFAULT_EYE_HEIGHT;
}

function _tokenPoint(token, heightAboveElevation) {
  const st = getTokenState(token);
  const c = st
    ? { x: st.xCells * st.gridSizeX, y: st.yCells * st.gridSizeY }
    : (token.center ?? { x: token.x, y: token.y });
  const elevation = st ? st.elevationM : (token.document?.elevation ?? token.elevation ?? 0);
  return { x: c.x, y: c.y, z: elevation + heightAboveElevation };
}

// v14 renamed CONST.WALL_SENSE_TYPES → CONST.EDGE_SENSE_TYPES (same values, old name deprecated,
// removed in v16); prefer the new one when present so this doesn't warn/break across cores.
const SENSE_TYPES = CONST.EDGE_SENSE_TYPES ?? CONST.WALL_SENSE_TYPES;

function _isBlockingDoc(doc) {
  if (doc.sight === SENSE_TYPES.NONE) return false; // never blocks sight
  if (doc.door && doc.ds === CONST.WALL_DOOR_STATES.OPEN) return false; // open door — no obstruction
  return true;
}

/** Ordinary sight-blocking walls with NO Wall Height "top" flag — full
 *  height, block at every elevation, no trigonometry needed. */
function _fullWalls() {
  const out = [];
  for (const wall of canvas.walls?.placeables ?? []) {
    const doc = wall.document;
    if (!_isBlockingDoc(doc)) continue;
    const top = doc.getFlag(WALL_HEIGHT_SCOPE, "top");
    if (top !== undefined && top !== null) continue; // height-limited — handled by _candidateWalls instead
    const [x1, y1, x2, y2] = doc.c;
    out.push({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, wallId: doc.id });
  }
  return out;
}

/** Every scene wall carrying an explicit Wall Height "top" flag — a
 *  height-limited parapet, handled by the 3D nearest-first walk instead of
 *  the plain 2D full-wall check above. */
function _candidateWalls() {
  const out = [];
  for (const wall of canvas.walls?.placeables ?? []) {
    const doc = wall.document;
    if (!_isBlockingDoc(doc)) continue;
    const top = doc.getFlag(WALL_HEIGHT_SCOPE, "top");
    if (top === undefined || top === null) continue;
    const bottom = doc.getFlag(WALL_HEIGHT_SCOPE, "bottom");
    const [x1, y1, x2, y2] = doc.c;
    out.push({
      a: { x: x1, y: y1 },
      b: { x: x2, y: y2 },
      top,
      bottom: bottom ?? -Infinity,
      wallId: doc.id,
      // Set only for a Region's own auto-generated wall (region-light-walls.mjs) — lets
      // coverAgainstEye credit the whole enclosing Region as cover instead of requiring the
      // target to hug this one exact segment (see _regionCoverApplies).
      regionId: doc.getFlag(GOD_FLAG_SCOPE, REGION_OWNER_FLAG) ?? null,
    });
  }
  return out;
}

/**
 * Full result of the blind-spot check.
 *  - `blocked` — true iff line of sight is broken outright (no attack
 *    possible at all); the plain boolean isTargetInBlindSpot exposes.
 *  - `reason` — `"wall"` (an ordinary full wall), `"parapet"` (a
 *    height-limited wall the ray failed to clear), or `null` (clear).
 *  - `eye`/`aim`/`wall`/`crossing` — debugging/UI detail: the two ray
 *    endpoints, the blocking wall (reason "parapet" only), and where the
 *    ray crossed it.
 *
 * `options.fullWalls`/`options.walls` let a caller pass pre-filtered wall
 * lists (skip the canvas scans) — mainly for many checks against one scene,
 * or testing without a live canvas.
 */
/** Pre-build the wall lists computeBlindSpot would otherwise re-scan from the
 *  canvas on every call — pass the result as its `options` when running MANY
 *  checks against the same scene (e.g. one per template cell), so the
 *  (unchanging within a single recompute) canvas scan happens once, not N
 *  times. Also fed to computeCover, which reads the same fullWalls/walls. */
export function buildBlindSpotContext() {
  return { fullWalls: _fullWalls(), walls: _candidateWalls() };
}

export function computeBlindSpot(shooterToken, targetToken, options = {}) {
  const eye = _tokenPoint(shooterToken, options.eyeHeight ?? eyeHeightForToken(shooterToken));
  // Aim point is the target's own eye/head height (2026-08-16 evening, was ~53% "center of
  // mass" — DEFAULT_TARGET_CENTER_HEIGHT/TARGET_CENTER_RATIO, now removed) — a target whose
  // head clears a low obstacle (e.g. a 1m crate below their 1.5m height) now correctly reads as
  // SEEN rather than fully blocked just because their torso doesn't clear it. Single-point test
  // still (not multi-sample like computeCover's head/mid/knee exposure) — this function answers
  // a binary "is there a line of sight at all" question for vision-obstruction.mjs (fog of war)
  // and template-3d.mjs's reach checks alike, not a granular cover amount; eye-to-eye is the
  // natural single point for that question, matching the shooter's own eye height above.
  const aim = _tokenPoint(targetToken, options.targetHeight ?? eyeHeightForToken(targetToken));

  // 1. Ordinary full-height walls block regardless of elevation — cheap
  //    2D-only check, short-circuits everything else below.
  const fullWalls = options.fullWalls ?? _fullWalls();
  if (crossesAnyWall(eye, aim, fullWalls)) {
    return { blocked: true, reason: "wall", eye, aim, wall: null, crossing: null };
  }

  // 2. Height-limited parapets — the 3D nearest-first walk.
  const walls = options.walls ?? _candidateWalls();
  const parapetHit = findBlockingWall(eye, aim, walls);
  if (parapetHit) {
    return {
      blocked: true,
      reason: "parapet",
      eye,
      aim,
      wall: parapetHit.wall,
      crossing: { x: parapetHit.x, y: parapetHit.y, z: parapetHit.rayZ },
    };
  }

  // Neither pass blocked — line of sight is clear.
  return { blocked: false, reason: null, eye, aim, wall: null, crossing: null };
}

/* -------------------------------------------- */
/*  Deterministic cover (COMBAT-REDESIGN)        */
/* -------------------------------------------- */

/** The four outer bounding corners of a token's footprint, in pixels — for a multi-cell
 *  creature these span the WHOLE footprint (not one cell), so a big target can't be fully
 *  covered by a small obstacle (see COMBAT-REDESIGN.md's giant-behind-a-tree case). */
function _footprintCorners(token) {
  const st = getTokenState(token);
  if (st) {
    const w = st.widthCells * st.gridSizeX;
    const h = st.heightCells * st.gridSizeY;
    const x = st.xCells * st.gridSizeX - w / 2;
    const y = st.yCells * st.gridSizeY - h / 2;
    return [{ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }];
  }
  const x = token.x ?? 0;
  const y = token.y ?? 0;
  const w = token.w ?? ((token.document?.width ?? 1) * (canvas.grid?.size ?? 100));
  const h = token.h ?? ((token.document?.height ?? 1) * (canvas.grid?.size ?? 100));
  return [{ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }];
}

/**
 * Deterministic cover for a shooter→target pair (COMBAT-REDESIGN.md). Casts rays from the
 * shooter's eye to the target's footprint corners at TWO body heights (head `H`, mid `H/2`,
 * both above the target's feet), classifies each sample point exposed/blocked by the real
 * 3D wall + parapet geometry, and turns the exposure fraction into a cover level via the
 * pure core (module/combat/combat-cover.mjs):
 *   "none"  — 100% exposed        → full damage
 *   "half"  — 50–99% exposed       → damage ÷2 (applyCover)
 *   "full"  — < 50% exposed        → no shot
 * Swarm collapses any partial cover to "full". This is the raycast cover model that REPLACED
 * the retired region-tag `coverValue` (a per-Region 0.25/0.5/1.0 flag, since removed); wired
 * into the AOE-template → damage path. `options.fullWalls`/`options.walls` let a caller
 * pre-pass the scans.
 *
 * @returns {{ level:"none"|"half"|"full", exposure:number, blockedByFullWall:boolean, sampled:number }}
 */
/** A shooter's eye point (world x/y + z above its own elevation) — exported so callers that
 *  test cover for a HYPOTHETICAL target position (the personal cover map) can build the eye
 *  once per enemy and reuse it across many candidate cells. */
export function shooterEye(shooterToken, eyeHeight) {
  return _tokenPoint(shooterToken, eyeHeight ?? eyeHeightForToken(shooterToken));
}

/** Body-geometry descriptor for a would-be target at some position, in the shape
 *  coverAgainstEye expects. `elevation` is the feet height; `bodyHeight`/`isSwarm` come from
 *  size (eyeHeightForToken gives the height). Corners are the footprint's outer bounds. */
export function targetGeometryAt(x, y, w, h, { elevation = 0, bodyHeight, isSwarm = false } = {}) {
  return {
    corners: [{ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }],
    feet: elevation,
    bodyH: bodyHeight ?? DEFAULT_EYE_HEIGHT,
    isSwarm,
  };
}

/** Core exposure→cover test for a given shooter eye against a target GEOMETRY (corners +
 *  feet + body height), independent of whether the target is a live token or a hypothetical
 *  cell. Rays go to each footprint corner at head (`feet+bodyH`) and mid (`feet+bodyH/2`);
 *  a corner point is exposed unless a full wall (2D) or a parapet (3D, below the ray) blocks
 *  it. The head/mid fraction drives none/half/full as before — PLUS a "waist-high" floor: a
 *  separate low sample (knee, LOW_BODY_RATIO) upgrades a "none" to at least half whenever a
 *  wall hides the target's lower body, even one the shooter can otherwise see the torso over
 *  (a tall attacker peeking down over a 1 m wall no longer reads as zero cover). See
 *  COMBAT-REDESIGN.md. */
/** Does wall `w` count as cover for a target's SPECIFIC sample point (`x,y,z`) by virtue of
 *  the target being genuinely enclosed inside the Region `w` was auto-generated for — an
 *  alternative to the segment-adjacency gate below, for region-sourced walls only
 *  (`w.regionId`, see region-light-walls.mjs). A target standing in the MIDDLE of a building
 *  is never "adjacent" to any one of its four walls despite being thoroughly enclosed by all
 *  of them together — that's the gap this covers (2026-08-17, GM ask). `z` is tested against
 *  the Region's own elevation band exactly like a normal parapet's own [bottom,top) — same as
 *  testWallAgainstRay — so a HEAD sample above a short building's top still reads as exposed
 *  (a giant's head clearing a 3 m roof) even while a lower sample on the same target is caught;
 *  callers testing the ratio-derived "knee" proxy still need MIN_COVER_EXPOSURE_M on top of
 *  this (see _lowCornerCovered) since a real z-test can't protect a heuristic point on its own.
 *  Two more guards: the SHOOTER's eye must NOT also be inside that same Region/band (two allies
 *  in the same room aren't shooting through its exterior walls at each other — an actual
 *  dividing wall between them still applies via the ordinary path, unaffected); and the target
 *  point itself must be inside the Region's 2D footprint. Returns false outright for a
 *  non-region (freestanding) wall — caller falls through to the existing adjacency test. */
function _regionCoverApplies(w, eye, x, y, z) {
  if (!w.regionId) return false;
  const region = canvas.scene?.regions?.get(w.regionId);
  if (!region) return false;
  const rs = getRegionState(region);
  const top = rs?.topM ?? Infinity;
  const bottom = rs?.bottomM ?? -Infinity;
  if (!(z < top && z >= bottom)) return false;
  if (eye.z > bottom && eye.z < top && pointInPolygonTree(region.polygonTree, eye.x, eye.y)) return false;
  return pointInPolygonTree(region.polygonTree, x, y);
}

/** Symmetric waist-high test for ONE target corner: is the corner's lower body (at `kneeZ`)
 *  hidden by a wall the TARGET is standing NEXT TO, on the SHOOTER-FACING side? Uses a 2D
 *  segment crossing (angle-free → same answer whichever side the shooter stands on). A parapet
 *  counts only if it spans the knee height (bottom ≤ kneeZ ≤ top), its crossing sits within
 *  `maxDistM` GRID-measured metres of the corner (adjacent to the target — not a wall the
 *  shooter hides behind or a mid-field one), AND the crossing is IN FRONT of the target's
 *  midline (within `dCenter` of the eye) — a wall the target hugs on the side AWAY from the
 *  shooter is behind that midline and must not grant cover. A full wall always spans the knee
 *  height. `headZ` (the target's OWN feet+bodyH) gates a wall out of this test entirely once
 *  its top sits MIN_COVER_EXPOSURE_M or more below it — see MIN_COVER_EXPOSURE_M's own
 *  comment — checked BEFORE branching into the region-enclosure test or the ordinary
 *  segment-adjacency one, since kneeZ is a ratio-derived proxy either way and needs the same
 *  sanity floor regardless of which path would otherwise credit it. */
function _lowCornerCovered(eye, corner, kneeZ, headZ, fullWalls, walls, maxDistM, dCenter) {
  const counts = (hit) =>
    _worldDistanceM(hit, corner) <= maxDistM &&
    Math.hypot(hit.x - eye.x, hit.y - eye.y) <= dCenter + 1e-6;
  for (const w of fullWalls) {
    const hit = intersectSegments(eye, corner, w.a, w.b);
    if (hit && counts(hit)) return true;
  }
  for (const w of walls) {
    if (headZ - w.top >= MIN_COVER_EXPOSURE_M) continue;
    if (_regionCoverApplies(w, eye, corner.x, corner.y, kneeZ)) return true;
    if (!(w.top >= kneeZ && (w.bottom ?? -Infinity) <= kneeZ)) continue;
    const hit = intersectSegments(eye, corner, w.a, w.b);
    if (hit && counts(hit)) return true;
  }
  return false;
}

export function coverAgainstEye(eye, geom, options = {}) {
  const fullWalls = options.fullWalls ?? _fullWalls();
  const walls = options.walls ?? _candidateWalls();
  const heights = [geom.feet + geom.bodyH, geom.feet + geom.bodyH / 2];

  // Target centre + its distance from the eye. A wall grants cover only if the ray crosses it
  // IN FRONT of this midline (crossing closer to the shooter than the centre). A wall the
  // target stands next to but on the side AWAY from the shooter sits BEYOND the midline, so it
  // must not shadow the far corners — the "the cover is on the other side but it still works"
  // bug (a unit in the open next to a wall on its far side was reading as covered).
  const n = geom.corners.length || 1;
  const cx = geom.corners.reduce((s, c) => s + c.x, 0) / n;
  const cy = geom.corners.reduce((s, c) => s + c.y, 0) / n;
  const dCenter = Math.hypot(cx - eye.x, cy - eye.y);
  const inFront = (px, py) => Math.hypot(px - eye.x, py - eye.y) <= dCenter + 1e-6;

  // Adjacency gate for a PARAPET only (height-limited "walls" — crates/rubble/low obstacles,
  // the GM's "curved wall" case), same COVER_ADJACENCY_CELLS radius the waist-high floor already
  // uses. A distant/unrelated parapet whose edge happens to graze one corner's ray produced noise
  // no player could predict from the picture — the target wasn't standing anywhere near it, so
  // the graze meant nothing tactically. Deliberately NOT applied to fullWalls: a genuine solid
  // wall blocks a ray no matter where along it it sits (same rule computeBlindSpot's own
  // crossesAnyWall uses, no adjacency there either) — only a "can be seen over/around depending
  // on exact geometry" obstacle needs "is the target actually next to it" to count. Plan recorded
  // 2026-08-14, implemented 2026-08-15 (see RECENT-CHANGES.md's sixth cover iteration).
  // GRID-measured metres (2026-08-16 evening), not raw pixel Euclidean — see
  // COVER_ADJACENCY_CELLS's own doc comment for why raw pixels made this gate trip
  // inconsistently depending on approach angle.
  const maxDistM = COVER_ADJACENCY_CELLS * (canvas.scene?.grid?.distance || 1);

  const exposedPoints = [];
  let blockedByFullWall = false;
  const blocks = (aim) => {
    for (const w of fullWalls) {
      const hit = intersectSegments(eye, aim, w.a, w.b);
      if (hit && inFront(hit.x, hit.y)) { blockedByFullWall = true; return true; }
    }
    for (const w of walls) {
      if (_regionCoverApplies(w, eye, aim.x, aim.y, aim.z)) return true;
      const r = testWallAgainstRay(eye, aim, w);
      if (r && r.blocked && inFront(r.x, r.y) && _worldDistanceM(r, aim) <= maxDistM) return true;
    }
    return false;
  };
  for (const c of geom.corners) {
    for (const z of heights) exposedPoints.push(!blocks({ x: c.x, y: c.y, z }));
  }

  const exposure = exposureFromPoints(exposedPoints);
  let level = coverLevelFromExposure(exposure, { isSwarm: geom.isSwarm });

  // Waist-high cover floor — angle-free 2D, adjacency + IN-FRONT gated (see _lowCornerCovered).
  // Only ever RAISES a "none"; the head/mid rays above still decide the half/full split.
  // SKIPPED when the target stands ABOVE the shooter's eye (on a ledge, `feet > eye.z`): its
  // lower body is behind that ledge trivially, so it's judged by torso+head (the rays) only.
  if (level === COVER.NONE && geom.feet <= eye.z) {
    const kneeZ = geom.feet + geom.bodyH * LOW_BODY_RATIO;
    const headZ = geom.feet + geom.bodyH;
    // Same half-cell slack as maxDistM's adjacency gate (COVER_ADJACENCY_CELLS), added to the
    // "in front of the midline" radius here — a cell-sized obstacle sits close enough to the
    // eye that two adjacent targets on opposite sides of it can differ in raw distance-to-centre
    // by more than this without either one meaningfully being "behind" the other (2026-08-17,
    // GM repro: two allies flanking a 2x1-cell parapet the blast landed inside of — one corner
    // failed this gate by ~1/6 cell, giving them different cover off the exact same obstacle).
    const dCenterSlack = COVER_ADJACENCY_CELLS * (canvas.grid?.sizeX || 100);
    let hidden = 0;
    for (const c of geom.corners) if (_lowCornerCovered(eye, c, kneeZ, headZ, fullWalls, walls, maxDistM, dCenter + dCenterSlack)) hidden++;
    if (geom.corners.length > 0 && hidden / geom.corners.length >= 0.5) {
      level = geom.isSwarm ? COVER.FULL : COVER.HALF;
    }
  }

  return { level, exposure, blockedByFullWall, sampled: exposedPoints.length };
}

/** A token's own configured range (scene distance units/metres) for one Detection Mode id —
 *  0 when the mode is missing/disabled (never reaches). */
function _modeRangeM(token, modeId) {
  const m = detectionModeList(token?.document).find((d) => d.id === modeId && d.enabled);
  return m?.range || 0;
}

function _tokenXY(token) {
  const st = getTokenState(token);
  if (st) return { x: st.xCells * st.gridSizeX, y: st.yCells * st.gridSizeY };
  const c = token?.center;
  return { x: c?.x ?? token?.x ?? 0, y: c?.y ?? token?.y ?? 0 };
}

/** Grid-measured distance (metres) between two world points — the SAME convention every
 *  on-screen distance label in this system already uses (template distance labels,
 *  pathMovementCost's alternating-diagonal rule), via Foundry's own `canvas.grid.measurePath`.
 *  NOT plain Euclidean: on a diagonal, raw `Math.hypot` overshoots the grid-measured value (a
 *  real bug found live 2026-08-15 — a target exactly 6 grid-metres out, matching the shooter's
 *  own Basic Sight range to the metre, read as 6.32 m of raw Euclidean distance and fell just
 *  outside range, wrongly flagging "hears but doesn't see" for a target in plain unobstructed
 *  sight). Falls back to Euclidean only if `measurePath` itself is ever unavailable. */
function _worldDistanceM(a, b) {
  try {
    const measured = canvas.grid?.measurePath?.([a, b]);
    if (Number.isFinite(measured?.distance)) return measured.distance;
  } catch { /* fall through to Euclidean below */ }
  const grid = canvas.scene?.grid;
  const gridSize = grid?.sizeX || 100;
  const metresPerCell = grid?.distance || 1;
  return (Math.hypot(a.x - b.x, a.y - b.y) / gridSize) * metresPerCell;
}

/**
 * "Hears but doesn't see" — the shooter can only place the target by sound/vibration (this
 * system's Feel Tremor mode, see range-vision.mjs), not by sight: a blind-fire shot. A
 * self-contained raycast/range test, same reasoning as computeBlindSpot/computeCover already
 * use instead of Foundry's own native visibility — Foundry only ever computes live vision
 * sources for the VIEWING client's own controlled tokens, so an arbitrary shooter↔target pair
 * (the shooter may not be the current client's controlled token at all) needs its own math.
 *   "hears" — target within the shooter's own Feel Tremor range, grid-measured 2D distance (see
 *             _worldDistanceM — NOT raw Euclidean), walls ignored entirely (Tremor is
 *             `walls:false` by design — feeling through the ground, not sighted).
 *   "sees"  — target within the shooter's own Basic Sight range (same grid-measured 2D distance)
 *             AND not blocked by computeBlindSpot (wall/parapet).
 * Returns false whenever the shooter doesn't even hear the target at all (out of Tremor range,
 * or Tremor disabled on that token) — this only flags the specific "detected by sound alone"
 * case, not "undetected entirely".
 * @returns {boolean}
 */
export function hearsButDoesNotSee(shooterToken, targetToken, options = {}) {
  if (!shooterToken || !targetToken) return false;
  const distM = _worldDistanceM(_tokenXY(shooterToken), _tokenXY(targetToken));

  const tremorRange = _modeRangeM(shooterToken, "feelTremor");
  if (tremorRange <= 0 || distM > tremorRange) return false; // can't even hear them

  const sightRange = _modeRangeM(shooterToken, "basicSight");
  if (sightRange <= 0 || distM > sightRange) return true; // out of sight range entirely → hears only

  return computeBlindSpot(shooterToken, targetToken, options).blocked; // in sight range, but blocked
}

function _targetGeom(targetToken) {
  const st = getTokenState(targetToken);
  return {
    corners: _footprintCorners(targetToken),
    feet: st ? st.elevationM : (targetToken.document?.elevation ?? targetToken.elevation ?? 0),
    bodyH: st ? st.eyeHeightM : eyeHeightForToken(targetToken), // size-based body height (same table as eye height)
    isSwarm: st ? st.sizeTier === "swarm" : targetToken.actor?.system?.size === "swarm",
  };
}

export function computeCover(shooterToken, targetToken, options = {}) {
  const eye = shooterEye(shooterToken, options.eyeHeight);
  return coverAgainstEye(eye, _targetGeom(targetToken), options);
}

/** Same cover test as computeCover, but from an explicit world point instead of a shooter
 *  token's own body — for a lobbed (Навесной) AOE, cover must be judged from where the blast
 *  itself landed (template-canvas.mjs's lobbedBlastEye), not from the shooter it arced over
 *  walls from. */
export function coverFromPoint(eyePoint, targetToken, options = {}) {
  return coverAgainstEye(eyePoint, _targetGeom(targetToken), options);
}
