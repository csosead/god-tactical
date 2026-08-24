/**
 * GOD Tactical — Hit Preview List (Alt overlay) — SUPERSEDED 2026-08-16 evening, UNREGISTERED.
 * `registerRegionCoverOverlay()` is no longer called anywhere (removed from god-tactical.mjs) —
 * this file's own Alt-hold binding competed with survey-mode.mjs's pre-existing press-to-toggle
 * Alt keybinding, which is what the GM actually wanted this folded into. The hit-preview logic
 * now lives inline in survey-mode.mjs's own _draw(), reusing coverTargetsForShooter the same
 * way. Left on disk rather than deleted (no VCS here to recover it from otherwise) — safe to
 * delete for real in a future cleanup pass once this is confirmed truly unneeded.
 *
 * Everything below describes the retired Alt-hold design — historical only.
 *
 * 2026-08-16 evening: REPLACED the old per-target ring/crosshair indicator entirely — the GM
 * called it, "оно не будет работать в моей игре" (won't work for my game), after several
 * rounds of it turning out confusing (nested rings from two unrelated indicator systems
 * overlapping, and — the immediate trigger for this rewrite — no way to show more than ONE
 * shooter's result per target token when several shooters aim at the same target at once, since
 * the old design deduped by TARGET across every shooter globally).
 *
 * New design: no canvas rings at all. Instead, a text list next to EACH armed shooter's own
 * token, one line per target it currently covers, each line colored by that target's combined
 * outcome tier (attack-outcome.mjs's combineAttackOutcome, same as before — full/half/quarter/
 * zero, same color meaning as the old rings). Because the list is scoped PER SHOOTER now
 * (not deduped across shooters), two shooters aiming at the same target each get their own
 * line for it, next to their own token — the exact gap the ring design couldn't express.
 *
 * Visibility, per explicit GM request:
 *  - Only while the Alt key is held (matches the "hold a key to reveal extra info" convention
 *    players already expect) — nothing is drawn at all otherwise.
 *  - Visible to every viewer, GM included — an initial player-only restriction was tried and
 *    reverted the same evening (GM explicitly wanted it on their own screen too, and testing
 *    accounts flagged isGM made it look broken entirely rather than "just hidden here").
 */

import {
  getVisibleAoeStrokes, coverTargetIdsForShooter, hitTokenIdsForShooter, isLobbedShooter,
  isRangedShooter, directionalAimInfo, lobbedBlastEye,
} from "./template-canvas.mjs";
import { computeCover, coverFromPoint, buildBlindSpotContext, eyeHeightForToken, hearsButDoesNotSee } from "./blind-spot.mjs";
import { aimHeightDamageTier, HEIGHT_GAP_ZERO_M } from "../combat/aim-height-damage.mjs";
import { combineAttackOutcome } from "../combat/attack-outcome.mjs";

const RECOMPUTE_INTERVAL = 300; // ms — same throttle rationale as before, only runs while Alt is held

const RED    = 0xff2b2b; // full damage
const ORANGE = 0xffa500; // half damage — one factor active
const GREEN  = 0x4caf50; // quarter damage — two factors stacking
const GREY   = 0x9a9a9a; // zero damage — no shot at all

const TIER_COLOR = { full: RED, half: ORANGE, quarter: GREEN, zero: GREY };
const TIER_LABEL = { full: "", half: "½", quarter: "¼", zero: "✕" };

let _container = null;
let _altHeld = false;
let _lastRecompute = 0;
let _lastStrokesKey = "";
/** [{ shooterToken, entries: [{ token, tier }] }] — one group per armed shooter, entries NOT
 *  deduped across groups (see file header — that's the whole point of this rewrite). */
let _groups = [];

function _strokesKey(strokes) {
  let out = "";
  for (const s of strokes) {
    const n = s.cells.length;
    const first = s.cells[0], last = s.cells[n - 1];
    out += `${s.tokenId}:${n}:${first?.col},${first?.row}:${last?.col},${last?.row}|`;
  }
  return out;
}

function _ensureContainer() {
  if (_container?.parent) return;
  if (!canvas.stage) return;
  const tokenParent = canvas.tokens?.parent || canvas.environment;
  _container = new PIXI.Container();
  _container.name = "godHitPreviewList";
  _container.eventMode = "none";
  const tokensIdx = tokenParent.children?.indexOf(canvas.tokens) ?? -1;
  if (tokensIdx >= 0) tokenParent.addChildAt(_container, tokensIdx + 1);
  else tokenParent.addChild(_container);
}

/** Same per-shooter tier computation the old ring system used — grouped per shooter instead of
 *  deduped globally by target (see file header). */
