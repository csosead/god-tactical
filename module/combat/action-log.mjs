/**
 * GOD Tactical — Action Log
 */

import { getActivePhaseEntry, getPhaseTokenId, getPhaseTokenName, PHASES, setActivePhase } from "../combat/phase-controls.mjs";
import { getTrackerPhaseEntry, isPlanningStage } from "../combat/phase-tracker.mjs";
import { worldToGrid, normalizeShapeType, pathMovementCost } from "../canvas/template-geometry.mjs";
import { extractBracketedHint } from "../data/rulebook-hints.mjs";
import { GOD, formatMeters, metersToCells } from "../config.mjs";
import { coverTargetsForStroke } from "../canvas/attack-cover-targets.mjs";
// getStrokeById/GODRollDialog/dealNpcDamage are only ever called from INSIDE a function
// body here (_rollAttackForTarget), never at this module's own top-level — safe despite
// the resulting import cycle (action-log.mjs → template-canvas.mjs → action-log.mjs,
// and action-log.mjs → roll-dialog.mjs/npc-attack.mjs → attack-cover-targets.mjs →
// template-canvas.mjs → action-log.mjs), same already-proven-safe pattern this file's
// own coverTargetsForStroke import below already relies on.
import { getStrokeById } from "../canvas/template-canvas.mjs";
import { GODRollDialog } from "../rolls/roll-dialog.mjs";
import { dealNpcDamage } from "../rolls/npc-attack.mjs";

const FLAG_SCOPE    = "god-tactical";
const LOG_KEY       = "actionLog";
const HISTORY_KEY   = "actionLogHistory";
const PUBLISHED_KEY = "publishedGroups";   // stores "tokenId:phase" strings
const GLOBAL_HIDE   = "globalHide";
const HISTORY_LIMIT = 50;

/** Whether a NON-GM player is currently locked out of editing their own already-declared
 *  Планер entries (delete/hold/reorder) — true once the shared tracker has moved past the
 *  "Планирование" stage (see phase-tracker.mjs's isPlanningStage and phase-controls.mjs's
 *  PHASES doc comment on the "Раскрытие" stage right after it). Replaces the old manual
 *  GM lock toggle — the stage boundary itself is now the lock, automatic and never
 *  requiring the GM to remember to flip anything. The GM is never locked out; callers
 *  combine this with `!game.user.isGM` themselves rather than baking that in here, same
 *  as the old isGlobalLocked() call sites did. */
function _isPlannerLocked() {
  return !isPlanningStage();
}

function _sceneKey(base) {
  return `${base}_${canvas.scene?.id ?? "none"}`;
}

function _groupKey(tokenId, phase) {
  return `${tokenId ?? ""}:${phase ?? ""}`;
}

/** Best available display name for a token still on this canvas — prefers the linked
 *  actor's LIVE name over the token's own (possibly stale) name field, since the
 *  actor's name is what carries the auto-assigned NPC nickname (см. кличка,
 *  module/data/npc-nicknames.mjs) — a token's own cached name can lag behind it.
 *  Every log-display
 *  function re-resolves through here at render time rather than trusting whatever name
 *  string got captured when the entry was logged, so a nickname assigned (or changed)
 *  after the fact still shows up correctly. Falls back to `fallback` (whatever WAS
 *  captured at log time) then "—" once the token no longer exists on this canvas at all
 *  (scene changed, token deleted) — old history entries in particular routinely outlive
 *  their token. */
function _liveTokenName(tokenId, fallback) {
  const token = canvas.tokens?.placeables.find((t) => t.id === tokenId);
  return token?.actor?.name || token?.name || fallback || "—";
}

export const SHAPE_LABEL = {
  thin_line: "Маршрут",
  line:      "Линия",
  wide_line: "Широкая линия",
  circle:    "Круг",
  cone:      "Конус",
  square:    "Квадрат",
};

export const PHASE_LABEL = {
  movement:  "Движения",
  execution: "Атака",
};

const ITEM_ICON = {
  weapon:     "fa-khanda",
  spell:      "fa-hat-wizard",
  ability:    "fa-bolt",
  armor:      "fa-shield-alt",
  consumable: "fa-flask",
  trophies:   "fa-gem",
};

/* ── Base actions catalogue ──────────────────────────────────────────────── */

// Action-economy category each base action belongs to — shown as a "[Категория]"
// tag next to its name in the picker. Attack/melee-adjacent actions can be
// declared as more than one; "movement" marks Перемещение itself (the only action
// that's really the Движения phase's own act — the rest of that phase's actions are
// preparatory, same as most of Атаки's).
export const ACTION_CATEGORY_LABEL = {
  attack:   "Атака",
  control:  "Контроль",
  prep:     "Подготовка",
  movement: "Движения",
};

export const BASE_ACTIONS = {
  // Перемещение's own template data isn't declared here (unlike every other draggable
  // action below) — its range is the acting token's own Race/Creature speed, read fresh
  // at drag time (see _buildPseudoItem's move special-case). Преследование carries no
  // template either — dragging it onto the canvas doesn't draw a shape at all, it picks
  // a Foundry target off whichever token it's dropped on (see _armLoggedAction's pursue
  // special-case and weapon-template-drop.mjs's setPursuitTarget).
  movement: [
    { id: "move",       name: "Перемещение",  desc: "Переместиться на новую позицию.",                     categories: ["movement"] },
    { id: "rise",       name: "Подъём",       desc: "Встать с земли.",                                      categories: ["prep"] },
    { id: "pursue",     name: "Преследование", desc: "Следовать за отступающим противником.",               categories: ["prep"] },
    { id: "speed_up",   name: "Ускорение",    desc: "Увеличить скорость передвижения в этот ход.",          categories: ["prep"] },
    { id: "hide",       name: "Скрытность",   desc: "Уйти в укрытие и стать незаметным для врагов.",        categories: ["prep"] },
  ],
  // `attackType`/`natiskM`/`brosokM` (metres, converted to cells at drag time via
  // config.mjs's metersToCells) are only set on the actions a logged Планер entry can
  // be dragged onto the canvas FOR (see _armLoggedAction/_buildPseudoItem below) — same
  // shape a Weapon/Ability item's own natisk/brosok arrays use, just declared directly
  // here since these base actions have no item to carry it. Every other action (no
  // template data) simply does nothing if dropped on the canvas.
  execution: [
    { id: "melee",      name: "Натиск",         desc: "Ближний бой. Игрок выбирает шаблон: линия (дальность 2.5 м) или конус (дальность 2 м) — оба настильные.", categories: ["attack"],
      attackType: "melee", natiskM: [{ shape: "line", rangeM: 2.5 }, { shape: "cone", rangeM: 2 }] },
    { id: "ranged",     name: "Залп",           desc: "Дальний бой. Игрок выбирает шаблон: прямая (линия, настильная, дальность 5 м) или круг (площадь 0,5 м, навесной, забрасывается в точку в пределах 5 м).", categories: ["attack"],
      attackType: "ranged", natiskM: [{ shape: "line", rangeM: 5 }], brosokM: [{ shape: "circle", rangeM: 5, sizeM: 0.5 }] },
    { id: "defense",    name: "Уклонение",      desc: "Перейти в оборонительную стойку, повысив защиту.",   categories: ["prep"] },
    { id: "break_grab", name: "Высвобождение",  desc: "Вырваться из захвата противника.",                   categories: ["prep"] },
    { id: "recovery",   name: "Восстановление", desc: "Восстановить ресурсы или снять негативный эффект.",  categories: ["prep"] },
    { id: "interact",   name: "Взаимодействие", desc: "Взаимодействовать с объектом или союзником.",        categories: ["prep"] },
    { id: "reload",     name: "Перезарядка",    desc: "Перезарядить дальнобойное оружие.",                  categories: ["prep"] },
    { id: "push",       name: "Толчок",         desc: "Оттолкнуть противника. Игрок выбирает шаблон: линия (дальность 1 м).", categories: ["control"],
      attackType: "melee", natiskM: [{ shape: "line", rangeM: 1 }] },
    { id: "grab",       name: "Захват",         desc: "Схватить и удержать противника. Игрок выбирает шаблон: линия (дальность 1 м).", categories: ["control"],
      attackType: "melee", natiskM: [{ shape: "line", rangeM: 1 }] },
    { id: "knockdown",  name: "Опрокидывание",  desc: "Повалить противника на землю. Игрок выбирает шаблон: линия (дальность 1 м).", categories: ["control"],
      attackType: "melee", natiskM: [{ shape: "line", rangeM: 1 }] },
    { id: "assess",     name: "Оценка",         desc: "Проанализировать слабости противника.",              categories: ["prep"] },
    { id: "dodge",      name: "Рывок",          desc: "Уклониться от атаки противника. Игрок прокладывает путь передвижения (дальность 4 м).", categories: ["prep"],
      natiskM: [{ shape: "thin_line", rangeM: 4 }] },
  ],
};

/**
 * Overrides each base action's hardcoded `desc` above (BASE_ACTIONS' own hover tooltip on
 * its picker button, see _buildActionsHTML) with the live text from the rulebook
 * journal's "Действия" entry (see seed-compendiums.mjs), if that entry exists and still
 * has the bracket convention intact for a given action — same convention as
 * phase-controls.mjs's stage hints (see rulebook-hints.mjs's extractBracketedHint): one
 * journal PAGE per BASE_ACTIONS group (page name === PHASE_LABEL[group], e.g.
 * "Атака"/"Движения"), and within it one heading per action (heading text === the
 * action's own name) immediately followed by the tooltip text wrapped in [square
 * brackets]. A GM can freely rewrite that sentence, even translate it, and every action's
 * tooltip picks up the change on next reload — the surrounding prose is entirely
 * free-form and never parsed. Removing the brackets (or renaming/deleting the heading)
 * for a given action just leaves THAT action's desc on the hardcoded default above;
 * nothing else on the page or in the picker breaks.
 *
 * Safe to call for every connected client (GM or player) — this only reads already-
 * seeded, world-shared compendium data, never writes anything. Called once from the
 * system's ready hook (god-tactical.mjs), after seedCompendiums() has had a chance to
 * create the entry for a fresh world.
 */
export async function loadBaseActionDescsFromRulebook() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;
  const index = await pack.getIndex();
  const entryIndex = index.find((e) => e.name === "Действия");
  if (!entryIndex) return;
  const entry = await pack.getDocument(entryIndex._id);
  if (!entry) return;

  for (const [group, actions] of Object.entries(BASE_ACTIONS)) {
    const page = entry.pages.find((p) => p.name === PHASE_LABEL[group]);
    if (!page) continue;
    const html = page.text?.content ?? "";
    for (const action of actions) {
      const desc = extractBracketedHint(html, action.name);
      if (desc) action.desc = desc;
    }
  }
}

