/**
 * GOD Tactical — Template Canvas
 * Custom PIXI layer + pointer-handlers replacing Foundry MeasuredTemplate flow.
 */

import {
  computeCoverage,
  coverageToCells,
  resolveGeometry,
  worldToGrid,
  gridToWorld,
  gridToWorldTopLeft,
  thinLineCells,
  pathMovementCost,
  isWithinRange,
} from "./template-geometry.mjs";
import { wouldHitIfAimed, navesnoyCanReachTarget, resolveTargetElevation, beamWallClip, directionalWallClip, snapAimHeight, bodyCrossesPlaneTokenIds, ASSUMED_TARGET_HEIGHT_M } from "./template-3d.mjs";
import { computeBlindSpot, buildBlindSpotContext, eyeHeightForToken } from "./blind-spot.mjs";
import { HEIGHT_BAND_CEILING_M, HEIGHT_GAP_ZERO_M } from "../combat/aim-height-damage.mjs";
import { getActivePhaseColor, getActivePhaseEntry, setPhaseTokenLabel, PHASES } from "../combat/phase-controls.mjs";
import { getTrackerPhaseEntry, isPlanningStage } from "../combat/phase-tracker.mjs";
import { formatMeters } from "../config.mjs";
import { addLogEntry, clearMyLog, removeLogEntry, getActionLog, getSelectedApType, toggleActionsFlyout, BASE_ACTIONS } from "../combat/action-log.mjs";

const PUBLISHED_KEY = "publishedGroups";

// Shapes that aim by continuous angle toward the cursor (vertex at origin).
// Circle/square instead target a ground point (the drag-start point). All of
// them originate wherever the user clicks — no shape is locked to a token's
// position, so players/GM can freely place an attack template anywhere.
// All directional shapes resolve their HITS the same way now (see _recomputeDraw): the shape's OWN
// footprint (corridor / band / cone fan) at GROUND LEVEL, flat 2D — same cell-membership hit model
// every other AOE shape uses, for BOTH Натиск (melee) and Залп (ranged) alike. Neither models
// height on the template any more — full-height walls still carve the footprint
// (directionalWallClip) — height mismatch is a pure damage-tier concern (see
// aim-height-damage.mjs), scoped by weapon reach for melee, a flat allowance for ranged.
const DIRECTIONAL_SHAPES = new Set(["line", "wide_line", "cone"]);

// thin_line is a movement-path tool (Bresenham staircase, always exactly one
// cell wide), separate from the AOE shapes above — it bypasses shapeConfig/
// computeCoverage entirely (see _recomputeDraw).
const THIN_LINE_SHAPE = "thin_line";

// ruler is a measure-only tool — a dashed line + distance label, no coverage cells,
// never written to strokes or the action log, and never tied to a bound token (see
// _onPointerUp). It vanishes the instant the mouse button is released.
const RULER_SHAPE = "ruler";

// Attack templates only — thin_line (movement) and ruler (measurement) never trigger
// the hit indicator.
const AOE_SHAPES = new Set(["line", "wide_line", "cone", "circle", "square"]);
const HIT_INDICATOR_COLOR = 0xff2b2b; // also the red used by region-cover-overlay.mjs's own pulse ring (no-cover case)
// Danger zone: a token within the bound shooter's Basic Sight range, visible, and not
// wall-blocked — "in your sights", could be attacked. Steady amber, distinct from the red
// pulsing HIT ring (which means "the current aim hits this token right now").
const DANGER_ZONE_COLOR = 0xff8c00;
// Height-fit ring: a token whose BODY crosses a directional template's current height — "if this unit
// moves into the footprint, the height would catch it". Cool blue, dimmer than amber, purely a
// planning aid for the top-down view's invisible vertical. Priority: red (hit now) > amber (reachable
// if aimed) > blue (fits this height). Shown for allies too (support/buff templates need it).
const HEIGHT_FIT_COLOR = 0x3fb5ff;

/**
 * Privacy check: can the current user see a stroke drawn by someone else?
 * - EVERY cross-user pair (GM↔player, GM↔GM, player↔player alike) requires the owner to
 *   publish the specific group (tokenId:phase) — 2026-08-16 evening: "players always see each
 *   other's templates" was retired at the GM's explicit request. A player's own in-planning
 *   template used to be visible to every OTHER player immediately, no publish needed — visually
 *   indistinguishable from an already-revealed one, so a player had no way to tell whether they
 *   were still planning in private or not. Now it stays private (same rule a GM's already had)
 *   until that owner explicitly hits "Раскрыть другим", regardless of who's looking.
 * - Strokes without tokenId are always visible (generic annotations).
 * - Strokes without phase (legacy data) are treated as visible for backward compat.
 */
function _canSeeStroke(stroke) {
  const ownerUser = game.users.get(stroke.ownerId);
  if (!ownerUser) return false;
  if (!stroke.tokenId) return true;
  if (!stroke.phase) return true; // legacy stroke without phase → always visible
  const published = ownerUser.getFlag(FLAG_SCOPE, `${PUBLISHED_KEY}_${canvas.scene?.id ?? "none"}`) ?? [];
  return published.includes(`${stroke.tokenId}:${stroke.phase}`);
}

/** Grid cells occupied by a token — top-left square plus width/height for multi-cell tokens. */
function _tokenCells(token) {
  const gs = canvas.grid?.sizeX ?? 100;
  const tl = worldToGrid(token.x, token.y);
  const wSquares = token.document?.width  ?? Math.max(1, Math.round((token.w ?? gs) / gs));
  const hSquares = token.document?.height ?? Math.max(1, Math.round((token.h ?? gs) / gs));
  const cells = [];
  for (let dc = 0; dc < wSquares; dc++) {
    for (let dr = 0; dr < hSquares; dr++) cells.push({ col: tl.col + dc, row: tl.row + dr });
  }
  return cells;
}

/** Return the token occupying the given grid cell (any square of multi-cell tokens), or null. */
function _findTokenAtCell(cell) {
  if (!canvas.tokens?.placeables) return null;
  return canvas.tokens.placeables.find((token) =>
    _tokenCells(token).some((c) => c.col === cell.col && c.row === cell.row)
  ) ?? null;
}

/** Public wrapper around _tokenCells — grid cells a token occupies, for callers outside
 *  this module (see region-cover-overlay.mjs's own per-token hit test). */
export function getTokenCells(token) {
  return _tokenCells(token);
}

const FLAG_SCOPE = "god-tactical";
const FLAG_KEY   = "strokes";
const SELECTED_TOKENS_KEY = "selectedTokens";

function _sceneKey(base) {
  return `${base}_${canvas.scene?.id ?? "none"}`;
}

const COLOR = 0x9d00ff;
const ALPHA_FILL = 0.45;
const ALPHA_PREVIEW = 0.55;

/** Convert a Foundry user Color (string "#rrggbb", Color object, or number) to a PIXI hex number. */
function _parseColor(c) {
  if (!c) return null;
  if (typeof c === "number") return c;
  if (typeof c === "string") return parseInt(c.replace("#", ""), 16);
  // Foundry Color object has .valueOf() → number
  const n = Number(c);
  return Number.isNaN(n) ? null : n;
}

function _ownerColor(ownerId) {
  const user = game.users?.get(ownerId);
  return _parseColor(user?.color) ?? COLOR;
}

let _persistentGfx = null;
let _previewGfx = null;
let _inputCatcher = null;
let _dangerZoneGfx = null;
let _coveredCellKeys = null;
// Always null now — the directional (line/wide_line/cone) hit model went flat-2D cell membership
// 2026-08-14 (see _recomputeCoveredCells), so there's no longer a separate "beam hit" set distinct
// from cells. Left in place only because _drawDangerZone still reads it defensively (?.has); safe
// to delete outright if that read is ever cleaned up too.
let _beamHitTokenIds = null;
let _currentDraw = null;
// The hover-time AOE preview (directed/thrown), before the first click makes it a real
// _currentDraw. Exposed to _recomputeCoveredCells + getVisibleAoeStrokes exactly like
// _currentDraw so the hit-pulse and cover/blocked rings show WHO the blast catches while
// you're still aiming — not only after it's placed. Reset each _renderPreview.
let _previewDraw = null;
let _assignedToken    = null;

// Weapon-drag-to-canvas constraint (see weapon-template-drop.mjs): a one-shot armed
// draw with a max size and a range check, as opposed to the persistent, unconstrained
// multi-draw scene-controls tool below. null when no weapon template is armed.
let _weaponConstraint = null;
let _weaponEscListener = null;
let _weaponHoverPoint = null;

// Right-click actions-menu / cancel (see _onCanvasContextMenu): viewport position of the
// last right-button press, so the contextmenu that follows can tell a stationary
// right-CLICK apart from a right-DRAG (Foundry's canvas pan) and only act on the former.
let _rightDownPos = null;

// Single-vs-double right-click disambiguation (see _onCanvasContextMenu): { t, x, y } of the
// previous stationary right-click, so a second one close in time+space counts as the
// cancel/undo gesture instead of a fresh single (open-menu) click.
let _lastRightClick = null;
const RIGHT_DBL_MS = 400; // max gap between the two right-clicks of a double (ms) — also the
                           // delay before a single click's pending menu-open actually fires
const RIGHT_DBL_PX = 10;  // max travel between them (viewport px)
// Pending "open the actions menu" timer armed by a single right-click, cancelled if a second
// right-click arrives within RIGHT_DBL_MS (turning the pair into cancel/undo instead).
let _pendingActionsMenuTimer = null;

// Manual template aim-height (scene units / metres). null = auto (ground under the cursor, the
// default). The mouse wheel dials an explicit value while a shape tool is armed (see _onCanvasWheel)
// so an attack can be aimed at a flyer that has no region beneath it — the one case the ground-based
// height can't express. Feeds the beam's aimZ (see _recomputeDraw) and the cursor height badge.
let _aimElevationOverride = null;
const ELEV_WHEEL_STEP = 1; // metres per wheel notch — tune here
// Last token the cursor was over (see _onPointerMove): moving onto a NEW token drops the manual
// override so snap-to-token re-engages — the wheel is a per-spot override for empty air, not a
// permanent mode that disables snapping once touched.
let _hoveredTokenId = null;
// Last height snapped to a token (see _onPointerMove/_aimElevation): the aim height STICKS here when
// the cursor leaves the token onto empty ground, instead of dropping back to the shooter's level —
// so you keep aiming at the level you snapped to. Reset (to shooter level) only on a fresh attack.
let _lastSnapElevation = null;

// Live cursor position for the elevation readout (see _drawCursorHeightLabel), tracked
// whenever a shape tool is active even before the origin is clicked — so the player can
// sweep the map and read the ground height a template would aim at while planning, not
// only mid-drag. Cleared when the tool is put away.
let _hoverPoint = null;

/**
 * Arm a one-shot, weapon-constrained draw: same shape tool as the manual toolbar, but
 * the template's length/radius/size is PINNED at exactly maxLengthCells regardless of
 * drag distance (see _recomputeDraw) — a directional shape (line/wide_line/cone) is
 * still aimed by dragging, just no longer sized by it. rangeOrigin/rangeCells are
 * optional — when set, the shape commits on a second CLICK instead of on release (see
 * _onPointerDown/_onPointerMove), UNLESS instantPlace is also set (see below), in which
 * case the first click already commits. Used by _armCompoundPhase2 to arm a compound
 * draw's phase 2 (rangeOrigin fixed at phase 1's tip, rangeCells: Infinity, since that
 * origin is already chosen and doesn't need re-validating) — with no aiming left to do
 * (circle/square have no rotation) it renders at full fixed size the instant it's armed,
 * and the second click is a plain confirm. Also used directly by weapon-template-drop.mjs
 * for a Навесной "thrown" entry's single-stage throw (rangeOrigin/rangeCells = the bound
 * token's own position/reach, instantPlace: true — see below); its "compound"-kind
 * (Настильный) calls still pass null for both, going through compoundShape instead.
 *
 * compoundShape is the other optional field — used only for a Настильный (natisk)
 * circle/square entry, which is really TWO shapes: this call arms phase 1 (a reach line,
 * fixed exactly at reachCells like any other placed template — see
 * weapon-template-drop.mjs), and once it's placed (see _finalizeDraw), phase 2
 * (compoundShape.shape, fixed exactly at compoundShape.maxLengthCells) is armed
 * automatically via _armCompoundPhase2, anchored at phase 1's tip — no extra click
 * needed to aim it, since its origin is already fixed. Phase 1 persists as its own
 * visible stroke on the canvas.
 *
 * instantPlace is the remaining optional field — used for Навесной's (brosok) single-
 * stage throw (see weapon-template-drop.mjs's "thrown" entries): rangeOrigin/rangeCells
 * are set from the start (the bound token's own position/reach), so every pointer move
 * before the first click already renders both the fixed-size shape AND the range ruler
 * together (see _renderWeaponThrowPreview) — the first click both aims and commits in
 * one motion (see _onPointerDown), instead of needing a second confirm click like the
 * two-click compound flow above.
 *
 * Cleared automatically once the (last) shape is placed (see _finalizeDraw) or cancelled
 * (Escape / switching tools).
 * @param {{shape:string, maxLengthCells:number, rangeOrigin:({x:number,y:number}|null), rangeCells:(number|null),
 *   tokenId:string, tokenName:string, itemId:string, itemName:string, itemType:string,
 *   compoundShape:({shape:string, maxLengthCells:number}|undefined), instantPlace:(boolean|undefined),
 *   selfCentered:(boolean|undefined), anchorToken:(boolean|undefined)}} opts
 *
 * selfCentered pins the shape to the bound token's own cell (a self AOE — a Настильный
 * circle/square with rangeModifier 0) instead of a placed/thrown point: paired with
 * instantPlace + rangeCells 0, the single confirming click commits it. The origin override
 * and its preview live in _onPointerDown / _renderSelfBurstPreview.
 *
 * anchorToken pins a compound phase-1 reach line's origin to the bound token (a Настильный
 * circle/square with rangeModifier > 0): the drag only aims its direction, its length stays
 * pinned to rangeModifier, and on release phase 2 (the AOE) arms at the line's tip.
 */
export function startWeaponTemplateDraw(opts) {
  _weaponConstraint = opts;
  _assignedToken = canvas.tokens?.placeables.find((t) => t.id === opts.tokenId) ?? null;
  _aimElevationOverride = null; // each fresh attack starts on auto height; wheel re-dials
  _lastSnapElevation = null;    // ...and no sticky snap carried over from a previous attack
  setActiveShape(opts.shape);

  // Self AOE (rangeModifier 0): there's nothing to aim, reposition, or confirm — it's always
  // on the caster, and once placed it lives in the planner (removed from there, not by an
  // Esc/second click) — so place it the instant the weapon is dropped, no confirming click.
  if (opts.selfCentered && opts.instantPlace && _assignedToken) {
    const tc = worldToGrid(opts.rangeOrigin.x, opts.rangeOrigin.y);
    const origin = gridToWorld(tc.col, tc.row);
    const draw = {
      shape: opts.shape, origin, cursor: origin, aim: origin,
      tokenId: _assignedToken.id, tokenName: _assignedToken.name,
      trajectory: opts.mode ?? null, direct3D: opts.direct3D ?? false, deliveryOrigin: null,
    };
    _recomputeDraw(draw);
    _finalizeDraw(draw); // commits + clears _weaponConstraint (self has no compoundShape)
    return;
  }

  _weaponEscListener = (event) => { if (event.key === "Escape") cancelWeaponTemplateDraw(); };
  document.addEventListener("keydown", _weaponEscListener);
}

/** Cancel an armed (or in-progress) weapon-constrained draw without placing anything. */
export function cancelWeaponTemplateDraw() {
  if (!_weaponConstraint) return;
  _weaponConstraint = null;
  _weaponHoverPoint = null;
  _hoverPoint = null;
  _aimElevationOverride = null;
  _lastSnapElevation = null;
  _currentDraw = null;
  setActiveShape(null);
  _renderPreview();
  if (_weaponEscListener) {
    document.removeEventListener("keydown", _weaponEscListener);
    _weaponEscListener = null;
  }
}

/**
 * Whether double-click cancel/undo of templates is currently allowed. Permitted only
 * while templates can still legitimately change: outside combat (GM freehand drawing —
 * nothing is locked) or during a combat's "Планирование" stage — the sole stage in
 * which declarations may change, the same gate weapon-template-drop.mjs uses to allow
 * PLACING them (isPlanningStage). Once combat advances past planning, placed templates
 * are locked, so double right-click does nothing. The enforced ban on editing after
 * planning lives elsewhere; this just keeps the convenience in step with it.
 */
function _canCancelTemplates() {
  return !game.combat || isPlanningStage();
}

/**
 * The actual cancel/undo, in the order the user experiences a template's life:
 *  1. an armed weapon draw not yet placed → disarm it (before-confirm cancel),
 *  2. an in-progress manual draw (e.g. a thrown shape mid-size, before its second
 *     confirming click) → drop it without committing,
 *  3. otherwise → pop THIS user's most recently committed template (LIFO "по порядку"),
 *     removing its action-log entry with it (undoStroke does both).
 * Returns true if it did anything, so the caller only swallows the event when it acted.
 */
function _handleCancelGesture() {
  if (_weaponConstraint) { cancelWeaponTemplateDraw(); return true; }
  if (_currentDraw)      { _currentDraw = null; _renderPreview(); return true; }
  if (_getMyStrokes().length) { undoStroke(); return true; }
  return false;
}

/** Record where a right-button press began, so the following contextmenu can measure how
 *  far the pointer travelled and skip both branches when it was a pan-drag (see
 *  _onCanvasContextMenu). */
function _onCanvasRightDown(event) {
  if (event.button === 2) _rightDownPos = { x: event.clientX, y: event.clientY };
}

/** True iff there's a token (any token, not just an owned one) at the world point a raw DOM
 *  MouseEvent landed on — used to gate the right-click "open Планер actions" gesture
 *  (_onCanvasContextMenu) to genuinely EMPTY ground, so it never fires instead of Foundry's
 *  own right-click-on-a-token behavior (Token HUD). `canvasCoordinatesFromClient` is Foundry's
 *  own client-px → world-px conversion (stage.worldTransform.applyInverse) — the correct one
 *  to use here since this is a raw DOM event, not a PIXI federated one with its own `.global`
 *  (contrast _eventToPoint, used elsewhere for PIXI events). */
function _pointHasToken(event) {
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  if (point.x == null) return false;
  return !!_findTokenAtCell(worldToGrid(point.x, point.y));
}

