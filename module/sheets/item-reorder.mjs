/**
 * GOD Tactical — drag-to-reorder for embedded-Item list cards.
 * Shared by the Character and NPC sheets so items dropped into an .inv-list
 * (weapons, armor, abilities, class/race, ...) can be dragged onto each
 * other to swap places, independent of those sheets' own "drop a new item
 * from a compendium" handling.
 */

export const REORDER_MIME = "text/god-item-reorder";

/**
 * Wire up drag-reordering for every `.inv-card[data-item-id]` inside every
 * `.inv-list` under `root`. Reordering is scoped to siblings within the same
 * list (the same type group, in the same tab) — dropping a card writes new
 * `sort` values for that group's items in one embedded update.
 */
export function bindInventoryReorder(root, actor) {
  root.querySelectorAll(".inv-list").forEach((list) => {
    // :scope > — direct children only. A nested (.inv-nested-list) container's own
    // packed cards are ALSO descendants of the top-level list further up the DOM (the
    // container's card wraps its nested list), so an unscoped querySelectorAll here
    // would double-bind them: once for their own nested list, once again for every
    // ancestor list too. Left unscoped, dropping a packed card onto a top-level card
    // let the top-level list's stray listener silently reassign its `sort` (and even
    // splice it into the top-level DOM) while leaving `system.containerId` untouched —
    // it never actually left the container, just looked like it had until the next
    // render put it back. Scoping fixes that class of bug and keeps each list's reorder
    // strictly to its own siblings, matching this file's own doc comment above.
    list.querySelectorAll(":scope > .inv-card[data-item-id]").forEach((card) => {
      const item = actor.items.get(card.dataset.itemId);
      // An equipped container is locked in place — see actor-sheet.mjs's/npc-sheet.mjs's
      // #bindContainerDropTargets, which turns it into a fixed "drop an item here to pack
      // it" target instead. Letting it ALSO be a drag source (moving the bag itself) or a
      // plain reorder-drop target (which would just swap sort order) would make dropping
      // something ONTO it ambiguous between "pack it" and "reorder past it" — so it gets
      // neither here, only the pack-drop handling those methods add separately.
      if (item?.type === "container" && item.system.equipped) return;

      card.setAttribute("draggable", "true");

      card.addEventListener("dragstart", (event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(REORDER_MIME, card.dataset.itemId);
        // Also carry the standard Foundry document-drag payload (alongside the reorder
        // MIME above) so these cards behave like any other draggable document — e.g.
        // droppable onto the chat log to post a linked card (see chat/chat-item-drop.mjs).
        const item = actor.items.get(card.dataset.itemId);
        if (item) event.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: item.uuid }));
        card.classList.add("is-dragging");
      });
      card.addEventListener("dragend", () => card.classList.remove("is-dragging"));

      card.addEventListener("dragover", (event) => {
        if (!event.dataTransfer.types.includes(REORDER_MIME)) return;
        event.preventDefault();
        event.stopPropagation();
        card.classList.add("drag-over-card");
      });
      card.addEventListener("dragleave", () => card.classList.remove("drag-over-card"));

      card.addEventListener("drop", async (event) => {
        if (!event.dataTransfer.types.includes(REORDER_MIME)) return;
        event.preventDefault();
        event.stopPropagation();
        card.classList.remove("drag-over-card");

        const draggedId = event.dataTransfer.getData(REORDER_MIME);
        const targetId = card.dataset.itemId;
        if (!draggedId || draggedId === targetId) return;

        // Dropping a packed item onto a TOP-LEVEL card (as opposed to one of its own
        // container-mates in a .inv-nested-list) takes it out of whatever container
        // it was in — the same "drag it out" gesture as dropping on blank Inventory
        // pane background (actor-sheet.mjs's/npc-sheet.mjs's #onDropItem, REORDER_MIME
        // branch), just generalized to work when dropped on another card too, since the
        // pane is usually full of cards and there's often no blank space to aim for.
        // Dragging straight into a DIFFERENT container's nested list isn't handled here
        // — drop it on the pane/a top-level card first, then use "Поместить в
        // контейнер" (or drop it directly on the equipped container's own card, see
        // #bindContainerDropTargets), which is what actually enforces capacity/
        // restriction for the destination.
        if (!list.classList.contains("inv-nested-list")) {
          const draggedItem = actor.items.get(draggedId);
          if (draggedItem?.system.containerId) {
            await draggedItem.update({ "system.containerId": null });
            return;
          }
        }

        const draggedEl = list.querySelector(`:scope > .inv-card[data-item-id="${draggedId}"]`);
        if (!draggedEl) return;

        // Move the card in the DOM immediately — the new order is visible without
        // waiting on (or being disturbed by) a re-render.
        list.insertBefore(draggedEl, card);

        const ids = Array.from(list.querySelectorAll(":scope > .inv-card[data-item-id]"), (el) => el.dataset.itemId);
        // Sparse integers so re-sorting one group never collides with sort values
        // belonging to items in other groups/lists on the same actor.
        const updates = ids
          .map((id, i) => ({ _id: id, sort: (i + 1) * 1000 }))
          .filter((u) => actor.items.has(u._id));
        if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { render: false });
      });
    });
  });
}
