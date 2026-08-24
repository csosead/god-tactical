/**
 * GOD Tactical — Container Ownership Cap
 *
 * An actor may own at most GOD.CONTAINER_TYPE_CAP[containerType] Container items of each
 * containerType at once (see config.mjs) — not just have equipped: Deep Storage Container
 * is already limited to one EQUIPPED at a time (#onToggleContainerEquip in
 * actor-sheet.mjs/npc-sheet.mjs), but nothing stopped a second one from just sitting in
 * the inventory unequipped until now. Enforced at the document level via preCreateItem
 * (not just in the actor sheet's drag-drop handler) so it holds no matter how the item
 * ends up on the actor — dropped onto the sheet, dropped onto the token on the canvas,
 * created via a macro, etc. Blocks the create outright (returning false cancels it)
 * rather than deleting whichever container already exists, since deleting an existing one
 * could orphan whatever's packed inside it (see items.mjs's containerId doc comment).
 */

import { GOD } from "../config.mjs";

const CONTAINER_TYPE_NAME = { deep: "Deep Storage Container", quick: "Quick Slot Container" };

export function registerContainerRules() {
  Hooks.on("preCreateItem", (item, data, options, userId) => {
    if (userId !== game.user.id) return; // only the client performing the create should act
    const actor = item.parent;
    if (!(actor instanceof Actor)) return;
    if (item.type !== "container") return;

    const containerType = item.system.containerType;
    const cap = GOD.CONTAINER_TYPE_CAP[containerType];
    if (!cap) return;

    const owned = actor.items.filter(
      (it) => it.type === "container" && it.system.containerType === containerType
    ).length;
    if (owned < cap) return;

    const name = CONTAINER_TYPE_NAME[containerType] ?? containerType;
    ui.notifications?.warn(`На одного персонажа можно иметь не больше ${cap} контейнеров типа "${name}".`);
    return false;
  });
}