/** Right-click on empty ground during combat's planning stage pops open the Планер's "Базовые
 *  действия фазы" flyout at the cursor; a SECOND right-click at ~the same spot within
 *  RIGHT_DBL_MS instead cancels the in-progress template or undoes the last placed one (LIFO)
 *  — the original gesture, restored here (2026-08-17 GM ask). Right-clicking a token is left
 *  untouched (Foundry's Token HUD), and a right-DRAG (canvas pan) is ignored via the down/up
 *  distance check.
 *
 *  A single click can't tell yet whether a second one is coming, so its menu-open is DELAYED
 *  by RIGHT_DBL_MS (see _pendingActionsMenuTimer) — if a qualifying second click lands before
 *  the timer fires, the pending open is cancelled and cancel/undo runs instead, so a fast
 *  double-click never visibly flashes the menu open first. Calls action-log.mjs's
 *  toggleActionsFlyout directly (this file already imports several action-log.mjs functions,
 *  e.g. addLogEntry — no new circularity introduced). */
function _onCanvasContextMenu(event) {
  const start = _rightDownPos;
  _rightDownPos = null;
  // Right-DRAG (Foundry canvas pan) — let it pass through untouched, and don't let it seed a
  // half of a double-click pair.
  if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) { _lastRightClick = null; return; }

  const prev = _lastRightClick;
  const isDouble = prev
    && (event.timeStamp - prev.t) <= RIGHT_DBL_MS
    && Math.hypot(event.clientX - prev.x, event.clientY - prev.y) <= RIGHT_DBL_PX;

  if (isDouble) {
    _lastRightClick = null; // consume the pair so a 3rd click starts a fresh single
    if (_pendingActionsMenuTimer) { clearTimeout(_pendingActionsMenuTimer); _pendingActionsMenuTimer = null; }
    if (_canCancelTemplates() && _handleCancelGesture()) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }

  _lastRightClick = { t: event.timeStamp, x: event.clientX, y: event.clientY };
  if (!(game.combat && isPlanningStage() && !_pointHasToken(event))) return; // nothing to open here

  const openAt = { x: event.clientX, y: event.clientY };
  _pendingActionsMenuTimer = setTimeout(() => {
    _pendingActionsMenuTimer = null;
    toggleActionsFlyout(openAt);
  }, RIGHT_DBL_MS);
  event.preventDefault();
  event.stopPropagation();
}

/** The height (scene units) a template AIMS at for a given point. Priority:
 *  1. manual wheel override, if dialed;
 *  2. the elevation of the TOKEN under the cursor — you aim at WHERE the unit actually is (flyer or
 *     grounded, region or none), read straight off token.elevation, so no discrete-height abstraction
 *     is needed;
 *  3. the shooter's own elevation — a level beam from where the attacker stands.
 *  Deliberately NO ground-under-cursor auto-raise any more: it lifted the template onto terrain the
 *  target might not stand on and fought the wheel/token snap.
 *
 *  Натиск (melee) clamps the RESULT to _meleeAimRange regardless of which branch produced it — a
 *  weapon's reach is a genuine physical limit, so snapping onto a token standing further above/
 *  below than the weapon can ever cover must NOT quietly let the swing exceed it (bug fixed
 *  2026-08-15: only the wheel override was clamped before, so snapping onto a real token still
 *  bypassed the weapon-length cap entirely). Ranged (Залп) deliberately keeps its snap UNCLAMPED —
 *  a shot can always fly further, so aiming at a real flyer must never be blocked by the wheel's
 *  own practical ceiling (see _onCanvasWheel) — only the manual override is capped there. */
function _aimElevation(point) {
  let z;
  if (_aimElevationOverride != null) {
    z = _aimElevationOverride;
  } else {
    const token = point ? _findTokenAtCell(worldToGrid(point.x, point.y)) : null;
    // Snap to the MOST reachable point of the target's body, not its bare feet (see snapAimHeight) —
    // otherwise a short unit (swarm) on the ground below the shooter snapped to a plane too low to reach.
    // Off any token: STICK to the last snapped height (_lastSnapElevation, kept by _onPointerMove) so
    // the aim doesn't drop back to the shooter's level the moment the cursor leaves the target; only a
    // fresh attack resets it. Nothing snapped yet → the shooter's own level.
    z = token ? snapAimHeight(_assignedToken, token) : (_lastSnapElevation ?? (_assignedToken?.document?.elevation ?? 0));
  }
  const meleeRange = _meleeAimRange();
  if (meleeRange) z = Math.min(meleeRange.max, Math.max(meleeRange.min, z));
  return z;
}

/** The height the CURRENT directional template sits at (for the height-fit ring + its cache key), or
 *  null when no directional shape is armed. Follows the same aim point _renderPreview uses. */
function _currentTemplateAimZ() {
  if (!_weaponConstraint || !DIRECTIONAL_SHAPES.has(_weaponConstraint.shape)) return null;
  return _aimElevation(_currentDraw?.aim ?? _currentDraw?.cursor ?? _hoverPoint ?? _weaponHoverPoint);
}

/** Mouse wheel over the canvas, while a template SHAPE tool is armed, dials the manual aim height
 *  up/down instead of zooming — so an attack can be pointed at a flyer with no region under it.
 *  Bind mode (Ctrl / the "Привязка токена" tool) is left alone: Ctrl already owns token binding
 *  here, and there's no template to raise. Anything else falls through to Foundry's normal zoom. */
/** Melee (Натиск) directional dial range, in scene metres — [floor − L/2, floor + H + L/2],
 *  where L is the weapon/template's own declared length and H the wielder's own body height
 *  (eyeHeightForToken). No flight, so no forgiving flat allowance like ranged's
 *  HEIGHT_GAP_ZERO_M: the swing's whole vertical arc is bounded by the weapon itself — a
 *  dagger's arc is tiny, a spear's is much wider, but neither is anywhere near 8 m. Asymmetric
 *  on purpose: swinging UP sweeps your own whole body height (free, matches the on-target band
 *  every height-tier check already grants) PLUS half the weapon beyond your head; swinging DOWN
 *  only has the weapon's own half-length below your feet to work with — your body height doesn't
 *  extend the reach a second time going down. Returns null when there's no weapon-constrained
 *  directional draw to bound (manual/GM shapes only — circle/square never dial through here,
 *  DIRECTIONAL_SHAPES stays line/wide_line/cone-only even though they share the same
 *  underlying reach/wall-clip model now, see _recomputeDraw). */
function _meleeAimRange() {
  if (!_weaponConstraint || _weaponConstraint.attackType === "ranged") return null;
  if (!DIRECTIONAL_SHAPES.has(_weaponConstraint.shape) || _weaponConstraint.maxLengthCells == null) return null;
  const metresPerCell = canvas.scene?.grid?.distance || 1;
  const weaponReachM = _weaponConstraint.maxLengthCells * metresPerCell;
  const halfWeapon = weaponReachM / 2;
  const floor = _assignedToken?.document?.elevation ?? 0;
  const bodyH = eyeHeightForToken(_assignedToken);
  return { min: floor - halfWeapon, max: floor + bodyH + halfWeapon };
}

function _onCanvasWheel(event) {
  if (!_getActiveShape() || game.godTactical?.bindTokenActive) return;
  event.preventDefault();
  event.stopPropagation();
  // First notch seeds from the CURRENT aim height (override, else the snapped token, else the
  // shooter — see _aimElevation), so the value doesn't jump; after that it's a pure ± on the override.
  // `base` can be FRACTIONAL the very first time (snapAimHeight interpolates a target's body, e.g.
  // eye/2 — nothing guarantees a whole metre), and _lastSnapElevation keeps that same fraction
  // sticky even after the cursor leaves the token. Left unrounded, that fraction rode along on
  // EVERY future ± step forever (bug: "starts drifting once you cross 8m, stays a floating number
  // even scrolling back down") — rounding the STEPPED result onto the ELEV_WHEEL_STEP grid here,
  // every single notch, snaps any fractional seed back onto whole metres on the very first turn
  // and keeps it there, regardless of what _aimElevation happened to return.
  const anchor = _currentDraw?.aim ?? _currentDraw?.cursor ?? _hoverPoint ?? _weaponHoverPoint;
  const base = _aimElevation(anchor);
  const stepped = base + (event.deltaY < 0 ? ELEV_WHEEL_STEP : -ELEV_WHEEL_STEP);
  const next = Math.round(stepped / ELEV_WHEEL_STEP) * ELEV_WHEEL_STEP;
  // Ranged (Залп) Target Z: you CAN dial below your own standing level (a shot aimed at floor
  // level or lower, e.g. down a stairwell) — no shooter-floor minimum any more (2026-08-15 fix,
  // was wrongly clamped). Only a practical ceiling remains, capped at HEIGHT_BAND_CEILING_M: the
  // world's height bands (aim-height-damage.mjs's HEIGHT_BANDS, 2026-08-17) top out there —
  // nothing above it belongs to any defined band, so dialing higher just wastes wheel notches on
  // a dead zone no real target could ever occupy. Melee (Натиск) dials within its own
  // weapon-length-bounded range instead (see _meleeAimRange) — no reach-shrink dead zone any more
  // (RETIRED directionalReachClip), height is purely this dial + the same damage-tier rule, just
  // with a much tighter zero-threshold. Anything else (no weapon constraint, or a shape/mode this
  // doesn't cover) keeps the old unbounded (min 0) behaviour.
  const meleeRange = _meleeAimRange();
  if (_weaponConstraint?.attackType === "ranged") {
    _aimElevationOverride = Math.min(HEIGHT_BAND_CEILING_M, Math.max(0, next));
  } else if (meleeRange) {
    _aimElevationOverride = Math.min(meleeRange.max, Math.max(meleeRange.min, next));
  } else {
    _aimElevationOverride = Math.max(0, next);
  }
  if (_currentDraw) _recomputeDraw(_currentDraw);
  _renderPreview();
}

/** Bind the canvas-level handlers (right-click actions-menu / double-right-click cancel-undo +
 *  wheel aim-height) to the live canvas element. Idempotent — the Foundry board canvas persists
 *  across scene changes, so a flag on it prevents double-binding when canvasReady fires again.
 *  Handlers read live module state. */
function _attachRightClickHandlers() {
  const view = canvas.app?.view;
  if (!view || view.__godRightClickBound) return;
  view.addEventListener("pointerdown", _onCanvasRightDown, { capture: true });
  view.addEventListener("contextmenu", _onCanvasContextMenu, { capture: true });
  view.addEventListener("wheel", _onCanvasWheel, { capture: true, passive: false });
  view.__godRightClickBound = true;
}

function _getActiveShape() {
  return game.godTactical?.activeShape ?? null;
}

export function setActiveShape(shape) {
  if (game.godTactical) game.godTactical.activeShape = shape;
  _updateCursor();
}

function _updateCursor() {
  const view = canvas.app?.view;
  if (!view) return;
  // Bind mode (tool button or held Ctrl) always clears the active shape, so it's
  // checked first — otherwise the cursor falls back to the shape crosshair, or default.
  if (game.godTactical?.bindTokenActive) {
    view.style.cursor = "alias";
  } else {
    view.style.cursor = _getActiveShape() ? "crosshair" : "";
  }
  _updateCatcher();
}

function _updateCatcher() {
  if (!_inputCatcher) return;
  // Catch clicks both while drawing a shape and while in bind mode (so we can hit-test
  // for a token under the click instead of Foundry's native token layer, which isn't
  // guaranteed to be interactive while our own "templates" control group is active).
  const active = !!_getActiveShape() || !!game.godTactical?.bindTokenActive;
  _inputCatcher.eventMode = active ? "static" : "none";
  _inputCatcher.visible = active;
}

function _getStrokes() {
  return game.users.reduce((acc, u) => {
    const raw = u.getFlag(FLAG_SCOPE, _sceneKey(FLAG_KEY)) ?? [];
    // Only include strokes actually owned by this user (defensive against cross-contamination)
    acc.push(...raw.filter(s => !s.ownerId || s.ownerId === u.id));
    return acc;
  }, []);
}

function _getMyStrokes() {
  const raw = game.user.getFlag(FLAG_SCOPE, _sceneKey(FLAG_KEY)) ?? [];
  // Filter out any strokes that leaked in from other users
  return raw.filter(s => !s.ownerId || s.ownerId === game.user.id);
}

async function _setStrokes(strokes) {
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(FLAG_KEY), strokes);
}

/** Token ids any connected user currently has selected (native token control, not the
 *  "Привязка токена" bind tool) on this scene — gathered from every user's own
 *  selectedTokens flag (see _syncSelectedTokens), the same broadcast-via-flag pattern
 *  strokes/phase/action-log already use so every client can render this from data it
 *  already has, with no extra socket plumbing. */
function _getHighlightedTokenIds() {
  const ids = new Set();
  for (const u of game.users) {
    const sel = u.getFlag(FLAG_SCOPE, _sceneKey(SELECTED_TOKENS_KEY)) ?? [];
    for (const id of sel) ids.add(id);
  }
  return ids;
}

let _selectionSyncTimer = null;

/** Broadcasts this client's own current token selection (debounced — a marquee-drag
 *  fires controlToken once per token toggled, not once for the whole selection) so
 *  every other client's _getHighlightedTokenIds sees it via the ordinary updateUser
 *  flag-change hook already wired to _renderPersistent below. */
function _syncSelectedTokens() {
  clearTimeout(_selectionSyncTimer);
  _selectionSyncTimer = setTimeout(async () => {
    const ids = canvas.tokens?.controlled.map((t) => t.id) ?? [];
    await game.user.setFlag(FLAG_SCOPE, _sceneKey(SELECTED_TOKENS_KEY), ids);
  }, 50);
}

function _drawCells(gfx, cells, color = COLOR, alpha = ALPHA_FILL) {
  if (!gfx || !cells?.length) return;
  const g = canvas.grid;
  const sx = g.sizeX;
  const sy = g.sizeY;
  gfx.lineStyle(0);
  gfx.beginFill(color, alpha);
  for (const { col, row } of cells) {
    const tl = gridToWorldTopLeft(col, row);
    gfx.drawRect(tl.x, tl.y, sx, sy);
  }
  gfx.endFill();
}

/**
 * Build the shapeConfig (declarative, easily-tunable data) for a drag in
 * progress. Circle/square explicitly force `snap: "center"` — the default
 * "auto" mode picks center-vs-vertex from the covered diameter's parity,
 * which for this freehand tool would flip unpredictably depending on the
 * exact (whole-cell-snapped) radius/size the player happened to drag to,
 * making it impossible to reliably center a shape on a token (tokens always
 * sit at a cell center, never a grid vertex). "auto"/"vertex" stay available
 * for future declarative presets that deliberately want a vertex-centered AOE.
 */
function _buildShapeConfig(shape, lengthCells) {
  switch (shape) {
    case "line":      return { type: "line", length: lengthCells };
    case "wide_line": return { type: "wide_line", length: lengthCells };
    case "cone":      return { type: "cone", length: lengthCells };
    case "circle":    return { type: "circle", radius: lengthCells, snap: "center" };
    // Square grows symmetrically from its center — drag distance is its half-side, like circle's radius.
    case "square":    return { type: "square", size: lengthCells * 2, snap: "center" };
    default:          return null;
  }
}

/**
 * Recompute a draw-in-progress' shapeConfig + covered cells.
 * `draw.cursor` is the live, unsnapped mouse position. For the free-form manual
 * scene-controls tool (`_weaponConstraint` null) it measures drag distance
 * (length/radius/size) same as always. For a weapon-constrained draw, the
 * template's length/radius/size is instead PINNED to exactly
 * `_weaponConstraint.maxLengthCells` regardless of how far the cursor actually
 * is — see the comment further down. `draw.aim` is the actual target fed into
 * computeCoverage: for directional shapes it tracks the cursor (so the angle
 * follows the mouse — free angle, never snapped, and still meaningful even
 * once length is pinned), but for circle/square it must stay pinned to
 * `origin` (the point clicked at pointerdown) — otherwise the shape's center
 * would drift with the cursor instead of staying anchored.
 *
 * The drag distance itself IS snapped to whole grid cells before it becomes
 * shapeConfig.length/radius/size. Feeding the raw continuous distance in
 * here would let the displayed size number and the actual highlighted cells
 * cross their own rounding thresholds at different drag positions — two
 * different mouse positions could show the identical "3" label while the
 * highlighted circle/cone/beam was visibly a different size. Snapping the
 * one underlying number that drives both the label AND computeCoverage
 * makes them the same physical size by construction, always.
 */

/**
 * Stitch an ordered list of world-space waypoints (cell centers) into ONE
 * continuous, single-step-per-move cell path — thinLineCells per consecutive
 * pair, joined without duplicating the shared cell at each seam (segment i+1's
 * own start IS segment i's end). Kept ordered and un-deduped across non-adjacent
 * segments on purpose: pathMovementCost (template-geometry.mjs) walks this list
 * pairwise and needs every consecutive pair to stay grid-adjacent, which a
 * global "seen cell" dedup would break the moment a path crosses its own earlier
 * route (a real, if unusual, case for a hand-drawn movement path).
 */
function _thinLinePathCells(waypoints) {
  if (!waypoints.length) return [];
  const first = worldToGrid(waypoints[0].x, waypoints[0].y);
  const cells = [{ col: first.col, row: first.row }];
  for (let i = 1; i < waypoints.length; i++) {
    const a = worldToGrid(waypoints[i - 1].x, waypoints[i - 1].y);
    const b = worldToGrid(waypoints[i].x, waypoints[i].y);
    const seg = thinLineCells(a.col, a.row, b.col, b.row); // seg[0] === a, already in cells
    for (let j = 1; j < seg.length; j++) cells.push(seg[j]);
  }
  return cells;
}

/** Cuts an ordered thin-line cell path down to whatever prefix fits within `maxCost`
 *  movement budget — same alternating-diagonal accounting as pathMovementCost
 *  (template-geometry.mjs), just stopping the walk the instant the NEXT step would push
 *  the running total over budget, instead of summing the whole path. Used to clamp the
 *  live cursor-following leg of a budget-constrained movement path (Рывок/Перемещение,
 *  see weapon-template-drop.mjs's maxLengthCells) so the preview visibly stops growing
 *  once the token's movement is spent, rather than previewing a path it can't afford. */
function _truncatePathToBudget(cells, maxCost) {
  if (cells.length <= 1) return cells;
  const out = [cells[0]];
  let cost = 0, diagonalCount = 0;
  for (let i = 1; i < cells.length; i++) {
    const dc = Math.abs(cells[i].col - cells[i - 1].col);
    const dr = Math.abs(cells[i].row - cells[i - 1].row);
    const isDiagonal = dc === 1 && dr === 1;
    const stepCost = isDiagonal ? ((diagonalCount + 1) % 2 === 0 ? 2 : 1) : 1;
    if (cost + stepCost > maxCost) break;
    if (isDiagonal) diagonalCount++;
    cost += stepCost;
    out.push(cells[i]);
  }
  return out;
}