/* ── Recovery / cooldown actions ─────────────────────────────────────────────
 * Actions that go on cooldown when used: they can't be pressed again until
 * restored by that many "Восстановление" (Recovery) actions. The cooldown lives
 * as a persistent ActiveEffect on the phase token's actor (visible in the
 * Effects tab), carrying flag `god-tactical.recovery = { type, key, label,
 * remaining, total }`. Recovery-eligible abilities can later be added to the
 * same picker by tagging them with the same flag shape (type: "ability").
 */
const RECOVERY_COST  = {};
const COOLDOWN_ICON  = "icons/svg/clockwork.svg";

// Actions that inflict a status effect on their own user when used (see GOD.STATUS_EFFECTS,
// module/config.mjs). Рывок no longer goes on a recovery-cooldown counter — instead it leaves
// the user in Шатание ("suppressed" status id, kept from before the rename).
const ACTION_SELF_STATUS = { dodge: "suppressed" };
const RECOVERY_FLAG  = "recovery";

/** The actor of the currently-selected phase token, or null. */
function _getPhaseActor() {
  const id = getPhaseTokenId();
  if (!id) return null;
  return canvas.scene?.tokens?.get(id)?.actor ?? null;
}

/** Active recovery cooldowns on an actor: [{ effectId, type, key, label, remaining, total }]. */
function _getActorCooldowns(actor) {
  if (!actor) return [];
  const out = [];
  for (const eff of actor.effects) {
    const rec = eff.getFlag(FLAG_SCOPE, RECOVERY_FLAG);
    if (rec && rec.remaining > 0) out.push({ effectId: eff.id, ...rec });
  }
  return out;
}

/** Map actionId → remaining recoveries, for disabling on-cooldown action buttons. */
function _phaseCooldownMap() {
  const map = {};
  for (const cd of _getActorCooldowns(_getPhaseActor())) {
    if (cd.type === "action") map[cd.key] = cd.remaining;
  }
  return map;
}

/** Put a recovery-cost action on cooldown (persistent ActiveEffect with a counter). */
async function _startActionCooldown(actor, actionId, actionName) {
  const total = RECOVERY_COST[actionId];
  if (!total || !actor?.isOwner) return;
  if (_getActorCooldowns(actor).some((cd) => cd.type === "action" && cd.key === actionId)) return;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: `${actionName} — перезарядка (${total}/${total})`,
    img:  COOLDOWN_ICON,
    origin: actor.uuid,
    flags: { [FLAG_SCOPE]: { [RECOVERY_FLAG]: { type: "action", key: actionId, label: actionName, remaining: total, total } } },
  }]);
}

/** Spend one Recovery on a cooldown effect: −1, and remove it (restoring the action) at 0.
 *  Exported so the Effects tab can offer a manual decrement when the Recovery action
 *  itself is unavailable (e.g. locked out by a wound). */
export async function applyRecoveryTick(actor, effectId) {
  const eff = actor?.effects.get(effectId);
  const rec = eff?.getFlag(FLAG_SCOPE, RECOVERY_FLAG);
  if (!rec) return;
  const remaining = rec.remaining - 1;
  if (remaining <= 0) {
    await eff.delete();
  } else {
    await eff.update({
      name: `${rec.label} — перезарядка (${remaining}/${rec.total})`,
      [`flags.${FLAG_SCOPE}.${RECOVERY_FLAG}.remaining`]: remaining,
    });
  }
}

/** Ask which cooldown to progress; returns the chosen effectId, or null if cancelled. */
async function _promptRecoveryTarget(cooldowns) {
  const buttons = cooldowns.map((cd) => ({
    action: cd.effectId,
    label:  `${cd.label} (${cd.remaining}/${cd.total})`,
  }));
  buttons.push({ action: "cancel", label: "Отмена" });
  const result = await foundry.applications.api.DialogV2.wait({
    window:      { title: "Восстановление" },
    content:     "<p>Что восстановить?</p>",
    buttons,
    rejectClose: false,
  });
  return result && result !== "cancel" ? result : null;
}

/**
 * Central handler for an action-button press:
 *  - a recovery-cost action already on cooldown is blocked;
 *  - "Восстановление" opens the picker (if anything needs it), spends one tick, then logs;
 *  - any other recovery-cost action logs, then starts its cooldown.
 * Actions in ACTION_SELF_STATUS (e.g. Рывок) do NOT apply their status here — only once
 * that phase group is actually revealed (see togglePublishGroup / _applySelfStatusesOnReveal),
 * so hidden/never-revealed uses of Рывок never tag the token.
 */
async function _onActionClick(actionId, apType) {
  const action = Object.values(BASE_ACTIONS).flat().find((a) => a.id === actionId);
  const actor  = _getPhaseActor();

  if (RECOVERY_COST[actionId] && _getActorCooldowns(actor).some((cd) => cd.type === "action" && cd.key === actionId)) {
    ui.notifications?.warn(`${action?.name ?? "Действие"} на перезарядке — сначала используйте Восстановление.`);
    return;
  }

  if (actionId === "recovery") {
    const cooldowns = _getActorCooldowns(actor);
    if (cooldowns.length) {
      const effectId = await _promptRecoveryTarget(cooldowns);
      if (!effectId) return;                       // cancelled — don't spend the action
      await applyRecoveryTick(actor, effectId);
    }
    await _addBaseAction(actionId, apType);
    return;
  }

  const added = await _addBaseAction(actionId, apType);
  if (!added) return;
  if (RECOVERY_COST[actionId]) {
    await _startActionCooldown(actor, actionId, action?.name ?? actionId);
  }
}

/* ── Log storage ─────────────────────────────────────────────────────────── */

export function getActionLog() {
  return game.user?.getFlag(FLAG_SCOPE, _sceneKey(LOG_KEY)) ?? [];
}

/** Every connected user's own scene-scoped Планер log, flattened into one array — the
 *  log is a PER-USER flag (each player only ever writes their own), so there's no single
 *  "everyone's log" anywhere until something asks for it. Used by
 *  phase-activation-reminder.mjs's GM-side reminder: the GM's own self-whisper rolls up
 *  every player's declared activations too, not just whatever the GM itself logged for
 *  its own NPCs — a GM running a table wants the full picture, not just their own slice.
 *  Regular per-user reads should keep using getActionLog() above. */
export function getAllActionLogs() {
  return game.users.contents.flatMap((u) => u.getFlag(FLAG_SCOPE, _sceneKey(LOG_KEY)) ?? []);
}

/* ── GM auto-reveal mode ─────────────────────────────────────────────────── */

let _autoReveal = false;

export function isAutoReveal() { return _autoReveal; }

export function toggleAutoReveal() {
  _autoReveal = !_autoReveal;
  _refresh();
}

export async function addLogEntry(entry) {
  if (!canvas.scene) return;
  const log = getActionLog().slice();
  log.push(entry);
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(LOG_KEY), log);
  // Auto-publish when GM draws a real canvas shape in auto-reveal mode
  if (_autoReveal && game.user?.isGM && entry.tokenId && entry.phase
      && entry.shape !== "action" && entry.shape !== "item") {
    const key = _groupKey(entry.tokenId, entry.phase);
    if (!getPublishedGroups().includes(key)) {
      await togglePublishGroup(entry.tokenId, entry.phase);
    }
  }
}

/** Logs a bare item tag into the Планер — same "shape: item" entry the sheets' old
 *  "Добавить в Планер" context-menu action used to create (removed 2026-08-20 in favor
 *  of dragging the card straight onto the Планер panel, see _wireLog's drop handler
 *  below, which is this function's only caller now). Enforces the same preconditions
 *  that button did: active combat + the shared tracker's Планирование stage + a bound
 *  token, PLUS a new check the button never needed (its item was always the current
 *  sheet's own actor) — dragging can originate from anywhere, so this confirms the
 *  dropped item actually belongs to the token currently bound to the Планер. */
export async function addItemToActionLog(item) {
  if (!item?.parent) return; // a loose world/compendium item, not embedded on any actor — nothing to log

  if (!game.combat || !isPlanningStage()) {
    ui.notifications?.warn("Добавление в Планер доступно только на этапе «Планирование».");
    return;
  }

  const phaseEntry = getTrackerPhaseEntry();
  const tokenId   = getPhaseTokenId();
  const tokenName = getPhaseTokenName();
  if (!tokenId) {
    ui.notifications?.warn("Выберите токен перед добавлением предмета.");
    return;
  }

  const boundActor = canvas.scene?.tokens?.get(tokenId)?.actor;
  if (!boundActor || item.parent.id !== boundActor.id) {
    ui.notifications?.warn("Этот предмет принадлежит другому персонажу.");
    return;
  }

  // Block if non-GM and this group is already published (locked) — same check
  // actor-sheet.mjs's old #onAddToActionLog made.
  if (!game.user.isGM) {
    const published = getPublishedGroups();
    if (published.includes(`${tokenId}:${phaseEntry.key}`)) return;
  }

  await addLogEntry({
    strokeId:   `item_${item.id}_${Date.now()}`,
    tokenId,
    tokenName,
    phase:      phaseEntry.key,
    phaseColor: phaseEntry.color,
    shape:      "item",
    itemId:     item.id,
    itemName:   item.name,
    itemType:   item.type,
  });
}

/** Stamps a picked target's name onto an already-logged entry — the ONLY mutation used
 *  for, so far, Преследование (see weapon-template-drop.mjs's setPursuitTarget): dropping
 *  the tag onto an enemy token doesn't create a new log entry, it labels the EXISTING one
 *  ("Преследование" → "Преследование → Костедав", see _buildBodyHTML's targetSuffix) so
 *  who's being chased reads straight off the Планер, not only off the map's target
 *  reticle. No-op if the entry's gone (e.g. removed mid-drag). */
export async function setLogEntryTarget(strokeId, targetTokenName) {
  const log = getActionLog();
  const idx = log.findIndex((e) => e.strokeId === strokeId);
  if (idx === -1) return;
  const newLog = log.slice();
  newLog[idx] = { ...newLog[idx], targetTokenName };
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(LOG_KEY), newLog);
}

export async function removeLogEntry(strokeId) {
  if (_isPlannerLocked() && !game.user.isGM) return;
  const log   = getActionLog();
  const entry = log.find(e => e.strokeId === strokeId);
  if (entry?.isHeld) return;                              // held — skip
  const newLog = log.filter(e => e.strokeId !== strokeId);
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(LOG_KEY), newLog);
  if (entry) await _pushHistory(entry);
  Hooks.callAll("godTactical.removeStroke", strokeId);
}