function _recompute() {
  const groups = [];
  const strokes = getVisibleAoeStrokes();
  if (strokes.length && canvas.tokens?.placeables) {
    const ctx = buildBlindSpotContext();
    for (const shooterId of new Set(strokes.map((s) => s.tokenId))) {
      const shooterToken = canvas.tokens.get(shooterId);
      if (!shooterToken) continue;
      const lobbed = isLobbedShooter(shooterId);
      const ranged = isRangedShooter(shooterId);
      const aim = directionalAimInfo(shooterId);
      const gapZeroM = aim?.attackType === "ranged" ? HEIGHT_GAP_ZERO_M : (aim?.weaponReachM ?? 0) / 2;
      const hitSet = hitTokenIdsForShooter(shooterId);

      const entries = [];
      for (const id of coverTargetIdsForShooter(shooterId)) {
        const token = canvas.tokens.get(id);
        if (!token || token.id === shooterId) continue;
        const actorType = token.actor?.type;
        if (actorType !== "character" && actorType !== "npc" && actorType !== "creature") continue;

        try {
          if (!hitSet.has(id)) {
            entries.push({ token, tier: "zero" });
            continue;
          }
          let level = "none";
          if (lobbed) {
            const eye = lobbedBlastEye(shooterId);
            if (eye) level = coverFromPoint(eye, token, { fullWalls: ctx.fullWalls, walls: ctx.walls }).level;
          } else {
            level = computeCover(shooterToken, token, { fullWalls: ctx.fullWalls, walls: ctx.walls }).level;
          }
          let heightTier = null;
          if (aim) {
            heightTier = aimHeightDamageTier({
              targetZ: aim.targetZ,
              attackType: aim.attackType,
              canHitLowFlight: aim.canHitLowFlight,
              canHitHighFlight: aim.canHitHighFlight,
            }, {
              floorZ: token.document.elevation ?? 0,
              heightM: eyeHeightForToken(token),
            }, gapZeroM).tier;
          }
          const hearNotSee = ranged
            ? hearsButDoesNotSee(shooterToken, token, { fullWalls: ctx.fullWalls, walls: ctx.walls })
            : false;
          const tier = combineAttackOutcome({ coverLevel: level, heightTier, hearNotSee });
          entries.push({ token, tier });
        } catch (e) {
          console.error("god-tactical | hit-preview-list: outcome computation failed for", token.name, e);
        }
      }
      if (entries.length) groups.push({ shooterToken, entries });
    }
  }
  _groups = groups;
}

/** One shooter's target list, anchored just right of its token. Each line: target name
 *  (nickname if set), tier-colored, with a short tier glyph so the color isn't the only signal
 *  (½/¼/✕ — full has no glyph, it's simply the un-halved number). */
function _drawGroup(group, gridSize) {
  const { shooterToken, entries } = group;
  const cx = shooterToken.center?.x ?? shooterToken.x;
  const cy = shooterToken.center?.y ?? shooterToken.y;
  const fontSize = Math.max(16, Math.min(gridSize, gridSize) * 0.16);

  const lines = new PIXI.Container();
  lines.eventMode = "none";
  let y = 0;
  for (const { token, tier } of entries) {
    const label = token.document?.name && token.document.name !== token.actor?.name
      ? token.document.name // token's own display name already IS the nickname when overridden
      : (token.actor?.name ?? token.name);
    const glyph = TIER_LABEL[tier] ? `${TIER_LABEL[tier]} ` : "";
    const text = new PIXI.Text(`${glyph}${label}`, new PIXI.TextStyle({
      fontFamily: "Signika",
      fontSize,
      fontWeight: "bold",
      fill: TIER_COLOR[tier] ?? GREY,
      stroke: "#000000",
      strokeThickness: Math.max(2, fontSize * 0.18),
      lineJoin: "round",
    }));
    text.position.set(0, y);
    lines.addChild(text);
    y += fontSize * 1.2;
  }
  lines.position.set(cx + gridSize * 0.55, cy - y / 2);
  _container.addChild(lines);
}

function _onTicker() {
  if (!_container || !canvas?.ready) return;

  if (!_altHeld) {
    if (_container.children.length) _container.removeChildren();
    return;
  }

  const now = performance.now();
  const key = _strokesKey(getVisibleAoeStrokes());
  const changed = key !== _lastStrokesKey;
  if (changed || now - _lastRecompute >= RECOMPUTE_INTERVAL) {
    _lastStrokesKey = key;
    _lastRecompute = now;
    _recompute();
  }

  for (let i = _container.children.length - 1; i >= 0; i--) {
    _container.children[i].destroy({ children: true });
  }
  _container.removeChildren();
  if (!_groups.length) return;

  const gridSize = canvas.grid?.sizeX ?? 100;
  for (const group of _groups) _drawGroup(group, gridSize);
}

function _onKeyDown(event) {
  if (event.key !== "Alt" || _altHeld) return;
  _altHeld = true;
}
function _onKeyUp(event) {
  if (event.key !== "Alt") return;
  _altHeld = false;
}

export function registerRegionCoverOverlay() {
  Hooks.on("canvasReady", () => {
    _ensureContainer();
    canvas.app.ticker.add(_onTicker);
  });
  Hooks.on("canvasTearDown", () => {
    if (canvas?.app?.ticker) canvas.app.ticker.remove(_onTicker);
    _container = null;
    _groups = [];
    _lastRecompute = 0;
  });
  // Alt is also a native-browser modifier (alt-click menus etc. on some OSes) — window-level
  // listeners here only ever flip a boolean, never preventDefault/stopPropagation, so they
  // can't interfere with anything else Alt already does.
  window.addEventListener("keydown", _onKeyDown);
  window.addEventListener("keyup", _onKeyUp);
}
