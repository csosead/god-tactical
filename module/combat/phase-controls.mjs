/**
 * GOD Tactical — Combat Phase Controls
 *
 * The movement/execution phase buttons themselves live inside the Планер
 * window now (action-log.mjs renders them from the exported PHASES list and
 * calls togglePhase() below) — this module just owns the flag storage, the
 * bound-token canvas ring, and the phase-colored measured-template hook.
 */

import { extractBracketedHint } from "../data/rulebook-hints.mjs";

const FLAG_SCOPE = "god-tactical";
const FLAG_KEY   = "activePhase";

// `stages` is the resolution order within each phase — read by the phase-stage tracker
// (combat/phase-tracker.mjs) so both features share one definition of what the two
// phases are named/colored, instead of a second copy drifting out of sync.
//
// "planning" (Планирование) — the execution phase's own first stage, and the ONLY stage
// with no restriction on who can act: every player (and the GM, for NPCs) freely draws
// attack templates, drags weapons onto the canvas, and declares base actions (attacks,
// movement, abilities — see phase-tracker.mjs's isPlanningStage(), the shared,
// GM-controlled gate weapon-template-drop.mjs and the sheets' "Добавить в Планер" button
// check) for the WHOLE round, not just this phase — Движения's own declarations get
// planned here too, even though the stage itself lives under "Атака". Every other stage
// exists only to sequence PLAYBACK of what was already planned — Подготовка and Контроль
// are where declared cards resolve; Атака (the stage, same key as the phase — same name
// is intentional, not a typo) only marks/tags them (resolution deferred); Движения's last
// stage (Конец Раунда) is where declarations made back in planning finally resolve. A new
// round always resets back to planning (see phase-tracker.mjs's registerPhaseTracker
// round-reset), so every round starts with everyone free to plan again.
//
// "reveal" (Раскрытие) sits right after "planning" — the moment everything a player can
// still freely change stops being changeable: action-log.mjs gates editing an already-
// declared entry (delete/hold/reorder) on isPlanningStage() alone, so as soon as the GM
// steps the tracker past "Планирование" — into "Раскрытие" or any stage beyond it —
// every player's own Планер locks automatically (the GM is never locked out). No separate
// manual lock toggle exists for this anymore; the stage boundary IS the lock.
export const PHASES = [
  {
    key: "execution", label: "Атака", color: "#2ecc71",
    stages: [
      { key: "planning", label: "Планирование", hint: "Все свободно объявляют атаки, движения, способности — шаблоны, оружие, действия" },
      { key: "reveal",  label: "Раскрытие",  hint: "Объявленное зафиксировано — игроки больше не могут менять свои записи в Планере, дальше только ГМ" },
      { key: "prep",    label: "Подготовка", hint: "Срабатывание после объявлений" },
      { key: "attacks", label: "Атака",      hint: "Только метки после объявлений" },
      { key: "control", label: "Контроль",   hint: "Срабатывание после объявлений" },
    ],
  },
  {
    key: "movement", label: "Движения", color: "#3f88e6",
    stages: [
      { key: "prep",       label: "Подготовка", hint: "Срабатывание после объявлений" },
      { key: "move",       label: "Движения" },
      { key: "activation", label: "Конец Раунда", hint: "Срабатывание объявлений из фазы Атаки" },
    ],
  },
];

/**
 * Overrides each stage's hardcoded `hint` above with the live text from the rulebook
 * journal's "Фазы и этапы" entry (see seed-compendiums.mjs), if that entry exists and
 * still has the bracket convention intact for a given stage — one journal PAGE per
 * phase (page name === the phase's own label, e.g. "Атака"/"Движения"), and within it one
 * heading per stage (heading text === the stage's own label) immediately followed by the
 * tooltip sentence wrapped in [square brackets]. A GM can freely rewrite that sentence,
 * even translate it, and every stage tooltip picks up the change on next reload — the
 * SURROUNDING prose on the page is entirely free-form and never parsed. Removing the
 * brackets (or renaming/deleting the heading) for a given stage just leaves THAT stage's
 * hint on the hardcoded default above; nothing else on the page or in the tracker breaks.
 *
 * Safe to call for every connected client (GM or player) — this only reads already-
 * seeded, world-shared compendium data, never writes anything. Called once from the
 * system's ready hook (god-tactical.mjs), after seedCompendiums() has had a chance to
 * create the entry for a fresh world.
 */
export async function loadPhaseStageHintsFromRulebook() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;
  const index = await pack.getIndex();
  const entryIndex = index.find((e) => e.name === "Фазы и этапы");
  if (!entryIndex) return;
  const entry = await pack.getDocument(entryIndex._id);
  if (!entry) return;

  for (const phase of PHASES) {
    const page = entry.pages.find((p) => p.name === phase.label);
    if (!page) continue;
    const html = page.text?.content ?? "";
    for (const stage of phase.stages) {
      const hint = extractBracketedHint(html, stage.label);
      if (hint) stage.hint = hint;
    }
  }
}