export async function removeGroupEntries(tokenId, phase, force = false) {
  if (_isPlannerLocked() && !game.user.isGM) return;
  const log = getActionLog();
  // If any entry in the group is held (and not force), abort
  if (!force && log.some(e => e.tokenId === tokenId && e.phase === phase && e.isHeld)) return;
  const toRemove = log.filter(e => e.tokenId === tokenId && e.phase === phase);
  const newLog   = log.filter(e => !(e.tokenId === tokenId && e.phase === phase));
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(LOG_KEY), newLog);
  for (const e of toRemove) {
    await _pushHistory(e);
    Hooks.callAll("godTactical.removeStroke", e.strokeId);
  }
  if (!newLog.some(e => e.tokenId === tokenId)) {
    const published = getPublishedGroups().filter(k => !k.startsWith(`${tokenId}:`));
    await game.user.setFlag(FLAG_SCOPE, _sceneKey(PUBLISHED_KEY), published);
  }
}

export async function clearMyLog() {
  const log     = getActionLog();
  const toKeep  = log.filter(e => e.isHeld);
  const toRemove = log.filter(e => !e.isHeld);
  for (const e of toRemove) Hooks.callAll("godTactical.removeStroke", e.strokeId);
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(LOG_KEY), toKeep);
  // Preserve published groups for held entries
  if (!toKeep.length) {
    await game.user.setFlag(FLAG_SCOPE, _sceneKey(PUBLISHED_KEY), []);
  } else {
    const heldKeys = new Set(toKeep.map(e => _groupKey(e.tokenId, e.phase)));
    const published = getPublishedGroups().filter(k => heldKeys.has(k));
    await game.user.setFlag(FLAG_SCOPE, _sceneKey(PUBLISHED_KEY), published);
  }
  Hooks.callAll("godTactical.rerenderTemplates");
}

/* ── Hold mode ───────────────────────────────────────────────────────────── */

export async function toggleHoldGroup(tokenId, phase) {
  if (_isPlannerLocked() && !game.user.isGM) return;
  const log         = getActionLog();
  const groupEntries = log.filter(e => e.tokenId === tokenId && e.phase === phase);
  const isHeld      = groupEntries.some(e => e.isHeld);
  if (isHeld) {
    // Release hold → immediately delete
    await removeGroupEntries(tokenId, phase, true);
  } else {
    // Set hold on all entries in the group
    const newLog = log.map(e => {
      if (e.tokenId !== tokenId || e.phase !== phase) return e;
      return { ...e, isHeld: true };
    });
    await game.user.setFlag(FLAG_SCOPE, _sceneKey(LOG_KEY), newLog);
  }
}

/* ── Reorder entries ─────────────────────────────────────────────────────── */

export async function reorderLogEntry(moveStrokeId, beforeStrokeId) {
  if (_isPlannerLocked() && !game.user.isGM) return;
  const log = getActionLog().slice();
  const fromIdx = log.findIndex(e => e.strokeId === moveStrokeId);
  if (fromIdx === -1) return;
  const [moved] = log.splice(fromIdx, 1);
  const toIdx = log.findIndex(e => e.strokeId === beforeStrokeId);
  log.splice(toIdx >= 0 ? toIdx : log.length, 0, moved);
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(LOG_KEY), log);
}

/* ── History storage ─────────────────────────────────────────────────────── */

export function getActionHistory() {
  return game.user?.getFlag(FLAG_SCOPE, _sceneKey(HISTORY_KEY)) ?? [];
}

async function _pushHistory(entry) {
  if (!entry?.strokeId) return;
  const history = getActionHistory().slice();
  if (history.some(h => h.strokeId === entry.strokeId)) return;
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(HISTORY_KEY), history);
}

export async function restoreHistoryEntry(entryId) {
  const history    = getActionHistory();
  const entry      = history.find(e => e.id === entryId);
  if (!entry) return;
  const newHistory = history.filter(e => e.id !== entryId);
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(HISTORY_KEY), newHistory);
  await addLogEntry(entry);
  if (entry.strokeData) Hooks.callAll("godTactical.restoreStroke", entry.strokeData);
}

export async function clearHistory() {
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(HISTORY_KEY), []);
}

/* ── Privacy / publish ───────────────────────────────────────────────────── */

export function getPublishedGroups() {
  return game.user?.getFlag(FLAG_SCOPE, _sceneKey(PUBLISHED_KEY)) ?? [];
}

export async function togglePublishGroup(tokenId, phase) {
  const published = getPublishedGroups().slice();
  const key       = _groupKey(tokenId, phase);
  const idx       = published.indexOf(key);
  const wasPublished = idx >= 0;
  if (wasPublished) published.splice(idx, 1);
  else published.push(key);
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(PUBLISHED_KEY), published);
  if (!wasPublished) await _sendPublishChatMessage(tokenId, phase);
  Hooks.callAll("godTactical.rerenderTemplates");
}

/** On round change, apply each ACTION_SELF_STATUS status (e.g. "dodge" → Рывок ⇒
 *  Шатание) to every token that currently has the matching action anywhere in
 *  this client's action log — regardless of whether that group was ever revealed. */
async function _applySelfStatusesOnRoundChange() {
  const byToken = new Map(); // tokenId -> Set<statusId>
  for (const e of getActionLog()) {
    if (e.shape !== "action") continue;
    const statusId = ACTION_SELF_STATUS[e.actionId];
    if (!statusId) continue;
    if (!byToken.has(e.tokenId)) byToken.set(e.tokenId, new Set());
    byToken.get(e.tokenId).add(statusId);
  }
  if (!byToken.size) return;

  for (const [tokenId, statuses] of byToken) {
    const actor = canvas.tokens?.placeables.find(t => t.id === tokenId)?.actor;
    if (!actor?.isOwner) continue;
    for (const statusId of statuses) {
      await actor.toggleStatusEffect(statusId, { active: true });
    }
  }
}

async function _unpublishAll() {
  if (!getPublishedGroups().length) return;
  await game.user.setFlag(FLAG_SCOPE, _sceneKey(PUBLISHED_KEY), []);
  Hooks.callAll("godTactical.rerenderTemplates");
}

function _findAffectedTokens(entries) {
  if (!canvas.ready || !canvas.tokens?.placeables?.length) return [];

  // Get canvas strokes owned by this user for the current scene
  const strokeKey  = `strokes_${canvas.scene?.id ?? "none"}`;
  const myStrokes  = game.user.getFlag(FLAG_SCOPE, strokeKey) ?? [];

  // Only entries that correspond to real canvas templates (not action/item tags)
  const realIds    = new Set(
    entries.filter(e => e.shape !== "action" && e.shape !== "item").map(e => e.strokeId)
  );
  const groupStrokes = myStrokes.filter(s => realIds.has(s.id));
  if (!groupStrokes.length) return [];

  // Build a set of all occupied cells as "col,row" strings
  const cellSet = new Set(
    groupStrokes.flatMap(s => (s.cells ?? []).map(c => `${c.col},${c.row}`))
  );
  if (!cellSet.size) return [];

  const gs = canvas.grid?.sizeX ?? 100;
  const found = new Map();

  for (const token of canvas.tokens.placeables) {
    if (found.has(token.id)) continue;
    const gc   = worldToGrid(token.x, token.y);
    const wSq  = token.document?.width  ?? Math.max(1, Math.round((token.w ?? gs) / gs));
    const hSq  = token.document?.height ?? Math.max(1, Math.round((token.h ?? gs) / gs));
    let hit = false;
    outer: for (let c = gc.col; c < gc.col + wSq; c++) {
      for (let r = gc.row; r < gc.row + hSq; r++) {
        if (cellSet.has(`${c},${r}`)) { hit = true; break outer; }
      }
    }
    if (hit) found.set(token.id, { id: token.id, name: _liveTokenName(token.id, token.name) });
  }

  return [...found.values()];
}

/** Size (in cells) of a logged entry's own template, read from the strokeData snapshot
 *  captured when it was drawn (see template-canvas.mjs's _finalizeDraw) — same declarative
 *  read as that module's own _getCellCount, just against a stored entry instead of a live
 *  draw-in-progress. Returns 0 for a bare action/item tag (no strokeData — nothing was
 *  drawn on the canvas for it), so callers can treat 0 as "no distance to show". */
function _entryDistanceCells(entry) {
  const sd = entry.strokeData;
  if (!sd) return 0;
  if (sd.shape === "thin_line") return pathMovementCost(sd.cells ?? []);
  const cfg = sd.shapeConfig;
  if (!cfg) return 0;
  return cfg.length ?? cfg.radius ?? cfg.size ?? 0;
}