function _recomputeDraw(draw) {
  if (draw.shape === THIN_LINE_SHAPE) {
    draw.shapeConfig = { type: THIN_LINE_SHAPE };
    const cursorCell = worldToGrid(draw.cursor.x, draw.cursor.y);
    const liveEnd = gridToWorld(cursorCell.col, cursorCell.row);
    // Multi-point path: draw.waypoints holds every cell the player has already
    // clicked to confirm (see _onPointerDown's THIN_LINE_SHAPE branch, which already
    // rejects any confirmed click that would blow a maxLengthCells budget — see below).
    // The LIVE cursor position is appended as one more, not-yet-confirmed leg so the
    // preview shows where the path would land if clicked/finished right now.
    const waypoints = draw.waypoints ?? [draw.origin];
    const committedCells = _thinLinePathCells(waypoints);
    let liveCells = _thinLinePathCells([waypoints[waypoints.length - 1], liveEnd]);
    // Budget-constrained draw (Рывок/Перемещение — see weapon-template-drop.mjs's
    // maxLengthCells): the confirmed waypoints are already guaranteed within budget
    // (_onPointerDown rejects a click that isn't), so only the LIVE trailing leg —
    // wherever the cursor currently is, not yet confirmed — needs clamping to
    // whatever's left, so the preview stops growing right where the budget runs out
    // instead of following the cursor past it.
    if (_weaponConstraint?.maxLengthCells != null) {
      const budgetLeft = _weaponConstraint.maxLengthCells - pathMovementCost(committedCells);
      liveCells = _truncatePathToBudget(liveCells, Math.max(0, budgetLeft));
    }
    draw.cells = committedCells.concat(liveCells.slice(1));
    const lastCell = draw.cells[draw.cells.length - 1];
    // Like the origin, the endpoint always snaps to the cell center — otherwise
    // the direction-hint line/label would land wherever the mouse happened to
    // be released within the final cell instead of the cell itself.
    draw.aim = gridToWorld(lastCell.col, lastCell.row);
    return;
  }

  if (draw.shape === RULER_SHAPE) {
    const gridSize = canvas.grid.sizeX;
    // Snap the endpoint to the target cell's center, same as thin_line and the origin
    // itself — measuring to the raw cursor position let the dashed line's visible end
    // land anywhere inside the final cell instead of on a clean, whole-cell distance.
    const cursorCell = worldToGrid(draw.cursor.x, draw.cursor.y);
    let aim = gridToWorld(cursorCell.col, cursorCell.row);
    let lengthCells = Math.round(Math.hypot(aim.x - draw.origin.x, aim.y - draw.origin.y) / gridSize);
    // Weapon-constrained ruler (only reachable via a compound weapon draw's phase 1 —
    // see startWeaponTemplateDraw's compoundShape — should that ever use a ruler again
    // instead of a line) — cap the ruler itself at rangeModifier, same as a capped line,
    // and re-snap the clamped tip so it stays a clean cell center.
    if (_weaponConstraint?.maxLengthCells != null && lengthCells > _weaponConstraint.maxLengthCells) {
      lengthCells = _weaponConstraint.maxLengthCells;
      const angle = Math.atan2(aim.y - draw.origin.y, aim.x - draw.origin.x);
      const clampedCell = worldToGrid(
        draw.origin.x + Math.cos(angle) * lengthCells * gridSize,
        draw.origin.y + Math.sin(angle) * lengthCells * gridSize,
      );
      aim = gridToWorld(clampedCell.col, clampedCell.row);
    }
    draw.shapeConfig = { type: RULER_SHAPE, length: lengthCells };
    draw.aim = aim;
    draw.cells = [];
    return;
  }

  const gridSize = canvas.grid.sizeX;
  const rawLengthCells = Math.hypot(draw.cursor.x - draw.origin.x, draw.cursor.y - draw.origin.y) / gridSize;
  let lengthCells = Math.round(rawLengthCells);
  // Weapon-constrained draw: the template is drawn at EXACTLY the weapon's declared
  // size (rangeModifier for a direct line/wide_line/cone or a Настильный reach line,
  // templateSize for a compound circle/square) — not a max the drag distance can shrink,
  // only the manual GM/player scene-controls tool (_weaponConstraint null) keeps a
  // free-form drag-to-size. A directional shape (line/wide_line/cone) still gets aimed by
  // dragging — draw.aim below still tracks the cursor for angle — only its LENGTH no
  // longer depends on drag distance. Circle/square (always reached via the compound
  // flow's phase 2, already anchored with no aiming left to do) simply renders at full
  // size the instant it's armed. The Навесной/Vertical reach RULER (RULER_SHAPE branch
  // above) is deliberately exempt from this — it stays freely draggable up to its own
  // cap, per design: only the placed template itself is locked to an exact size, not how
  // far a throw is measured.
  if (_weaponConstraint?.maxLengthCells != null) {
    lengthCells = _weaponConstraint.maxLengthCells;
  }
  draw.shapeConfig = _buildShapeConfig(draw.shape, lengthCells);
  draw.aim = DIRECTIONAL_SHAPES.has(draw.shape) ? draw.cursor : draw.origin;
  draw.cells = coverageToCells(computeCoverage(draw.shapeConfig, draw.origin, draw.aim));

  // 3D-Direct wall handling: full-height walls carve the flat footprint (directionalWallClip),
  // same function for EVERY AOE shape now (2026-08-16: circle/square unified onto the exact
  // line/wide_line/cone model, see directionalWallClip's own header). Only Настильный
  // (natisk) — Навесной arcs over walls by design, no exceptions.
  draw.unreachableCells = [];
  draw.meleeClipPolys = null;
  draw.targetZ = null;
  draw.weaponReachM = null;
  if (_weaponConstraint?.direct3D && _weaponConstraint.mode === "natisk" && _assignedToken && AOE_SHAPES.has(draw.shape)) {
    // line/wide_line/cone/circle/square, ALL alike now — flat 2D footprint, only full-height
    // walls carve it, exactly the same for melee and ranged alike. Height is a pure post-hit
    // damage-tier concern (aim-height-damage.mjs), never the template's own geometry — see
    // directionalWallClip's header for the 2026-08-15 line/cone redesign this now extends to
    // circle/square too (RETIRED circle/square's old meleeReachClip 3D reach-shrink dead zone
    // and the Навесной "Взрыв"/"Столб" vertical-volume choice built on top of it — see
    // TODO below and the brosok branch's comment).
    const footprint = coverageToCells(computeCoverage(draw.shapeConfig, draw.origin, draw.aim));
    draw.targetZ = _aimElevation(draw.aim);
    draw.weaponReachM = lengthCells * (canvas.scene?.grid?.distance || 1);

    // Delivery-beam pre-check: only ever relevant for a directed circle/square blast
    // (draw.deliveryOrigin is only ever set by weapon-template-drop.mjs's "directed" kind —
    // rangeModifier > 0 circle/square; line/wide_line/cone never set it, so this is a no-op
    // for them). Did the throw/shot physically reach the landing point AT ALL — separate
    // question from which of the blast's OWN footprint cells are wall-clipped from the
    // landing point, checked below by the same directionalWallClip every other AOE shape uses.
    // Applies regardless of attackType now (previously ranged-only, see plan review) — a
    // melee-directed blast whose delivery path is wall-blocked now also fails to land.
    let delivered = true;
    if (draw.deliveryOrigin) {
      const px = canvas.grid.sizeX;
      const aimZ = resolveTargetElevation(draw.origin) + 1;
      const cutCells = beamWallClip(draw.deliveryOrigin, draw.origin, _assignedToken, _weaponConstraint.rangeCells, aimZ);
      const centreDist = Math.hypot(draw.origin.x - draw.deliveryOrigin.x, draw.origin.y - draw.deliveryOrigin.y) / px;
      delivered = (Number.isFinite(cutCells) ? cutCells : Infinity) >= centreDist - 0.5;
    }

    if (!delivered) {
      draw.unreachableCells = footprint; // shot stopped short of the centre — nothing lands
      draw.cells = [];
    } else {
      // TODO(hitLogic): a future alternate per-entry hit-resolution logic (see items.mjs's
      // per-entry `hitLogic` field, carried onto _weaponConstraint.hitLogic, added as
      // forward-looking infrastructure — no alternate implementation exists yet) would
      // branch here instead of always calling directionalWallClip.
      const { reachable } = directionalWallClip(footprint, draw.origin);
      draw.cells = reachable;
    }
  } else if (_weaponConstraint?.mode === "brosok" && _assignedToken && AOE_SHAPES.has(draw.shape)) {
    // Навесной (lobbed) — 2026-08-16 (evening) REVISED: the throw itself still arcs over walls
    // to REACH the landing point (no delivery-beam wall check here, unlike a natisk directed
    // blast's beamWallClip pre-check above) — that IS navesnoy's one advantage, and it's already
    // covered by placement (drop-anywhere-in-reach), nothing to clip here. But once landed, the
    // footprint itself behaves EXACTLY like a natisk blast centered at the landing point:
    // full-height walls still carve it from there outward, and height-tier damage
    // (aim-height-damage.mjs, via targetZ/weaponReachM below) still applies. This REVERSES the
    // earlier same-day "Столб" call (arcs over walls AND hits at any elevation, no exceptions) —
    // the GM's later call was that "перелёт через стены" only describes the DELIVERY, not a
    // blanket exemption for the effect itself; cover/height for who's caught in the blast should
    // read like any other template of the same shape (see TODO(hitLogic) above for where a future
    // alternate hit-logic would branch instead).
    const footprint = coverageToCells(computeCoverage(draw.shapeConfig, draw.origin, draw.aim));
    draw.targetZ = _aimElevation(draw.aim);
    draw.weaponReachM = lengthCells * (canvas.scene?.grid?.distance || 1);
    const { reachable } = directionalWallClip(footprint, draw.origin);
    draw.cells = reachable;
  }
  // Unfixed drag distance — kept alongside the (possibly pinned) shapeConfig so
  // _finalizeDraw can still tell "released without ever moving the mouse" apart from a
  // deliberate aim, now that shapeConfig.length no longer drops to ~0 in that case for a
  // weapon-constrained directional shape (see _finalizeDraw's degenerate-drag guard).
  draw.rawLengthCells = rawLengthCells;
}

/** PIXI.Graphics has no dashed lineStyle — fake it with alternating moveTo/lineTo segments. */
function _drawDashedLine(gfx, from, to, dashLen = 14, gapLen = 9) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001) return;
  const ux = dx / dist;
  const uy = dy / dist;
  let drawn = 0;
  let isDash = true;
  while (drawn < dist) {
    const segLen = Math.min(isDash ? dashLen : gapLen, dist - drawn);
    if (isDash) {
      gfx.moveTo(from.x + ux * drawn, from.y + uy * drawn);
      gfx.lineTo(from.x + ux * (drawn + segLen), from.y + uy * (drawn + segLen));
    }
    drawn += segLen;
    isDash = !isDash;
  }
}

/** Fill a resolved shape geometry (solid), for use as a PIXI mask that clips
 *  the blocky per-cell red "unreachable" fill down to the template's own
 *  outline — so red never spills past the shape and the partial edge cells get
 *  cropped to the shape instead of drawn as full squares. */
function _fillShapeGeometry(gfx, geometry) {
  switch (geometry.kind) {
    case "polygon":
      gfx.drawPolygon(geometry.vertices.flatMap((v) => [v.x, v.y]));
      break;
    case "fan":
      gfx.moveTo(geometry.origin.x, geometry.origin.y);
      for (const v of geometry.arc) gfx.lineTo(v.x, v.y);
      gfx.lineTo(geometry.origin.x, geometry.origin.y);
      gfx.closePath();
      break;
    case "circle":
      gfx.drawCircle(geometry.center.x, geometry.center.y, geometry.radius);
      break;
    case "square":
      gfx.drawRect(
        geometry.center.x - geometry.halfSize,
        geometry.center.y - geometry.halfSize,
        geometry.halfSize * 2,
        geometry.halfSize * 2,
      );
      break;
  }
}

function _drawShapeOutline(gfx, stroke, color, lineAlpha = 1, lineWidth = 3, overridePolys = null) {
  if (!stroke.shapeConfig) return;
  gfx.lineStyle(lineWidth, color, lineAlpha);

  // Movement path: a polyline through every waypoint the player clicked (see
  // _onPointerDown's THIN_LINE_SHAPE branch), plus the live/final leg to
  // stroke.aim — showing the intended route; the actual step-by-step path is the
  // cell fill. A dot at every vertex (not just start/end) marks each confirmed
  // click, since the thin line alone is easy to lose track of at a glance. Radius
  // scales with lineWidth (not a fixed size) so the selected-token glow's
  // wider/narrower passes (see _renderStroke) nest into visible concentric rings
  // around each dot instead of just fully overlapping it.
  if (stroke.shape === THIN_LINE_SHAPE) {
    const waypoints = stroke.waypoints?.length ? stroke.waypoints : [stroke.origin];
    const pts = [...waypoints, stroke.aim];
    gfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x, pts[i].y);

    const dotRadius = lineWidth * 2.2;
    gfx.lineStyle(0);
    gfx.beginFill(color, lineAlpha);
    for (const p of pts) gfx.drawCircle(p.x, p.y, dotRadius);
    gfx.endFill();
    return;
  }

  // Ruler: dashed line, no coverage geometry (it's not an attack template) — plus
  // endpoint dots, same treatment as thin_line above, so the measured span's ends
  // are as easy to spot at a glance as a movement path's.
  if (stroke.shape === RULER_SHAPE) {
    _drawDashedLine(gfx, stroke.origin, stroke.aim);

    const dotRadius = lineWidth * 2.2;
    gfx.lineStyle(0);
    gfx.beginFill(color, lineAlpha);
    gfx.drawCircle(stroke.origin.x, stroke.origin.y, dotRadius);
    gfx.drawCircle(stroke.aim.x, stroke.aim.y, dotRadius);
    gfx.endFill();
    return;
  }

  // direct3D shapes pass their wall-shadow-carved outline polygons (meleeClipPolys — set for
  // BOTH melee reach and the ranged beam now) as `overridePolys` — the shape is cut by the wall's
  // shape, keeping its own form, instead of the full nominal outline. Nothing in the way, and
  // non-direct3D strokes, get null and fall through to nominal.
  if (overridePolys?.length) {
    for (const poly of overridePolys) if (poly.length >= 6) gfx.drawPolygon(poly);
    return;
  }

  const geometry = resolveGeometry(stroke.shapeConfig, stroke.origin, stroke.aim);

  switch (geometry.kind) {
    case "polygon": {
      const pts = geometry.vertices.flatMap((v) => [v.x, v.y]);
      gfx.drawPolygon(pts);
      break;
    }
    case "fan": {
      gfx.moveTo(geometry.origin.x, geometry.origin.y);
      for (const v of geometry.arc) gfx.lineTo(v.x, v.y);
      gfx.lineTo(geometry.origin.x, geometry.origin.y);
      gfx.closePath();
      break;
    }
    case "circle": {
      gfx.drawCircle(geometry.center.x, geometry.center.y, geometry.radius);
      break;
    }
    case "square": {
      gfx.drawRect(
        geometry.center.x - geometry.halfSize,
        geometry.center.y - geometry.halfSize,
        geometry.halfSize * 2,
        geometry.halfSize * 2,
      );
      break;
    }
  }
}

/**
 * Size the stroke reports to the player, in grid cells — read straight from
 * its declarative config. Safe to read directly (and guaranteed to match the
 * actual highlighted cells exactly) because _recomputeDraw already snaps the
 * drag distance to a whole cell count before building shapeConfig.
 */
function _getCellCount(stroke) {
  // Movement budget cost, alternating diagonal rule (1-2-1-2): orthogonal
  // steps cost 1, every SECOND diagonal step in the path costs 2.
  if (stroke.shape === THIN_LINE_SHAPE) return pathMovementCost(stroke.cells ?? []);
  const cfg = stroke.shapeConfig;
  if (!cfg) return 0;
  if (cfg.length != null) return cfg.length;
  if (cfg.radius != null) return cfg.radius;
  if (cfg.size != null) return cfg.size;
  return 0;
}

function _drawDistanceLabel(container, stroke) {
  const dist = _getCellCount(stroke);
  if (dist <= 0) return;

  const g = canvas.grid;
  const fontSize = Math.max(14, Math.min(g.sizeX, g.sizeY) * 0.55);

  const style = new PIXI.TextStyle({
    fontFamily: "Signika",
    fontSize: fontSize,
    fontWeight: "bold",
    fill: "#ffffff",
    stroke: "#000000",
    strokeThickness: Math.max(2, fontSize * 0.15),
    // Miter (default) join spikes out at tight inner corners — e.g. the "М"
    // notch — as sharp black horns. Round join keeps the outline flush.
    lineJoin: "round",
    align: "center",
  });

  // dist is the size in whole cells; show it to the player in metres (1 cell = 0.5 м).
  const text = new PIXI.Text(formatMeters(Math.round(dist)), style);
  text.anchor.set(0.5);
  text.eventMode = "none";

  let x, y;
  if (DIRECTIONAL_SHAPES.has(stroke.shape) || stroke.shape === THIN_LINE_SHAPE || stroke.shape === RULER_SHAPE) {
    x = (stroke.origin.x + stroke.aim.x) / 2;
    y = (stroke.origin.y + stroke.aim.y) / 2;
  } else {
    // Circle/square target their own center (stroke.aim === stroke.origin) — show the
    // label above the shape's own top edge instead, so it isn't hidden under the click point.
    const geometry = resolveGeometry(stroke.shapeConfig, stroke.origin, stroke.aim);
    const reach = geometry.radius ?? geometry.halfSize ?? 0;
    x = geometry.center.x;
    y = geometry.center.y - reach;
  }

  text.position.set(x, y);
  container.addChild(text);
}

/** Format a scene-unit elevation (already in metres — see resolveTargetElevation) with
 *  an "м" suffix, trimming a trailing .0 (5 → "5 м", 2.5 → "2.5 м"). */
function _fmtElev(m) {
  const n = Number(m) || 0;
  return `${Number.isInteger(n) ? String(n) : n.toFixed(1)} м`;
}

/**
 * Small elevation readout pinned just off the cursor while a shape tool is active: the
 * ground height (the highest Region `elevation.top` under the point, else 0 — same
 * resolveTargetElevation every 3D attack check uses) at the point the template AIMS at
 * — the cursor for a directional shape, the shape's own centre (origin) for a circle/
 * square. The flat outline alone can't show WHAT HEIGHT a template is pointed at, so a
 * shot planned onto a +5 m platform looked identical to one on the floor; this makes the
 * target height explicit for planning. When a shooter token is bound (see "Привязка
 * токена") and its own floor sits at a different level, the signed vertical gap is
 * appended (+/−), since that difference is exactly what a 3D shot's reach has to pay for.
 */
