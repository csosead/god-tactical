/**
 * GOD Tactical — right-click context menu for inventory item cards.
 * Replaces the always-visible +/equip/× button row on each card (see
 * templates/item/parts/weapon-inventory-row.hbs) with a popup menu, shared by the
 * Character and NPC sheets.
 */

let _menuEl = null;

function _closeMenu() {
  _menuEl?.remove();
  _menuEl = null;
  document.removeEventListener("pointerdown", _onOutsidePointerDown, true);
  window.removeEventListener("scroll", _closeMenu, true);
  window.removeEventListener("resize", _closeMenu);
}

function _onOutsidePointerDown(event) {
  if (_menuEl && !_menuEl.contains(event.target)) _closeMenu();
}

/**
 * Show the same floating popup menu used for the inventory right-click menu at an
 * arbitrary screen point — reused by weapon-template-drop.mjs to let the player pick
 * which natisk/brosok entry to draw when a dropped weapon offers more than one.
 * @param {Array<{label:string, icon:string, className?:string, onClick:Function}>} entries
 */
export function showPopupMenu(entries, x, y) {
  _showMenu(entries, x, y);
}

function _showMenu(entries, x, y) {
  _closeMenu();

  const menu = document.createElement("div");
  menu.className = "inv-ctx-menu";
  for (const entry of entries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `inv-ctx-item ${entry.className ?? ""}`;
    item.innerHTML = `<i class="fas ${entry.icon}"></i><span>${entry.label}</span>`;
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      _closeMenu();
      entry.onClick();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  _menuEl = menu;

  // Position at the cursor, clamped so the menu never spills off-screen.
  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top  = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;

  // Deferred so the contextmenu event's own pointerdown doesn't instantly close it.
  setTimeout(() => {
    document.addEventListener("pointerdown", _onOutsidePointerDown, true);
    window.addEventListener("scroll", _closeMenu, true);
    window.addEventListener("resize", _closeMenu);
  }, 0);
}

/**
 * Wire up right-click → popup menu on a single element. Exported separately from
 * bindContextMenu() so code that manually patches a single new row into the DOM (e.g.
 * to avoid a full re-render — see actor-sheet.mjs's effect insert/remove patching) can
 * bind just that one element instead of re-scanning the whole sheet.
 * @param {HTMLElement} el
 * @param {string} dataAttr — the dataset key (camelCase) holding the id, e.g. "itemId"
 * @param {(id: string, el: HTMLElement) => Array<{label:string, icon:string, className?:string, onClick:Function}>|null} buildEntries
 */
export function bindContextMenuOnElement(el, dataAttr, buildEntries) {
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const entries = buildEntries(el.dataset[dataAttr], el);
    if (!entries?.length) return;
    _showMenu(entries, event.clientX, event.clientY);
  });
}

/**
 * Wire up right-click → popup menu for every element matching `selector` under `root`.
 * Bound per-element (like item-reorder.mjs's dragstart) rather than delegated from
 * `root` — `root` (the sheet's persistent element) survives re-renders while its
 * matching children are recreated each time, so a root-level listener would pile up
 * duplicates across renders instead of a fresh one replacing the old.
 * @param {HTMLElement} root
 * @param {string} selector — must carry the id in `dataAttr` (e.g. `data-item-id`)
 * @param {string} dataAttr — the dataset key (camelCase) holding the id, e.g. "itemId"
 * @param {(id: string, el: HTMLElement) => Array<{label:string, icon:string, className?:string, onClick:Function}>|null} buildEntries
 *   Returns the menu rows for the right-clicked element, or null/empty to show nothing.
 */
export function bindContextMenu(root, selector, dataAttr, buildEntries) {
  root.querySelectorAll(selector).forEach((el) => bindContextMenuOnElement(el, dataAttr, buildEntries));
}

/**
 * Wire up right-click → popup menu for every `.inv-card[data-item-id]` under `root`.
 * @param {HTMLElement} root
 * @param {(itemId: string, card: HTMLElement) => Array<{label:string, icon:string, className?:string, onClick:Function}>|null} buildEntries
 *   Returns the menu rows for the right-clicked card, or null/empty to show nothing.
 */
export function bindInventoryContextMenu(root, buildEntries) {
  bindContextMenu(root, ".inv-card[data-item-id]", "itemId", buildEntries);
}

/** Minimal Event stand-in for handlers that only read currentTarget.dataset.itemId. */
export function fakeItemEvent(itemId) {
  return { preventDefault() {}, stopPropagation() {}, currentTarget: { dataset: { itemId } } };
}
