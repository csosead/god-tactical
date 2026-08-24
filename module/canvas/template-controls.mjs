/**
 * GOD Tactical — Template Controls
 * Replaces the native "templates" SceneControl tools with GOD shape tools.
 */

import { setActiveShape, clearStrokes } from "./template-canvas.mjs";

// Invisible sentinel used as activeTool when nothing is selected.
// Foundry needs a valid tool key for deactivation calls; this satisfies
// that without blocking any real tool's onClick.
const PLACEHOLDER = "__god_none__";

const SHAPE_TOOLS = [
  { name: "god-ruler",    shape: "ruler",      icon: "fas fa-ruler",      title: "Ruler — measures distance only, never saved or logged" },
  { name: "god-thinline", shape: "thin_line", icon: "fas fa-shoe-prints", title: "Movement Path — click to lay each point, double-click to finish" },
  { name: "god-line",     shape: "line",      icon: "fas fa-minus",      title: "Line" },
  { name: "god-wideline", shape: "wide_line", icon: "fas fa-bars",       title: "Wide Line" },
  { name: "god-circle",   shape: "circle",    icon: "fas fa-circle",     title: "Circle" },
  { name: "god-cone",     shape: "cone",      icon: "fas fa-play",       title: "Cone" },
  { name: "god-square",   shape: "square",    icon: "fas fa-square",     title: "Square" },
];

/**
 * Single authoritative "which tool is active" switch — shape tools and the
 * "Привязка токена" tool are mutually exclusive (picking one clears the other),
 * so binding a token is a deliberate one-time action rather than something that
 * silently rides along with whatever shape you're drawing.
 */
function _activateShape(shape, toolName, bindMode = false) {
  setActiveShape(shape);
  if (game.godTactical) {
    game.godTactical.activeToolName  = toolName ?? null;
    game.godTactical.activeShape     = shape;
    game.godTactical.bindTokenActive = bindMode;
  }
  Hooks.callAll("godTactical.shapeChanged", shape);
}

function _getMeasure() {
  const c = ui.controls?.controls;
  if (!c) return null;
  if (typeof c.get === "function") return c.get("templates");
  return c?.templates ?? Object.values(c).find(x => x?.name === "templates") ?? null;
}

function _syncToolButtons(activeToolName) {
  for (const t of SHAPE_TOOLS) {
    const btn = document.querySelector(`[data-tool="${t.name}"]`);
    if (btn) btn.classList.toggle("active", t.name === activeToolName);
  }
  document.querySelector('[data-tool="god-bind-token"]')?.classList.toggle("active", activeToolName === "god-bind-token");
  // god-clear is sometimes set as activeTool internally — ensure it never looks active
  document.querySelector('[data-tool="god-clear"]')?.classList.remove("active");
}

// Cache tool objects so Foundry keeps stable references between renders
let _cachedTools = null;

function _buildTools() {
  const tools = {};

  // Sits directly above "Movement Path" (order 10). Selecting it is a mode switch,
  // same as picking a shape tool: it clears whatever shape was active, so the next
  // click on the canvas is a normal Foundry token click (select it → bind), not the
  // start of a template. Picking a shape tool afterwards leaves the bound token alone.
  const bindHandler = function (event, active) {
    if (active === false) return;
    _activateShape(null, "god-bind-token", true);
    _syncToolButtons("god-bind-token");
    const m = _getMeasure();
    if (m) m.activeTool = "god-bind-token";
  };
  tools["god-bind-token"] = {
    name:     "god-bind-token",
    title:    "Привязка токена — выбери этот инструмент (или зажми Ctrl), затем кликни по токену на карте, чтобы привязать его к следующим шаблонам и Планеру. Снимается кликом по пустому месту.",
    icon:     "fas fa-link",
    order:    9,
    button:   true,
    onChange: bindHandler,
    execute:  bindHandler,
  };

  let order = 10;

  for (const t of SHAPE_TOOLS) {
    const name = t.name;
    const handler = function (event, active) {
      // Foundry calls onChange(event, false) when deactivating the activeTool
      // as you leave the control group — skip in that case.
      if (active === false) return;
      _activateShape(t.shape, name);
      _syncToolButtons(name);
      // Move activeTool to the newly selected tool so every OTHER tool remains
      // clickable (Foundry skips onChange for the current activeTool on click).
      const m = _getMeasure();
      if (m) m.activeTool = name;
    };
    tools[name] = {
      name,
      title:    t.title,
      icon:     t.icon,
      order:    order++,
      button:   true,
      onChange: handler,
      execute:  handler,
    };
  }

  tools["god-clear"] = {
    name:     "god-clear",
    title:    game.i18n.localize("GOD.Templates.Clear"),
    icon:     "fas fa-trash",
    order:    order++,
    button:   true,
    onChange: (event, active) => { if (active !== false) clearStrokes(); },
    execute:  () => clearStrokes(),
  };

  // Hidden sentinel — gives Foundry a valid deactivation target when nothing
  // is selected, so it never tries to call .onChange on undefined.
  tools[PLACEHOLDER] = {
    name:     PLACEHOLDER,
    title:    "",
    icon:     "fas fa-circle",
    order:    order++,
    button:   true,
    onChange: () => {},
    execute:  () => {},
  };

  _cachedTools = tools;
  return tools;
}