function _drawCursorHeightLabel(container, point) {
  if (!point) return;
  // Show the height the template actually AIMS at (_aimElevation — the true plane), tagged so the
  // player knows WHY: "(задано)" = dialed on the wheel, "(цель)" = snapped to the token under the
  // cursor (its most reachable body point, see snapAimHeight — so a swarm on the ground can read
  // e.g. "выс. 1" when the shooter reaches its head), no tag = the shooter's own level.
  const elev = _aimElevation(point);
  let tag = "";
  if (_aimElevationOverride != null) tag = " (задано)";
  else if (point && _findTokenAtCell(worldToGrid(point.x, point.y))) tag = " (цель)";

  const g = canvas.grid;
  const fontSize = Math.max(12, Math.min(g.sizeX, g.sizeY) * 0.34);

  let label = `выс. ${_fmtElev(elev)}${tag}`;
  const shooterElev = _assignedToken?.document?.elevation;
  if (typeof shooterElev === "number" && Math.abs(shooterElev - elev) > 1e-6) {
    const delta = elev - shooterElev;
    label += `  (${delta > 0 ? "+" : "−"}${_fmtElev(Math.abs(delta))})`;
  }

  const style = new PIXI.TextStyle({
    fontFamily: "Signika",
    fontSize,
    fontWeight: "bold",
    // Light-blue tint so the elevation reads as a distinct value from the white size/
    // distance label the same template already draws (see _drawDistanceLabel).
    fill: "#7fd6ff",
    stroke: "#000000",
    strokeThickness: Math.max(2, fontSize * 0.18),
    lineJoin: "round",
    align: "left",
  });
  const text = new PIXI.Text(label, style);
  // Bottom-left anchored and nudged up/right of the cursor, so the readout floats just
  // above-right of the pointer instead of sitting under it.
  text.anchor.set(0, 1);
  text.eventMode = "none";
  text.position.set(point.x + g.sizeX * 0.35, point.y - g.sizeY * 0.15);
  container.addChild(text);
}

/** A small white "×" at `point` — during phase 1 of a compound weapon draw (a real
 *  Настильный line, dragged at a free angle), this previews exactly which cell phase 2's
 *  circle/square will anchor at (see _compoundTip) the moment the player releases,
 *  instead of leaving them to guess from the line's rotated outline alone. Deliberately
 *  white/high-contrast rather than the phase color the outline/fill already use — and
 *  not red, which HIT_INDICATOR_COLOR already means "this hit" elsewhere on this layer. */
function _drawAnchorMarker(container, point, color = 0xffffff) {
  const g = canvas.grid;
  const half = Math.min(g.sizeX, g.sizeY) * 0.18;

  const gfx = new PIXI.Graphics();
  gfx.lineStyle(3, color, 1);
  gfx.moveTo(point.x - half, point.y - half);
  gfx.lineTo(point.x + half, point.y + half);
  gfx.moveTo(point.x + half, point.y - half);
  gfx.lineTo(point.x - half, point.y + half);
  container.addChild(gfx);
}

function _renderStroke(container, stroke, color, alpha, outlineColor, highlighted = false) {
  // Ruler has no coverage cells by design (it's a measurement, not an area template) —
  // only bail here for a stroke with neither cells NOR real geometry to draw.
  const hasGeometry = !!(stroke.origin && stroke.shapeConfig);
  if (!stroke.cells?.length && !hasGeometry) return;

  const border = outlineColor ?? color;

  // Legacy strokes (pre-rewrite, lacking .origin/.shapeConfig) get a plain cell fill —
  // they're transient per-scene data cleared every combat round, not worth a dual renderer.
  if (!hasGeometry) {
    const cellsGfx = new PIXI.Graphics();
    _drawCells(cellsGfx, stroke.cells, color, 0.7);
    container.addChild(cellsGfx);
    return;
  }

  // meleeClipPolys (wall-shadow-carved outline polygons) is permanently null now for every AOE
  // shape (2026-08-16: circle/square's old meleeReachClip-based outline clip was retired along
  // with the rest of its 3D reach-shrink model) — dormant field, kept in the stroke schema in
  // case a future alternate hit-logic resurrects it (see items.mjs's per-entry `hitLogic`). Null here just means
  // "draw the nominal shape", same as it always did for line/wide_line/cone.
  const clipPolys = stroke.meleeClipPolys?.length ? stroke.meleeClipPolys : null;

  // Unreachable fill: paint red the part of the footprint that never landed at all. The ONLY
  // producer left is an undelivered directed circle/square blast (the delivery beam was
  // wall-blocked before reaching the landing point — see _recomputeDraw) — the WHOLE footprint
  // paints red in that case, nothing partial. Line/wide_line/cone and Навесной (any shape)
  // never populate this any more (no per-cell height dead zone exists anywhere in the template
  // geometry today — height is a post-hit damage-tier concern, aim-height-damage.mjs).
  if (AOE_SHAPES.has(stroke.shape) && stroke.unreachableCells?.length) {
    // Dead-zone fill — INVERTED from the old "red cell rects cropped to the outline". There the
    // blocky per-cell union stopped a partial cell short of the smooth outline (cells whose centre
    // fell outside the shape were never painted), leaving a ragged gap along the shape's angled
    // edges. Now the FILL itself IS the shape — its exact outline, or the wall-cut clipPolys — so it
    // meets the edge cleanly and can NEVER spill past the template; a mask built from the dead-zone
    // cells then carves out WHICH part of the shape is filled. The mask cells are inflated by half a
    // cell so their union closes up to the outline (filling the ragged gap) instead of ending on a
    // blocky step. Inflation only bleeds a hair across the reach cutoff on the INNER side; the
    // outer edge is still hard-capped by the shape fill, which is the whole point.
    //
    // Single colour for every AOE (2026-08-17, reverted an earlier two-colour ORANGE/RED split):
    // red just means "this part doesn't reach" — a genuine dead zone now, not a graded exemption.
    const redGfx = new PIXI.Graphics();
    redGfx.lineStyle(0);
    redGfx.beginFill(HIT_INDICATOR_COLOR, 0.4);
    if (clipPolys) for (const poly of clipPolys) redGfx.drawPolygon(poly);
    else _fillShapeGeometry(redGfx, resolveGeometry(stroke.shapeConfig, stroke.origin, stroke.aim));
    redGfx.endFill();

    const g = canvas.grid, sx = g.sizeX, sy = g.sizeY, pad = Math.min(sx, sy) * 0.5;
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff);
    for (const { col, row } of stroke.unreachableCells) {
      const tl = gridToWorldTopLeft(col, row);
      mask.drawRect(tl.x - pad, tl.y - pad, sx + 2 * pad, sy + 2 * pad); // half-cell inflate closes the edge gap
    }
    mask.endFill();
    container.addChild(mask);
    redGfx.mask = mask;
    container.addChild(redGfx);
  }

  // Selected-token highlight (see _getHighlightedTokenIds): a black-edged white halo
  // drawn behind the template's own outline — black first (wider), white on top
  // (narrower), same trick as map-pin/text outlines use for contrast against any
  // background: the black ring reads against a light map, the white ring reads against
  // a dark one, so at least one half of the pair always stands out regardless of what's
  // under it. The template itself still reads with its normal color, just called out.
  // Never reveals a stroke _canSeeStroke would otherwise hide (the caller only ever
  // passes highlighted for strokes already past that check — see _renderPersistent).
  if (highlighted) {
    const glowOuter = new PIXI.Graphics();
    _drawShapeOutline(glowOuter, stroke, 0x000000, 0.65, 12, clipPolys);
    container.addChild(glowOuter);

    const glowInner = new PIXI.Graphics();
    _drawShapeOutline(glowInner, stroke, 0xffffff, 0.9, 7, clipPolys);
    container.addChild(glowInner);
  }

  const outline = new PIXI.Graphics();
  _drawShapeOutline(outline, stroke, border, 1.0, highlighted ? 4 : 3, clipPolys);
  container.addChild(outline);

  _drawDistanceLabel(container, stroke);
}

function _renderPersistent() {
  if (!_persistentGfx) return;
  for (let i = _persistentGfx.children.length - 1; i >= 0; i--) {
    _persistentGfx.children[i].destroy({ children: true });
  }
  _persistentGfx.removeChildren();
  // Global hide: scene-flag, GM toggles → clears canvas for everyone
  if (!canvas.scene?.getFlag(FLAG_SCOPE, "globalHide")) {
    const highlightedTokens = _getHighlightedTokenIds();
    for (const s of _getStrokes()) {
      // Privacy: can this user see someone else's templates?
      if (s.ownerId !== game.user.id && !_canSeeStroke(s)) continue;
      const highlighted = !!s.tokenId && highlightedTokens.has(s.tokenId);
      _renderStroke(_persistentGfx, s, s.color ?? COLOR, ALPHA_FILL, _ownerColor(s.ownerId), highlighted);
    }
  }
  _recomputeCoveredCells();
  Hooks.callAll("godTactical.strokesChanged");
}

/** Live dashed ruler from the bound token to the cursor, shown only while a thrown
 *  (circle/square) weapon template is armed but not yet being dragged (see
 *  _onPointerMove/startWeaponTemplateDraw) — lets the player judge whether a spot is
 *  within the weapon's throw range before clicking. Color signals in/out of range. */
function _renderWeaponRangeRuler() {
  const origin = _weaponConstraint.rangeOrigin;
  const point = _weaponHoverPoint;
  const gridSize = canvas.grid.sizeX;
  const distCells = Math.round(Math.hypot(point.x - origin.x, point.y - origin.y) / gridSize);
  const inRange = distCells <= _weaponConstraint.rangeCells;
  const color = inRange ? 0x39ff14 : 0xff2b2b;

  const gfx = new PIXI.Graphics();
  gfx.lineStyle(2, color, 0.8);
  _drawDashedLine(gfx, origin, point, 10, 7);
  _previewGfx.addChild(gfx);

  const fontSize = Math.max(14, Math.min(gridSize, canvas.grid.sizeY) * 0.5);
  const style = new PIXI.TextStyle({
    fontFamily: "Signika",
    fontSize,
    fontWeight: "bold",
    fill: inRange ? "#39ff14" : "#ff2b2b",
    stroke: "#000000",
    strokeThickness: Math.max(2, fontSize * 0.15),
    lineJoin: "round",
    align: "center",
  });
  const text = new PIXI.Text(formatMeters(distCells), style);
  text.anchor.set(0.5);
  text.eventMode = "none";
  text.position.set((origin.x + point.x) / 2, (origin.y + point.y) / 2);
  _previewGfx.addChild(text);
}

/** Live preview for a single-stage thrown weapon (see startWeaponTemplateDraw's
 *  instantPlace): the range ruler (via _renderWeaponRangeRuler) PLUS the fixed-size
 *  circle/square template itself at the (grid-snapped) hover cell — both update together
 *  on every pointer move, so the player sees exactly what a click will place before they
 *  place it. Runs the full _recomputeDraw (2026-08-16 evening, same fix as
 *  _renderDirectedPreview already had) so the preview's wall-clip/targetZ/weaponReachM — and
 *  therefore the hit-pulse/cover-overlay rings drawn from `_previewDraw` while still aiming —
 *  already match what a click will actually commit. Before this, the preview built a bare
 *  `{shape, shapeConfig, origin, aim, cells}` with no targetZ at all, so height-tier damage
 *  silently never applied while aiming (always read FULL) even though the committed stroke
 *  computed it correctly — caught live: the GM aimed a lob at a token clearly above/below the
 *  landing height and the ring stayed red the whole time, only proven a bug by comparing
 *  against the committed math directly. */
function _renderWeaponThrowPreview() {
  _renderWeaponRangeRuler();

  const shape = _getActiveShape();
  if (!shape || _weaponConstraint?.maxLengthCells == null) return;

  const cell = worldToGrid(_weaponHoverPoint.x, _weaponHoverPoint.y);
  const origin = gridToWorld(cell.col, cell.row);

  const draw = {
    shape, origin, cursor: origin, aim: origin,
    tokenId: _assignedToken?.id ?? null,
    tokenName: _assignedToken?.name ?? null,
    trajectory: _weaponConstraint.mode ?? null,
    direct3D: _weaponConstraint.direct3D ?? false,
    // Missing here was the ACTUAL bug behind the "preview always reads zero/crosshair, commit
    // is fine" report (2026-08-16 evening) — directionalAimInfo reads this off the in-progress
    // draw, and combineAttackOutcome's gapZeroM picks Залп's forgiving flat 10m allowance only
    // when attackType === "ranged"; missing here it silently fell back to Натиск's tiny
    // weaponReachM/2 threshold (e.g. ~0.5m for a small-radius blast) for EVERY preview, so
    // almost any real height gap hard-zeroed while only aiming. The committed stroke always had
    // this right (_finalizeDraw's own stroke object sets it from _weaponConstraint) — only the
    // live in-progress draw object was missing it.
    attackType: _weaponConstraint.attackType ?? null,
    // Same reasoning as attackType above, for the height-band gate (aim-height-damage.mjs) —
    // without these the live preview would wrongly hard-zero any in-band flying target while
    // still aiming, even though the committed stroke (which reads them off _weaponConstraint
    // directly) would score it correctly.
    canHitLowFlight: _weaponConstraint.canHitLowFlight ?? false,
    canHitHighFlight: _weaponConstraint.canHitHighFlight ?? false,
  };
  _recomputeDraw(draw);
  _previewDraw = draw; // mark caught tokens while aiming a lob too
  _renderStroke(_previewGfx, draw, getActivePhaseColor() ?? COLOR, ALPHA_PREVIEW, _ownerColor(game.user.id));
}

/** Live preview for a self-centered AOE (see startWeaponTemplateDraw's selfCentered):
 *  the fixed-size shape pinned to the bound token's own cell — no range ruler, since it's
 *  on self. A cone rotates to face the hover cursor (its aim), so the player can pick a
 *  facing before the confirming click; circle/square stay centered regardless. */
function _renderSelfBurstPreview() {
  const shape = _getActiveShape();
  if (!shape || _weaponConstraint?.maxLengthCells == null || !_weaponConstraint?.rangeOrigin) return;

  const tc = worldToGrid(_weaponConstraint.rangeOrigin.x, _weaponConstraint.rangeOrigin.y);
  const origin = gridToWorld(tc.col, tc.row);
  const aim = (shape === "cone") ? (_weaponHoverPoint ?? origin) : origin;
  const shapeConfig = _buildShapeConfig(shape, _weaponConstraint.maxLengthCells);
  if (!shapeConfig) return;

  const preview = {
    shape, shapeConfig, origin, aim,
    cells: coverageToCells(computeCoverage(shapeConfig, origin, aim)),
  };
  _renderStroke(_previewGfx, preview, getActivePhaseColor() ?? COLOR, ALPHA_PREVIEW, _ownerColor(game.user.id));
}

/** The (grid-snapped) blast-center a directed AOE lands at: `rangeCells` (the delivery
 *  distance) out from the caster in the direction of `aimPoint`. A click/hover right on
 *  the caster falls back to straight-out (+x) so there's always a direction. */
function _directedBlastOrigin(aimPoint) {
  const c = _weaponConstraint.rangeOrigin;
  let dx = aimPoint.x - c.x, dy = aimPoint.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
  const gridSize = canvas.grid.sizeX;
  const target = { x: c.x + dx * _weaponConstraint.rangeCells * gridSize, y: c.y + dy * _weaponConstraint.rangeCells * gridSize };
  const tc = worldToGrid(target.x, target.y);
  return gridToWorld(tc.col, tc.row);
}

/** Live preview for a directed AOE (see startWeaponTemplateDraw's directedFromToken): the
 *  fixed-size blast previews at `rangeCells` from the caster in the hover direction, with a
 *  solid delivery line drawn from the unit to it — the player aims the direction, the
 *  distance is fixed, one click commits. Runs the full _recomputeDraw so the preview already
 *  shows the blast's dead zone (out-of-reach cells), same as the committed stroke will. */
function _renderDirectedPreview() {
  const shape = _getActiveShape();
  if (!shape || _weaponConstraint?.maxLengthCells == null || !_weaponConstraint?.rangeOrigin) return;

  const c = _weaponConstraint.rangeOrigin;
  const origin = _directedBlastOrigin(_weaponHoverPoint);

  const lineGfx = new PIXI.Graphics();
  lineGfx.lineStyle(2, getActivePhaseColor() ?? COLOR, 0.7);
  lineGfx.moveTo(c.x, c.y);
  lineGfx.lineTo(origin.x, origin.y);
  lineGfx.eventMode = "none";
  _previewGfx.addChild(lineGfx);

  const draw = {
    shape, origin, cursor: origin, aim: origin,
    deliveryOrigin: c,
    tokenId: _assignedToken?.id ?? null,
    tokenName: _assignedToken?.name ?? null,
    trajectory: _weaponConstraint.mode ?? null,
    direct3D: _weaponConstraint.direct3D ?? false,
    // See _renderWeaponThrowPreview's identical field for why this matters — directionalAimInfo
    // reads it off the in-progress draw, and without it the height-tier gapZeroM silently used
    // Натиск's tiny weaponReachM/2 threshold instead of Залп's flat 10m for a ranged weapon.
    attackType: _weaponConstraint.attackType ?? null,
    canHitLowFlight: _weaponConstraint.canHitLowFlight ?? false,
    canHitHighFlight: _weaponConstraint.canHitHighFlight ?? false,
  };
  _recomputeDraw(draw);
  // Publish so the hit-pulse / cover rings mark caught tokens while still aiming.
  _previewDraw = draw;
  _renderStroke(_previewGfx, draw, getActivePhaseColor() ?? COLOR, ALPHA_PREVIEW, _ownerColor(game.user.id));
}

