/**
 * GOD Tactical — Survey Mode
 * A toggled "tactical visor": press Alt to flip survey mode on/off (a MODE, not a
 * hold — see registerSurveyMode's keybinding). While survey mode is ON:
 *  - Foundry's own object highlight is turned on (the same red/green disposition
 *    outlines core normally binds to a HELD Alt — here it's folded into the mode, so
 *    Alt stops meaning "hold to highlight" and becomes "tap to toggle survey").
 *  - Each Region gets ONE height label — its `elevation.top` in metres — drawn on its
 *    boundary. A Region is a single uniform-height zone (the region-auto-walls model),
 *    so one number per region says it all; no per-wall-segment clutter.
 *  - A token's size (metres — eyeHeightForToken's size-tier value, not raw footprint) and
 *    current elevation ("2 м (h3)") are shown ONLY as part of the hit-preview line below, next
 *    to that token's name — NOT as a standalone always-on label under every token any more
 *    (2026-08-17, GM ask: the size/height that matters is the one for a token actually being
 *    evaluated as a target, not a permanent label on every unit; also stopped colliding with
 *    the name+tier line above the shooter). History: 2026-08-15 this info briefly rode the
 *    always-on lift-shadow cue with elevation deliberately left off, reversed the same day
 *    after a live mix-up (a target standing well above a low wall read as "no cover"/"full hit
 *    only at exactly its own elevation" — both correct, but with no quick way to SEE it was
 *    elevated at all without checking token config).
 *
 * Templates and the attack-time cover marks (✕/½, region-cover-overlay.mjs) are untouched: they
 * stay visible regardless of this mode, per design.
 *
 * Overlay mechanics mirror region-cover-overlay.mjs — a PIXI.Container above tokens,
 * refreshed on a short throttle WHILE ACTIVE so labels track moving tokens, and doing
 * literally nothing (early return) while the mode is off, so it costs zero when unused.
 *
 * Colour code (heights match their own contour, per design):
 *  - Walls  → amber contour + amber height numbers (a region WITH auto-walls, flag
 *    `autoLightWalls`, reads as "walled" — its boundary IS drawn by the wall pass, so its
 *    one height number is amber too).
 *  - Wall-less regions → cyan polygon/rect outline + cyan height number, so a pure
 *    elevation zone with no physical barrier is still visible and tells them apart.
 *  - Hit-preview name+size+height lines → tier color (red/orange/green/grey); white only as
 *    the fallback for an unrecognized tier, so it can never be misread as a wall/region height.
 * All labels and line widths are kept at a CONSTANT ON-SCREEN size (scaled by 1/zoom), so
 * nothing needs zooming in to read.
 */

import { eyeHeightForToken } from "./blind-spot.mjs";
import { getVisibleAoeStrokes } from "./template-canvas.mjs";
import { coverTargetsForShooter } from "./attack-cover-targets.mjs";

const WALL_COLOR = 0xef9f27;   // amber — walls + walled-region heights (matches HUD accent)
const WALL_HEX = "#ef9f27";
const REGION_COLOR = 0x3fd8e8; // cyan — wall-less region outline + their heights
const REGION_HEX = "#3fd8e8";
const SIZE_HEX = "#ffffff";     // white — unit sizes, distinct from any height
const REDRAW_INTERVAL = 250;    // ms — labels catch up to token movement within this

// Hit-preview tier colors — same meaning the retired region-cover-overlay.mjs ring/Alt-list
// used: full = clean hit, half/quarter = one/two halving factors, zero = no shot at all.
const TIER_HEX = { full: "#ff2b2b", half: "#ffa500", quarter: "#4caf50", zero: "#9a9a9a" };
const HIT_PREVIEW_FONT = 22; // 2026-08-16 evening: bumped up from the retired overlay's 16 —
                              // GM reported that one too small to read

let _active = false;
let _container = null;
let _ticker = null;
let _lastDraw = 0;

/** Format a raw metres value (region top / token size) as "N м" — integers stay whole,
 *  fractions show one decimal (0.5 м). Values are already in metres (scene units), so no
 *  cell↔metre conversion here. */