/** Sets the current user's active phase — no more manual toggle buttons; this is now
 *  called automatically from action-log.mjs's _addBaseAction whenever the player logs a
 *  base action, deriving the phase from which BASE_ACTIONS group that action belongs to.
 *  A no-op if the phase is already current, so repeated actions in the same phase don't
 *  cause a redundant flag write (and downstream re-renders). */
export async function setActivePhase(key) {
  if (_getActivePhase() === key) return;
  await game.user.setFlag(FLAG_SCOPE, FLAG_KEY, key);
}

/** Returns the active phase color as a 0xRRGGBB number, or null if no phase set. */
export function getActivePhaseColor() {
  const entry = getActivePhaseEntry();
  if (!entry) return null;
  return Number(entry.color.replace("#", "0x"));
}

/** Returns the full active phase object {key, label, color}, or null. */
export function getActivePhaseEntry() {
  const phase = game.user?.getFlag(FLAG_SCOPE, FLAG_KEY) ?? null;
  if (!phase) return null;
  return PHASES.find((p) => p.key === phase) ?? null;
}

function _getActivePhase() {
  return game.user?.getFlag(FLAG_SCOPE, FLAG_KEY) ?? null;
}

let _tokenLabel = null;
let _tokenId    = null;

/** Returns the token ID last assigned via setPhaseTokenLabel, or null. */
export function getPhaseTokenId()   { return _tokenId; }
export function getPhaseTokenName() { return _tokenLabel; }

/** Update the bound-token state: toggles the static ◆ indicator (now in the Планер
 *  window's header, see action-log.mjs) and (re)draws the highlight ring on the token
 *  itself — see _highlightBoundToken. `name` is still stored/returned by
 *  getPhaseTokenName() (a few callers — action-log.mjs's _addBaseAction, mainly — use
 *  it as a fallback label when logging an entry), it's just not shown as text anywhere
 *  anymore. */
export function setPhaseTokenLabel(name, id = null) {
  _tokenLabel = name ?? null;
  _tokenId    = id   ?? null;
  const slot = document.querySelector("#god-phase-token");
  if (slot) slot.classList.toggle("has-token", !!id);
  _highlightBoundToken(id);
}

/* ── Bound-token canvas highlight ────────────────────────────────────────── */

let _highlightGfx = null;

function _clearTokenHighlight() {
  if (_highlightGfx && !_highlightGfx.destroyed) _highlightGfx.destroy();
  _highlightGfx = null;
}

/** Draws a colored ring (active phase color, falling back to a neutral green) around
 *  the bound token, as a child of the token's own PIXI display object — it then moves/
 *  scales with the token for free, no separate position-sync code needed. Replaces the
 *  old text-name indicator in the phase bar (see setPhaseTokenLabel above): "which
 *  token is bound" is now a property of the token itself, visible right on the map,
 *  not something you have to read off the bar. */
function _highlightBoundToken(id) {
  _clearTokenHighlight();
  if (!id || !canvas?.ready) return;
  const token = canvas.tokens?.placeables.find((t) => t.id === id);
  if (!token) return;

  const color = getActivePhaseColor() ?? 0x39ff14;
  const pad = 6;
  const g = new PIXI.Graphics();
  g.lineStyle(4, color, 1);
  g.drawRoundedRect(-pad, -pad, token.w + pad * 2, token.h + pad * 2, 8);
  g.eventMode = "none"; // purely decorative — never intercepts clicks meant for the token
  token.addChild(g);
  _highlightGfx = g;
}

function _onPreCreateMeasuredTemplate(doc) {
  if (!game.combat) return;
  const phase = _getActivePhase();
  if (!phase) return;
  const entry = PHASES.find((p) => p.key === phase);
  if (!entry) return;
  doc.updateSource({ fillColor: entry.color, borderColor: entry.color });
}

export function registerPhaseControls() {
  const _onCombatChange = () => {
    if (!game.combat) setPhaseTokenLabel(null); // combat over — binding no longer means anything
  };

  Hooks.on("createCombat", _onCombatChange);
  Hooks.on("deleteCombat", _onCombatChange);

  // The highlight ring is a child of the token's own PIXI object — Foundry destroys
  // that whole tree on scene teardown, so the reference just needs dropping, not a
  // second destroy() call. Also drop the binding itself: a token bound on scene A has
  // no meaning once you're looking at scene B.
  Hooks.on("canvasReady", () => {
    _highlightGfx = null;
    setPhaseTokenLabel(null);
  });

  // The bound token itself got deleted — same "binding no longer means anything" case.
  Hooks.on("deleteToken", (tokenDoc) => {
    if (tokenDoc.id === _tokenId) setPhaseTokenLabel(null);
  });

  // Re-color the bound-token ring when the current user's phase flag changes (picks
  // up the new phase's color; the Планер window's own phase-switch row re-renders
  // itself via its own updateUser listener in action-log.mjs).
  Hooks.on("updateUser", (user, changes) => {
    if (user.id !== game.user.id) return;
    if (foundry.utils.hasProperty(changes, `flags.${FLAG_SCOPE}.${FLAG_KEY}`)) {
      _highlightBoundToken(_tokenId);
    }
  });

  Hooks.on("preCreateMeasuredTemplate", _onPreCreateMeasuredTemplate);
}
