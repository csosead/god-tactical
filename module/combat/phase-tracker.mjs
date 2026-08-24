/**
 * GOD Tactical — Phase-Stage Tracker
 *
 * Embedded into the native Combat Encounters sidebar tab, shared by the whole table,
 * reminding everyone which combat phase (Атака/Движения) and which resolution stage
 * within it is currently active. This system has no initiative, so that tab's own
 * combatant list is always empty — the tracker lives in the space right under its
 * round header instead of a separate floating window. One value for the whole
 * encounter — stored on the Combat document (not per-user, unlike phase-controls.mjs's
 * own activePhase flag, which is each player's own current phase, set automatically by
 * whichever base action they last pressed in the Планер). Only the GM advances it;
 * everyone else gets a read-only view.
 */

import { PHASES } from "./phase-controls.mjs";

const FLAG_SCOPE  = "god-tactical";
const PHASE_FLAG  = "trackerPhase";
const STAGE_FLAG  = "trackerStage";

/** Every {phaseKey, stageKey} pair in resolution order, execution first — lets prev/next
 *  step across the phase boundary without the caller needing to special-case it. */
function _flatSteps() {
  const steps = [];
  for (const phase of PHASES) {
    for (const stage of phase.stages) steps.push({ phaseKey: phase.key, stageKey: stage.key });
  }
  return steps;
}

/** Current {phase, stage} objects (falls back to the very first step of the first
 *  phase if the combat has no tracker flags yet, or its stored keys no longer match
 *  anything in PHASES). */
function _getState() {
  const phaseKey = game.combat?.getFlag(FLAG_SCOPE, PHASE_FLAG);
  const phase = PHASES.find((p) => p.key === phaseKey) ?? PHASES[0];
  const stageKey = game.combat?.getFlag(FLAG_SCOPE, STAGE_FLAG);
  const stage = phase.stages.find((s) => s.key === stageKey) ?? phase.stages[0];
  return { phase, stage };
}

/** The shared tracker's current phase entry ({key,label,color,stages}), or null if
 *  there's no active combat — there's nothing shared to read yet, so callers should
 *  fall back to something else (see action-log.mjs's use of this alongside
 *  phase-controls.mjs's own per-user getActivePhaseEntry()). Unlike _getState()
 *  above (used by the tracker's own render, which always wants *a* phase to draw),
 *  this one deliberately does NOT default to PHASES[0] when there's no combat. */
export function getTrackerPhaseEntry() {
  if (!game.combat) return null;
  return _getState().phase;
}

/** The shared tracker's current STAGE entry ({key,label,hint}) — same null-with-no-
 *  combat behavior as getTrackerPhaseEntry() above, and always from the same phase that
 *  function would return (both read one _getState() call's worth of flags, just never
 *  the same call — each recomputes independently, which is fine since Combat flag reads
 *  are cheap and synchronous). Added for phase-activation-reminder.mjs, which needs to
 *  know exactly which stage just became current, not just which phase it's in (both
 *  phases have their own "prep" stage — see PHASES' doc comment in phase-controls.mjs —
 *  so the phase alone doesn't disambiguate it). */
export function getTrackerStageEntry() {
  if (!game.combat) return null;
  return _getState().stage;
}

/** Whether the shared tracker is currently sitting on the "planning" stage (Атака's own
 *  first stage — see phase-controls.mjs's PHASES doc comment) — the ONE stage where
 *  declaring new stuff (dragging a weapon onto the canvas, "Добавить в Планер") is
 *  allowed at all. false with no active combat, same as everything else here that reads
 *  the shared state. This is a table-wide gate, not a per-user one — replaces the old
 *  per-user activePhase check (phase-controls.mjs's getActivePhaseEntry()) for exactly
 *  that purpose; getActivePhaseEntry() itself still exists for its other uses (display
 *  fallback outside combat, template preview coloring). */
export function isPlanningStage() {
  if (!game.combat) return false;
  return _getState().stage.key === "planning";
}

/** Writes the shared state — GM-only (Combat document permissions would reject a
 *  player's attempt anyway, but the UI never even shows these controls to one). */
async function _setState(phaseKey, stageKey) {
  if (!game.combat || !game.user.isGM) return;
  await game.combat.update({
    [`flags.${FLAG_SCOPE}.${PHASE_FLAG}`]: phaseKey,
    [`flags.${FLAG_SCOPE}.${STAGE_FLAG}`]: stageKey,
  });
}

/** Jump to a phase's own first stage — used by the phase tabs and the round-reset. */
async function _selectPhase(phaseKey) {
  const phase = PHASES.find((p) => p.key === phaseKey);
  if (!phase) return;
  await _setState(phaseKey, phase.stages[0].key);
}

/** Step forward/backward through the flat, cross-phase sequence — clamped at both
 *  ends rather than wrapping (a GM who wants to jump phases directly already has the
 *  phase tabs for that). */
async function _step(delta) {
  const steps = _flatSteps();
  const { phase, stage } = _getState();
  const idx = steps.findIndex((s) => s.phaseKey === phase.key && s.stageKey === stage.key);
  const nextIdx = Math.min(steps.length - 1, Math.max(0, idx + delta));
  const next = steps[nextIdx];
  await _setState(next.phaseKey, next.stageKey);
}

/* ── Combat Tracker embed ────────────────────────────────────────────────── */

