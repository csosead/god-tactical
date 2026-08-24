/**
 * GOD Tactical — Phase-Activation Reminder
 *
 * Whenever the shared phase/stage tracker (phase-tracker.mjs) steps onto a stage that's
 * a real trigger point for SOME activation type (Подготовка/Контроль in the Атака phase,
 * Подготовка/Финал раунда in the Движения phase — see ACTIVATION_BY_STAGE below), each
 * player gets a SELF-ONLY whispered chat card (public chat gets buried fast under
 * players' own dice-roll cards, this needs to stay legible) listing every "Особенности"
 * entry (items.mjs's featureEntryField — Weapon/Spell/Armor/Consumable/Trophy/Ability)
 * whose activation tag matches, but ONLY for items actually PLANNED this ROUND — logged
 * into the Планер (action-log.mjs's getActionLog(), a plain item tag added by dragging a
 * card onto the Планер panel, or a weapon/spell/ability template drop) — not just
 * sitting in inventory. Owning a weapon with a "Контроль, активация" feature doesn't
 * page you every Контроль stage; only actually declaring it this round does. Note this
 * is ROUND-wide, not phase-wide — an item logged while planning the execution phase
 * (e.g. firing a crossbow, Залп) can still carry a Feature meant to remind at a
 * movement-phase stage (e.g. Финал раунда) and vice versa; see _collectActivations'
 * own doc comment for why filtering that out by the entry's logged phase was wrong.
 *
 * Runs for the GM too (unlike planning-vignette.mjs's player-only vignette), and the
 * GM's OWN whisper is special-cased to roll up EVERY connected user's declared
 * activations, not just whatever the GM itself logged for its own NPCs — see
 * _collectActivations' use of action-log.mjs's getAllActionLogs() vs. getActionLog(). A
 * table-running GM wants the full picture of what triggers this stage across the whole
 * party, not just their own slice; a player only ever sees their own.
 */

import { getTrackerPhaseEntry, getTrackerStageEntry } from "./phase-tracker.mjs";
import { getActionLog, getAllActionLogs } from "./action-log.mjs";

// Both phases (Атака/Движения) have their OWN "prep" stage — keyed here as
// "phaseKey:stageKey" so the two don't collide (see config.mjs's ACTIVATION_TYPES doc
// comment for why "instant" stayed scoped to execution/prep specifically instead of
// matching either phase ambiguously — that's the whole point of this fix).
const ACTIVATION_BY_STAGE = {
  "execution:prep":       "instant",      // Подготовка (Атака) — GOD.Item.ActivationInstant
  "execution:control":    "control",      // Контроль (Атака) — GOD.Item.ActivationControl
  "movement:prep":        "prepMovement", // Подготовка (Движения) — GOD.Item.ActivationPrepMovement
  "movement:activation":  "closing",      // Финал раунда (Движения) — GOD.Item.ActivationClosing
};

// Item types that can carry a features list (items.mjs's featureEntryField) — Container
// and Tools don't. Local copy of action-log.mjs's own ITEM_ICON (not imported — importing
// FROM action-log.mjs risks the static-import-cycle class of bug flagged elsewhere in this
// codebase, e.g. weapon-template-drop.mjs's own header comment, and this map is 6 lines).
const ITEM_ICON = {
  weapon:     "fa-khanda",
  spell:      "fa-hat-wizard",
  ability:    "fa-bolt",
  armor:      "fa-shield-alt",
  consumable: "fa-flask",
  trophies:   "fa-gem",
};

/** Every logged item's matching features for this activation type — grouped by token as
 *  [{actorName, items:[{name, icon, features:[{text}]}]}]. Empty array (not null) when
 *  there's nothing to report, so the caller can just check `.length`.
 *
 *  Deliberately does NOT filter entries by the log entry's own `phase` (execution/
 *  movement) — that field records which BASE_ACTIONS group the LOGGED ACTION itself
 *  belongs to (Залп/Натиск → execution, see template-canvas.mjs's addLogEntry call), which
 *  is a completely different axis from which STAGE a card's own Feature is tagged to
 *  remind on (activation: instant/control/prepMovement/closing, ACTIVATION_BY_STAGE
 *  below spans both phase groups). A weapon fired during execution (phase:"execution" on
 *  its log entry) can still carry a Feature meant to remind at "Финал раунда"
 *  (movement:activation, activation:"closing") — e.g. Арбалет's own "Тяжёлый болт" —
 *  entirely legitimately, since firing it is what the closing-stage reminder is ABOUT.
 *  An earlier version of this filtered on `e.phase === phaseKey` on the theory that a
 *  stray entry from "the other phase" needed excluding — wrong: the log is already
 *  scoped to THIS ROUND (cleared on round change only, see action-log.mjs's
 *  registerPhaseTracker's updateCombat listener), never to a phase within it, so both
 *  the movement-side and execution-side entries logged this round are equally "this
 *  round's plan" and both need to stay in play for every stage's reminder check.
 *
 *  Deliberately does NOT go through game.combat.combatants — this system has no
 *  initiative (see phase-tracker.mjs's own header comment: "this system has no
 *  initiative, so that tab's own combatant list is always empty"), so a token bound to
 *  the Планер is essentially never actually added as a Combatant. getActionLog() is
 *  already a per-user flag (only this player's own logged entries), so ownership is
 *  implicit for a player — each logged tokenId is resolved straight off the scene
 *  instead. The GM gets EVERY connected user's log merged (getAllActionLogs(), see file
 *  header) instead of just its own — a GM's own Планер entries are usually just its
 *  NPCs, but the reminder should cover the whole table, players included. */