async function _sendPublishChatMessage(tokenId, phase) {
  const log     = getActionLog();
  const entries = log.filter(e => e.tokenId === tokenId && e.phase === phase);
  if (!entries.length) return;

  const tokenName  = _liveTokenName(tokenId, entries[0].tokenName);
  const phaseName  = PHASE_LABEL[phase] ?? phase ?? "—";
  const phaseColor = entries[0].phaseColor ?? "#9d00ff";

  // Render each entry as a styled tag, preserving log order
  const tagsHTML = entries.map(e => {
    if (e.shape === "action") {
      const badge      = e.actionType === "S" ? "У" : "Ф";
      const badgeClass = e.actionType === "S" ? "s" : "m";
      return `<span class="god-reveal-tag is-action">
        <span class="god-reveal-action-badge god-log-act-${badgeClass}">[${badge}]</span>
        ${e.actionName ?? ""}
      </span>`;
    }
    if (e.shape === "item") {
      const icon  = ITEM_ICON[e.itemType] ?? "fa-box";
      // Resolve through the token (not game.actors.get) so unlinked-token actors — whose items
      // live only on the token's own synthetic actor — still find the item.
      const inner = tokenId && e.itemId
        ? `<a class="god-item-link" data-token-id="${tokenId}" data-item-id="${e.itemId}"><i class="fas ${icon}"></i>${e.itemName ?? ""}</a>`
        : `<i class="fas ${icon}"></i>${e.itemName ?? ""}`;
      return `<span class="god-reveal-tag is-item">${inner}</span>`;
    }
    const normShape = normalizeShapeType(e.shape);
    // Дистанция шаблона (в "Шагах" — см. formatMeters) рядом с его формой, если она
    // вообще есть (bare action/item tags уже отсечены выше, так что здесь только
    // реально нарисованные шаблоны — у них strokeData.cells/shapeConfig всегда есть).
    const dist = _entryDistanceCells(e);
    const shapeLabel = (SHAPE_LABEL[normShape] ?? e.shape) + (dist > 0 ? ` · ${formatMeters(dist)}` : "");
    // Every entry logged while drawing (weapon-tagged or a plain manual shape) is
    // stamped with the action-log panel's currently-selected AP type at log time (see
    // getSelectedApType/_finalizeDraw) — same badge treatment as a base-action entry above.
    const apBadge = e.actionType
      ? `<span class="god-reveal-action-badge god-log-act-${e.actionType === "S" ? "s" : "m"}">[${e.actionType === "S" ? "У" : "Ф"}]</span>`
      : "";
    // A weapon dragged onto the canvas — same combined "item + shape" treatment as
    // the action-log panel itself (see _buildBodyHTML above). actionName (Натиск/Залп)
    // comes from the weapon's own attackType field — see
    // weapon-template-drop.mjs's ACTION_FOR_ATTACK_TYPE.
    if (e.itemId) {
      const icon         = ITEM_ICON[e.itemType] ?? "fa-box";
      const actionPrefix = e.actionName ? `${e.actionName}: ` : "";
      const inner = tokenId
        ? `<a class="god-item-link" data-token-id="${tokenId}" data-item-id="${e.itemId}">${actionPrefix}<i class="fas ${icon}"></i>${e.itemName ?? ""} · ${shapeLabel}</a>`
        : `${actionPrefix}<i class="fas ${icon}"></i>${e.itemName ?? ""} · ${shapeLabel}`;
      return `<span class="god-reveal-tag is-item">${apBadge}${inner}</span>`;
    }
    return `<span class="god-reveal-tag">${apBadge}${shapeLabel}</span>`;
  }).join("");

  // Exclude the owner's own token from the affected list
  const affected = _findAffectedTokens(entries).filter(t => t.id !== tokenId);
  const targetsRow = affected.length ? `
    <div class="god-reveal-targets">
      <i class="fas fa-crosshairs god-reveal-targets-icon"></i>
      ${affected.map(t => `<a class="god-reveal-target" data-highlight-token="${t.id}" data-token-id="${t.id}">${t.name}</a>`).join("")}
    </div>` : "";

  const content = `
    <div class="god-reveal-card" style="--phase-color:${phaseColor}">
      <div class="god-reveal-header">
        <span class="god-reveal-phase">${phaseName}</span>
        <span class="god-reveal-actor">${tokenName}</span>
      </div>
      <div class="god-reveal-tags">${tagsHTML}</div>
      ${targetsRow}
    </div>`;

  const token = canvas.tokens?.placeables.find(t => t.id === tokenId);
  await ChatMessage.create({
    content,
    speaker: token
      ? ChatMessage.getSpeaker({ token: token.document })
      : { alias: tokenName },
  });
}

/* ── Global hide ─────────────────────────────────────────────────────────── */

export function isGlobalHidden() {
  return !!canvas.scene?.getFlag(FLAG_SCOPE, GLOBAL_HIDE);
}

export async function toggleGlobalHide() {
  if (!canvas.scene) return;
  if (!game.user.isGM) {
    ui.notifications?.warn("Только ГМ может управлять глобальным скрытием.");
    return;
  }
  await canvas.scene.setFlag(FLAG_SCOPE, GLOBAL_HIDE, !isGlobalHidden());
}

/* ── HTML builders ───────────────────────────────────────────────────────── */

function _groupLog(log) {
  const map = new Map();
  for (const entry of log) {
    const key = _groupKey(entry.tokenId, entry.phase);
    if (!map.has(key)) {
      map.set(key, {
        tokenId:    entry.tokenId,
        tokenName:  _liveTokenName(entry.tokenId, entry.tokenName),
        phase:      entry.phase,
        phaseColor: entry.phaseColor ?? "#9d00ff",
        isHeld:     false,
        shapes:     [],
      });
    }
    const g = map.get(key);
    if (entry.isHeld) g.isHeld = true;
    g.shapes.push({
      type:       entry.shape,
      strokeId:   entry.strokeId,
      // base-action fields
      actionId:   entry.actionId   ?? null,
      actionName: entry.actionName ?? null,
      actionType: entry.actionType ?? null,
      // Преследование only (see setLogEntryTarget) — the token this entry's own action
      // picked as a Foundry target, so the tag can show WHO without needing the map.
      targetTokenName: entry.targetTokenName ?? null,
      // item fields
      itemId:     entry.itemId     ?? null,
      itemName:   entry.itemName   ?? null,
      itemType:   entry.itemType   ?? null,
      damage1:    entry.damage1    ?? null,
      damage2:    entry.damage2    ?? null,
      damage3:    entry.damage3    ?? null,
      damage4:    entry.damage4    ?? null,
    });
  }
  return [...map.values()];
}

// Which BASE_ACTIONS ids represent a genuine attack/control move against a target — the
// live cover-target strip (_targetsHTML/targetsAnchor below) only makes sense for these,
// never for a pure movement or self/prep action (Рывок, Перемещение, Преследование,
// Уклонение, Оценка, etc.) that happens to share the group.
const OFFENSIVE_ACTION_IDS = new Set(["melee", "ranged", "push", "grab", "knockdown"]);

// Real AOE templates — for a bare manual scene-controls draw (no actionId/itemId at
// all), only these count as offensive; thin_line (movement path) and ruler
// (measurement) never should, and never reach here as anything else anyway.
const OFFENSIVE_SHAPE_TYPES = new Set(["line", "wide_line", "cone", "circle", "square"]);

/** Does this shape-log entry represent an actual attack on someone — vs. a movement,
 *  measurement, or self/prep action that merely happens to be logged in the same
 *  token+phase group? See OFFENSIVE_ACTION_IDS' header for why this matters. */
function _isOffensiveLogEntry(s) {
  // A dragged weapon/spell/ability item is always an attack template — nothing else
  // goes through weapon-template-drop.mjs's item-drop flow (only weapon/spell/ability).
  if (s.itemId) return true;
  if (s.actionId) return OFFENSIVE_ACTION_IDS.has(s.actionId);
  return OFFENSIVE_SHAPE_TYPES.has(normalizeShapeType(s.type));
}

function _buildBodyHTML(groups, published) {
  if (!groups.length) {
    return `<div class="god-log-empty">— Нет активных записей —</div>`;
  }
  const isGM = !!game.user?.isGM;
  return groups.map((group) => {
    const key         = _groupKey(group.tokenId, group.phase);
    const isPublished = published.includes(key);
    const isLocked    = !isGM && _isPlannerLocked();  // locked automatically past "Планирование"
    const isHeld      = group.isHeld;
    const phaseTxt    = PHASE_LABEL[group.phase] ?? group.phase ?? "—";

    const shapeTags = group.shapes.map(s => {
      // A weapon dragged onto the canvas (see weapon-template-drop.mjs) now ALSO carries
      // actionId/actionName (Натиск or Залп, from the weapon's own attackType field —
      // see weapon-template-drop.mjs's ACTION_FOR_ATTACK_TYPE), so isAct must exclude it,
      // or it would lose its item/shape label and the "open item on dblclick" behavior below.
      const isAct  = !!s.actionId && !s.itemId;
      const isItem = s.type === "item";
      // A weapon dragged onto the canvas (see weapon-template-drop.mjs) logs as a real
      // AOE shape carrying an itemId — same "open the item on dblclick" treatment as a
      // bare item tag, but the label also shows which shape it was drawn as.
      const hasItemTag = !!s.itemId;
      // Every entry logged while drawing (weapon-tagged or a plain manual shape) is
      // stamped with the action-log panel's currently-selected AP type at log time (see
      // getSelectedApType/_finalizeDraw) — not just bare base-action entries.
      const apBadge = s.actionType
        ? `<span class="god-log-action-badge-sm god-log-act-${s.actionType === "S" ? "s" : "m"}">[${s.actionType === "S" ? "У" : "Ф"}]</span>`
        : "";
      let label;
      if (isAct) {
        // Преследование only — see setLogEntryTarget/weapon-template-drop.mjs's
        // setPursuitTarget: shows who this entry's own Foundry target-pick landed on,
        // right on the tag, instead of only being visible via the map's reticle.
        const targetSuffix = s.targetTokenName ? ` → ${s.targetTokenName}` : "";
        label = `${apBadge}${s.actionName}${targetSuffix}`;
      } else if (hasItemTag) {
        const icon         = ITEM_ICON[s.itemType] ?? "fa-box";
        const shapeLabel   = isItem ? "" : ` · ${SHAPE_LABEL[normalizeShapeType(s.type)] ?? s.type}`;
        // Натиск/Залп — from the weapon's own attackType field, independent of whether
        // this particular entry is Настильный or Навесной — see weapon-template-drop.mjs's
        // ACTION_FOR_ATTACK_TYPE.
        const actionPrefix = s.actionName ? `${s.actionName}: ` : "";
        label = `${apBadge}${actionPrefix}<i class="fas ${icon} god-log-item-icon"></i>${s.itemName}${shapeLabel}`;
      } else {
        label = `${apBadge}${SHAPE_LABEL[normalizeShapeType(s.type)] ?? s.type}`;
      }
      const canEdit    = !isLocked && !isHeld;
      const delBtn     = canEdit ? `<button type="button" class="god-log-shape-del" data-stroke-id="${s.strokeId}" title="Удалить">×</button>` : "";
      const cls        = ["god-log-shape-tag", isAct ? "is-action" : "", hasItemTag ? "is-item" : "", canEdit ? "can-drag" : ""].filter(Boolean).join(" ");
      // Item tags double as a link to the item sheet — carry token/item id for the dblclick handler
      // below. Resolved through the token (not game.actors.get) so unlinked-token actors, whose
      // items live only on the token's own synthetic actor, still find the item.
      const itemAttrs  = (hasItemTag && group.tokenId && s.itemId)
        ? ` data-item-id="${s.itemId}" data-token-id="${group.tokenId}" title="Двойной клик — открыть предмет"`
        : "";
      // Drag-to-canvas source for a plain base-action tag (Натиск/Залп/Толчок/Захват/
      // Опрокидывание — see BASE_ACTIONS' natiskM/brosokM) — read by _wireLog's pointer-
      // drag handler / _armLoggedAction when the tag is released over the canvas.
      const actionAttrs = (isAct && group.tokenId && s.actionId)
        ? ` data-token-id="${group.tokenId}" data-action-id="${s.actionId}"`
        : "";
      const tag = `<span class="${cls}" data-stroke-id="${s.strokeId}"${itemAttrs}${actionAttrs}>${label}${delBtn}</span>`;
      // Live "who THIS specific attack currently hits, how well" strip — one per offensive
      // entry (see _isOffensiveLogEntry), not one per whole group: a token can have several
      // attacks logged in the same phase (Натиск + Опрокидывание, say), each with its own
      // footprint, so each needs its OWN preview instead of one shared/merged strip (see
      // coverTargetsForStroke's header for why the shooter-aggregate version can't do this).
      // Filled/kept fresh by _updateLiveTargets() below, not rebuilt as part of this HTML —
      // just the empty anchor at data-stroke-id here (same reasoning as the old per-group
      // anchor: replacing this whole panel's innerHTML on a timer would break any in-
      // progress drag/scroll every tick). Silently empty for the bare "action" log entry
      // logged at button-press time (its strokeId has no real stroke yet — nothing to
      // preview until the tag is actually dragged onto the canvas).
      const targetsAnchor = _isOffensiveLogEntry(s)
        ? `<div class="god-log-targets" data-stroke-id="${s.strokeId}"></div>`
        : "";
      return tag + targetsAnchor;
    }).join("");

    const privacyBtn = group.tokenId ? `
      <button type="button" class="god-log-pub-btn${isPublished ? " is-published" : ""}"
              data-token-id="${group.tokenId}" data-phase="${group.phase}"
              title="${isPublished ? "Скрыть от других" : "Раскрыть другим"}">
        <i class="fas fa-share-alt"></i>
      </button>` : "";

    const holdBtn = `
      <button type="button" class="god-log-hold-btn${isHeld ? " is-held" : ""}"
              data-token-id="${group.tokenId}" data-phase="${group.phase}"
              title="${isHeld ? "Снять удержание (удалит группу)" : "Удержание"}">
        <i class="fas fa-thumbtack"></i>
      </button>`;

    const deleteBtn = (!isLocked && !isHeld) ? `
      <button type="button" class="god-log-del-btn"
              data-token-id="${group.tokenId}" data-phase="${group.phase}"
              title="Удалить всю запись">
        <i class="fas fa-times"></i>
      </button>` : "";

    const lockedBadge = isLocked ? `<span class="god-log-lock-badge" title="Планирование завершено — изменения недоступны"><i class="fas fa-ban"></i></span>` : "";

    return `
      <div class="god-log-group${isLocked ? " is-locked" : ""}${isHeld ? " is-held" : ""}"
           style="--phase-color:${group.phaseColor}">
        <div class="god-log-group-head">
          <span class="god-log-phase-tag">${phaseTxt}</span>
          <span class="god-log-token-name">${group.tokenName}</span>
          ${lockedBadge}
          ${holdBtn}
          ${privacyBtn}
          ${deleteBtn}
        </div>
        <div class="god-log-shapes">${shapeTags}</div>
      </div>`;
  }).join("");
}

