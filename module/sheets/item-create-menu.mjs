/**
 * GOD Tactical — "+" create-blank-item menu, shared by the Character and NPC sheets'
 * Inventory/Abilities sections. Until now the only way to put an Item on an actor was to
 * drag one in from a compendium; this adds a second path — build a brand-new blank Item
 * directly on the actor (weapon/armor/consumable/tools/trophies/container, or an ability
 * pre-set to one of its three subtypes — Дар/Простой манёвр/Тактический манёвр — or a
 * spell) and open it straight into edit mode so every field is immediately fillable.
 */
import { showPopupMenu } from "./item-context-menu.mjs";

const ENTRIES = [
  { label: "Оружие",             icon: "fa-khanda",     type: "weapon",     name: "Новое оружие" },
  { label: "Броня",              icon: "fa-shield-alt", type: "armor",      name: "Новая броня" },
  { label: "Расходник",          icon: "fa-flask",      type: "consumable", name: "Новый расходник" },
  { label: "Инструменты",        icon: "fa-toolbox",    type: "tools",      name: "Новый инструмент" },
  { label: "Трофей",             icon: "fa-gem",        type: "trophies",   name: "Новый трофей" },
  { label: "Контейнер",          icon: "fa-backpack",   type: "container",  name: "Новый контейнер" },
  { label: "Дар",                icon: "fa-star",       type: "ability", subtype: "gift",             name: "Новый дар" },
  { label: "Простой манёвр",     icon: "fa-star",       type: "ability", subtype: "simpleManeuver",   name: "Новый манёвр" },
  { label: "Тактический манёвр", icon: "fa-star",       type: "ability", subtype: "tacticalManeuver",  name: "Новый тактический манёвр" },
  { label: "Заклинание",         icon: "fa-hat-wizard", type: "spell",      name: "Новое заклинание" },
];

/** Create one blank Item of `entry`'s type on `actor`, then open its own sheet already
 *  in edit mode — every item sheet in this system gates its editable fields behind an
 *  instance `_isEditing` flag toggled by a pencil button (see e.g. consumable-sheet.mjs,
 *  class-sheet.mjs, ability-sheet.mjs), so a freshly-created, all-default item would
 *  otherwise open to a near-empty read-only view with no visible way to start filling it in. */
async function createItem(actor, entry) {
  const data = { name: entry.name, type: entry.type };
  if (entry.subtype) data.system = { subtype: entry.subtype };
  const [item] = await actor.createEmbeddedDocuments("Item", [data]);
  const sheet = item.sheet;
  sheet._isEditing = true;
  sheet.render(true);
}

/** Pop the "+" menu at the triggering click's position (same showPopupMenu(entries, x, y)
 *  call shape as actor-sheet.mjs's #onPickCompetency / ability-sheet.mjs's
 *  #onPickStatusEffect — x/y are just the click event's own clientX/clientY). */
export function showCreateItemMenu(actor, event) {
  event.preventDefault();
  const menuEntries = ENTRIES.map((entry) => ({
    label: entry.label,
    icon: entry.icon,
    onClick: () => createItem(actor, entry),
  }));
  showPopupMenu(menuEntries, event.clientX, event.clientY);
}
