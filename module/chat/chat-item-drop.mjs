/**
 * GOD Tactical — Drag any Document (ability, item, weapon, armor, …) onto the chat
 * log to post a small card linking to it, mirroring the hyperlink-in-chat pattern
 * already used for action-log reveal cards (see combat/action-log.mjs's
 * .god-item-link / .god-reveal-target). Works for anything that carries the
 * standard Foundry document-drag payload — actor-embedded items (see
 * sheets/item-reorder.mjs), compendium entries, and world items alike.
 */

export function registerChatItemDrop() {
  // Foundry requires dragover to call preventDefault() for a drop to be allowed.
  document.addEventListener("dragover", (e) => {
    if (!e.target.closest("#chat-log")) return;
    e.preventDefault();
  });

  document.addEventListener("drop", async (e) => {
    const chatLog = e.target.closest("#chat-log");
    if (!chatLog) return;

    let data;
    try { data = JSON.parse(e.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (!data?.uuid) return;

    e.preventDefault();
    e.stopPropagation();

    const doc = await fromUuid(data.uuid);
    if (!doc) return;

    const img = doc.img ?? "icons/svg/item-bag.svg";
    const content = `
      <div class="god-drop-card">
        <a class="god-uuid-link" data-uuid="${data.uuid}">
          <img class="god-drop-card-img" src="${img}" alt="">
          <span class="god-drop-card-name">${doc.name}</span>
        </a>
      </div>`;

    await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker() });
  });

  // Card link in chat → open the document's sheet
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".god-uuid-link");
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    fromUuid(link.dataset.uuid).then((doc) => doc?.sheet?.render(true));
  });
}