function _renderPreview() {
  if (!_previewGfx) return;
  for (let i = _previewGfx.children.length - 1; i >= 0; i--) {
    _previewGfx.children[i].destroy({ children: true });
  }
  _previewGfx.removeChildren();
  _previewDraw = null; // re-published below only while a hover preview is actually up
  // Ruler has no coverage cells by design — gate on real geometry (origin+shapeConfig)
  // too, or its preview would never draw at all.
  const hasDraw = _currentDraw?.cells?.length || (_currentDraw?.origin && _currentDraw?.shapeConfig);
  if (hasDraw) {
    _renderStroke(_previewGfx, _currentDraw, getActivePhaseColor() ?? COLOR, ALPHA_PREVIEW, _ownerColor(game.user.id));

    // Still phase 1 of a compound weapon draw (_armCompoundPhase2 drops compoundShape
    // from _weaponConstraint once phase 2 is armed, so this is false again by then) —
    // preview exactly where phase 2's circle/square will anchor, live, while the player
    // is still dragging phase 1.
    if (_weaponConstraint?.compoundShape) {
      const anchor = _compoundTip(_currentDraw);
      if (anchor) _drawAnchorMarker(_previewGfx, anchor);
    }
  } else if (_weaponHoverPoint && _weaponConstraint?.rangeOrigin) {
    if (_weaponConstraint.selfCentered) _renderSelfBurstPreview();
    else if (_weaponConstraint.directedFromToken) _renderDirectedPreview();
    else _renderWeaponThrowPreview();
  }

  // Elevation readout at the cursor, drawn on top of whatever preview is (or isn't) up,
  // whenever a shape tool is active (see _drawCursorHeightLabel). During a draw it follows
  // the shape's aim point (cursor for directional, centre for circle/square); while merely
  // hovering an armed tool it follows the raw cursor (_weaponHoverPoint for a thrown-weapon
  // range preview, else _hoverPoint tracked in _onPointerMove).
  if (_getActiveShape()) {
    const heightPoint = _currentDraw
      ? (_currentDraw.aim ?? _currentDraw.cursor)
      : (_weaponHoverPoint ?? _hoverPoint);
    _drawCursorHeightLabel(_previewGfx, heightPoint);
  }

  _recomputeCoveredCells();
  Hooks.callAll("godTactical.strokesChanged");
}

/**
 * Which grid cells are currently under an attack template — persistent strokes
 * this user can see, plus their own in-progress draw. Movement-path (thin_line)
 * strokes never count. Feeds the hit-indicator ticker (_onHitTicker): a token
 * "in the zone" is one where the template covers the CENTER of at least one of
 * its occupied cells — exactly what computeCoverage/thinLineCells already bake
 * into stroke.cells, so no separate geometry check is needed here. Every AOE
 * shape (including the directional line/wide_line/cone model, Натиск or Залп alike — see
 * directionalWallClip in template-3d.mjs) is plain
 * cell membership now, tested LIVE against tokens' current positions by
 * whoever reads `_coveredCellKeys` — nothing here needs to be beam-specific.
 */
function _recomputeCoveredCells() {
  const keys = new Set();
  const addCells = (cells) => { for (const c of cells ?? []) keys.add(`${c.col},${c.row}`); };

  if (!canvas.scene?.getFlag(FLAG_SCOPE, "globalHide")) {
    for (const s of _getStrokes()) {
      if (!AOE_SHAPES.has(s.shape)) continue;
      if (s.ownerId !== game.user.id && !_canSeeStroke(s)) continue;
      addCells(s.cells);
    }
  }
  const inProgress = _currentDraw ?? _previewDraw;
  if (inProgress && AOE_SHAPES.has(inProgress.shape)) addCells(inProgress.cells);

  _coveredCellKeys = keys;
}

/**
 * Every currently-visible AOE stroke that has a bound shooter — persisted
 * strokes this user can see (same privacy filter as _recomputeCoveredCells)
 * plus their own in-progress draw — as {tokenId, cells}. A stroke with no
 * bound token (see template-controls.mjs's "Привязка токена") has no
 * shooter to compute a sightline FROM, so it's skipped entirely: this is
 * only ever "which OTHER tokens does this attacker's template cover", never
 * a generic shape-coverage query (see _recomputeCoveredCells for that).
 * Consumed by region-cover-overlay.mjs's own per-target computeBlindSpot
 * check, kept here rather than duplicated so it shares the one privacy
 * check (_canSeeStroke) and the one in-progress-draw source of truth
 * (_currentDraw).
 */
export function getVisibleAoeStrokes() {
  const out = [];
  const push = (s) => {
    if (!AOE_SHAPES.has(s.shape) || !s.tokenId) return;
    out.push({ tokenId: s.tokenId, cells: s.cells ?? [] });
  };
  if (!canvas.scene?.getFlag(FLAG_SCOPE, "globalHide")) {
    for (const s of _getStrokes()) {
      if (s.ownerId !== game.user.id && !_canSeeStroke(s)) continue;
      push(s);
    }
  }
  const inProgress = _currentDraw ?? _previewDraw;
  if (inProgress) push(inProgress);
  return out;
}

/**
 * The set of OTHER token ids the given shooter's own visible attack template(s) currently HIT —
 * the SAME determination the red hit-indicator uses (_recomputeCoveredCells). Plain cell
 * membership for every shape, including the directional (line/wide_line/cone) model, Натиск or
 * Залп alike — see template-3d.mjs's directionalWallClip. Height mismatch is never represented
 * here at all (RETIRED both trajectory/reach-shrink models that used to) — it's now a pure
 * damage-tier concern applied AFTER a plain hit, see aim-height-damage.mjs.
 *
 * A cell match alone isn't enough, though: directionalWallClip only ever drops a cell for a
 * plain FULL wall — a genuinely tall region-built building (its auto-walls always carry a
 * Wall Height "top", so they land in the parapet bucket, never fullWalls) was passing straight
 * through with cells intact (2026-08-17 GM report — a beam hit clean through a building). So
 * every surviving candidate also gets a real eye-to-eye computeBlindSpot check against THIS
 * token's own head height — the same 3D wall+parapet geometry the amber danger-zone ring
 * already uses (wouldHitIfAimed), now applied to the actual hit set too. A short/waist wall
 * does NOT trip this (the eye-to-head ray typically clears it) — that stays exactly as before,
 * a computeCover partial-cover credit only, never a hard drop.
 */
export function hitTokenIdsForShooter(shooterId) {
  if (!shooterId || !canvas.tokens?.placeables) return new Set();
  const cellKeys = new Set();

  const considerCommitted = (s) => {
    if (!AOE_SHAPES.has(s.shape) || s.tokenId !== shooterId) return;
    for (const c of s.cells ?? []) cellKeys.add(`${c.col},${c.row}`);
  };
  if (!canvas.scene?.getFlag(FLAG_SCOPE, "globalHide")) {
    for (const s of _getStrokes()) {
      if (s.ownerId !== game.user.id && !_canSeeStroke(s)) continue;
      considerCommitted(s);
    }
  }
  const inProgress = _currentDraw ?? _previewDraw;
  if (inProgress && AOE_SHAPES.has(inProgress.shape) && inProgress.tokenId === shooterId) {
    considerCommitted(inProgress);
  }

  const ids = new Set();
  if (cellKeys.size) {
    const shooterToken = canvas.tokens.placeables.find((t) => t.id === shooterId);
    const losCtx = shooterToken ? buildBlindSpotContext() : null;
    for (const token of canvas.tokens.placeables) {
      if (token.id === shooterId) continue;
      const tokenCellKeys = _tokenCells(token).map((c) => `${c.col},${c.row}`);
      if (!tokenCellKeys.some((k) => cellKeys.has(k))) continue;
      if (losCtx && computeBlindSpot(shooterToken, token, losCtx).blocked) continue;
      ids.add(token.id);
    }
  }
  return ids;
}

/**
 * Like hitTokenIdsForShooter, but seeded from ONE SPECIFIC stroke's own footprint —
 * never merged across every AOE template the shooter currently has down. The Планер can
 * now log more than one attack for the same token in the same phase (e.g. Натиск AND
 * Опрокидывание together, see action-log.mjs's Рывок/Перемещение/Преследование work) —
 * hitTokenIdsForShooter and its siblings (isLobbedShooter/isRangedShooter/
 * directionalAimInfo/lobbedBlastEye, all just above) explicitly assume "only one attack
 * is ever being resolved at a time" (their own doc comments) and collapse onto whichever
 * stroke was placed LAST, which mixed every logged attack's hit targets into one
 * undifferentiated list in the live Планер preview (GM report, 2026-08-19). This is the
 * per-stroke counterpart used ONLY by that preview (see attack-cover-targets.mjs's
 * coverTargetsForStroke/action-log.mjs's _targetsHTML) — the real roll-resolution path
 * (roll-dialog.mjs/npc-attack.mjs via coverTargetsForShooter) is untouched.
 */
export function hitTokenIdsForStroke(stroke) {
  if (!stroke || !AOE_SHAPES.has(stroke.shape) || !canvas.tokens?.placeables) return new Set();
  const cellKeys = new Set();
  for (const c of stroke.cells ?? []) cellKeys.add(`${c.col},${c.row}`);

  const ids = new Set();
  if (cellKeys.size) {
    const shooterToken = canvas.tokens.placeables.find((t) => t.id === stroke.tokenId);
    const losCtx = shooterToken ? buildBlindSpotContext() : null;
    for (const token of canvas.tokens.placeables) {
      if (token.id === stroke.tokenId) continue;
      const tokenCellKeys = _tokenCells(token).map((c) => `${c.col},${c.row}`);
      if (!tokenCellKeys.some((k) => cellKeys.has(k))) continue;
      if (losCtx && computeBlindSpot(shooterToken, token, losCtx).blocked) continue;
      ids.add(token.id);
    }
  }
  return ids;
}

/** This user's own committed stroke by id — the Планер only ever needs to preview
 *  strokes IT logged (getActionLog() reads game.user's own flag, and every strokeId it
 *  carries traces back to a stroke THIS user's own _finalizeDraw created). null once the
 *  stroke's been removed/undone (see getActionLog's strokeId going stale). */
export function getStrokeById(id) {
  return _getMyStrokes().find((s) => s.id === id) ?? null;
}

/** Per-stroke counterpart to lobbedBlastEye — the landing-point "eye" for judging cover
 *  of ONE SPECIFIC lobbed (Навесной) stroke, not the shooter's most-recently-placed one
 *  (see hitTokenIdsForStroke's header for why the shooter-aggregate version can't be
 *  reused here). null for a non-lobbed stroke, or one with no origin. */
export function lobbedBlastEyeForStroke(stroke) {
  if (!stroke?.origin) return null;
  if ((stroke.trajectory ?? _defaultTrajectory(stroke.shape)) !== "brosok") return null;
  return { x: stroke.origin.x, y: stroke.origin.y, z: resolveTargetElevation(stroke.origin) + ASSUMED_TARGET_HEIGHT_M / 2 };
}

/**
 * Like hitTokenIdsForShooter, but for COVER MARKING rather than damage: every OTHER token the
 * shooter's template geometrically covers, INCLUDING units a wall/parapet fully blocks (which the
 * hit set drops) — region-cover-overlay.mjs runs computeCover over each and draws the ✕/½ ring, so
 * a shot into full cover is MARKED "no shot" instead of the target silently vanishing.
 */
export function coverTargetIdsForShooter(shooterId) {
  if (!shooterId || !canvas.tokens?.placeables) return new Set();
  const cellKeys = new Set();
  const ids = new Set();

  const consider = (s) => {
    if (!AOE_SHAPES.has(s.shape) || s.tokenId !== shooterId) return;
    for (const c of s.cells ?? []) cellKeys.add(`${c.col},${c.row}`);
  };
  if (!canvas.scene?.getFlag(FLAG_SCOPE, "globalHide")) {
    for (const s of _getStrokes()) {
      if (s.ownerId !== game.user.id && !_canSeeStroke(s)) continue;
      consider(s);
    }
  }
  const inProgress = _currentDraw ?? _previewDraw;
  if (inProgress) consider(inProgress);

  if (cellKeys.size) {
    for (const token of canvas.tokens.placeables) {
      if (_tokenCells(token).some((c) => cellKeys.has(`${c.col},${c.row}`))) ids.add(token.id);
    }
  }
  ids.delete(shooterId);
  return ids;
}

/** True iff the given shooter's currently-visible AOE stroke(s) are a Навесной (brosok) LOB —
 *  a shot that ARCS OVER walls to REACH its landing point (see _recomputeDraw's brosok branch).
 *  Only the DELIVERY ignores walls, not the footprint effect once landed (2026-08-16 evening
 *  revision) — attack-cover-targets.mjs / region-cover-overlay.mjs use this flag to switch cover's
 *  origin from the shooter's own eye to the landing point (see lobbedBlastEye), not to skip cover.
 *  Reads the stroke's `trajectory` field (opts.mode), falling back to _defaultTrajectory for
 *  legacy/manual strokes. A single Настильный (natisk) stroke in the mix means "not purely
 *  lobbed" → cover resolves from the shooter as normal. */
export function isLobbedShooter(shooterId) {
  if (!shooterId) return false;
  const strokes = [];
  const consider = (s) => { if (AOE_SHAPES.has(s.shape) && s.tokenId === shooterId) strokes.push(s); };
  if (!canvas.scene?.getFlag(FLAG_SCOPE, "globalHide")) {
    for (const s of _getStrokes()) { if (s.ownerId === game.user.id || _canSeeStroke(s)) consider(s); }
  }
  const inProgress = _currentDraw ?? _previewDraw;
  if (inProgress) consider(inProgress);
  if (!strokes.length) return false;
  return strokes.every((s) => (s.trajectory ?? _defaultTrajectory(s.shape)) === "brosok");
}

/** The landing-point "eye" for a lobbed shooter's cover computation — the point the blast itself
 *  radiates from, since a lob's cover must be judged from where it detonated, not from the
 *  shooter's own body (which is exactly what its walls-don't-apply delivery bypasses). z is the
 *  landing ground elevation plus a standard-body mid-height (same ASSUMED_TARGET_HEIGHT_M/2
 *  convention meleeReachClip already uses for "a standard creature standing here", see
 *  template-3d.mjs) — occupancy-independent, doesn't depend on who if anyone is actually there.
 *  Same "gather this shooter's visible/in-progress strokes" pattern as isLobbedShooter/
 *  directionalAimInfo; takes the MOST RECENTLY placed matching stroke. null when the shooter has
 *  no lobbed stroke down. */
export function lobbedBlastEye(shooterId) {
  if (!shooterId) return null;
  const strokes = [];
  const consider = (s) => {
    if (s.tokenId !== shooterId || !AOE_SHAPES.has(s.shape)) return;
    if ((s.trajectory ?? _defaultTrajectory(s.shape)) !== "brosok") return;
    strokes.push(s);
  };
  if (!canvas.scene?.getFlag(FLAG_SCOPE, "globalHide")) {
    for (const s of _getStrokes()) { if (s.ownerId === game.user.id || _canSeeStroke(s)) consider(s); }
  }
  const inProgress = _currentDraw ?? _previewDraw;
  if (inProgress) consider(inProgress);
  if (!strokes.length) return null;
  const origin = strokes[strokes.length - 1].origin;
  if (!origin) return null;
  return { x: origin.x, y: origin.y, z: resolveTargetElevation(origin) + ASSUMED_TARGET_HEIGHT_M / 2 };
}

/** True iff the given shooter's currently-visible AOE stroke(s) are all `attackType: "ranged"`
 *  — used to gate the "hears but doesn't see" blind-fire penalty (blind-spot.mjs's
 *  hearsButDoesNotSee) to actual ranged attacks only, same "gather this shooter's visible/
 *  in-progress strokes" pattern as isLobbedShooter. A melee (or legacy/manual, `attackType`
 *  null) stroke in the mix means false — the penalty only ever applies to a genuine shot. */
export function isRangedShooter(shooterId) {
  if (!shooterId) return false;
  const strokes = [];
  const consider = (s) => { if (AOE_SHAPES.has(s.shape) && s.tokenId === shooterId) strokes.push(s); };
  if (!canvas.scene?.getFlag(FLAG_SCOPE, "globalHide")) {
    for (const s of _getStrokes()) { if (s.ownerId === game.user.id || _canSeeStroke(s)) consider(s); }
  }
  const inProgress = _currentDraw ?? _previewDraw;
  if (inProgress) consider(inProgress);
  if (!strokes.length) return false;
  return strokes.every((s) => s.attackType === "ranged");
}

/** Target Z (dialed/auto aim height) + weapon reach of the given shooter's current AOE
 *  template that carries one — ANY AOE shape now (line/wide_line/cone, self-centred circle/
 *  square, a directed circle/square blast, AND a Навесной/brosok lob alike, see
 *  _recomputeDraw — brosok started setting this too in the 2026-08-16 evening revision, once
 *  its footprint stopped being exempt from height-tier damage). Only an undelivered directed
 *  blast leaves `targetZ` null (nothing landed) — so plain "has targetZ" is exactly the right
 *  filter, no shape allowlist needed. Null when the shooter has none down.
 *  See aim-height-damage.mjs's aimHeightDamageTier, applied as a damage modifier AFTER a plain
 *  hit (none of these shapes encode height in their own geometry any more). Same "gather this
 *  shooter's visible/in-progress strokes" pattern as isLobbedShooter; takes the MOST RECENTLY
 *  placed matching stroke when more than one is down (last in the stroke list = most recent),
 *  since only one attack is ever being resolved at a time.
 *  @returns {{targetZ:number, attackType:(string|null), weaponReachM:(number|null),
 *    canHitLowFlight:boolean, canHitHighFlight:boolean}|null} */
export function directionalAimInfo(shooterId) {
  if (!shooterId) return null;
  const matches = [];
  const consider = (s) => {
    if (s.tokenId !== shooterId || s.targetZ == null) return;
    if (!AOE_SHAPES.has(s.shape)) return;
    matches.push(s);
  };
  if (!canvas.scene?.getFlag(FLAG_SCOPE, "globalHide")) {
    for (const s of _getStrokes()) { if (s.ownerId === game.user.id || _canSeeStroke(s)) consider(s); }
  }
  const inProgress = _currentDraw ?? _previewDraw;
  if (inProgress) consider(inProgress);
  if (!matches.length) return null;
  const s = matches[matches.length - 1];
  return {
    targetZ: s.targetZ, attackType: s.attackType ?? null, weaponReachM: s.weaponReachM ?? null,
    canHitLowFlight: s.canHitLowFlight ?? false, canHitHighFlight: s.canHitHighFlight ?? false,
  };
}

// Trajectory fallback for strokes saved before the `trajectory` field existed, and
// for manually-drawn (non-weapon) strokes, which have no UI concept of Косой at all
// (per items.mjs's Настильный/Навесной doc comment, Косой is only ever a
// weapon/ability-tracked list) — line/wide_line/cone can only ever be Настильный,
// circle/square default to Навесной (matches action-log.mjs's own base-action
// wording, where the manual ranged circle is already called "навесной").
function _defaultTrajectory(shape) {
  return (shape === "circle" || shape === "square") ? "brosok" : "natisk";
}

