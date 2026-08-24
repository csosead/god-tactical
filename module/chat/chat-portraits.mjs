/**
 * Messenger-style portrait injection for chat messages.
 * Uses renderChatMessageHTML (V13) for new messages and
 * renderChatLog to retroactively style existing history.
 */

const _injected = new WeakSet();

export function registerChatPortraits() {
  // V13 API — html is already an HTMLElement
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (_injected.has(html)) return;
    _injected.add(html);
    _injectPortrait(message, html);
  });

  // Retroactively style messages already in the DOM when chat history loads
  Hooks.on("renderChatLog", (_log, html) => {
    const container = (html instanceof HTMLElement) ? html : html[0];
    if (!container) return;
    container.querySelectorAll(".chat-message:not(.god-msg)").forEach(el => {
      if (_injected.has(el)) return;
      const message = game.messages?.get(el.dataset.messageId);
      if (!message) return;
      _injected.add(el);
      _injectPortrait(message, el);
    });
  });

  // Token highlight: hover over [data-highlight-token] in chat → glow on canvas
  document.body.addEventListener("pointerover", _onTokenHighlightEnter, { capture: false });
  document.body.addEventListener("pointerout",  _onTokenHighlightLeave, { capture: false });
}

function _onTokenHighlightEnter(e) {
  const el = e.target.closest("[data-highlight-token]");
  if (!el || !canvas.ready) return;
  const token = canvas.tokens?.placeables.find(t => t.id === el.dataset.highlightToken);
  if (!token) return;
  token._onHoverIn?.(e, { hoverOutOthers: true });
}

function _onTokenHighlightLeave(e) {
  const el = e.target.closest("[data-highlight-token]");
  if (!el || !canvas.ready) return;
  const token = canvas.tokens?.placeables.find(t => t.id === el.dataset.highlightToken);
  if (!token) return;
  token._onHoverOut?.(e);
}

/* -------------------------------------------- */

function _injectPortrait(message, html) {
  const el = (html instanceof HTMLElement) ? html : html[0];
  if (!el) return;

  // Resolve portrait image
  const actor  = game.actors?.get(message.speaker?.actor);
  const token  = canvas.ready ? canvas.tokens?.get(message.speaker?.token) : null;

  const img = token?.document?.texture?.src
    || actor?.img
    || message.author?.avatar
    || "icons/svg/mystery-man.svg";

  const speakerName = message.speaker?.alias
    || actor?.name
    || message.author?.name
    || "";

  const isOwn = message.author?.id === game.user.id;

  // Mark the message element
  el.classList.add("god-msg");
  if (isOwn) el.classList.add("god-msg-own");

  // Remove Foundry's default header (we replace it entirely)
  el.querySelector(".message-header")?.remove();

  // Build portrait
  const portrait = document.createElement("img");
  portrait.className = "god-msg-portrait";
  portrait.src = img;
  portrait.alt = speakerName;
  portrait.title = speakerName;

  // Build name label + bubble wrapper around existing .message-content
  const nameEl = document.createElement("div");
  nameEl.className = "god-msg-name";
  nameEl.textContent = speakerName;

  const content = el.querySelector(".message-content");
  const bubble  = document.createElement("div");
  bubble.className = "god-msg-bubble";

  if (content) {
    el.insertBefore(bubble, content);
    bubble.appendChild(nameEl);
    bubble.appendChild(content);
  } else {
    el.appendChild(bubble);
    bubble.appendChild(nameEl);
  }

  // Portrait goes before (or after for own messages — CSS handles flip via flex-direction)
  el.insertBefore(portrait, bubble);
}
