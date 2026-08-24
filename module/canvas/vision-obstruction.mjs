/**
 * GOD Tactical — Vision Obstruction (OPTIONAL, off by default)
 * Adds wall/region/elevation blocking on top of range-vision.mjs's plain
 * distance-based Basic Sight — split into its own file, gated by a world
 * setting defaulting to OFF, after the wall+region+elevation logic broke
 * live play three separate times while it lived inside range-vision.mjs
 * itself (a Lift platform region wrongly read as an obstacle; a symmetric
 * elevation check that blocked looking DOWN as well as up; a target token
 * lacking `.document` in some CanvasVisibility call path, throwing and
 * taking down the whole scene's rendering — `_testLOS`/`testVisibility` run
 * inside Foundry's own render loop, so an uncaught error there doesn't just
 * fail this feature, it breaks token rendering entirely). Keeping this
 * behind its own toggle means a bug here can be switched off from Settings
 * in seconds — no code edit, no reload of the whole vision system's base
 * layer — instead of taking Basic Sight down with it.
 *
 * Blocks Basic Sight (not Feel Tremor — that's still always pure range) if:
 *  - a wall's `sight` property blocks the straight line between observer and
 *    target. Was `move` (not `sight`) originally — deliberately, to stay
 *    independent of every wall's `sight: None` convention and Foundry's own
 *    native dynamic-shadow FOV rendering (see range-vision.mjs's header,
 *    which now documents that convention as REVERSED: walls are back to
 *    `sight: Normal` on purpose, to get native dynamic shadows back). Once
 *    walls block `sight` again, checking `move` here was actively wrong —
 *    confirmed live: a `sight: Normal` / `move: None` wall visibly cast a
 *    native shadow yet didn't block detection at all, because this file was
 *    still testing the wrong property. `sight` is now the single source of
 *    truth for both the visual shadow and this detection check, so the two
 *    can never disagree again.
 *  - (PRECISE_SETTING, default on) `computeBlindSpot` (blind-spot.mjs) says so —
 *    genuine ray-vs-wall/parapet 3D trigonometry, the SAME math the attack/cover
 *    gate already trusts, run for BOTH looking up and looking down. Region-based
 *    elevation blocking used to be its own separate, cruder mechanism here
 *    (`tallRegionsFor`: flat 2D region-boundary crossing, with a hardcoded
 *    Lift-H-macro-UUID exclusion so a platform didn't block its own occupant) —
 *    removed 2026-08-14. It only ever ran for "looking down", so it never had a
 *    counterpart for "looking up" — that asymmetry is exactly what let a
 *    stepped-back rooftop sniper see straight through their own roof's edge to
 *    spot someone hugging the wall below, since nothing checked the platform's
 *    OWN wall-height walls (region-light-walls.mjs auto-traces every Region's
 *    boundary onto real Walls, which `computeBlindSpot` already tests) for that
 *    direction at all. One symmetric `computeBlindSpot` call replaces it: no
 *    separate region concept, no macro-UUID exclusion, correct in both
 *    directions by construction. Falls back to the flat "target above my eyes =
 *    never visible, at ANY distance, no matter the angle" rule (confirmed live
 *    as wrong — see `_isLookingUp`) when PRECISE_SETTING is off.
 *
 * Every per-token access below is defensively optional-chained specifically
 * because of the crash that split this file out in the first place — some
 * CanvasVisibility call paths pass a target without a `.document` (a plain
 * point-visibility test, not a specific token; confirmed live, never fully
 * traced to its exact caller). Treat that as "not blocked" rather than
 * throwing — a missed obstruction is a minor gameplay inconsistency; an
 * uncaught exception here breaks the whole scene's rendering again.
 */

import { eyeHeightForToken, computeBlindSpot } from "./blind-spot.mjs";

const SETTING = "obstructBasicSight";
const PRECISE_SETTING = "preciseElevationLOS";

