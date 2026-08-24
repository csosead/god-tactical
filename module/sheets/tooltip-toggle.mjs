/**
 * GOD Tactical — Tooltip toggle
 * A client-scoped on/off switch for Foundry's own hover tooltips (data-tooltip — skill/
 * characteristic descriptions, XP readouts, etc., all rendered through the singleton
 * #tooltip element game.tooltip/TooltipManager manages). Native title="" tooltips on
 * plain buttons are untouched — those are OS-rendered, never go through #tooltip at all.
 * Per-user preference (scope "client"), not a world setting — one player finding the
 * hover text distracting shouldn't hide it for the whole table.
 */

const SETTING_KEY = "tooltipsEnabled";
const BODY_CLASS = "god-tooltips-off";

function _applyBodyClass() {
  const enabled = game.settings.get("god-tactical", SETTING_KEY);
  document.body.classList.toggle(BODY_CLASS, !enabled);
}

/** Registered at "init" (settings must be) — the body class itself is applied once
 *  settings are actually readable, at "ready" (see god-tactical.mjs). */
export function registerTooltipToggle() {
  game.settings.register("god-tactical", SETTING_KEY, {
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
  });
}

/** Applies the current setting's body class — call once at ready, and again any time the
 *  setting changes (the button below does both itself). */
export function applyTooltipToggleState() {
  _applyBodyClass();
}

/** Inject the tooltip on/off button into a sheet's window header. Mirrors actor-sheet.mjs's
 *  injectEditToggle/injectBuilderButton insertion logic (before the first existing
 *  control, or appended if none) — call from each sheet class's own _onRender, same as
 *  those. Self-contained: reads/writes the client setting directly, no per-actor state to
 *  thread through like editMode has. */
export function injectTooltipToggleButton(root) {
  const header = root.closest(".application")?.querySelector(".window-header")
              ?? root.querySelector(".window-header");
  if (!header) return;
  const enabled = game.settings.get("god-tactical", SETTING_KEY);
  let btn = header.querySelector(".god-tooltip-toggle-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "god-tooltip-toggle-btn";
    const firstCtrl = header.querySelector(".sheet-edit-btn, .god-builder-btn")
                    ?? header.querySelector("[data-action='toggleControls'], [data-action='close']");
    if (firstCtrl) header.insertBefore(btn, firstCtrl);
    else header.appendChild(btn);
  }
  btn.classList.toggle("is-off", !enabled);
  btn.title = enabled ? "Подсказки включены — нажмите, чтобы отключить" : "Подсказки отключены — нажмите, чтобы включить";
  btn.innerHTML = `<i class="fa-solid ${enabled ? "fa-comment-dots" : "fa-comment-slash"}"></i>`;
  btn.onclick = async (e) => {
    e.preventDefault();
    const next = !game.settings.get("god-tactical", SETTING_KEY);
    await game.settings.set("god-tactical", SETTING_KEY, next);
    _applyBodyClass();
    // Re-run this same function to flip the icon/title in place, on every sheet
    // currently open — not just this one — so all of them agree immediately.
    for (const app of foundry.applications.instances.values()) {
      if (app.element) injectTooltipToggleButton(app.element);
    }
  };
}
