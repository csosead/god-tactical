/**
 * GOD Tactical — Token HUD tweaks
 *
 * Removes Foundry's native "Toggle Combat State" control (the crossed-swords button,
 * `data-action="combat"`) from the Token HUD for EVERYONE, GM included. This system
 * runs combat through its own phase tracker (combat/phase-tracker.mjs), not Foundry's
 * initiative/combatant model, so adding a token to the encounter from the HUD does
 * nothing useful and only invites confusion — the button is retired at the UI level.
 */

/** `renderTokenHUD` handler. `html` is the HUD's root element (HTMLElement in v13, a
 *  jQuery object in older cores) — normalise to a DOM node, then drop the combat button. */
function _stripCombatButton(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  root.querySelectorAll('[data-action="combat"]').forEach((el) => el.remove());
}

export function registerTokenHudTweaks() {
  Hooks.on("renderTokenHUD", _stripCombatButton);
}
