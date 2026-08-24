/**
 * GOD Tactical — Range Preview
 * GM-only reference overlay: draws Basic Sight's and Feel Tremor's Range
 * as two circles around the currently controlled token, so you don't have
 * to eyeball grid squares against the numbers in Token Config. GM-only and
 * selected-token-only on purpose (see range-vision.mjs's whole point —
 * showing this to players would just tell them their own detection radius
 * outright).
 *
 * Deliberately a flat circle at the raw Range value — NOT the token's
 * actual computed visibility shape (walls/regions/elevation-band blocking
 * from range-vision.mjs isn't factored in here). That's a much bigger
 * thing to draw correctly (would need to run the same per-point tests this
 * system's own detection modes do, all around the circle) for a feature
 * that's meant to answer "how far, roughly" — not replace testing the real
 * mechanic in play.
 */

import { detectionModeList } from "./detection-modes-compat.mjs";

const SIGHT_COLOR = 0xffcc00;
const TREMOR_COLOR = 0x8855ff;

function _rangeFor(token, modeId) {
  const mode = detectionModeList(token.document).find((m) => m.id === modeId);
  if (!mode?.enabled || !mode.range) return null;
  return token.getLightRadius(mode.range);
}

function _ensureRangeCircles(token) {
  let g = token._godRangeCircles;
  if (!g) {
    g = new PIXI.Graphics();
    canvas.controls.addChild(g);
    token._godRangeCircles = g;
  }

  g.clear();
  const tremorRadius = _rangeFor(token, "feelTremor");
  const sightRadius = _rangeFor(token, "basicSight");
  if (tremorRadius !== null) g.lineStyle(2, TREMOR_COLOR, 0.8).drawCircle(0, 0, tremorRadius);
  if (sightRadius !== null) g.lineStyle(2, SIGHT_COLOR, 0.9).drawCircle(0, 0, sightRadius);

  g.position.set(token.center.x, token.center.y);
  g.visible = true;
}

export function registerRangePreview() {
  Hooks.on("refreshToken", (token) => {
    if (!game.user.isGM) return;
    if (token.controlled) _ensureRangeCircles(token);
    else if (token._godRangeCircles) token._godRangeCircles.visible = false;
  });

  Hooks.on("destroyToken", (token) => {
    token._godRangeCircles?.destroy();
  });
}