/** Builds the tracker's inner markup for the given state — shared by first-insert and
 *  refresh-in-place, so both paths render identically. */
function _buildMarkup(isGM, phase, stage) {
  return `
    <div class="god-tracker-phases">
      ${PHASES.map((p) => `
        <button type="button" class="god-tracker-phase-btn${p.key === phase.key ? " active" : ""}"
                data-phase="${p.key}" title="${p.label}" style="--phase-color: ${p.color};"
                ${isGM ? "" : "disabled"}>
          ${p.label}
        </button>`).join("")}
    </div>
    <div class="god-tracker-stages" style="--phase-color: ${phase.color};">
      ${phase.stages.map((s, i) => `
        <div class="god-tracker-stage${s.key === stage.key ? " active" : ""}${isGM ? " can-select" : ""}"
             data-stage="${s.key}" ${s.hint ? `data-tooltip="${s.hint}" data-tooltip-direction="UP"` : ""}>
          <span class="god-tracker-stage-num">${i + 1}</span>
          <span class="god-tracker-stage-label">${s.label}</span>
        </div>`).join("")}
    </div>
    ${isGM ? `
    <div class="god-tracker-nav">
      <button type="button" class="god-tracker-prev" title="Предыдущий этап"><i class="fas fa-chevron-left"></i></button>
      <button type="button" class="god-tracker-next" title="Следующий этап"><i class="fas fa-chevron-right"></i></button>
    </div>` : ""}
  `;
}

/** Wires up the GM-only controls inside a freshly-(re)built tracker container —
 *  read-only for players, who never get these listeners (nothing in their markup is
 *  clickable anyway, see _buildMarkup's `disabled`/missing `can-select`/no nav). */
function _wireListeners(container, phase) {
  container.querySelectorAll(".god-tracker-phase-btn").forEach((btn) => {
    btn.addEventListener("click", () => _selectPhase(btn.dataset.phase));
  });
  container.querySelectorAll(".god-tracker-stage.can-select").forEach((el) => {
    el.addEventListener("click", () => _setState(phase.key, el.dataset.stage));
  });
  container.querySelector(".god-tracker-prev")?.addEventListener("click", () => _step(-1));
  container.querySelector(".god-tracker-next")?.addEventListener("click", () => _step(1));
}

/** `renderCombatTracker` handler — inserts (once) or refreshes (on every later render,
 *  partial or full) a `.god-tracker-embed` block right under the encounter header. The
 *  block sits outside the tracker's own `header`/`tracker`/`footer` PARTS containers, so
 *  it survives partial re-renders (e.g. a turn/round change only touches "tracker")
 *  without needing to be recreated — only its content is rebuilt each time. `html` is
 *  the app's own root element (works the same whether popped out or docked in the
 *  sidebar), never the global `document`, so this behaves correctly in either case. */
function _injectIntoCombatTracker(_app, html) {
  const existing = html.querySelector(".god-tracker-embed");
  if (!game.combat) {
    existing?.remove();
    return;
  }

  let container = existing;
  if (!container) {
    const header = html.querySelector("header.combat-tracker-header");
    if (!header) return;
    container = document.createElement("div");
    container.className = "god-tracker-embed god-tracker-wrap";
    header.insertAdjacentElement("afterend", container);
  }

  const isGM = game.user.isGM;
  const { phase, stage } = _getState();
  container.innerHTML = _buildMarkup(isGM, phase, stage);
  if (isGM) _wireListeners(container, phase);
}

export function registerPhaseTracker() {
  // As soon as combat starts, reset to the very first stage (Атака → Подготовка) —
  // every connected client runs this hook and reads the same Combat-document flags, so
  // re-rendering the sidebar tab (if it's currently open) picks up the reset for all of
  // them via the renderCombatTracker hook below.
  Hooks.on("createCombat", async () => {
    if (game.user.isGM) await _selectPhase(PHASES[0].key);
    if (ui.combat?.rendered) ui.combat.render();
  });

  Hooks.on("updateCombat", (combat, changes) => {
    if (combat.id !== game.combat?.id) return;
    // New round — resolution starts over from the top, same as the per-user action
    // log's own round-reset (action-log.mjs's updateCombat listener). Deferred one tick:
    // firing a second combat.update() synchronously inside this same updateCombat
    // dispatch can race with Foundry's own still-in-flight round/turn update on the same
    // document, occasionally losing our flag write once both acks land (reproduced live —
    // the reset intermittently stuck on the previous phase instead of the first one).
    // Letting the round update's own round-trip settle first avoids the race.
    if (foundry.utils.hasProperty(changes, "round") && game.user.isGM) {
      setTimeout(() => _selectPhase(PHASES[0].key), 50);
      return; // the update above triggers its own updateCombat re-render
    }
    if (foundry.utils.hasProperty(changes, `flags.${FLAG_SCOPE}.${PHASE_FLAG}`)
        || foundry.utils.hasProperty(changes, `flags.${FLAG_SCOPE}.${STAGE_FLAG}`)) {
      if (ui.combat?.rendered) ui.combat.render();
    }
  });

  // No deleteCombat listener needed — ending combat already makes Foundry's own
  // CombatTracker re-render itself (hasCombat becomes false), and _injectIntoCombatTracker
  // removes the stale embed as soon as that render (or any other) fires with no game.combat.
  Hooks.on("renderCombatTracker", _injectIntoCombatTracker);
}
