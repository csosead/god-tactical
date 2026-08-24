/**
 * GOD Tactical — Dice Tray (inline chat integration)
 * Injects a row of die buttons directly into the ChatLog sidebar.
 */

/**
 * Inject dice buttons into the chat log DOM.
 * Called via Hooks.on("renderChatLog", injectDiceTray).
 * @param {ChatLog} chatLog
 * @param {HTMLElement|jQuery} html
 */
export function injectDiceTray(chatLog, html) {
  // Normalize html to HTMLElement (Foundry may pass jQuery or raw element)
  const element = (html instanceof HTMLElement) ? html : (html?.[0] || html);
  if (!element || !(element instanceof HTMLElement)) {
    console.warn("god-tactical | Dice tray: no valid HTML element", html);
    return;
  }

  // Prevent double injection
  if (element.querySelector(".god-dice-tray-inline")) return;

  const template = `
    <div class="god-dice-tray-inline">
      <button type="button" class="dice-tray-btn" data-die="4">d4</button>
      <button type="button" class="dice-tray-btn" data-die="6">d6</button>
      <button type="button" class="dice-tray-btn" data-die="8">d8</button>
      <button type="button" class="dice-tray-btn" data-die="10">d10</button>
      <button type="button" class="dice-tray-btn" data-die="12">d12</button>
      <button type="button" class="dice-tray-btn" data-die="20">d20</button>
      <button type="button" class="dice-tray-btn" data-die="100">d100</button>
    </div>
  `;

  // Try several selectors for chat controls (v12/v13 compatibility)
  const controls = element.querySelector("#chat-controls")
                || element.querySelector(".chat-controls")
                || element.querySelector('[data-application-part="controls"]');

  if (controls) {
    controls.insertAdjacentHTML("beforebegin", template);
    console.log("god-tactical | Dice tray injected before controls");
  } else {
    // Fallback: try to insert before chat-form or at the end of the chat container
    const chatForm = element.querySelector("#chat-form") || element.querySelector(".chat-form");
    if (chatForm) {
      chatForm.insertAdjacentHTML("beforebegin", template);
      console.log("god-tactical | Dice tray injected before chat-form");
    } else {
      element.insertAdjacentHTML("beforeend", template);
      console.log("god-tactical | Dice tray injected at end of chat container");
    }
  }

  // Attach delegated click handler on the tray container
  const tray = element.querySelector(".god-dice-tray-inline");
  if (tray) {
    tray.addEventListener("click", (event) => {
      const btn = event.target.closest(".dice-tray-btn");
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();

      const die = btn.dataset.die;
      console.log("god-tactical | Dice tray click:", die);
      if (!die) return;

      const roll = new Roll(`1d${die}`);
      roll.toMessage({
        speaker: ChatMessage.getSpeaker({ user: game.user }),
      });
    });
  }
}
