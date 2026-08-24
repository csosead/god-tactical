/**
 * GOD Tactical — Blind Spot Debug Draw
 * On-demand visual check for computeBlindSpot: while hand-tagging walls,
 * parapets, or cover Regions, run this from a macro to immediately SEE
 * whether the tag "did anything" — a colored ray drawn straight on the
 * canvas, rather than reading a chat card or a console object.
 *
 * NOT wired to any Hook, NOT part of the combat pipeline, purely a manual
 * verification tool — draws on canvas.controls.debug, Foundry's own scratch
 * layer for exactly this kind of temporary overlay (nothing here is saved
 * to scene data, and it never runs on its own).
 */

import { computeBlindSpot } from "./blind-spot.mjs";

const COLOR_BLOCKED = 0xff2b2b; // red   — wall or parapet breaks the shot
const COLOR_CLEAR = 0x39ff14;   // green — clear line of sight

let _label = null;
let _generation = 0;

function _statusLabel(result) {
  if (result.blocked) return result.reason === "wall" ? "СТЕНА" : "ПАРАПЕТ";
  return "ЧИСТО";
}

/**
 * Draws the shooter→target ray colored by computeBlindSpot's result (red =
 * blocked by a wall or parapet, green = clear line of sight), with a text
 * label at its midpoint naming which. A dot marks the exact wall/parapet
 * crossing point where relevant. Auto-clears after `options.duration` ms (default
 * 6000) — pass `duration: 0` to leave it up until the next call or
 * clearBlindSpotDebug(). Returns the same result object computeBlindSpot
 * would, so a macro can log/inspect it too.
 */
export function drawBlindSpotDebug(shooterToken, targetToken, options = {}) {
  const result = computeBlindSpot(shooterToken, targetToken, options);

  const myGeneration = ++_generation; // invalidates any older pending auto-clear timer
  canvas.controls.debug.clear();
  if (_label) {
    _label.destroy();
    _label = null;
  }

  const color = result.blocked ? COLOR_BLOCKED : COLOR_CLEAR;
  const gfx = canvas.controls.debug;
  gfx.lineStyle(4, color, 0.9);
  gfx.moveTo(result.eye.x, result.eye.y);
  gfx.lineTo(result.aim.x, result.aim.y);

  const midX = (result.eye.x + result.aim.x) / 2;
  const midY = (result.eye.y + result.aim.y) / 2;
  const point = result.crossing ?? { x: midX, y: midY };
  gfx.lineStyle(0);
  gfx.beginFill(color, 1);
  gfx.drawCircle(point.x, point.y, 8);
  gfx.endFill();

  const style = new PIXI.TextStyle({
    fontFamily: "Signika",
    fontSize: 24,
    fontWeight: "bold",
    fill: `#${color.toString(16).padStart(6, "0")}`,
    stroke: "#000000",
    strokeThickness: 4,
  });
  _label = new PIXI.Text(_statusLabel(result), style);
  _label.anchor.set(0.5);
  _label.position.set(midX, midY - 24);
  canvas.controls.addChild(_label);

  const duration = options.duration ?? 6000;
  if (duration > 0) {
    setTimeout(() => { if (_generation === myGeneration) clearBlindSpotDebug(); }, duration);
  }

  return result;
}

/** Wipes the debug ray/label immediately — also happens automatically at
 *  the start of the next drawBlindSpotDebug() call and after `duration` ms. */
export function clearBlindSpotDebug() {
  _generation++;
  canvas.controls?.debug?.clear();
  if (_label) {
    _label.destroy();
    _label = null;
  }
}