function _collectActivations(activationType) {
  if (!game.combat) return [];

  const rawLog = game.user.isGM ? getAllActionLogs() : getActionLog();
  const entries = rawLog.filter((e) => e.itemId);
  if (!entries.length) return [];

  // A token can log the same item more than once (e.g. two separate template picks off
  // the same weapon) — dedupe by itemId per token, the reminder cares whether it was
  // declared at all this round, not how many times.
  const itemIdsByToken = new Map();
  for (const e of entries) {
    if (!itemIdsByToken.has(e.tokenId)) itemIdsByToken.set(e.tokenId, new Set());
    itemIdsByToken.get(e.tokenId).add(e.itemId);
  }

  const groups = [];
  for (const [tokenId, itemIds] of itemIdsByToken) {
    const actor = canvas.scene?.tokens?.get(tokenId)?.actor;
    if (!actor?.isOwner) continue;

    const items = [];
    for (const itemId of itemIds) {
      const item = actor.items.get(itemId);
      if (!item) continue; // logged, then deleted from the actor since — nothing left to remind about
      const features = (item.system.features ?? [])
        .filter((f) => f.activation === activationType && f.text?.trim());
      if (!features.length) continue;
      items.push({ name: item.name, icon: ITEM_ICON[item.type] ?? "fa-box", features });
    }
    if (items.length) groups.push({ actorName: actor.name, items });
  }
  return groups;
}

/** Hand-built HTML card — same idiom as action-log.mjs's _sendPublishChatMessage (phase-
 *  colored border via --phase-color, reuses its .god-reveal-header/-phase/-actor classes
 *  for the header row so this doesn't need its own copy of that styling). */
function _buildCardHTML(phase, stage, groups) {
  const groupsHTML = groups.map((g) => {
    const itemsHTML = g.items.map((it) => {
      const featsHTML = it.features.map((f) => `<div class="god-phase-reminder-feat">${f.text}</div>`).join("");
      return `
        <div class="god-phase-reminder-item">
          <div class="god-phase-reminder-item-head"><i class="fas ${it.icon}"></i> ${it.name}</div>
          ${featsHTML}
        </div>`;
    }).join("");
    return `
      <div class="god-phase-reminder-group">
        <div class="god-phase-reminder-actor">${g.actorName}</div>
        ${itemsHTML}
      </div>`;
  }).join("");

  return `
    <div class="god-phase-reminder-card" style="--phase-color:${phase?.color ?? "#8a6bb8"}">
      <div class="god-reveal-header">
        <span class="god-reveal-phase">${phase?.label ?? ""}</span>
        <span class="god-reveal-actor">${stage.label}</span>
      </div>
      ${groupsHTML}
    </div>`;
}

/** Builds and sends the reminder for whichever stage the tracker just landed on — a
 *  silent no-op for stages with no ACTIVATION_BY_STAGE entry (Планирование, Раскрытие,
 *  Атака-the-stage, Движения-the-stage) or where nothing logged matches, so stepping
 *  through those never posts an empty card. */
function _sendReminder(phase, stage) {
  const activationType = ACTIVATION_BY_STAGE[`${phase.key}:${stage.key}`];
  if (!activationType) return;

  const groups = _collectActivations(activationType);
  if (!groups.length) return;

  const content = _buildCardHTML(phase, stage, groups);
  ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker(),
    whisper: [game.user.id],
  });
}

let _lastStageKey = null;

/** Resets the change-tracking baseline WITHOUT sending anything — used on load/combat-
 *  start so opening the client (or a fresh encounter) mid-stage doesn't itself trigger a
 *  reminder; only an actual subsequent stage change should. */
function _resetTracking() {
  _lastStageKey = getTrackerStageEntry()?.key ?? null;
}

/** The real entry point, called from every updateCombat — only fires when the stage KEY
 *  actually changed since last seen. A round reset touches the Combat document twice
 *  (round first, then the stage flags ~50ms later — see phase-tracker.mjs's registerPhaseTracker
 *  doc comment), so the first of those two updateCombat calls here sees no stage-key
 *  change yet and does nothing; the second one is what actually fires. */
function _maybeSendReminder() {
  const stage = getTrackerStageEntry();
  const newKey = stage?.key ?? null;
  if (newKey === _lastStageKey) return;
  _lastStageKey = newKey;
  const phase = getTrackerPhaseEntry();
  if (stage && phase) _sendReminder(phase, stage);
}

export function registerPhaseActivationReminder() {
  Hooks.on("updateCombat", (combat) => {
    if (combat.id !== game.combat?.id) return;
    _maybeSendReminder();
  });
  Hooks.on("createCombat", () => _resetTracking());
  Hooks.on("deleteCombat", () => { _lastStageKey = null; });
  Hooks.on("ready", () => _resetTracking());
}