// --- Danger-zone compute cache -----------------------------------------------------------
// The threat set (which tokens this weapon could hit) depends ONLY on the shooter, the weapon's
// reach/type, the walls/regions, and every OTHER token's cell/elevation/visibility — NOT on the
// mouse/aim. So the heavy per-token blind-spot math (buildBlindSpotContext + a computeBlindSpot per
// pair) must NOT run on every ticker frame: it's gated behind a cheap state signature (recompute
// only when that changes) plus a throttle, with a heartbeat fallback. `_wallVersion` is bumped on
// any wall/region CRUD so a wall edit invalidates the cache even when no token moved. Result: a
// stationary board and a fast-jiggling mouse cost essentially nothing.
let _wallVersion = 0;
let _dangerZoneKey = null;
let _dangerZoneAt = 0;
const DANGER_ZONE_THROTTLE = 180;    // ms — cap heavy recomputes while inputs change rapidly
const DANGER_ZONE_HEARTBEAT = 2000;  // ms — recompute anyway, catching any input the key misses

/** A token's CURRENT grid cell — the threat set only changes when a token crosses to a NEW cell,
 *  not on every sub-cell animation pixel, so the cache key snaps to the grid (grid-based, not
 *  pixel-based). */
function _tokenCellKey(token) {
  const c = worldToGrid(token.center.x, token.center.y);
  return `${c.col},${c.row}`;
}

/** Lightweight signature of every input the danger-zone threat set depends on. Built cheaply each
 *  frame (reads only, no geometry) and compared; the heavy math re-runs only when it changes (or
 *  the heartbeat elapses). null when no attack is being planned. */
function _dangerZoneStateKey() {
  const shooter = _assignedToken;
  if (!shooter || !AOE_SHAPES.has(_getActiveShape()) || !_weaponConstraint) return null;
  const at = _weaponConstraint.attackType;
  if ((at !== "ranged" && at !== "melee") || _weaponConstraint.maxLengthCells == null) return null;

  const parts = [
    "w", _wallVersion,
    shooter.id, _tokenCellKey(shooter), shooter.document.elevation,
    _weaponConstraint.maxLengthCells, at, _weaponConstraint.mode ?? "", _weaponConstraint.rangeCells ?? "",
    +!!_weaponConstraint.directedFromToken, +!!_weaponConstraint.instantPlace, +!!_weaponConstraint.selfCentered,
    // Manual wheel aim-height (see _aimElevation): raising/lowering the template changes which
    // tokens the beam threatens, so it must invalidate the threat-set cache like any other input.
    _aimElevationOverride ?? "auto",
    // Current directional plane height (snap/wheel/shooter) — drives the blue height-fit ring, which
    // changes as the set height changes (hovering a new token, wheeling), so fold it into the key.
    _currentTemplateAimZ() ?? "-",
  ];
  for (const t of canvas.tokens?.placeables ?? []) {
    if (t.id === shooter.id) continue;
    const type = t.actor?.type;
    if (type !== "character" && type !== "npc" && type !== "creature") continue;
    parts.push(t.id, _tokenCellKey(t), t.document.elevation, t.visible ? 1 : 0);
  }
  return parts.join("|");
}

function _clearDangerZoneGfx() {
  if (!_dangerZoneGfx) return;
  for (let i = _dangerZoneGfx.children.length - 1; i >= 0; i--) _dangerZoneGfx.children[i].destroy({ children: true });
  _dangerZoneGfx.removeChildren();
}

/**
 * Danger zone (planning aid): while an attack template tool is active AND a shooter is bound
 * ("Привязка токена"), ring every OTHER token the CURRENT WEAPON could hit if aimed straight at it
 * — the exact height-band/flag/reach/wall rules of a real shot, per token (wouldHitIfAimed, same
 * flat-2D-reach + band-gated height-tier model the real hit test itself uses, 2026-08-17 — line/
 * cone, melee, and delivered-AOE circle/square all share this one test now); a lobbed навесной
 * ignores walls on delivery but still gets the height-tier check (navesnoyCanReachTarget). A
 * steady amber ring, distinct from the red pulsing "this aim hits right now" ring below.
 *
 * Called every ticker frame but GATED: the heavy per-token math (_recomputeDangerZoneRings) only
 * re-runs when the state signature changes (a token crosses a cell, a wall is edited, the weapon
 * changes) — throttled, with a heartbeat fallback — so an idle board and a jiggling mouse are free.
 */
function _drawDangerZone() {
  if (!_dangerZoneGfx) return;

  const key = _dangerZoneStateKey();
  const now = performance.now();

  if (key === null) {                                     // nothing being planned → clear once, then idle
    if (_dangerZoneKey !== null) { _clearDangerZoneGfx(); _dangerZoneKey = null; }
    return;
  }
  if (key === _dangerZoneKey) {
    if (now - _dangerZoneAt < DANGER_ZONE_HEARTBEAT) return; // unchanged → reuse the drawn rings, zero work
  } else if (now - _dangerZoneAt < DANGER_ZONE_THROTTLE) {
    return;                                               // changed, but throttle the recompute (rings stale ≤ throttle)
  }

  _dangerZoneKey = key;
  _dangerZoneAt = now;
  _recomputeDangerZoneRings();
}

/** The heavy half of the danger zone: builds the wall snapshot once and runs the per-token hit
 *  test, redrawing the amber rings. Only reached from _drawDangerZone's gate. */
function _recomputeDangerZoneRings() {
  if (game.godTactical) game.godTactical._dangerZoneRecomputes = (game.godTactical._dangerZoneRecomputes ?? 0) + 1; // diagnostic
  _clearDangerZoneGfx();
  const shooter = _assignedToken;
  if (!shooter || !_weaponConstraint || !canvas.tokens?.placeables) return;

  const attackType = _weaponConstraint.attackType;
  // A DELIVERED AOE — a directed circle/square lobbed to a point, or a thrown lob — threatens a
  // token within its DELIVERY distance PLUS the blast radius (not just the radius). A navesнoy
  // lob's delivery ignores walls entirely (navesnoyCanReachTarget). Every other shape/trajectory
  // (line/wide_line/cone AND melee/delivered-AOE circle/square alike, unified 2026-08-17) shares
  // ONE reachability test now — wouldHitIfAimed — since the real hit determination has used the
  // exact same flat-2D-footprint-plus-height-tier model for all of them since the 2026-08-16
  // circle/square unification; there's no longer a real geometric difference to test separately.
  const delivery = Number.isFinite(_weaponConstraint.rangeCells) ? _weaponConstraint.rangeCells : 0;
  const isDeliveredAoe = !!_weaponConstraint.directedFromToken
    || (!!_weaponConstraint.instantPlace && !_weaponConstraint.selfCentered);
  const reachCells = _weaponConstraint.maxLengthCells + (isDeliveredAoe ? delivery : 0);
  const isNavesnoy = _weaponConstraint.mode === "brosok";
  // Still needed below for the SEPARATE blue height-fit ring (bodyCrossesPlaneTokenIds) — only
  // the plane shapes have a single height plane to fit a body against; unrelated to which
  // reachability test the amber ring above uses.
  const isBeamShape = DIRECTIONAL_SHAPES.has(_weaponConstraint.shape);

  const ctx = buildBlindSpotContext(); // one wall/region snapshot, shared across the per-token tests
  // Same aimInfo shape directionalAimInfo returns off a real stroke — attackType/canHitLowFlight/
  // canHitHighFlight gate ranged into a non-ground band exactly like a real roll (aim-height-
  // damage.mjs), and gapZeroM mirrors attack-cover-targets.mjs's own selection: Залп gets the
  // flat allowance, Натиск scopes to half ITS OWN declared length (maxLengthCells, NOT reachCells
  // — that's threat radius including delivery, not the template's own reach).
  const metresPerCell = canvas.scene?.grid?.distance || 1;
  const gapZeroM = attackType === "ranged"
    ? HEIGHT_GAP_ZERO_M
    : (_weaponConstraint.maxLengthCells * metresPerCell) / 2;
  const aimInfo = {
    attackType,
    canHitLowFlight: _weaponConstraint.canHitLowFlight ?? false,
    canHitHighFlight: _weaponConstraint.canHitHighFlight ?? false,
    gapZeroM,
    // Plane model: the beam travels AT this height (no +1). Must match _recomputeDraw's
    // aimZ = _aimElevation(cursor), or the amber ring tests a metre higher than the shot actually
    // flies and disagrees with the hit (the GM's "amber ≠ hit" report on the shard cone).
    aimZOverride: _aimElevationOverride ?? undefined,
  };

  // A token the CURRENT template already actually reaches gets its own real red/orange/green/✕
  // ring from region-cover-overlay.mjs (the true cover+height+hearNotSee outcome) — the amber
  // "could hit if aimed here" prediction is redundant and confusing stacked on top of that (GM
  // report 2026-08-16 evening: "nested red+orange rings" on a token the AOE was already landing
  // on). The header doc above already claimed "red (hit now) > amber" as the priority, but that
  // was never actually implemented for amber vs red — only amber vs the blue height-fit ring
  // below. Fixed here: skip amber for anything hitTokenIdsForShooter already covers.
  const activeHitIds = hitTokenIdsForShooter(shooter.id);

  const hittableIds = new Set(); // amber tokens — excluded from the blue height-fit pass below
  for (const token of canvas.tokens.placeables) {
    if (token.id === shooter.id) continue;
    if (!token.visible) continue; // never mark (or reveal) a token the current user can't see
    const at = token.actor?.type;
    if (at !== "character" && at !== "npc" && at !== "creature") continue;
    if (activeHitIds.has(token.id)) continue; // already has its own real outcome ring, see above

    const hittable = isNavesnoy
      ? navesnoyCanReachTarget(shooter, token, reachCells, aimInfo)
      : wouldHitIfAimed(shooter, token, reachCells, ctx, aimInfo);
    if (!hittable) continue;
    hittableIds.add(token.id);

    const cx = token.center.x, cy = token.center.y;
    const r = Math.max(12, Math.min(token.w ?? 50, token.h ?? 50) / 2) * 1.08;
    const g = new PIXI.Graphics();
    g.lineStyle(4, 0x000000, 0.35).drawCircle(cx, cy, r);         // dark halo so the ring reads on light ground
    g.lineStyle(2.5, DANGER_ZONE_COLOR, 0.95).drawCircle(cx, cy, r);
    _dangerZoneGfx.addChild(g);
  }

  // Blue height-fit ring — planning aid for the top-down view's invisible vertical. For a DIRECTIONAL
  // template at its current set height, mark every visible unit (ally OR enemy) whose BODY crosses
  // that height, so the player can predict who a placed veer/line catches IF they move into its area.
  // Distinct from amber (reachable if aimed now) and red (hit now); priority red > amber > blue, so
  // skip anything already amber/red. Only the plane shapes — circle/square/навесной have no single
  // plane to fit against.
  if (isBeamShape) {
    const planeZ = _currentTemplateAimZ();
    if (planeZ != null) {
      for (const id of bodyCrossesPlaneTokenIds(shooter, planeZ, reachCells)) {
        if (hittableIds.has(id) || activeHitIds.has(id) || _beamHitTokenIds?.has(id)) continue; // amber/red already say more
        const token = canvas.tokens.get(id);
        if (!token) continue;
        const cx = token.center.x, cy = token.center.y;
        const r = Math.max(12, Math.min(token.w ?? 50, token.h ?? 50) / 2) * 1.08;
        const g = new PIXI.Graphics();
        g.lineStyle(3, 0x000000, 0.28).drawCircle(cx, cy, r);        // faint dark halo
        g.lineStyle(2, HEIGHT_FIT_COLOR, 0.55).drawCircle(cx, cy, r); // dim blue = fits this height
        _dangerZoneGfx.addChild(g);
      }
    }
  }
}

/**
 * Ticker-driven amber danger-zone highlight (see _drawDangerZone). Used to also draw its own
 * red pulsing hit-ring here — merged into region-cover-overlay.mjs 2026-08-14 (that file now
 * draws ONE indicator per shooter→target pair: red pulse for a clear hit, blue pulse for half
 * cover, a static grey crosshair for full cover/no shot — the plain "hit, no cover" ring this
 * function used to draw is just that overlay's red case now, so drawing it twice was redundant
 * HUD noise). `_coveredCellKeys` (still computed by _recomputeCoveredCells) remains in use below
 * to keep a hit token from also getting an amber danger-zone ring; `_beamHitTokenIds` is always
 * null now (the directional model went flat-2D cell membership, see _recomputeCoveredCells) but
 * the read below is left as a harmless no-op rather than touched, out of scope for that change.
 */
function _onHitTicker() {
  if (!canvas?.ready) return;
  _drawDangerZone();
}

/** Raw (grid-unsnapped) world point under the pointer event.
 *
 * Returns a PLAIN {x,y} object, NOT the PIXI.Point instance canvas.stage.toLocal() hands
 * back — root-caused live 2026-08-14: a stroke's `aim` (sourced from this function, via
 * draw.cursor) was silently coming back as `{}` after game.user.setFlag()/getFlag(), while
 * `origin` (built as a plain object literal by gridToWorld) never did, for identical x/y
 * values. Isolated test: writing the SAME coordinates as a real PIXI.Point instance vs a
 * plain object literal to a flag — only the PIXI.Point one lost its properties. Foundry's
 * document-update pipeline evidently doesn't walk non-plain-object (class instance) values
 * the same way it walks plain objects, and silently drops them instead of erroring. Every
 * point that might ever end up persisted in a stroke must be a plain object because of this. */
function _eventToPoint(event) {
  const global = event.global ?? event.data?.global ?? event;
  const p = canvas.stage.toLocal(global);
  return { x: p.x, y: p.y };
}

function _stop(event) {
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  const native = event.nativeEvent ?? event.data?.originalEvent;
  native?.preventDefault?.();
  native?.stopPropagation?.();
  native?.stopImmediatePropagation?.();
}

function _onPointerDown(event) {
  const button = event.button ?? event.data?.button ?? event.nativeEvent?.button ?? 0;
  if (button !== 0) return;

  // Bind mode: hit-test for a token under the click ourselves and bind it directly —
  // the token layer isn't guaranteed to be interactive/controllable while our own
  // "templates" control group owns the canvas (Foundry's control() gates on the
  // layer being active), so we can't rely on native selection alone. We still call
  // control()/releaseAll() best-effort for the native highlight when it does work.
  if (game.godTactical?.bindTokenActive) {
    _stop(event);
    const point = _eventToPoint(event);
    const cell = worldToGrid(point.x, point.y);
    const detected = _findTokenAtCell(cell);
    if (detected && (game.user.isGM || detected.document?.isOwner)) {
      _assignedToken = detected;
      setPhaseTokenLabel(detected.name, detected.id);
      try { detected.control({ releaseOthers: true }); } catch { /* layer inactive — fine, already bound above */ }
    } else {
      _assignedToken = null;
      setPhaseTokenLabel(null);
      try { canvas.tokens?.releaseAll(); } catch { /* ignore */ }
    }
    return;
  }

  const shape = _getActiveShape();
  if (!shape) return;
  _stop(event);

  // Movement path (thin_line): click-click-…-double-click, not press-drag-release.
  // The FIRST click (further down) starts the path. Every click AFTER that lands
  // here instead and just appends the clicked cell as a confirmed waypoint,
  // keeping the path open for more — PointerEvent.detail is NOT a usable click
  // counter here (Chromium leaves it 0 on pointerdown; only the derived
  // click/dblclick events increment it), so finishing the path is handled by a
  // separate native "dblclick" listener (_onCanvasDblClick) instead of trying to
  // detect it here. The stray waypoint a finishing double-click's own first
  // click pushes lands on the same cell dblclick then commits from, so it
  // collapses to a single point in _thinLinePathCells — harmless. See
  // _onPointerUp, which no-ops for this shape so mouse-release never finalizes it.
  if (shape === THIN_LINE_SHAPE && _currentDraw) {
    const point = _eventToPoint(event);
    const cell = worldToGrid(point.x, point.y);
    const candidate = gridToWorld(cell.col, cell.row);
    // Budget-constrained draw (Рывок/Перемещение — see weapon-template-drop.mjs's
    // maxLengthCells): reject a click that would spend more movement than the action
    // has, same "refuse the click, don't start/extend anything" pattern the range-gated
    // weapon flow above uses. Waypoints only ever grow through this check, so every
    // CONFIRMED point is guaranteed within budget — only the live trailing leg
    // (_recomputeDraw) ever needs clamping.
    if (_weaponConstraint?.maxLengthCells != null) {
      const cost = pathMovementCost(_thinLinePathCells([..._currentDraw.waypoints, candidate]));
      if (cost > _weaponConstraint.maxLengthCells) {
        ui.notifications?.warn("Слишком далеко — превышен запас хода.");
        return;
      }
    }
    _currentDraw.waypoints.push(candidate);
    _currentDraw.cursor = point;
    _recomputeDraw(_currentDraw);
    _renderPreview();
    return;
  }

  // Thrown weapon shapes (circle/square) use a two-click aim→size→place flow instead
  // of the usual press-drag-release: the FIRST click (below) locks the origin and
  // starts a live size preview that follows the cursor on hover — no button needs to
  // stay held (see _onPointerMove/_onPointerUp). This SECOND click commits the shape
  // at whatever size that preview has grown to, instead of starting a new draw.
  if (_weaponConstraint?.rangeOrigin && _currentDraw) {
    _finalizeDraw(_currentDraw);
    return;
  }

  const point = _eventToPoint(event);
  const cell = worldToGrid(point.x, point.y);

  // Token binding is a one-time, deliberate action now (see the "Привязка токена"
  // tool + Ctrl-hold in template-controls.mjs, and the controlToken hook below) — it
  // no longer gets re-evaluated on every draw. Whatever was last bound just carries
  // forward into this stroke.
  const token = _assignedToken;

  // Every shape originates at the CENTER of the clicked grid cell — never at a
  // token's position (so players/GM place templates freely, from ANY cell) and
  // never at the raw sub-cell pixel. The cell-center snap is what keeps
  // coverage clean: line/wide_line/cone measure their fixed-width band from the
  // axis through the origin, so an off-center origin makes that band straddle
  // two rows and yields a ragged, double-width beam that no longer matches its
  // outline. Circle/square already re-snap their target internally, so this is
  // a no-op for them. (thin_line likewise snaps here, so its segments chain
  // cleanly cell-to-cell.)
  let origin = gridToWorld(cell.col, cell.row);

  // Self-centered AOE (see startWeaponTemplateDraw's selfCentered): the shape is pinned
  // to the bound token's OWN cell, never the clicked cell — the click only confirms
  // placement (and, for a cone, sets facing via _currentDraw.cursor below). No range
  // gate: it's on self by definition.
  if (_weaponConstraint?.selfCentered && _assignedToken) {
    const tc = worldToGrid(_weaponConstraint.rangeOrigin.x, _weaponConstraint.rangeOrigin.y);
    origin = gridToWorld(tc.col, tc.row);
    _weaponHoverPoint = null;
  } else if (_weaponConstraint?.anchorToken && _assignedToken) {
    // Compound phase-1 reach line starts AT the caster: force the origin to the token,
    // the drag only aims the line's direction (its length is pinned to rangeModifier).
    // rangeOrigin is null here, so this stays a press-drag-release draw that commits on
    // _onPointerUp, then arms phase 2 (the AOE) at the line's tip.
    const tc = worldToGrid(_assignedToken.center.x, _assignedToken.center.y);
    origin = gridToWorld(tc.col, tc.row);
  } else if (_weaponConstraint?.directedFromToken && _assignedToken) {
    // Directed AOE (one gesture): the blast center sits at rangeCells (delivery distance)
    // from the caster in the CLICKED direction — the click aims, distance is fixed. See
    // _directedBlastOrigin / _renderDirectedPreview; the delivery line is a preview aid.
    origin = _directedBlastOrigin(point);
    _weaponHoverPoint = null;
  } else if (_weaponConstraint?.rangeOrigin) {
    // Weapon-constrained draw: the template's origin must land within the weapon's
    // rangeModifier (in cells) of the bound token's position — reject the click
    // (without starting a draw) if it doesn't, same way an out-of-range manual click
    // would just fail to place anything.
    const gridSize = canvas.grid.sizeX;
    if (!isWithinRange(_weaponConstraint.rangeOrigin, origin, _weaponConstraint.rangeCells, gridSize)) {
      ui.notifications?.warn("Слишком далеко — вне дальности оружия.");
      return;
    }
    // Origin locked in — the aiming ruler has done its job, the shape's own size
    // preview takes over from here.
    _weaponHoverPoint = null;
  }

  _currentDraw = {
    shape,
    origin,
    cursor:     point,
    tokenId:    token?.id   ?? null,
    tokenName:  token?.name ?? null,
    // Mirror onto the live draw so the PREVIEW render (_renderStroke via
    // _renderPreview) clips its outline the same way a committed stroke will.
    trajectory: _weaponConstraint?.mode ?? null,
    direct3D:   _weaponConstraint?.direct3D ?? false,
    // Same reason as _renderWeaponThrowPreview/_renderDirectedPreview's identical field: this
    // object is briefly readable via getVisibleAoeStrokes()/directionalAimInfo (region-cover-
    // overlay's ticker can fire in the gap between this click and _finalizeDraw's async persist)
    // before the real stroke exists — without attackType here, that brief window used the wrong
    // (Натиск) gapZeroM threshold too.
    attackType: _weaponConstraint?.attackType ?? null,
    // Same reasoning, for the height-band gate (aim-height-damage.mjs) — without these an
    // in-progress directional (line/wide_line/cone) draw would wrongly hard-zero an in-band
    // flying target while still aiming/dragging, same class of gap attackType had above.
    canHitLowFlight: _weaponConstraint?.canHitLowFlight ?? false,
    canHitHighFlight: _weaponConstraint?.canHitHighFlight ?? false,
    // Directed AOE only: the caster point the blast was delivered from — used by the
    // ranged shot-reachability dead zone (see _recomputeDraw). null for every other draw.
    deliveryOrigin: _weaponConstraint?.directedFromToken ? _weaponConstraint.rangeOrigin : null,
  };
  // Movement path: the first confirmed waypoint is the origin itself — every click
  // from here on (see the THIN_LINE_SHAPE branch above) pushes another one.
  if (shape === THIN_LINE_SHAPE) _currentDraw.waypoints = [origin];
  _recomputeDraw(_currentDraw);

  // Single-stage thrown weapon (see startWeaponTemplateDraw's instantPlace): there's no
  // separate aim/size step left to do — the live hover preview (_renderWeaponThrowPreview)
  // already showed exactly this shape at this spot, so the very click that placed it here
  // also commits it, instead of waiting for a release or a second confirm click.
  if (_weaponConstraint?.instantPlace) {
    _finalizeDraw(_currentDraw);
    return;
  }

  _renderPreview();
}