/** Per-target strip for ONE offensive log entry's own stroke (see _buildBodyHTML's
 *  targetsAnchor) — reuses coverTargetsForStroke (module/canvas/attack-cover-targets.mjs),
 *  the per-stroke counterpart of the exact function a real attack roll calls
 *  (coverTargetsForShooter, still used unmodified by roll-dialog.mjs/npc-attack.mjs), so
 *  this preview can never disagree with what actually rolling THAT stroke would show. The
 *  `1` passed as damage is a throwaway — only `.outcomeTier`/`.name` are used here, this
 *  strip shows QUALITY (full/half/quarter/zero) while still planning, not a number that
 *  would be fiction before a player's die is even cast.
 *
 *  Each tag carries data-stroke-id/data-token-id so a click can fire the actual attack
 *  roll against exactly that one target — see registerActionLog's delegated click
 *  handler and _rollAttackForTarget below. Every tier is clickable, including "zero"
 *  (fully blocked) — that's still a real roll a player might want to make (or log the
 *  attempt for), not something to silently forbid. */
function _targetsHTML(strokeId) {
  if (!strokeId) return "";
  let targets;
  try {
    targets = coverTargetsForStroke(strokeId, 1);
  } catch (e) {
    console.error("god-tactical | action-log: live target preview failed", e);
    return "";
  }
  if (!targets.length) return "";
  return targets
    .map((t) => `<span class="god-log-target-tag god-log-tier-${t.outcomeTier}" data-stroke-id="${strokeId}" data-token-id="${t.tokenId}" data-tooltip="Бросить атаку по цели «${t.name}»">${t.name}</span>`)
    .join("");
}

/** Fires the real attack roll for ONE target — the live-target tag's own click (see
 *  registerActionLog below). Rebuilds the same {name,value,isChar,...} data weapon-
 *  sheet.mjs's #onAttack constructs for its own "Атаковать" button (that logic is a
 *  private method there, not exported, so it's duplicated rather than imported), then
 *  opens GODRollDialog/dealNpcDamage exactly as clicking that item's own button would —
 *  except constrained to `targetTokenId` via the onlyTargetTokenId option threaded
 *  through roll-dialog.mjs/npc-attack.mjs/attack-cover-targets.mjs, so only THIS tag's
 *  own target ends up in the result instead of everything currently under the shooter's
 *  live template. A bare base-action tag (Толчок/Захват/Опрокидывание — no itemId, see
 *  BASE_ACTIONS) has no weapon item to read a skill from, so this is a silent no-op for
 *  those; only a logged Weapon/Spell/Ability (its own system.skill) can be attacked this
 *  way. */
function _rollAttackForTarget(strokeId, targetTokenId) {
  const stroke = getStrokeById(strokeId);
  if (!stroke?.tokenId) return;

  const attackerActor = canvas.scene?.tokens?.get(stroke.tokenId)?.actor;
  if (!attackerActor) return;

  const item = stroke.itemId ? attackerActor.items.get(stroke.itemId) : null;
  if (!item) return;

  if (attackerActor.type === "npc" || attackerActor.type === "creature") {
    dealNpcDamage(attackerActor, {
      attackType: item.system.attackType,
      damageNature: item.system.damageNature,
      onlyTargetTokenId: targetTokenId,
    });
    return;
  }

  const skillKey = item.system.skill;
  if (!skillKey) return;

  const catEntry = Object.values(GOD.SKILL_MAP).find((c) => c.skills.some((s) => s.key === skillKey));
  const skill = catEntry?.skills.find((s) => s.key === skillKey);
  const name = skill?.name || skillKey;
  const charKey = catEntry?.charKey;
  const flaws = charKey ? (attackerActor.system.charFlaws?.[charKey] ?? 0) : 0;
  const value = attackerActor.system.skills?.[skillKey] ?? 0;
  const classItem = attackerActor.items.find((it) => it.type === "class");
  const raceItem = attackerActor.items.find((it) => it.type === "race");

  new GODRollDialog(attackerActor, {
    name,
    value,
    isChar: false,
    charKey,
    skillKey,
    flaws,
    classItem: classItem ? classItem.system : null,
    raceItem: raceItem ? raceItem.system : null,
    attackType: item.system.attackType,
    damageNature: item.system.damageNature,
    onlyTargetTokenId: targetTokenId,
  }).render(true);
}

/** Refreshes every live `.god-log-targets` strip currently in the DOM, in place — see
 *  registerActionLog's setInterval. Cheap no-op when the panel isn't even open (no
 *  `.god-log-embed`) or no entry has an anchor yet (no `.god-log-targets` nodes). One strip
 *  per offensive log entry now (data-stroke-id, see _buildBodyHTML), not one per group —
 *  each attack previews only its OWN stroke's targets (see coverTargetsForStroke's header).
 *  Skips a node's DOM write when the computed HTML hasn't actually changed, so a token that
 *  hasn't moved doesn't re-trigger layout/paint every tick for nothing. */
function _updateLiveTargets() {
  const container = document.querySelector(".god-log-embed");
  if (!container) return;
  const nodes = container.querySelectorAll(".god-log-targets[data-stroke-id]");
  if (!nodes.length) return;
  for (const node of nodes) {
    const html = _targetsHTML(node.dataset.strokeId);
    if (node.innerHTML !== html) node.innerHTML = html;
  }
}

function _buildHistoryHTML(history) {
  if (!history.length) {
    return `<div class="god-log-empty">— История пуста —</div>`;
  }
  return history.map((entry) => {
    const phaseTxt = PHASE_LABEL[entry.phase] ?? entry.phase ?? "—";
    const shapeTxt = entry.actionName ?? SHAPE_LABEL[normalizeShapeType(entry.shape)] ?? entry.shape ?? "—";
    const color    = entry.phaseColor ?? "#9d00ff";
    return `
      <div class="god-log-history-row" style="--phase-color:${color}">
        <span class="god-log-phase-tag">${phaseTxt}</span>
        <span class="god-log-token-name">${_liveTokenName(entry.tokenId, entry.tokenName)}</span>
        <span class="god-log-history-shape">${shapeTxt}</span>
        <button type="button" class="god-log-restore-btn" data-entry-id="${entry.id}"
                title="Восстановить">
          <i class="fas fa-rotate-left"></i>
        </button>
      </div>`;
  }).join("");
}

