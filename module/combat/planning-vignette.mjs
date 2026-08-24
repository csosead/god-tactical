/**
 * GOD Tactical — Planning Stage Vignette
 * A subtle red edge-glow over the whole viewport, PLAYER-ONLY (GM never sees it — they set the
 * stage, they don't need a reminder), visible exactly while the shared tracker sits on the
 * "Планирование" stage (phase-tracker.mjs's isPlanningStage) and gone the instant the GM moves
 * the stage on ("раскрывается" — the табле moves to Раскрытие). Purely a passive ambient cue —
 * "you're still in the private-planning window" — no click targets, no blocking.
 */

import { isPlanningStage } from "./phase-tracker.mjs";

let _el = null;

function _ensureElement() {
  if (_el) return _el;
  _el = document.createElement("div");
  _el.id = "god-planning-vignette";
  document.body.appendChild(_el);
  return _el;
}

function _sync() {
  if (game.user.isGM) return; // player-only cue, see file header
  const el = _ensureElement();
  el.classList.toggle("is-active", isPlanningStage());
}

export function registerPlanningVignette() {
  if (game.user.isGM) return; // never even create the element for a GM client

  Hooks.on("updateCombat", (combat, changes) => {
    if (combat.id !== game.combat?.id) return;
    // Any combat update could plausibly touch the phase/stage flags (or round, which resets
    // to the first stage — see phase-tracker.mjs) — cheap enough to just re-sync unconditionally
    // rather than pick apart `changes` for the exact flag paths.
    _sync();
  });
  Hooks.on("createCombat", () => _sync());
  Hooks.on("deleteCombat", () => _sync());
  Hooks.on("ready", () => _sync());
}