function _onPointerMove(event) {
  // Re-snap onto a token even after the wheel was used: entering a NEW token's cell drops the manual
  // height override so _aimElevation snaps to that token again. Moving over empty space keeps the
  // override (so a dialed air height persists until you point at a unit). Only while a tool is armed.
  if (_getActiveShape()) {
    const p = _eventToPoint(event);
    const tok = _findTokenAtCell(worldToGrid(p.x, p.y));
    if (tok && tok.id !== _hoveredTokenId) _aimElevationOverride = null; // re-snap onto a new token
    _hoveredTokenId = tok?.id ?? null;
    // Remember the snapped height so it STICKS when the cursor moves off onto empty ground (see
    // _aimElevation). Only while no wheel override is active — the override owns the height then.
    if (tok && _aimElevationOverride == null) _lastSnapElevation = snapAimHeight(_assignedToken, tok);
  }
  if (!_currentDraw) {
    // Armed but not yet clicked: for a thrown (circle/square) weapon template, track
    // the cursor so _renderPreview can show a live range ruler from the bound token —
    // there's nothing to recompute otherwise (see _onPointerDown/startWeaponTemplateDraw).
    if (_weaponConstraint?.rangeOrigin) {
      _weaponHoverPoint = _eventToPoint(event);
      _renderPreview();
      return;
    }
    // No draw yet, but a shape tool is armed — track the cursor so the elevation readout
    // (see _drawCursorHeightLabel) follows it around the map while the player is still
    // choosing where to place/aim, not only mid-drag. Same 0.05-cell move threshold as
    // the drag branch below, so a resting mouse doesn't re-render every frame.
    if (_getActiveShape()) {
      const point = _eventToPoint(event);
      const gridSize = canvas.grid.sizeX;
      if (_hoverPoint && Math.hypot(point.x - _hoverPoint.x, point.y - _hoverPoint.y) < 0.05 * gridSize) return;
      _hoverPoint = point;
      _renderPreview();
    }
    return;
  }
  _stop(event);
  const point = _eventToPoint(event);
  const gridSize = canvas.grid.sizeX;
  const last = _currentDraw.cursor;
  if (Math.hypot(point.x - last.x, point.y - last.y) < 0.05 * gridSize) return;
  _currentDraw.cursor = point;
  _hoverPoint = point;
  _recomputeDraw(_currentDraw);
  _renderPreview();
}

async function _onPointerUp(event) {
  if (!_currentDraw) return;
  _stop(event);

  // Thrown weapon shapes (circle/square, i.e. _weaponConstraint.rangeOrigin is set —
  // see _onPointerDown's second-click branch) commit on a SECOND click, not on
  // release — the first click's button-up must not finalize a shape that hasn't been
  // sized yet.
  if (_weaponConstraint?.rangeOrigin) return;

  // Movement path likewise never commits on release — it's an open click-click-…-
  // double-click path (see _onPointerDown's THIN_LINE_SHAPE branch); every button-up
  // here is just the tail end of one of those clicks, not a drag release.
  if (_currentDraw.shape === THIN_LINE_SHAPE) return;

  const draw = _currentDraw;
  await _finalizeDraw(draw);
}

/**
 * Finishes a movement path (thin_line). Bound as a plain native "dblclick" listener
 * on canvas.app.view (see _ensureLayers) rather than detected inside _onPointerDown —
 * PointerEvent.detail stays 0 on pointerdown in Chromium (confirmed live), so a real
 * double-click can only be told apart from two separate single clicks via the browser's
 * own derived dblclick event, same class of gotcha as the Esc-key listener
 * (_weaponEscListener) needing a raw DOM listener instead of a PIXI one. By the time
 * this fires, the double-click's own first pointerdown has already appended one more
 * waypoint at (near enough) this same spot via the normal single-click path — harmless,
 * see _onPointerDown's comment.
 */
function _onCanvasDblClick(event) {
  if (_currentDraw?.shape !== THIN_LINE_SHAPE) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  _finalizeDraw(_currentDraw);
}

/**
 * The point phase 2 of a compound weapon draw (see startWeaponTemplateDraw's
 * compoundShape) anchors at, given phase 1's draw — a real line (Настильный) or a
 * ruler-style reach measurement (Навесной). Single source of truth shared by the live
 * preview marker (_renderPreview, drawn while phase 1 is still being dragged) and the
 * actual phase-2 arm (_armCompoundPhase2, called once phase 1 commits) — what the
 * player sees during the drag is guaranteed to be exactly where the circle/square ends
 * up, never a different computation that could disagree with it.
 *
 * For a real line, it's the CENTER OF THE FARTHEST CELL THE LINE ITSELF ALREADY COVERS
 * (draw.cells, computed by _recomputeDraw via computeCoverage) — not a fresh raw-angle
 * projection from origin. Those two can disagree: the line is a rectangle with real
 * width, drawn at the exact unsnapped drag angle; projecting that same raw angle out to
 * the full capped length and THEN snapping to the nearest cell can land in a cell the
 * rectangle itself never actually covered (most visible at an off-grid angle, near a
 * corner where the rectangle only partly overlaps a cell). Anchoring on draw.cells
 * guarantees the circle/square always starts from a cell the player can see highlighted
 * as part of the line they just drew.
 *
 * A ruler has no coverage cells (draw.cells is always [] — see _recomputeDraw's
 * RULER_SHAPE branch) since it's a single measured point, not an area; for that case
 * draw.aim already IS phase 1's exact (snapped, clamped) tip, so it's used directly.
 *
 * Returns null if draw doesn't have enough to compute a tip yet (e.g. a line that
 * hasn't reached its first whole cell, or no draw in progress at all).
 */
function _compoundTip(draw) {
  if (draw?.cells?.length) {
    let tip = null, bestDist = -Infinity;
    for (const { col, row } of draw.cells) {
      const center = gridToWorld(col, row);
      const dist = Math.hypot(center.x - draw.origin.x, center.y - draw.origin.y);
      if (dist > bestDist) { bestDist = dist; tip = center; }
    }
    return tip;
  }
  if (!draw?.aim) return null;
  const tipCell = worldToGrid(draw.aim.x, draw.aim.y);
  return gridToWorld(tipCell.col, tipCell.row);
}

/**
 * Arm phase 2 of a compound weapon draw: a circle/square anchored exactly at phase 1's
 * tip (see _compoundTip). No extra click is needed to aim it, since the origin is
 * already fixed; the player just moves the mouse to size it and clicks once to commit
 * (same mechanic as the plain thrown-shape flow).
 */
function _armCompoundPhase2(draw) {
  const compound = _weaponConstraint.compoundShape;
  const tip = _compoundTip(draw);

  _weaponConstraint = {
    itemId:   _weaponConstraint.itemId,
    itemName: _weaponConstraint.itemName,
    itemType: _weaponConstraint.itemType,
    actionId:   _weaponConstraint.actionId,
    actionName: _weaponConstraint.actionName,
    // Compound is always Настильный's own two-phase flow (see weapon-template-drop.mjs's
    // _collectEntries — "compound" only ever comes from the natisk list), so this just
    // carries "natisk" forward from phase 1 onto phase 2's stroke.
    mode: _weaponConstraint.mode,
    // Carry the 3D-Direct flags from phase 1 onto phase 2 — without these the phase-2
    // AOE failed _recomputeDraw's `direct3D` gate and lost ALL height-aware handling,
    // most visibly its red height dead zone (confirmed live: an AOE straddling a
    // platform edge showed no dead zone at all once phase 2 armed).
    direct3D: _weaponConstraint.direct3D,
    attackType: _weaponConstraint.attackType,
    canHitLowFlight: _weaponConstraint.canHitLowFlight,
    canHitHighFlight: _weaponConstraint.canHitHighFlight,
    tokenId:  draw.tokenId,
    tokenName: draw.tokenName,
    maxLengthCells: compound.maxLengthCells,
    // Not a real "how far from the token" check — this constraint's rangeOrigin is
    // only ever read by _onPointerDown/_onPointerUp to know the shape commits on a
    // click rather than on release. The origin itself is already fixed at phase 1's
    // (snapped) tip, so there's no click needed to choose/validate it.
    rangeOrigin: tip,
    rangeCells: Infinity,
  };
  setActiveShape(compound.shape);
  _currentDraw = { shape: compound.shape, origin: tip, cursor: tip, tokenId: draw.tokenId, tokenName: draw.tokenName };
  _recomputeDraw(_currentDraw);
  _renderPreview();
}

/** Commit a draw-in-progress: persist the stroke, log it, and reset for the next one.
 *  Called from _onPointerUp for the normal press-drag-release gesture, and from
 *  _onPointerDown's second click for the thrown-weapon aim→size→place flow. */