/** One-directional gate: is the target above the OBSERVER's own eye level?
 *  Doesn't by itself mean "blocked" any more (see PRECISE_SETTING below) —
 *  just marks which of the two totally different code paths in
 *  `_basicSightBlocked` applies. `false` if either token doesn't have the
 *  shape expected — see file header. */
function _isLookingUp(observerToken, targetToken) {
  const observerElevation = observerToken?.document?.elevation;
  const targetElevation = targetToken?.document?.elevation;
  if (typeof observerElevation !== "number" || typeof targetElevation !== "number") return false;
  const observerEye = observerElevation + eyeHeightForToken(observerToken);
  return observerEye < targetElevation;
}

function _basicSightBlocked(visionSource, target, test) {
  try {
    const observerToken = visionSource?.object;

    if (!game.settings.get("god-tactical", PRECISE_SETTING)) {
      // Old flat rule: looking up is always blocked; looking down only by ordinary walls
      // (native collision — no elevation awareness at all in this fallback path).
      if (_isLookingUp(observerToken, target)) return true;
      return CONFIG.Canvas.polygonBackends.sight.testCollision(
        visionSource.origin, test.point,
        { type: "sight", mode: "any", source: visionSource, useThreshold: true, priority: visionSource.priority },
      );
    }

    // Precise path (default on): real 3D ray-vs-wall trigonometry (computeBlindSpot,
    // blind-spot.mjs) for BOTH directions — the same math the attack/cover gate already
    // trusts, and already covers ordinary full-height walls AND height-limited parapets in
    // one pass. Deliberately NOT the native wall-collision sweep either direction — parapet
    // walls (the `wall-height` top/bottom flag) carry `sight: Normal` too, and Wall Height's
    // own `_testEdgeInclusion` patch approximates the whole sightline as a flat plane at the
    // observer's eye height (see blind-spot.mjs's own header for why it avoids the native
    // sweep for the same reason). Confirmed live in both directions: that flat approximation
    // still flags a parapet as blocking at an angle computeBlindSpot's real trigonometry
    // correctly clears, and — the 2026-08-14 bug this unification fixes — a stepped-back
    // rooftop sniper failing to be blocked by their OWN roof edge when looking down at
    // someone hugging the wall below (a separate, cruder region-crossing check used to run
    // only for "looking down", got the elevation cutoff wrong, and is now gone — this single
    // symmetric check replaces it). Feeding the native sweep after already trusting
    // computeBlindSpot's answer would silently reintroduce either bug.
    //
    // Some CanvasVisibility call paths pass a plain point-visibility test rather than a real
    // token on either end (see file header) — computeBlindSpot needs a real `.center`/`.document`
    // on both, so bail to "not blocked" up front instead of letting it throw into the catch below
    // (same graceful-degradation outcome, just without the console spam on every such test).
    if (!observerToken?.document || !target?.document) return false;
    return computeBlindSpot(observerToken, target).blocked;
  } catch (e) {
    console.error("god-tactical | Vision Obstruction: falling back to unobstructed for this test — ", e);
    return false;
  }
}

export function registerVisionObstruction() {
  if (typeof libWrapper === "undefined") {
    console.warn("god-tactical | Vision Obstruction requires the 'lib-wrapper' module to be active — skipping (no setting, no wall/region/elevation blocking).");
    return;
  }

  game.settings.register("god-tactical", SETTING, {
    name: "GOD.Setting.ObstructBasicSight.Name",
    hint: "GOD.Setting.ObstructBasicSight.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register("god-tactical", PRECISE_SETTING, {
    name: "GOD.Setting.PreciseElevationLOS.Name",
    hint: "GOD.Setting.PreciseElevationLOS.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  libWrapper.register(
    "god-tactical",
    "foundry.canvas.perception.DetectionMode.prototype._testLOS",
    function (wrapped, visionSource, mode, target, test) {
      if (this.id !== "basicSight" || !game.settings.get("god-tactical", SETTING)) {
        return wrapped(visionSource, mode, target, test);
      }
      return !_basicSightBlocked(visionSource, target, test);
    },
    "MIXED",
  );
}