function _metres(v) {
  const n = Number(v) || 0;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} м`;
}

/** Same integer/decimal rule as _metres, no unit suffix — for the compact "(hN)" elevation tag
 *  next to a token's size, where repeating "м" twice in one label would be noise. */
function _num(v) {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function _ensureContainer() {
  if (_container?.parent) return;
  if (!canvas?.stage) return;
  const parent = canvas.tokens?.parent || canvas.environment;
  if (!parent) return;
  _container = new PIXI.Container();
  _container.eventMode = "none";
  // Directly above the tokens layer — same placement convention as region-cover-overlay.
  const idx = parent.children?.indexOf(canvas.tokens) ?? -1;
  if (idx >= 0) parent.addChildAt(_container, idx + 1);
  else parent.addChild(_container);
}

function _clear() {
  if (!_container) return;
  for (let i = _container.children.length - 1; i >= 0; i--) {
    _container.children[i].destroy({ children: true });
  }
  _container.removeChildren();
}

/** A black-outlined HUD label at a CONSTANT on-screen size: `screenSize` is the target
 *  screen px and `inv` (= 1/zoom) counter-scales the canvas zoom, so it reads the same at
 *  any zoom without zooming in. Reads over both lit and dark map areas. */
function _hudText(str, screenSize, hex, inv) {
  const label = new PIXI.Text(str, new PIXI.TextStyle({
    fontFamily: "Signika",
    fontSize: screenSize,
    fontWeight: "bold",
    fill: hex,
    stroke: "#000000",
    strokeThickness: 3,
  }));
  label.eventMode = "none";
  label.anchor.set(0.5, 0.5);
  label.scale.set(inv);
  return label;
}

/** Trace a region's boundary shapes (polygon/rectangle/ellipse, absolute scene coords) into
 *  `g` — used only for WALL-LESS regions, which otherwise have no visible edge. Holes are
 *  skipped: this is a "where is this zone" outline, not a fill. */
function _regionOutline(g, region) {
  for (const shape of region.document.shapes ?? []) {
    if (shape.hole) continue;
    if (shape.type === "polygon" && (shape.points?.length ?? 0) >= 6) {
      const p = shape.points;
      g.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
      g.lineTo(p[0], p[1]);
    } else if (shape.type === "rectangle") {
      g.drawRect(shape.x, shape.y, shape.width, shape.height);
    } else if (shape.type === "ellipse") {
      g.drawEllipse(shape.x, shape.y, shape.radiusX, shape.radiusY);
    }
  }
}

/** A point guaranteed INSIDE the region (so its height number sits on the zone, not floating
 *  in a concave notch of its bounding box). Prefers the bounds centre; if that's outside the
 *  shape, scans a grid and keeps the interior point nearest the centre. testPoint needs an
 *  elevation actually within the region's band, so we sample at mid-band. */
function _regionLabelPoint(region) {
  const b = region.bounds;
  if (!b) return null;
  const doc = region.document;
  const top = doc.elevation?.top ?? 0;
  const bottom = doc.elevation?.bottom ?? 0;
  const elev = (top + bottom) / 2;
  const inside = (x, y) => {
    try { return doc.testPoint?.({ x, y, elevation: elev }) === true; } catch { return false; }
  };
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  if (inside(cx, cy)) return { x: cx, y: cy };
  let best = null, bestD = Infinity;
  const N = 8;
  for (let iy = 1; iy < N; iy++) for (let ix = 1; ix < N; ix++) {
    const x = b.x + (b.width * ix) / N, y = b.y + (b.height * iy) / N;
    if (!inside(x, y)) continue;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bestD) { bestD = d; best = { x, y }; }
  }
  return best ?? { x: cx, y: cy };
}

function _draw() {
  _clear();
  if (!_active || !_container) return;
  const inv = 1 / (canvas.stage?.scale?.x || 1); // keep strokes + labels a constant screen size

  // --- Wall contours (amber, all walls) + standalone-parapet height labels. A wall with its
  //     OWN height that isn't a region's auto-wall gets its number AT the wall (midpoint);
  //     auto-walls stay unlabelled — their region carries the number instead (below), so a
  //     walled zone shows one number, not one per boundary edge. Labels added after the
  //     Graphics so text sits on top of the lines. ---
  const wallG = new PIXI.Graphics();
  wallG.lineStyle(2 * inv, WALL_COLOR, 0.85);
  const wallLabels = [];
  for (const wall of canvas.walls?.placeables ?? []) {
    const doc = wall.document;
    const c = doc?.c;
    if (!c) continue;
    wallG.moveTo(c[0], c[1]);
    wallG.lineTo(c[2], c[3]);
    const top = doc.getFlag("wall-height", "top");
    if (top !== undefined && top !== null && !doc.getFlag("god-tactical", "autoWallForRegion")) {
      const label = _hudText(_metres(top), 18, WALL_HEX, inv);
      label.position.set((c[0] + c[2]) / 2, (c[1] + c[3]) / 2);
      wallLabels.push(label);
    }
  }
  _container.addChild(wallG);
  for (const l of wallLabels) _container.addChild(l);

  // --- Regions: WALL-LESS ones get a cyan outline (their only visible edge); WALLED ones
  //     rely on the amber wall pass above. Either way one height label placed INSIDE the
  //     region (not the raw bbox centre, which can fall in a concave notch), coloured to
  //     match its own contour — amber if walled, cyan if not. ---
  const regionG = new PIXI.Graphics();
  regionG.lineStyle(2 * inv, REGION_COLOR, 0.9);
  const regionLabels = [];
  for (const region of canvas.regions?.placeables ?? []) {
    const walled = !!region.document.getFlag("god-tactical", "autoLightWalls");
    if (!walled) _regionOutline(regionG, region);

    const top = region.document?.elevation?.top;
    if (top === undefined || top === null) continue;
    const pt = _regionLabelPoint(region);
    if (!pt) continue;
    const label = _hudText(_metres(top), 20, walled ? WALL_HEX : REGION_HEX, inv);
    label.position.set(pt.x, pt.y);
    regionLabels.push(label);
  }
  _container.addChild(regionG);
  for (const l of regionLabels) _container.addChild(l);

  // --- Hit preview: for every currently-armed shooter (a bound token with a visible AOE
  //     stroke), who it's currently covering and how well — tier-colored, stacked ABOVE the
  //     token. Reuses coverTargetsForShooter (attack-cover-targets.mjs), the SAME function a
  //     real roll and the NPC damage button both call, so this can't disagree with the real
  //     result. Folded in here 2026-08-16 evening — used to be its own separate Alt-HOLD
  //     overlay (region-cover-overlay.mjs, now unregistered) with a competing Alt binding; the
  //     GM wanted it in the one existing tactical-visor toggle instead. `1` as the damage arg
  //     is a throwaway — only `.name`/`.outcomeTier` are used, this shows QUALITY, not a number
  //     that would be fiction before a player's die is even cast.
  //     Each line also carries the TARGET's own size + elevation ("· 2 м (h10)", 2026-08-17) —
  //     this used to be a separate always-on white label under EVERY token (any token, not just
  //     ones under an armed shooter); the GM asked to fold it into this line instead and drop
  //     the standalone one — the size/height that actually matters for reading a hit is the
  //     one for a token currently being evaluated, not a permanent label on every unit. ---
  const shooterIds = [...new Set(getVisibleAoeStrokes().map((s) => s.tokenId))];
  for (const shooterId of shooterIds) {
    const shooterToken = canvas.tokens.get(shooterId);
    if (!shooterToken) continue;
    let targets;
    try {
      targets = coverTargetsForShooter(shooterToken, 1);
    } catch (e) {
      console.error("god-tactical | survey-mode: hit preview failed", e);
      continue;
    }
    if (!targets.length) continue;

    const cx = shooterToken.center?.x ?? shooterToken.x;
    const baseY = (shooterToken.y ?? 0) - 6 * inv;
    const lineGap = (HIT_PREVIEW_FONT + 6) * inv;
    targets.forEach((t, i) => {
      // Heard, not seen (blind-fire — hearsButDoesNotSee, blind-spot.mjs): the shooter only
      // knows SOMETHING is there by sound, not who/what/how big — showing the real name/size
      // here would leak information the character doesn't have. Elevation stays real (2026-08-17,
      // GM ask): sound carries a rough sense of where a source sits vertically, unlike identity
      // or bulk. Question marks keep the same "name · size (hN)" shape instead of collapsing to
      // a bare "???", so the line's width/rhythm stays consistent between targets.
      const targetToken = canvas.tokens.get(t.tokenId);
      const elevation = targetToken?.document?.elevation ?? 0;
      let text;
      if (t.hearNotSee) {
        text = `??? · ? м (h${_num(elevation)})`;
      } else {
        const size = targetToken ? eyeHeightForToken(targetToken) : null;
        text = size != null ? `${t.name} · ${_metres(size)} (h${_num(elevation)})` : t.name;
      }
      const label = _hudText(text, HIT_PREVIEW_FONT, TIER_HEX[t.outcomeTier] ?? SIZE_HEX, inv);
      label.anchor.set(0.5, 1); // bottom-anchored — stacks upward, away from the token
      label.position.set(cx, baseY - i * lineGap);
      _container.addChild(label);
    });
  }
}

function _onTick() {
  if (!_active || !_container) return; // zero cost while the mode is off
  const now = performance.now();
  if (now - _lastDraw < REDRAW_INTERVAL) return;
  _lastDraw = now;
  _draw();
}

/** Flip survey mode. Turns Foundry's object highlight on/off with it (so the red/green
 *  outlines the user liked come along for free) and shows/hides the height+size overlay. */
function _toggle() {
  _active = !_active;
  canvas?.highlightObjects?.(_active);
  if (_active) {
    _ensureContainer();
    _lastDraw = 0;
    _draw();
  } else {
    _clear();
  }
}

export function registerSurveyMode() {
  // Bound to the physical Alt keys with PRIORITY precedence: returning true from onDown
  // swallows the press so core's own "highlightObjects" (also on Alt) doesn't double-fire
  // — we drive the highlight ourselves in _toggle instead, folding it into the mode.
  game.keybindings.register("god-tactical", "surveyMode", {
    name: "GOD.Survey.Keybinding",
    hint: "GOD.Survey.KeybindingHint",
    editable: [{ key: "AltLeft" }, { key: "AltRight" }],
    precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY,
    onDown: (ctx) => {
      if (ctx.repeat) return true; // ignore auto-repeat while the key is held — one tap, one toggle
      _toggle();
      return true;
    },
  });

  Hooks.on("canvasReady", () => {
    _ensureContainer();
    if (!_ticker) {
      _ticker = _onTick;
      canvas.app.ticker.add(_ticker);
    }
    // Re-entering a scene while the mode is still on: re-apply both halves.
    if (_active) {
      canvas.highlightObjects?.(true);
      _lastDraw = 0;
      _draw();
    }
  });

  Hooks.on("canvasTearDown", () => {
    if (_ticker && canvas?.app?.ticker) canvas.app.ticker.remove(_ticker);
    _ticker = null;
    _container = null;
    _lastDraw = 0;
  });

  // Zoom/pan changes the 1/zoom factor every label + stroke is sized by — force an
  // immediate redraw (next tick) so constant-screen-size labels don't lag the gesture.
  Hooks.on("canvasPan", () => {
    if (_active) _lastDraw = 0;
  });

  // Height-display policy: suppress the native per-token elevation badge (Token#tooltip,
  // e.g. "+5 m") everywhere — token height is meant to read off the always-on lift-shadow,
  // not a floating number (per design). refreshToken fires AFTER Foundry re-shows the badge
  // on any token change, so hiding it here wins. The hover nameplate (token.nameplate) is a
  // separate object and is left alone. Side effect: no live number while Ctrl-dragging a
  // token's elevation — revisit if that feedback is wanted.
  Hooks.on("refreshToken", (token) => {
    if (token.tooltip) token.tooltip.visible = false;
  });
}