/** "Атака, Контроль или Подготовка" for multiple categories, plain label for one. */
function _formatActionCategories(categories) {
  const labels = (categories ?? []).map((c) => ACTION_CATEGORY_LABEL[c] ?? c);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} или ${labels[labels.length - 1]}`;
}

function _buildActionsHTML(actions, cooldowns = {}) {
  if (!actions.length) return `<div class="god-log-empty">— Нет действий для этой фазы —</div>`;
  return actions.map(a => {
    const remaining = cooldowns[a.id];
    const onCd      = remaining != null;
    let badge = "";
    let title = a.desc;
    if (onCd) {
      badge = `<span class="god-log-cd-badge" title="Нужно Восстановлений: ${remaining}">${remaining}</span>`;
      title = `На перезарядке — нужно Восстановлений: ${remaining}`;
    }
    const cls = ["god-log-action-item", onCd ? "is-cooldown" : ""].filter(Boolean).join(" ");
    const catLabel = _formatActionCategories(a.categories);
    const catTag   = catLabel ? `<span class="god-log-action-cat">[${catLabel}]</span>` : "";
    return `
    <button type="button" class="${cls}"
            data-action-id="${a.id}"
            data-tooltip="${title}"
            data-tooltip-direction="UP">
      <span class="god-log-action-name">${a.name} ${catTag}</span>${badge}
    </button>`;
  }).join("");
}

/* ── Combat Tracker embed ────────────────────────────────────────────────── */

let _showHistory    = false;
let _showActions    = false;
let _selectedApType = "M";   // "M" = Фазовое, "S" = Универсальное

// {x,y} client px to open the actions flyout AT, set only when it was opened via the
// double-right-click-on-canvas gesture (see toggleActionsFlyout) — null (the default,
// and reset on every close) means "anchor to the trigger button instead" (_positionFlyout).
let _actionsAnchor = null;

/** Side flyouts — base actions AND history both open as a separate floating panel to
 *  the left of the embedded Планер (see _setFlyoutContent) rather than an inline section
 *  squeezed into the narrow sidebar column. Keyed by a plain string tag so the position/
 *  animation machinery is shared between the two instead of duplicated. Each flyout
 *  element, once created, stays in the DOM (hidden via the .open class, not removed) so
 *  it can transition smoothly on both open AND close. Lives at module scope — there's
 *  only ever one Планер embed, same as there was only ever one floating window before. */
const _flyouts = new Map();

function _prepareContext() {
  // The shared Трекер phase (what the GM has the whole table set to right now) wins
  // when there's an active combat — that's what "which phase are we in" visibly means
  // to whoever's looking at it. Falls back to this user's own last-pressed-action phase
  // (phase-controls.mjs) outside combat, where there's no shared tracker to read.
  const phaseEntry = getTrackerPhaseEntry() ?? getActivePhaseEntry();
  return {
    groups:         _groupLog(getActionLog()),
    published:      getPublishedGroups(),
    globalHidden:   isGlobalHidden(),
    history:        getActionHistory(),
    showHistory:    _showHistory,
    showActions:    _showActions,
    phaseEntry,
    cooldowns:      _phaseCooldownMap(),
    selectedApType: _selectedApType,
  };
}

function _buildLogHTML(context) {
  return `
    <div class="god-log-header">
      <button type="button" class="god-log-history-btn${context.showHistory ? " active" : ""}"
              title="История действий">
        <i class="fas fa-clock-rotate-left"></i>
        ${context.history.length ? `<span class="god-log-history-badge">${context.history.length}</span>` : ""}
      </button>
      ${game.user.isGM ? `
      <button type="button" class="god-log-auto-reveal-btn${_autoReveal ? " active" : ""}"
              title="Авто-раскрытие: показывать шаблоны сразу при рисовании">
        <i class="fas fa-eye"></i>
      </button>
      <button type="button" class="god-log-gm-wipe" title="ГМ: сбросить шаблоны ВСЕХ пользователей">
        <i class="fas fa-radiation-alt"></i>
      </button>
      <button type="button" class="god-log-global-eye${context.globalHidden ? " is-hidden" : ""}"
              title="${context.globalHidden ? "Показать все шаблоны" : "Скрыть все шаблоны"}">
        <i class="fas ${context.globalHidden ? "fa-eye-slash" : "fa-eye"}"></i>
        <span class="god-log-eye-all">ALL</span>
      </button>` : ""}
      <div id="god-phase-token" class="god-phase-token${getPhaseTokenId() ? " has-token" : ""}"
           title="Привязанный токен подсвечивается на карте">◆</div>
      <button type="button" class="god-phase-clear-token" title="Снять выделение токена">
        <i class="fas fa-times"></i>
      </button>
    </div>
    <div class="god-log-body">${_buildBodyHTML(context.groups, context.published)}</div>
  `;
}

/** Opens/closes the "Базовые действия фазы" flyout. Its own trigger button was removed
 *  2026-08-17 (GM ask, once the double-right-click-on-empty-ground canvas gesture in
 *  template-canvas.mjs covered the same job for both GM and players) — that gesture is now
 *  the ONLY caller, always passing `atPoint` ({x,y} in CLIENT px, its own cursor position) so
 *  the flyout opens right there (see _positionFlyout) instead of anchored to a button. Kept as
 *  a plain optional param (not required) rather than folding the point into the call site,
 *  since _positionFlyout's button-anchor fallback path still serves the separate history
 *  flyout, which still has its own trigger button. */
export function toggleActionsFlyout(atPoint = null) {
  _showActions = !_showActions;
  if (_showActions) {
    _showHistory = false;
    _actionsAnchor = atPoint;
  } else {
    _actionsAnchor = null; // always reset on close, so a later open doesn't inherit a stale point
  }
  _refresh();
}

function _wireLog(container, context) {
  // Drop a card straight onto the Планер panel — same standard Foundry document-drag
  // payload every draggable item card already carries (item-reorder.mjs's dragstart sets
  // both a reorder-only MIME and this plain "text/plain" one; weapon-template-drop.mjs's
  // own canvas drop handler parses the identical format). Replaces the sheets' old
  // "Добавить в Планер" context-menu button (removed 2026-08-20) — addItemToActionLog
  // enforces every precondition that button did, plus an ownership check the button
  // never needed (dragging can originate from any open sheet, not just the bound
  // token's own).
  container.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("text/plain")) return;
    event.preventDefault();
    container.classList.add("drag-over-log");
  });
  container.addEventListener("dragleave", (event) => {
    if (event.target === container) container.classList.remove("drag-over-log");
  });
  container.addEventListener("drop", async (event) => {
    container.classList.remove("drag-over-log");
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (data?.type !== "Item") return;
    event.preventDefault();
    event.stopPropagation();
    const item = await fromUuid(data.uuid);
    await addItemToActionLog(item);
  });

  // Unbind. #god-phase-token itself needs no handler — it's just a glyph;
  // setPhaseTokenLabel()/_highlightBoundToken() (phase-controls.mjs) keep it and the
  // canvas ring in sync by querying for this same id wherever it currently lives.
  container.querySelector(".god-phase-clear-token")?.addEventListener("click", () => {
    canvas.tokens?.releaseAll?.();
    Hooks.callAll("godTactical.clearToken");
  });

  container.querySelector(".god-log-auto-reveal-btn")?.addEventListener("click", () => {
    toggleAutoReveal();
  });

  container.querySelector(".god-log-gm-wipe")?.addEventListener("click", async () => {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window:      { title: "Сбросить все шаблоны" },
      content:     "<p>Удалить шаблоны и записи лога у <strong>всех</strong> пользователей на этой сцене?</p>",
      rejectClose: false,
    });
    if (!confirmed) return;
    Hooks.callAll("godTactical.gmWipeAll");
  });

  container.querySelector(".god-log-history-btn")?.addEventListener("click", () => {
    _showHistory = !_showHistory;
    if (_showHistory) { _showActions = false; _actionsAnchor = null; }
    _refresh();
  });

  container.querySelector(".god-log-global-eye")?.addEventListener("click", async () => {
    await toggleGlobalHide();
  });

  container.querySelectorAll(".god-log-pub-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      await togglePublishGroup(btn.dataset.tokenId, btn.dataset.phase);
    });
  });

  container.querySelectorAll(".god-log-hold-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (btn.classList.contains("is-held")) {
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window:      { title: "Снять удержание" },
          content:     "<p>Снятие удержания удалит группу шаблонов. Продолжить?</p>",
          rejectClose: false,
        });
        if (!confirmed) return;
      }
      await toggleHoldGroup(btn.dataset.tokenId, btn.dataset.phase);
    });
  });

  // Pointer-based drag-to-reorder (bypasses Foundry window drag interference)
  let _dragSrcId  = null;
  let _dragClone  = null;
  let _lastTapTag = null;
  let _lastTapTime = 0;

  const _openItemTag = (tag) => {
    if (!tag.classList.contains("is-item") || !tag.dataset.itemId) return;
    const actor = canvas.scene?.tokens?.get(tag.dataset.tokenId)?.actor;
    const item  = actor?.items.get(tag.dataset.itemId);
    item?.sheet?.render(true);
  };

  container.querySelectorAll(".god-log-shape-tag.can-drag").forEach((tag) => {
    tag.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".god-log-shape-del")) return;
      e.stopPropagation();
      e.preventDefault();

      const startX  = e.clientX;
      const startY  = e.clientY;
      const rect    = tag.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      let dragging  = false;

      const onMove = (mv) => {
        if (!dragging) {
          if (Math.abs(mv.clientX - startX) < 5 && Math.abs(mv.clientY - startY) < 5) return;
          dragging   = true;
          _dragSrcId = tag.dataset.strokeId;
          tag.classList.add("is-dragging");
          _dragClone = tag.cloneNode(true);
          _dragClone.style.cssText = `position:fixed;pointer-events:none;opacity:0.75;z-index:99999;width:${rect.width}px;margin:0;`;
          document.body.appendChild(_dragClone);
        }
        _dragClone.style.left = `${mv.clientX - offsetX}px`;
        _dragClone.style.top  = `${mv.clientY - offsetY}px`;

        // Find what's under the clone without the clone blocking hit-testing
        _dragClone.style.visibility = "hidden";
        const under = document.elementFromPoint(mv.clientX, mv.clientY);
        _dragClone.style.visibility = "";

        container.querySelectorAll(".drag-over").forEach(t => t.classList.remove("drag-over"));
        const over = under?.closest(".god-log-shape-tag.can-drag");
        if (over && over.dataset.strokeId !== _dragSrcId) over.classList.add("drag-over");
      };

      const onUp = async (up) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup",   onUp);
        const src = _dragSrcId;
        _dragSrcId = null;
        tag.classList.remove("is-dragging");
        if (_dragClone) { _dragClone.remove(); _dragClone = null; }
        if (!dragging) {
          // pointerdown's preventDefault above suppresses the browser's native dblclick for
          // this tag, so a double-click has to be detected manually from two quick releases.
          const now = Date.now();
          const isDoubleTap = _lastTapTag === tag && (now - _lastTapTime) < 400;
          _lastTapTag  = isDoubleTap ? null : tag;
          _lastTapTime = now;
          if (isDoubleTap) _openItemTag(tag);
          return;
        }

        // Released over the canvas instead of another tag — draw a template for this
        // logged base action (Натиск/Залп/Толчок/Захват/Опрокидывание only, see
        // BASE_ACTIONS' natiskM/brosokM and _armLoggedAction) instead of reordering.
        const dropTarget = document.elementFromPoint(up.clientX, up.clientY);
        if (dropTarget === canvas.app?.view && tag.dataset.actionId) {
          container.querySelectorAll(".drag-over").forEach(t => t.classList.remove("drag-over"));
          await _armLoggedAction(tag.dataset.actionId, tag.dataset.tokenId, up.clientX, up.clientY, tag.dataset.strokeId);
          return;
        }

        const over = container.querySelector(".god-log-shape-tag.drag-over");
        container.querySelectorAll(".drag-over").forEach(t => t.classList.remove("drag-over"));
        if (over && over.dataset.strokeId !== src) await reorderLogEntry(src, over.dataset.strokeId);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup",   onUp);
    });
  });

  container.querySelectorAll(".god-log-shape-del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      await removeLogEntry(btn.dataset.strokeId);
    });
  });

  // Item tags in locked/held groups skip the pointerdown handler above (no drag needed there),
  // so their native dblclick isn't suppressed and can open the item's sheet directly.
  container.querySelectorAll(".god-log-shape-tag.is-item[data-item-id]:not(.can-drag)").forEach((tag) => {
    tag.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      _openItemTag(tag);
    });
  });

  container.querySelectorAll(".god-log-del-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      await removeGroupEntries(btn.dataset.tokenId, btn.dataset.phase);
    });
  });

  _syncActionsFlyout(context);
  _syncHistoryFlyout(context);
  _positionAllFlyouts();
}

/** Renders the Планер into its embed container, preserving `.god-log-body`'s scroll
 *  position across the refresh (log/history/action-cooldown changes re-render often). */
function _renderInto(container, context) {
  const scrollTop = container.querySelector(".god-log-body")?.scrollTop ?? null;
  container.innerHTML = _buildLogHTML(context);
  _wireLog(container, context);
  if (scrollTop != null) {
    const body = container.querySelector(".god-log-body");
    if (body) body.scrollTop = scrollTop;
  }
}

/** `renderCombatTracker` handler — inserts (once) or refreshes (on every later render) a
 *  `.god-log-embed` block, anchored right below the phase tracker's own embed (or right
 *  under the header if the tracker embed isn't there for some reason — kept independent
 *  of registration order between registerPhaseTracker/registerActionLog). Unlike the
 *  tracker embed, this one does NOT hide when there's no active combat — the log is
 *  scene-keyed, not combat-keyed, and historically survived `deleteCombat` (only a scene
 *  change via canvasTearDown closed it). */
function _injectLogIntoCombatTracker(_app, html) {
  let container = html.querySelector(".god-log-embed");
  if (!container) {
    const anchor = html.querySelector(".god-tracker-embed")
                ?? html.querySelector("header.combat-tracker-header");
    if (!anchor) return;
    container = document.createElement("div");
    container.className = "god-log-embed god-log-wrap";
    anchor.insertAdjacentElement("afterend", container);
  }
  _renderInto(container, _prepareContext());
}

/** Re-renders the live embed in place — replaces every former `this.render(false)` /
 *  `_app.render(false)` call now that there's no ApplicationV2 instance to re-render. */
function _refresh() {
  const container = document.querySelector(".god-log-embed");
  if (!container) return;
  _renderInto(container, _prepareContext());
}

/** Base-actions flyout content — see _setFlyoutContent for the shared machinery this
 *  feeds into (positioning, open/close transition, DOM lifecycle). Runs on every
 *  refresh (i.e. every time the embed re-renders, which already happens on every log
 *  change — see the updateUser/controlToken/etc. hooks at the bottom of this file) so
 *  cooldowns/selected AP type/active phase never go stale while it's open. Both phases'
 *  actions are always shown, grouped under a labeled head each (Атака first, Движения
 *  second, matching PHASES' order) — there's no more "select a phase first" gate since
 *  the active phase is now set implicitly by whichever action you actually press. */
function _syncActionsFlyout(context) {
  const html = `
    <div class="god-log-ap-selector">
      <button type="button" class="god-log-ap-btn god-log-act-m${context.selectedApType === "M" ? " active" : ""}" data-ap="M"
              style="--phase-color:${context.phaseEntry?.color ?? "#3f88e6"}">
        [Ф] Фазовое
      </button>
      <button type="button" class="god-log-ap-btn god-log-act-s${context.selectedApType === "S" ? " active" : ""}"
              data-ap="S">
        [У] Универсальное
      </button>
    </div>
    <div class="god-log-actions-list" data-flyout-scroll>
      ${PHASES.map((p) => `
        <div class="god-log-actions-head${p.key === context.phaseEntry?.key ? " is-current" : ""}"
             style="--phase-color:${p.color}">
          <span>${p.label.toUpperCase()}</span>
        </div>
        ${_buildActionsHTML(BASE_ACTIONS[p.key], context.cooldowns)}
      `).join("")}
    </div>
  `;

  _setFlyoutContent("actions", context.showActions, html, (flyout) => {
    flyout.querySelectorAll(".god-log-ap-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        _selectedApType = btn.dataset.ap;
        _refresh();
      });
    });
    flyout.querySelectorAll(".god-log-action-item").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (btn.classList.contains("is-cooldown")) return;
        await _onActionClick(btn.dataset.actionId, _selectedApType);
      });
    });
  });
}

/** History flyout content — same deal as _syncActionsFlyout above, just for the
 *  removed-templates history list instead of the base-actions picker. */
function _syncHistoryFlyout(context) {
  const html = `
    <div class="god-log-history-head">
      <span>// ИСТОРИЯ</span>
      <button type="button" class="god-log-history-clear" title="Очистить историю">
        <i class="fas fa-trash"></i>
      </button>
    </div>
    <div class="god-log-history-body" data-flyout-scroll>${_buildHistoryHTML(context.history)}</div>
  `;

  _setFlyoutContent("history", context.showHistory, html, (flyout) => {
    flyout.querySelector(".god-log-history-clear")?.addEventListener("click", async () => {
      await clearHistory();
      _showHistory = false;
      _refresh();
    });
    flyout.querySelectorAll(".god-log-restore-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        await restoreHistoryEntry(btn.dataset.entryId);
      });
    });
  });
}

/** Shared machinery behind both side flyouts (base actions, history): creates the
 *  floating element on first use (appended to document.body, NOT the embed container),
 *  keeps it in the DOM afterward (hidden via the .open class, not removed, so both open
 *  AND close have something to transition), refreshes its content+handlers, restores
 *  whatever scroll position its `[data-flyout-scroll]` element had before the refresh,
 *  and (re)positions it against its trigger button. `tag` is a plain string key into
 *  _flyouts ("actions"/"history"). */
function _setFlyoutContent(tag, visible, html, bindHandlers) {
  if (!visible) {
    _flyouts.get(tag)?.classList.remove("open");
    return;
  }

  let flyout = _flyouts.get(tag);
  const isNew = !flyout;
  if (isNew) {
    flyout = document.createElement("div");
    flyout.className = `god-log-flyout god-log-${tag}-flyout`;
    document.body.appendChild(flyout);
    _flyouts.set(tag, flyout);
  }

  const scrollTop = flyout.querySelector("[data-flyout-scroll]")?.scrollTop ?? 0;
  flyout.innerHTML = html;
  const scrollEl = flyout.querySelector("[data-flyout-scroll]");
  if (scrollEl) scrollEl.scrollTop = scrollTop;

  bindHandlers(flyout);
  _positionFlyout(tag, flyout);

  if (isNew) {
    // Needs a style flush between "inserted at its closed transform/opacity" and
    // "told to transition to open" for the transition to actually play — one rAF is
    // occasionally not enough (still batched with the insert by some browsers), two is
    // the standard belt-and-suspenders fix.
    requestAnimationFrame(() => requestAnimationFrame(() => flyout.classList.add("open")));
  } else {
    flyout.classList.add("open");
  }
}

/** Anchors a flyout to its own trigger button (.god-log-history-btn inside the embedded
 *  Планер), opening it LEFTWARD over the canvas — the embed lives in the sidebar flush
 *  against the right edge of the viewport, so a right-opening flyout (the old floating-window
 *  behavior) would run off-screen. Clamped to a minimum of 8px so it never goes fully
 *  off-screen if the button itself sits very close to the edge.
 *
 *  The actions flyout has no trigger button of its own any more (removed 2026-08-17, see
 *  toggleActionsFlyout) — it always opens AT THE CURSOR instead, via `_actionsAnchor` (set by
 *  the double-right-click-on-canvas gesture that's now its only entry point). Clamped to the
 *  viewport on all four sides (not just left, since a canvas click can land anywhere) so the
 *  menu never opens partly off-screen near an edge/corner. */
function _positionFlyout(tag, flyout) {
  const width  = flyout.offsetWidth  || 260;
  const height = flyout.offsetHeight || 300;

  if (tag === "actions" && _actionsAnchor) {
    const left = Math.max(8, Math.min(_actionsAnchor.x, window.innerWidth  - width  - 8));
    const top  = Math.max(8, Math.min(_actionsAnchor.y, window.innerHeight - height - 8));
    flyout.style.left      = `${left}px`;
    flyout.style.top       = `${top}px`;
    flyout.style.maxHeight = `${window.innerHeight - top - 16}px`;
    return;
  }

  const btn = document.querySelector(`#combat .god-log-${tag}-btn`);
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  flyout.style.left      = `${Math.max(8, r.left - width - 8)}px`;
  flyout.style.top       = `${r.top}px`;
  flyout.style.maxHeight = `${window.innerHeight - r.top - 16}px`;
}

