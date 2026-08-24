/**
 * GOD Tactical — Item search bars (Inventory + Abilities tabs), character sheet only —
 * the NPC sheet has never had a filter/search bar of either kind; its lists are short
 * enough not to need one.
 *
 * Both tabs used to share a type/rarity/subtype/… chip filter bar (module/sheets/
 * item-filter.mjs's bindFilterBar) instead. That toggled `.inv-filtered-out` on every
 * `.inv-card` independently, including a container's own card — a container's card never
 * matches a "Броня"/"Оружие" type chip (its own type is "container"), so as soon as any
 * chip was active it got hidden, and with it, via plain CSS `display:none`, every item
 * nested inside it too, regardless of whether THAT matched. Free-text search sidesteps
 * this: each card is matched against its OWN text only (#ownText strips out any nested
 * contents list first), and a card is kept visible if it matches OR any of its
 * descendants still do — so a container is never hidden while something inside it
 * matches, and a match inside a COLLAPSED container gets its immediate parent's nested
 * list momentarily forced open (the "search-open" class) without touching the user's own
 * manual expand/collapse state (see weapon-inventory-row.hbs's "collapsed" class).
 * Abilities have no nested contents at all, so for that tab the descendant-matching half
 * of this is simply always a no-op — same code, no special-casing needed. item-filter.mjs
 * itself is gone now — nothing else was left calling it once Abilities moved off it too.
 */

const HIDDEN_CLASS = "inv-filtered-out";
const FORCED_OPEN_CLASS = "search-open";

/** A card's own searchable text: its name plus every stat chip already rendered on it
 *  (hands/size/damage type/skill/subtype/class/…) — reading straight off already-
 *  rendered DOM text means every item type is searchable without hardcoding a field list
 *  per type or per tab, and automatically covers anything a future item type's card
 *  renders too. Nested contents are stripped first so a container's own match/non-match
 *  is never polluted by what's packed inside it (that's handled separately via
 *  descendant matching in _apply). */
function _ownText(card) {
  const clone = card.cloneNode(true);
  clone.querySelectorAll(".inv-nested-list").forEach((el) => el.remove());
  return clone.textContent.toLowerCase();
}

function _apply(scope, query) {
  const q = query.trim().toLowerCase();
  const cards = [...scope.querySelectorAll(".inv-card[data-item-id]")];

  if (!q) {
    for (const card of cards) card.classList.remove(HIDDEN_CLASS);
    scope.querySelectorAll(`.inv-nested-list.${FORCED_OPEN_CLASS}`).forEach((el) => el.classList.remove(FORCED_OPEN_CLASS));
    return;
  }

  const ownMatch = new Map(cards.map((card) => [card, _ownText(card).includes(q)]));

  for (const card of cards) {
    const hasMatchingDescendant = [...card.querySelectorAll(".inv-card[data-item-id]")]
      .some((descendant) => ownMatch.get(descendant));
    card.classList.toggle(HIDDEN_CLASS, !(ownMatch.get(card) || hasMatchingDescendant));

    // Direct child only — a deeper match still forces open every ancestor along the way
    // since this loop runs for every card, including intermediate containers. Always a
    // no-op on the Abilities tab (no card there ever has a nested list).
    const nested = card.querySelector(":scope > .inv-list.inv-nested-list");
    nested?.classList.toggle(FORCED_OPEN_CLASS, hasMatchingDescendant);
  }
}

/** Wire up one search bar. `state` persists the query string across re-renders — e.g. a
 *  drag-reorder triggers a full re-render that would otherwise silently clear whatever
 *  the user had typed. Safe to call on every render (no-ops if the bar isn't in the DOM,
 *  e.g. an empty inventory/ability list — see the *-search-bar.hbs hasItems/hasFeatures
 *  gates). */
function _bindSearch(root, barSelector, state) {
  const bar = root.querySelector(barSelector);
  if (!bar) return;
  const input = bar.querySelector(".inv-search-input");
  const clearBtn = bar.querySelector(".inv-search-clear");
  if (!input) return;

  state.query ??= "";
  input.value = state.query;
  clearBtn?.classList.toggle("is-visible", !!state.query);

  const scope = bar.closest(".tab-pane") ?? root;
  _apply(scope, state.query);

  input.addEventListener("input", () => {
    state.query = input.value;
    clearBtn?.classList.toggle("is-visible", !!state.query);
    _apply(scope, state.query);
  });

  clearBtn?.addEventListener("click", () => {
    state.query = "";
    input.value = "";
    clearBtn.classList.remove("is-visible");
    _apply(scope, "");
    input.focus();
  });
}

/** Wire up the Inventory tab's search input. */
export function bindInventorySearch(root, state = {}) {
  _bindSearch(root, ".inv-search-bar", state);
}

/** Wire up the Abilities tab's search input — own outer bar class (".ability-search-bar")
 *  so its querySelector never collides with Inventory's own bar when both tabs are in
 *  the DOM at once (only one is ever visible via .tab-pane.active, but both exist). */
export function bindAbilitySearch(root, state = {}) {
  _bindSearch(root, ".ability-search-bar", state);
}