export function registerTemplateControls() {
  Hooks.on("getSceneControlButtons", (controls) => {
    let measure;
    if (controls instanceof Map || typeof controls?.get === "function") {
      measure = controls.get("templates");
    } else if (typeof controls === "object" && controls !== null) {
      measure = controls.templates;
    }
    if (!measure) {
      const all = (controls instanceof Map) ? Array.from(controls.values()) : Object.values(controls);
      measure = all.find((c) => c.name === "templates");
    }
    if (!measure) {
      // Foundry v14 stopped auto-providing a native "templates" scene-control group
      // (CONFIG.Canvas.layers.templates / the TemplateLayer itself still exists —
      // core just no longer wires a toolbar group to it by default). Previously this
      // function only ever RELABELED an existing native group; now it has to build
      // one from scratch in the same minimal shape core's own groups use (see
      // ui.controls.controls.tokens for reference: {name, order, title, icon, tools,
      // activeTool}) and insert it back — order 1.5 sits between Tokens (1) and
      // Tiles (2), where the native template control used to live.
      measure = {
        name: "templates",
        order: 1.5,
        title: game.i18n.localize("GOD.Templates.Title"),
        icon: "fas fa-ruler-combined",
        tools: {},
      };
      if (controls instanceof Map || typeof controls?.set === "function") controls.set("templates", measure);
      else if (typeof controls === "object" && controls !== null) controls.templates = measure;
      else { console.warn("god-tactical | could not insert templates control — unrecognised controls shape"); return; }
    }

    const ourTools = _cachedTools ?? _buildTools();
    measure.tools = ourTools;

    // Default activeTool to the hidden placeholder so that every real tool
    // (shapes AND god-clear) remains clickable. Foundry skips onChange for
    // the activeTool on click, so we never put a real tool there by default.
    // Once a shape is clicked its handler moves activeTool to itself.
    const savedTool = game.godTactical?.activeToolName;
    measure.activeTool = (savedTool && ourTools[savedTool]) ? savedTool : PLACEHOLDER;
  });

  Hooks.on("renderSceneControls", () => {
    const cur = ui.controls?.control?.name ?? ui.controls?.activeControl;
    if (cur === "templates") {
      _syncToolButtons(game.godTactical?.activeToolName ?? null);
    } else if (cur && game.godTactical?.activeShape) {
      _activateShape(null, null);
    }
  });

  // registerTemplateControls() itself runs on "setup", ahead of when this hook is
  // needed — but confirmed live that Foundry v14's SceneControls does its ONE
  // getSceneControlButtons call before "setup" even fires (unlike v13, nothing
  // ever re-invokes the hook naturally afterward), so our listener above is
  // registered too late to be seen by core's own first pass and the "templates"
  // group we build in it never appears. Self-heal once "ready" (ui.controls is
  // guaranteed to exist by then): re-run the hook by hand against the LIVE
  // controls object, then re-render — verified live to pick the group up.
  Hooks.once("ready", () => {
    if (!ui.controls?.controls) return;
    Hooks.callAll("getSceneControlButtons", ui.controls.controls);
    ui.controls.render(true);
  });

  document.addEventListener("keydown", _onGlobalKeyDown);
  document.addEventListener("keyup",   _onGlobalKeyUp);
  window.addEventListener("blur",      _releaseCtrlBindMode);

  // "R" activates our own ruler tool (Templates group). Core's "core.ruler" binding
  // is also on KeyR but only fires while the Token layer is active and only toggles
  // the native ruler tool — which we removed (see god-tactical.mjs). PRIORITY
  // precedence puts us ahead of that NORMAL-precedence core binding in the dispatch
  // order, and always returning true stops it from running afterward, so the two
  // never fight over the same key.
  game.keybindings.register("god-tactical", "activateRuler", {
    name: "GOD.Templates.RulerKeybinding",
    editable: [{ key: "KeyR" }],
    precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY,
    onDown: () => {
      ui.controls?.activate?.({ control: "templates", tool: "god-ruler" });
      return true;
    },
  });
}