/** Repositions every currently-tracked flyout — called from _renderInto on every refresh
 *  so scrolling/resizing the sidebar (or the tab reflowing as the log grows/shrinks)
 *  carries them along instead of leaving them behind. */
function _positionAllFlyouts() {
  for (const [tag, flyout] of _flyouts) _positionFlyout(tag, flyout);
}

/* ── Add base action ─────────────────────────────────────────────────────── */

/** Which token a base action gets logged against: the explicitly BOUND phase token (the
 *  "Привязка токена" tool / Ctrl-click, phase-controls.mjs) if one is set — unchanged, takes
 *  priority — otherwise falls back to whatever's currently controlled via PLAIN Foundry token
 *  selection (2026-08-17, GM ask: actions from the double-right-click canvas menu should bind
 *  to a normally-selected token, not require the separate bind tool). Neither set → {id: null}. */
function _currentActionToken() {
  const boundId = getPhaseTokenId();
  if (boundId) return { id: boundId, name: getPhaseTokenName() };
  const controlled = canvas.tokens?.controlled?.[0];
  if (controlled) return { id: controlled.id, name: controlled.name };
  return { id: null, name: null };
}

async function _addBaseAction(actionId, apType = "M") {
  const phaseKey = Object.keys(BASE_ACTIONS).find(k => BASE_ACTIONS[k].some(a => a.id === actionId));
  const action   = phaseKey && BASE_ACTIONS[phaseKey].find(a => a.id === actionId);
  if (!action) return false;

  const { id: tokenId, name: tokenName } = _currentActionToken();
  if (!tokenId) {
    ui.notifications?.warn("Выберите токен перед добавлением действия.");
    return false;
  }

  // The phase is no longer picked manually — it follows whichever action's own group
  // (Атака/Движения) the player just pressed, overwriting whatever was active before.
  await setActivePhase(phaseKey);
  const phaseEntry = PHASES.find(p => p.key === phaseKey);

  await addLogEntry({
    strokeId:   `act_${actionId}_${Date.now()}`,
    tokenId,
    tokenName,
    phase:      phaseEntry.key,
    phaseColor: phaseEntry.color,
    shape:      "action",
    actionId:   action.id,
    actionName: action.name,
    actionType: apType,
  });
  return true;
}

/** Turns a BASE_ACTIONS entry's own natiskM/brosokM (metres, see the array's doc
 *  comment above) into the exact same {natisk, brosok} cell-array shape a real Weapon/
 *  Ability item carries on `item.system` — so weapon-template-drop.mjs's existing
 *  _collectEntries/_armDraw (which only ever read that shape, never anything Item-
 *  specific beyond id/name/type/attackType/flight flags) work completely unmodified
 *  against this synthetic "item" too. See _armLoggedAction below for the call site.
 *  `token` is only actually read for Перемещение (see the "move" special-case below) —
 *  every other action ignores it, same as before this parameter existed. */
