/**
 * GOD Tactical — NPC Hierarchy Badge (canvas)
 *
 * Draws a small, unobtrusive corner badge on every NPC token reflecting its
 * system.hierarchy tier (Pawn/Equal/Boss — see GOD.NPC_HIERARCHY_TIERS in
 * config.mjs), so the GM can read combat role at a glance on the map instead of
 * opening each sheet. GM-only: hierarchy is table/GM metadata with no mechanical
 * effect (see npc-sheet.mjs) — showing "this one's a Boss" to players would just
 * spoil the read.
 *
 * Plain PIXI shapes, not the FontAwesome glyphs the sheet's own portrait badge
 * uses — a canvas overlay can't rely on an icon webfont being loaded/available the
 * way the sheet's HTML <i> tag can, so this reuses only the tier→color half of
 * GOD.NPC_HIERARCHY_META, not the icon class.
 */

import { GOD } from "../config.mjs";

const BADGE_KEY = "_godHierarchyBadge";
const BADGE_TIER_KEY = "_godHierarchyBadgeTier";

function _tierColorInt(tier) {
  const hex = GOD.NPC_HIERARCHY_META[tier]?.color;
  return hex ? PIXI.utils.string2hex(hex) : null;
}

function _shouldShow(token) {
  if (!game.user.isGM) return false;
  return token.actor?.type === "npc";
}

function _clearBadge(token) {
  const g = token[BADGE_KEY];
  if (g && !g.destroyed) g.destroy();
  token[BADGE_KEY] = null;
  token[BADGE_TIER_KEY] = null;
}

/** (Re)builds the badge graphic from scratch — only needed the first time a token is
 *  drawn, or when its tier actually changes; see _refreshBadge below. */
function _buildBadge(token, tier, color) {
  const r = Math.max(3, Math.min(token.w, token.h) * 0.07);
  const g = new PIXI.Graphics();
  g.eventMode = "none"; // purely decorative — never intercepts clicks meant for the token

  // Dark backing disc so the badge stays legible over any token art.
  g.beginFill(0x0a0b0b, 0.75);
  g.drawCircle(0, 0, r + 2);
  g.endFill();

  // Pawn stays a faint hollow ring (minor/disposable); Equal and Boss get a filled
  // dot, Boss additionally rings itself again so it's the one tier that visibly
  // stands out at a glance.
  g.lineStyle(1.5, color, 0.9);
  g.beginFill(color, tier === "pawn" ? 0 : 0.85);
  g.drawCircle(0, 0, r);
  g.endFill();

  if (tier === "boss") {
    g.lineStyle(1.5, color, 0.9);
    g.drawCircle(0, 0, r + 4);
  }

  g.alpha = tier === "equal" ? 0.55 : 0.85;
  return g;
}

/** Called on drawToken/refreshToken/updateActor — repositions the existing badge
 *  (cheap, token size/position may have changed) and only rebuilds the actual
 *  graphic when the tier changed or it doesn't exist yet (avoids recreating a
 *  PIXI.Graphics on every single refreshToken, which fires very often). */
function _refreshBadge(token) {
  if (!_shouldShow(token)) {
    _clearBadge(token);
    return;
  }

  const tier = token.actor.system.hierarchy;
  const color = _tierColorInt(tier);
  if (color === null) {
    _clearBadge(token);
    return;
  }

  if (!token[BADGE_KEY] || token[BADGE_TIER_KEY] !== tier) {
    _clearBadge(token);
    const g = _buildBadge(token, tier, color);
    token.addChild(g);
    token[BADGE_KEY] = g;
    token[BADGE_TIER_KEY] = tier;
  }

  const pad = 4;
  token[BADGE_KEY].position.set(token.w - pad, pad);
}

export function registerNpcHierarchyBadges() {
  Hooks.on("drawToken", (token) => _refreshBadge(token));
  Hooks.on("refreshToken", (token) => _refreshBadge(token));
  Hooks.on("destroyToken", (token) => _clearBadge(token));

  Hooks.on("updateActor", (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, "system.hierarchy")) return;
    for (const token of canvas?.tokens?.placeables ?? []) {
      if (token.actor?.id === actor.id) _refreshBadge(token);
    }
  });

  // Fresh scene load — every placeable needs its badge (re)built from scratch since
  // the previous scene's PIXI tree (and our token[BADGE_KEY] references on it) is gone.
  Hooks.on("canvasReady", () => {
    for (const token of canvas?.tokens?.placeables ?? []) _refreshBadge(token);
  });
}