// Set only while a Ctrl-hold is the reason bind mode turned on, so releasing Ctrl
// knows whether (and what) to restore. Stays null if bind mode was entered by
// clicking the tool button instead — that's a deliberate pick, Ctrl shouldn't undo it.
let _preCtrlState = null;

/** True while this Ctrl press is the same one Foundry's core MouseManager reserves for
 *  itself, so grabbing it would break the native gesture instead of just riding along
 *  beside it. Mirrors the exact conditions in MouseManager#onWheel (core client code,
 *  helpers/interaction/mouse-manager.mjs): Case 2 (dragging a token — Ctrl+Scroll adjusts
 *  elevation mid-drag) and Case 3 (rotate the hovered/controlled placeable on the active
 *  layer — Draw Light Source, Tiles, Drawings, Tokens, and our own Templates layer all set
 *  `rotatableObjects: true`). If we switch ui.controls the instant Ctrl goes down, Foundry's
 *  next Ctrl+Scroll rotates nothing: canvas.activeLayer has already become "templates" by
 *  the time the wheel event arrives, so the light/tile/token the user was hovering is no
 *  longer what `layer.hover` points to. Skipping the switch in exactly these cases leaves
 *  every other context (nothing hovered, or a non-rotatable layer) working as before. */
function _ctrlHasNativeMeaning() {
  if (canvas?.tokens?._draggedToken) return true; // Case 2 — mid-drag elevation adjust
  const layer = canvas?.activeLayer;
  if (!layer?.options?.rotatableObjects) return false;
  return layer.options?.controllableObjects ? layer.controlled.length > 0 : !!layer.hover; // Case 3
}

/** Holding Ctrl/Cmd temporarily switches into bind mode — same as clicking the tool
 *  — from ANY control group, not just Templates (matches the "activateRuler"
 *  keybinding's "works everywhere" behavior registered above): if a different
 *  group is active, ui.controls.activate() jumps to Templates and selects
 *  god-bind-token in one call, same official API path the Ruler hotkey uses. Releasing
 *  Ctrl restores both the previous tool/shape AND the previous control group (Foundry
 *  itself remembers that other group's last-active tool, so we only need to hand the
 *  group name back to activate() — see _releaseCtrlBindMode). */
function _onGlobalKeyDown(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (_preCtrlState !== null) return; // key-repeat while already switched — ignore
  if (game.godTactical?.bindTokenActive) return; // already in bind mode via the tool button
  if (_ctrlHasNativeMeaning()) return; // Foundry itself wants this Ctrl press — don't steal it

  _preCtrlState = {
    control:  ui.controls?.control?.name ?? ui.controls?.activeControl ?? null,
    shape:    game.godTactical?.activeShape ?? null,
    toolName: game.godTactical?.activeToolName ?? null,
  };
  ui.controls?.activate?.({ control: "templates", tool: "god-bind-token" });
}

function _onGlobalKeyUp(e) {
  if (e.ctrlKey || e.metaKey) return; // the other modifier key is still held
  _releaseCtrlBindMode();
}

function _releaseCtrlBindMode() {
  if (_preCtrlState === null) return;
  const saved = _preCtrlState;
  _preCtrlState = null;
  _activateShape(saved.shape, saved.toolName, false);
  _syncToolButtons(saved.toolName);
  if (saved.control && saved.control !== "templates") {
    ui.controls?.activate?.({ control: saved.control });
    return;
  }
  const m = _getMeasure();
  if (m) m.activeTool = (saved.toolName && _cachedTools?.[saved.toolName]) ? saved.toolName : PLACEHOLDER;
}