function _buildPseudoItem(action, token) {
  const toEntry = (t) => ({
    rangeModifier: metersToCells(t.rangeM),
    templateShape: t.shape,
    templateSize: t.sizeM != null ? metersToCells(t.sizeM) : 1,
    hitLogic: "base",
  });
  let natiskM = action.natiskM ?? [];
  if (action.id === "move") {
    // Перемещение has no fixed rangeM of its own (unlike Рывок's flat 4 м) — its reach
    // IS the acting token's own Race (or Creature, for an NPC/bestiary actor) speed stat,
    // read fresh at drag time (see items.mjs's RaceDataModel/CreatureDataModel `speed`,
    // metres/round — same field actor-sheet.mjs's/npc-sheet.mjs's species card already
    // shows as "N м"). No species item, or speed 0, leaves natiskM empty — the same
    // "У этого действия не настроен шаблон дальности" warning below then fires exactly
    // as it would for an item with no template configured, no separate message needed.
    const speciesItem = token?.actor?.items.find((it) => it.type === "race" || it.type === "creature");
    const speedM = speciesItem?.system.speed ?? 0;
    natiskM = speedM > 0 ? [{ shape: "thin_line", rangeM: speedM }] : [];
  }
  return {
    id: null,
    name: action.name,
    type: "action",
    system: {
      attackType: action.attackType ?? "melee",
      canHitLowFlight: false,
      canHitHighFlight: false,
      natisk: natiskM.map(toEntry),
      brosok: (action.brosokM ?? []).map(toEntry),
    },
  };
}

/** Drag-to-canvas for an already-logged Планер entry (Натиск/Залп/Толчок/Захват/
 *  Опрокидывание/Рывок/Перемещение/Преследование — see BASE_ACTIONS' natiskM/brosokM
 *  and the "move"/"pursue" special-cases below) — called from _wireLog's pointer-drag
 *  handler when a `.god-log-shape-tag` is released over the canvas instead of over
 *  another tag (which reorders instead, see the existing drag-to-reorder logic right
 *  above the drop check). Unlike a fresh drag off an inventory card (weapon-template-
 *  drop.mjs's own _onDrop), the token is never ambiguous here — the log entry already
 *  says exactly which token the action was logged against, so this skips straight to
 *  arming the template, no actor→token(s) picker needed.
 *  Dynamic import (not a static one) deliberately avoids a module-load-order cycle:
 *  weapon-template-drop.mjs already imports BASE_ACTIONS from this file at ITS OWN
 *  top level (for ACTION_FOR_ATTACK_TYPE) — a static import back from here would make
 *  whichever module loads second see the other's exports still mid-evaluation. */
async function _armLoggedAction(actionId, tokenId, x, y, strokeId) {
  const action = Object.values(BASE_ACTIONS).flat().find((a) => a.id === actionId);
  const token = tokenId ? canvas.tokens?.get(tokenId) : null;
  if (!action || !token) return;

  if (!game.combat || !isPlanningStage()) {
    ui.notifications?.warn("Перетаскивание на сетку доступно только на этапе «Планирование» (проверьте общий трекер боя).");
    return;
  }

  // Преследование doesn't draw a template at all — dropping it onto the canvas picks
  // whichever token it lands on as this user's Foundry target (see
  // weapon-template-drop.mjs's setPursuitTarget), auto-cleared at the next round start.
  // strokeId (this tag's own log entry) lets setPursuitTarget stamp the pursued token's
  // name straight onto the tag (see setLogEntryTarget/_buildBodyHTML's targetSuffix)
  // instead of leaving it only visible via the map's target reticle.
  if (action.id === "pursue") {
    const { setPursuitTarget } = await import("../canvas/weapon-template-drop.mjs");
    setPursuitTarget(x, y, strokeId);
    return;
  }

  // Перемещение's natiskM is computed dynamically inside _buildPseudoItem (from the
  // token's own Race/Creature speed), not declared statically like every other action
  // here — so this guard would always wrongly reject it before that lookup even runs.
  if (action.id !== "move" && !action.natiskM?.length && !action.brosokM?.length) {
    ui.notifications?.warn("У этого действия не настроен шаблон дальности.");
    return;
  }
  const { armTemplateForToken } = await import("../canvas/weapon-template-drop.mjs");
  armTemplateForToken(_buildPseudoItem(action, token), token, x, y);
}

/** The action log's own "[Ф] Фазовое / [У] Универсальное" toggle — read by anything
 *  else that logs an entry (e.g. a weapon dragged onto the canvas, see
 *  template-canvas.mjs's _finalizeDraw) so it's tagged with the same action type the
 *  player currently has selected, exactly as a base-action button press already is (see
 *  _addBaseAction). Safe to call before the panel has ever rendered — just returns the
 *  module-level default ("M"). */
export function getSelectedApType() {
  return _selectedApType;
}

/* ── Hooks ───────────────────────────────────────────────────────────────── */

export function registerActionLog() {
  // Item link in chat reveal cards → open item sheet
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".god-item-link");
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    const actor = canvas.scene?.tokens?.get(link.dataset.tokenId)?.actor;
    const item  = actor?.items.get(link.dataset.itemId);
    item?.sheet?.render(true);
  });

  // Target link in chat reveal cards → open that token's actor sheet on double-click
  // (single click is reserved for the hover-highlight in chat-portraits.mjs, and a
  // double-click reads more intentionally than a single click for a chat chip).
  document.addEventListener("dblclick", (e) => {
    const link = e.target.closest(".god-reveal-target");
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    const actor = canvas.scene?.tokens?.get(link.dataset.tokenId)?.actor;
    actor?.sheet?.render(true);
  });

  // Live-target tag in the Планер panel (a stroke's own "who does this currently hit"
  // strip, see _targetsHTML) → fire the real attack roll against exactly that one
  // target. MUST be delegated (not bound directly to the tag) — _updateLiveTargets
  // replaces this strip's innerHTML every 300ms (registerActionLog's own setInterval
  // below), which would silently rip out any directly-attached listener.
  document.addEventListener("click", (e) => {
    const tag = e.target.closest(".god-log-target-tag");
    if (!tag) return;
    e.preventDefault();
    e.stopPropagation();
    _rollAttackForTarget(tag.dataset.strokeId, tag.dataset.tokenId);
  });

  Hooks.on("updateUser", (user, changes) => {
    if (user.id !== game.user.id) return;
    const flagData = changes?.flags?.[FLAG_SCOPE];
    if (!flagData) return;
    const sceneId = canvas.scene?.id;
    if (!sceneId) return;
    if (Object.keys(flagData).some(k =>
      k === `${LOG_KEY}_${sceneId}`       ||
      k === `${PUBLISHED_KEY}_${sceneId}` ||
      k === `${HISTORY_KEY}_${sceneId}`   ||
      k === "activePhase"
    )) {
      _refresh();
    }
  });

  Hooks.on("updateScene", (scene, changes) => {
    if (scene.id !== canvas.scene?.id) return;
    if (foundry.utils.hasProperty(changes, `flags.${FLAG_SCOPE}.${GLOBAL_HIDE}`)) {
      _refresh();
    }
  });

  // Re-render the action panel when anything on the phase actor changes that
  // affects the buttons: cooldown/status effects — keeps the cooldown UI live.
  const _isPhaseActor = (doc) => {
    const actor = _getPhaseActor();
    return actor && (doc?.uuid === actor.uuid || doc?.parent?.uuid === actor.uuid);
  };
  const _rerenderIfPhaseActor = (doc) => { if (_isPhaseActor(doc)) _refresh(); };
  for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect", "updateActor", "updateItem"]) {
    Hooks.on(hook, _rerenderIfPhaseActor);
  }

  // Switching the selected token changes whose cooldowns/wounds the panel shows.
  Hooks.on("controlToken", () => _refresh());

  Hooks.on("createCombat", () => {
    ui.combat?.render();
    _unpublishAll();
  });

  Hooks.on("updateCombat", (combat, changes) => {
    if (!foundry.utils.hasProperty(changes, "round")) return;
    _applySelfStatusesOnRoundChange();
    _unpublishAll();
    // Clears this client's own templates + action log, except any group put on
    // hold — handled by template-canvas.mjs's clearStrokes() (see its listener for
    // this event; called via a custom event rather than a direct import to avoid a
    // circular import, since template-canvas.mjs already imports from this file).
    Hooks.callAll("godTactical.combatRoundChanged");
  });

  // Flyouts live in document.body, not inside the sidebar, so scene teardown doesn't
  // remove them on its own — clean them up and reset the open/closed state here.
  Hooks.on("canvasTearDown", () => {
    _showActions = false;
    _showHistory = false;
    _actionsAnchor = null;
    for (const f of _flyouts.values()) f.remove();
    _flyouts.clear();
  });

  // Same "flyouts live outside the sidebar" problem as canvasTearDown above, triggered by
  // a much more everyday action: collapsing the sidebar (the arrow tab on its left edge)
  // hides the embedded Планер — and with it, the actions/history trigger buttons the
  // flyouts are anchored to (see _positionFlyout) — without removing anything, so a still-
  // open flyout was left floating over the canvas with no visible way to close it. Close
  // (not destroy) them here — same _showActions/_showHistory reset as clicking the
  // trigger button a second time would do; re-expanding the sidebar just needs a fresh
  // open click, same as always. Foundry fires this with `collapsed` — true right after
  // the sidebar finishes collapsing, false on expand — so this only fires on the collapse
  // half of the toggle.
  Hooks.on("collapseSidebar", (_sidebar, collapsed) => {
    if (!collapsed) return;
    _showActions = false;
    _showHistory = false;
    _actionsAnchor = null;
    for (const flyout of _flyouts.values()) flyout.classList.remove("open");
  });

  Hooks.on("renderCombatTracker", _injectLogIntoCombatTracker);

  // Live target-quality strip (see _updateLiveTargets) — a narrow, targeted DOM patch on its
  // own timer, deliberately separate from every _refresh() above: those replace the WHOLE
  // panel's innerHTML, which is fine for discrete state changes (an item deleted, a group
  // held) but would wreck an in-progress drag/scroll if run every 300ms just to keep a target
  // list current while the player is still aiming. 300ms matches the throttle
  // region-cover-overlay.mjs's canvas ticker used to run at, for the same "a tactical,
  // turn-based game doesn't need frame-perfect freshness" reasoning.
  setInterval(_updateLiveTargets, 300);
}