async function _finalizeDraw(draw) {
  _currentDraw = null;
  _renderPreview(); // preview is cleared right here — the live shape/ruler vanishes immediately

  // Ruler is measure-only: never persisted as a stroke, never written to the action log,
  // and never tied to whatever token happens to be bound (see template-controls.mjs's
  // "Привязка токена") — it always just measures from click to release and disappears.
  // A weapon-constrained ruler used as a compound draw's phase 1 would still need to
  // arm phase 2 despite vanishing itself — everything else about a ruler (including the
  // plain manual measure-and-vanish tool) just stops here.
  if (draw.shape === RULER_SHAPE) {
    if (_weaponConstraint?.compoundShape) _armCompoundPhase2(draw);
    return;
  }

  // Never persist a directional stroke with a broken aim point (present but missing x/y, or
  // non-finite) — reproduced live 2026-08-14: a saved stroke's `aim` came out as `{}`. Root
  // cause found the same day: `aim` traced back to a live PIXI.Point instance (from
  // canvas.stage.toLocal in _eventToPoint), and Foundry's document-update pipeline silently
  // drops a non-plain-object's properties on persist — _eventToPoint now returns a plain {x,y}
  // instead, which is the real fix. This check is a cheap belt-and-suspenders backstop on top of
  // that, not the fix itself — falls back to the cursor (still a real aim direction) rather than
  // silently dropping the stroke if a bad aim ever slips through some other way.
  if (DIRECTIONAL_SHAPES.has(draw.shape) && (!Number.isFinite(draw.aim?.x) || !Number.isFinite(draw.aim?.y))) {
    console.error("god-tactical | _finalizeDraw: draw.aim was invalid", { aim: draw.aim, cursor: draw.cursor, shape: draw.shape });
    if (Number.isFinite(draw.cursor?.x) && Number.isFinite(draw.cursor?.y)) draw.aim = draw.cursor;
    else return; // no salvageable aim at all — drop the draw rather than commit garbage
  }

  // Released without ever moving the mouse — bail rather than commit a degenerate
  // zero-length shape. Checked against the raw (unfixed) drag distance, not
  // shapeConfig.length: a weapon-constrained directional shape's length is now pinned to
  // its exact declared size (see _recomputeDraw) and stays nonzero even at the click
  // point itself, so shapeConfig.length alone could no longer tell "never moved" apart
  // from "moved and aimed".
  if (DIRECTIONAL_SHAPES.has(draw.shape) && (draw.rawLengthCells ?? draw.shapeConfig?.length ?? 0) < 0.1) {
    return;
  }
  if (draw.shape === THIN_LINE_SHAPE && (draw.cells?.length ?? 0) <= 1) {
    return; // no real movement drawn (start and end are the same cell)
  }

  // The shared, GM-controlled tracker phase wins when there's an active combat to read
  // one from — same fallback order action-log.mjs's own _prepareContext already uses for
  // display (getTrackerPhaseEntry() ?? getActivePhaseEntry()). This is just which
  // phase/color the entry gets tagged with, not a gate: whether a weapon-drop got this
  // far at all is already enforced upstream by weapon-template-drop.mjs's own
  // isPlanningStage() check; the manual scene-controls tool has never been phase-gated.
  const phaseEntry = getTrackerPhaseEntry() ?? getActivePhaseEntry();
  // Weapon-constrained draw (see startWeaponTemplateDraw): tags this stroke + its log
  // entry with the weapon that's being placed, so they show up as ONE combined entry
  // instead of a separate item tag and shape tag.
  const weaponTag = _weaponConstraint?.itemId
    ? {
        itemId: _weaponConstraint.itemId, itemName: _weaponConstraint.itemName, itemType: _weaponConstraint.itemType,
        // Натиск (melee) or Залп (ranged) — from the weapon's own attackType field,
        // see weapon-template-drop.mjs's ACTION_FOR_ATTACK_TYPE.
        actionId: _weaponConstraint.actionId ?? null, actionName: _weaponConstraint.actionName ?? null,
      }
    : null;
  const stroke = {
    id:          foundry.utils.randomID(),
    shape:       draw.shape,
    shapeConfig: draw.shapeConfig,
    origin:      draw.origin,
    aim:         draw.aim,
    cells:       draw.cells,
    // Movement path only: every waypoint the player clicked, in order — lets a
    // committed/restored stroke re-draw its actual bent route (see
    // _drawShapeOutline) instead of a single straight origin→aim line. null for
    // every other shape.
    waypoints:   draw.waypoints ?? null,
    // Out-of-reach chunk — render-only, painted red, never part of `cells`. The only remaining
    // producer is an undelivered directed circle/square blast (delivery beam wall-blocked
    // before reaching the landing point, see _recomputeDraw); every other AOE shape/trajectory
    // leaves this empty (no per-cell height dead zone exists anywhere any more).
    unreachableCells: draw.unreachableCells ?? [],
    // Wall-shadow-carved outline polygons — permanently null now (2026-08-16, circle/square's
    // old meleeReachClip-based outline clip was retired). Dormant field, kept for a possible
    // future alternate hit-logic (see items.mjs's per-entry `hitLogic`); _renderStroke already null-checks it.
    meleeClipPolys: draw.meleeClipPolys ?? null,
    // Target Z (the dialed/auto aim height, see _aimElevation) — set for ANY natisk AOE shape
    // now (line/wide_line/cone AND circle/square alike), null only for an undelivered directed
    // blast or a Навесной (brosok) stroke. Consumed by aim-height-damage.mjs's
    // aimHeightDamageTier via directionalAimInfo, AFTER a plain cell-membership hit, as a
    // damage modifier — no longer shapes the template's geometry.
    targetZ:     draw.targetZ ?? null,
    // The weapon/template's own declared length in METRES (only set alongside targetZ, same
    // directional strokes) — Натиск's damage tier scopes its zero-threshold to half of this
    // instead of Залп's flat HEIGHT_GAP_ZERO_M (see _meleeAimRange / attack-cover-targets.mjs).
    weaponReachM: draw.weaponReachM ?? null,
    // Натиск/Залп (melee/ranged) — carried directly off the weapon constraint so a committed
    // stroke still knows which one it was (weaponTag.actionId only encodes it indirectly).
    attackType:  _weaponConstraint?.attackType ?? null,
    // Ranged-only height-band flags (items.mjs's weaponCardSchema, see aim-height-damage.mjs's
    // aimHeightDamageTier) — carried straight off the constraint, same pattern as attackType.
    canHitLowFlight:  _weaponConstraint?.canHitLowFlight ?? false,
    canHitHighFlight: _weaponConstraint?.canHitHighFlight ?? false,
    // Which hit-resolution logic the SOURCE ENTRY picked (items.mjs's per-entry `hitLogic`,
    // see TODO(hitLogic) above) — carried onto the committed stroke too, not just the live
    // in-progress draw, so a future implementation can resolve it from persisted strokes.
    hitLogic:    _weaponConstraint?.hitLogic ?? "base",
    ownerId:     game.user.id,
    tokenId:     draw.tokenId   ?? null,
    tokenName:   draw.tokenName ?? null,
    color:       getActivePhaseColor() ?? COLOR,
    phase:       phaseEntry?.key ?? null,
    // Настильный/Навесной — from the weapon entry's own list when this came off
    // a weapon drop (see weapon-template-drop.mjs), otherwise the shape's only
    // possible trajectory (see _defaultTrajectory).
    trajectory:  _weaponConstraint?.mode ?? _defaultTrajectory(draw.shape),
    // 3D-Direct (items.mjs's direct3D) — carried onto the stroke so the render
    // (_renderStroke) can clip its OUTLINE at walls, not just its cells; the
    // weapon constraint is gone by the time a committed stroke re-renders.
    direct3D:    _weaponConstraint?.direct3D ?? false,
    ...(weaponTag ?? {}),
  };

  // One-shot weapon draw: placing the template ends the armed mode — UNLESS this was phase 1
  // of a compound (Настильный circle/square) draw, in which case the committed line stays on
  // the canvas and phase 2 (the circle/square) arms automatically, pinned at its tip.
  //
  // Done HERE — synchronously, right after the stroke object is built and BEFORE the async
  // persist below — on purpose: _finalizeDraw nulls _currentDraw at the top, so running the
  // phase-2 arm only after `await _setStrokes`/`await addLogEntry` left _currentDraw null
  // across that gap. A click landing there started a stray free-floating circle under the
  // cursor (draggable past the line's end) that a SECOND click then committed — the "phantom
  // first circle" bug. Arming before any await closes the gap: the next click finalizes the
  // pinned circle at the tip in one go. The stroke object above already copied everything it
  // needs from _weaponConstraint (weaponTag/trajectory/direct3D), so mutating it now is safe.
  if (_weaponConstraint?.compoundShape) {
    _armCompoundPhase2(draw);
  } else if (_weaponConstraint) {
    _weaponConstraint = null;
    _weaponHoverPoint = null;
    if (_weaponEscListener) {
      document.removeEventListener("keydown", _weaponEscListener);
      _weaponEscListener = null;
    }
    setActiveShape(null);
  }
  // _renderPreview() above (right after nulling _currentDraw) re-populated _previewDraw with
  // one more live preview render — at that point _weaponConstraint/_weaponHoverPoint were still
  // set (they're only cleared just above, AFTER that call), so a thrown/directed/self-burst
  // preview function ran once more and republished a fresh `_previewDraw` for the SAME spot the
  // stroke was just committed at. Nothing clears it after this: once the tool deactivates (the
  // branch above), no further pointermove will ever refresh or null it again, so it would sit
  // there FOREVER as an invisible "still aiming" ghost — merged into every isLobbedShooter/
  // directionalAimInfo/hitTokenIdsForShooter query for this shooter alongside the real committed
  // stroke, indefinitely, even with the weapon tool long since put away. Usually numerically
  // identical to what was just committed (harmless), but not guaranteed to stay that way, and
  // wrong on principle — a finished draw shouldn't leave a phantom in-progress one behind. Null
  // it explicitly here (found live 2026-08-16 evening chasing a preview/commit color mismatch
  // report that turned out to be this ghost, not the throttle fix above).
  _previewDraw = null;

  const strokes = _getMyStrokes().slice();
  strokes.push(stroke);
  if (game.godTactical) game.godTactical._lastStrokeId = stroke.id;
  await _setStrokes(strokes);

  // Write to action log if user drew from a token cell during combat
  if (draw.tokenId && phaseEntry) {
    // The log entry's `phase` decides which phase-activation-reminder.mjs stage this
    // entry can trigger a "Особенности" reminder in (e.g. Арбалет's own "После выстрела —
    // Перезарядка" feature, tagged activation:"prepMovement") — so it needs to be the
    // action's TRUE category (Натиск/Залп → execution, per BASE_ACTIONS), not just
    // whichever phase the tracker happened to be sitting in when this stroke was drawn.
    // Dragging a weapon onto the Планер during the movement phase's own planning stage
    // (to have it ready before execution's planning stage comes up) used to stamp
    // phase:"movement" on the confirmed attack too, making its Feature reminder fire a
    // whole phase early, in "Подготовка (Движения)", even though nothing execution-phase
    // had happened yet that round — same fix _addBaseAction (action-log.mjs) already
    // applies for plain base-action-button presses, just missing here for weapon drops.
    // Falls back to the tracker's own phase for a manually-drawn shape with no weaponTag
    // (nothing in BASE_ACTIONS to look up a category from).
    const actionPhaseKey = weaponTag?.actionId
      ? Object.keys(BASE_ACTIONS).find((k) => BASE_ACTIONS[k].some((a) => a.id === weaponTag.actionId))
      : null;
    const logPhaseEntry = (actionPhaseKey && PHASES.find((p) => p.key === actionPhaseKey)) || phaseEntry;

    await addLogEntry({
      id:         foundry.utils.randomID(),
      strokeId:   stroke.id,
      phase:      logPhaseEntry.key,
      phaseColor: logPhaseEntry.color,
      tokenId:    draw.tokenId,
      tokenName:  draw.tokenName,
      shape:      draw.shape,
      timestamp:  Date.now(),
      // Tags this entry with whichever AP type ([М] Основное / [Д] Дополнительное) is
      // currently selected in the action log panel — same as a base-action button press
      // already does (see _addBaseAction/getSelectedApType) — so a weapon dragged onto
      // the canvas shows up with a badge too, not just picker-added actions.
      actionType: getSelectedApType(),
      itemId:     weaponTag?.itemId   ?? null,
      itemName:   weaponTag?.itemName ?? null,
      itemType:   weaponTag?.itemType ?? null,
      // Натиск/Залп — which base action the dropped weapon's attackType counts as (see
      // weapon-template-drop.mjs's ACTION_FOR_ATTACK_TYPE); null for a manually-drawn shape.
      actionId:   weaponTag?.actionId   ?? null,
      actionName: weaponTag?.actionName ?? null,
      strokeData: {
        id:          stroke.id,
        shape:       stroke.shape,
        shapeConfig: stroke.shapeConfig,
        origin:      stroke.origin,
        aim:         stroke.aim,
        cells:       stroke.cells,
        waypoints:   stroke.waypoints,
        color:       stroke.color,
        ownerId:     stroke.ownerId,
        tokenId:     stroke.tokenId,
        tokenName:   stroke.tokenName,
        trajectory:  stroke.trajectory,
        ...(weaponTag ?? {}),
      },
    });
    setPhaseTokenLabel(draw.tokenName, draw.tokenId);
  }
}

function _ensureLayers() {
  if (!canvas.stage) return;

  // Размещаем шаблоны внутри того же родителя, что и токены (canvas.primary),
  // но ПЕРЕД ними — так шаблоны рендерятся ниже токенов.
  // Надёжно работает в Foundry v13.
  const tokenParent = canvas.tokens?.parent || canvas.environment;
  const tokenIndex = tokenParent.children?.indexOf(canvas.tokens) ?? -1;

  if (!_persistentGfx || !_persistentGfx.parent) {
    _persistentGfx = new PIXI.Container();
    _persistentGfx.eventMode = "none";
    if (tokenIndex >= 0) tokenParent.addChildAt(_persistentGfx, tokenIndex);
    else tokenParent.addChild(_persistentGfx);
  }

  if (!_previewGfx || !_previewGfx.parent) {
    _previewGfx = new PIXI.Container();
    _previewGfx.eventMode = "none";
    // Вставляем после _persistentGfx, но всё равно перед токенами.
    const idx = tokenParent.children?.indexOf(_persistentGfx) ?? -1;
    if (idx >= 0) tokenParent.addChildAt(_previewGfx, idx + 1);
    else tokenParent.addChild(_previewGfx);
  }

  if (!_dangerZoneGfx || !_dangerZoneGfx.parent) {
    _dangerZoneGfx = new PIXI.Container();
    _dangerZoneGfx.eventMode = "none";
    // Above tokens like the hit indicator; its ring sits at a larger radius than the hit ring
    // so the two coexist on a token that is both in-danger and hit, whatever the z-order.
    const tokensIdx = tokenParent.children?.indexOf(canvas.tokens) ?? -1;
    if (tokensIdx >= 0) tokenParent.addChildAt(_dangerZoneGfx, tokensIdx + 1);
    else tokenParent.addChild(_dangerZoneGfx);
  }

  if (!_inputCatcher || !_inputCatcher.parent) {
    _inputCatcher = new PIXI.Graphics();
    _inputCatcher.eventMode = "none";
    _inputCatcher.visible = false;
    // Catcher должен быть выше всего, чтобы перехватывать клики.
    canvas.stage.addChild(_inputCatcher);

    _inputCatcher.on("pointerdown", _onPointerDown);
    _inputCatcher.on("pointermove", _onPointerMove);
    _inputCatcher.on("pointerup", _onPointerUp);
    _inputCatcher.on("pointerupoutside", _onPointerUp);
    // Native, not PIXI-federated (see _onCanvasDblClick's header) — movement path's
    // double-click-to-finish gesture.
    canvas.app.view.addEventListener("dblclick", _onCanvasDblClick);
  }

  _drawCatcherHitArea();
}

function _drawCatcherHitArea() {
  if (!_inputCatcher) return;
  const d = canvas.dimensions ?? { width: 100000, height: 100000, sceneX: -50000, sceneY: -50000 };
  const x = d.sceneX ?? 0;
  const y = d.sceneY ?? 0;
  const w = d.width ?? 100000;
  const h = d.height ?? 100000;
  const PAD = 100000;
  _inputCatcher.clear();
  _inputCatcher.beginFill(0x000000, 0.0001).drawRect(x - PAD, y - PAD, w + 2 * PAD, h + 2 * PAD).endFill();
  _inputCatcher.hitArea = new PIXI.Rectangle(x - PAD, y - PAD, w + 2 * PAD, h + 2 * PAD);
}

export async function undoStroke() {
  const strokes = _getMyStrokes().slice();
  if (!strokes.length) {
    return ui.notifications.info(game.i18n.localize("GOD.Templates.NothingToUndo"));
  }
  const removed = strokes.pop();
  await _setStrokes(strokes);
  if (removed?.id) await removeLogEntry(removed.id);
}

export async function clearStrokes() {
  // Preserve strokes that belong to held log entries
  const heldStrokeIds = new Set(
    getActionLog().filter(e => e.isHeld).map(e => e.strokeId)
  );
  if (heldStrokeIds.size > 0) {
    const keep = _getMyStrokes().filter(s => heldStrokeIds.has(s.id));
    await _setStrokes(keep);
  } else {
    await _setStrokes([]);
  }
  await clearMyLog();
}

function _patchTemplateLayer() {
  const TL = foundry.canvas?.layers?.TemplateLayer ?? globalThis.TemplateLayer;
  if (!TL || TL.prototype.__godPatched) return;
  const proto = TL.prototype;
  const wrap = (key) => {
    const orig = proto[key];
    if (typeof orig !== "function") return;
    proto[key] = function (...args) {
      // This system fully owns the "templates" control group — never let Foundry's
      // native MeasuredTemplate drag-creation run while it's the active layer, no
      // matter what our activeTool happens to be at that instant. (Used to only skip
      // when activeTool started with "god-", which missed the "nothing selected"
      // placeholder tool and let Foundry try to validate a template with that as its
      // shape type — the crash in the bug report.)
      const cur = ui.controls?.control?.name ?? ui.controls?.activeControl;
      if (cur === "templates") return;
      return orig.apply(this, args);
    };
  };
  wrap("_onDragLeftStart");
  wrap("_onDragLeftMove");
  wrap("_onDragLeftDrop");
  wrap("_onDragLeftCancel");
  proto.__godPatched = true;
}

async function _healMyStrokes() {
  const raw = game.user.getFlag(FLAG_SCOPE, _sceneKey(FLAG_KEY)) ?? [];
  const clean = raw.filter(s => !s.ownerId || s.ownerId === game.user.id);
  if (clean.length !== raw.length) {
    await game.user.setFlag(FLAG_SCOPE, _sceneKey(FLAG_KEY), clean);
  }
}

export function registerTemplateCanvas() {
  Hooks.once("ready", _patchTemplateLayer);

  // Bind mode (the "Привязка токена" tool, or Ctrl held — see template-controls.mjs)
  // clears the active shape, which turns off our own input catcher and lets Foundry's
  // normal token click-to-select go through. This just listens for that native
  // selection: selecting a token while in bind mode binds it; deselecting it (e.g.
  // clicking empty canvas) clears the binding.
  Hooks.on("controlToken", (token, controlled) => {
    if (!game.godTactical?.bindTokenActive) return;
    if (controlled) {
      if (game.user.isGM || token.document?.isOwner) {
        _assignedToken = token;
        setPhaseTokenLabel(token.name, token.id);
      }
    } else if (_assignedToken?.id === token.id) {
      _assignedToken = null;
      setPhaseTokenLabel(null);
    }
  });

  // Broadcast this client's own token selection (see _syncSelectedTokens/
  // _getHighlightedTokenIds) so every viewer can brighten that token's own
  // templates — independent of, and fires alongside, the bind-mode listener above.
  Hooks.on("controlToken", () => _syncSelectedTokens());

  Hooks.on("canvasReady", () => {
    _ensureLayers();
    _attachRightClickHandlers();
    _healMyStrokes().then(() => {
      _renderPersistent();
      _renderPreview();
    });
    _updateCursor();
    canvas.app.ticker.add(_onHitTicker);
    _dangerZoneKey = null; // new scene: force a clean danger-zone recompute (different walls/tokens)
    // Fresh scene — this client has nothing controlled here yet.
    _syncSelectedTokens();
  });

  Hooks.on("updateScene", (scene, changes) => {
    if (scene.id !== canvas.scene?.id) return;
    if (foundry.utils.hasProperty(changes, `flags.${FLAG_SCOPE}.globalHide`)) {
      _renderPersistent();
    }
  });

  Hooks.on("updateUser", (user, changes) => {
    const flagData = changes?.flags?.[FLAG_SCOPE];
    if (!flagData) return;
    const sceneId = canvas.scene?.id;
    if (!sceneId) return;
    if (Object.keys(flagData).some(k => k.endsWith(`_${sceneId}`))) {
      _renderPersistent();
    }
  });

  // A token moving/changing elevation can move IN or OUT of a placed ranged beam's line,
  // which (unlike a footprint template) isn't re-tested by the ticker on its own — the
  // beam's hit set is derived in _recomputeCoveredCells, so re-run that when a token's
  // position or height changes. Footprint coverage doesn't need this (the ticker already
  // re-reads live token cells every frame); it's only the beam membership that's stale
  // between renders. Cheap enough to run per-move (moves are rare next to frames).
  Hooks.on("updateToken", (doc, changes) => {
    if (!("x" in changes || "y" in changes || "elevation" in changes)) return;
    if (doc.parent?.id !== canvas.scene?.id) return;
    _recomputeCoveredCells();
  });

  // Danger-zone cache invalidation: any wall/region CRUD changes the threat geometry even when no
  // token moved, so bump the version the cache key folds in (see _dangerZoneStateKey). Token moves,
  // elevation and visibility are already in the key directly, so they need no hook here.
  for (const hook of ["createWall", "updateWall", "deleteWall", "createRegion", "updateRegion", "deleteRegion"]) {
    Hooks.on(hook, () => { _wallVersion++; });
  }

  Hooks.on("godTactical.removeStroke", async (strokeId) => {
    const strokes = _getMyStrokes().filter(s => s.id !== strokeId);
    await _setStrokes(strokes);
  });

  // Restore a previously deleted stroke (from history)
  Hooks.on("godTactical.restoreStroke", async (strokeData) => {
    const strokes = _getMyStrokes().slice();
    if (strokes.some(s => s.id === strokeData.id)) return;
    strokes.push(strokeData);
    await _setStrokes(strokes);
  });

  Hooks.on("godTactical.shapeChanged", () => {
    if (!_getActiveShape()) {
      _currentDraw = null;
      _hoverPoint = null; // tool put away — drop the cursor-height readout's tracked point
      _aimElevationOverride = null; // and any dialed aim height, so the next tool starts on auto
      _lastSnapElevation = null;    // and the sticky snapped height
      // Switching to a manual toolbar tool (or clearing the tool) mid-arm should drop
      // any pending weapon constraint too, not just the in-progress draw.
      if (_weaponConstraint) {
        _weaponConstraint = null;
        _weaponHoverPoint = null;
        if (_weaponEscListener) {
          document.removeEventListener("keydown", _weaponEscListener);
          _weaponEscListener = null;
        }
      }
      _renderPreview();
    }
    _updateCursor();
  });

  // Re-render when action log hides/shows a token's strokes
  Hooks.on("godTactical.rerenderTemplates", () => {
    _renderPersistent();
  });

  // Clear captured token when GM clicks "×" in phase bar
  Hooks.on("godTactical.clearToken", () => {
    _assignedToken = null;
    setPhaseTokenLabel(null);
  });

  Hooks.on("godTactical.gmWipeAll", async () => {
    if (!game.user.isGM) return;
    const sceneId = canvas.scene?.id;
    if (!sceneId) return;
    for (const user of game.users) {
      await user.setFlag(FLAG_SCOPE, `${FLAG_KEY}_${sceneId}`,          []);
      await user.setFlag(FLAG_SCOPE, `actionLog_${sceneId}`,             []);
      await user.setFlag(FLAG_SCOPE, `publishedGroups_${sceneId}`,       []);
      await user.setFlag(FLAG_SCOPE, `actionLogHistory_${sceneId}`,      []);
    }
    _renderPersistent();
  });

  // Round change during combat clears this client's own templates + action log —
  // except groups the player has explicitly put on hold (clearStrokes/clearMyLog
  // already preserve any entry with isHeld, same as the manual "trash" scene-control
  // button). Fired by action-log.mjs's own updateCombat round-change hook via a custom
  // event rather than a direct import, since this file is already imported BY
  // action-log.mjs (addLogEntry/clearMyLog/etc.) — a reverse import would be circular.
  Hooks.on("godTactical.combatRoundChanged", () => {
    clearStrokes();
  });

  Hooks.on("canvasTearDown", () => {
    _assignedToken = null;
    if (canvas?.app?.ticker) canvas.app.ticker.remove(_onHitTicker);
  });
}
