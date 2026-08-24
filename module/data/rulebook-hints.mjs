/**
 * GOD Tactical — Rulebook Hint Extraction
 *
 * Shared bracket convention: a rulebook journal page (see seed-compendiums.mjs) marks a
 * sentence as "live tooltip text" by wrapping it in [square brackets] right after a
 * heading matching whatever it's describing. Used by phase-controls.mjs (stage hints) and
 * action-log.mjs (base-action descriptions) so both features read the SAME convention off
 * their own rulebook entry, instead of each parsing journal HTML its own slightly
 * different way.
 *
 * A second, simpler convention lives here too: a plain bullet/numbered list, read back
 * as a whole array rather than one string per heading — used by config.mjs's
 * GOD.COMPETENCY_GROUPS, where a GM edits/adds/removes actual LIST ENTRIES (competency
 * names) rather than just overriding a hint sentence for an already-fixed set of names.
 *
 * A third convention, for when the HEADING TEXT ITSELF is the editable part (so matching
 * by exact label, like extractBracketedHint does, isn't an option — renaming the very
 * thing you're matching against unmatches it): headings of one given level are read back
 * by POSITION instead, each paired with its own [bracketed] hint the same way. Used by
 * config.mjs's GOD.SKILL_MAP, where a GM can rename a characteristic/skill's display name
 * (not just its hint) — see extractHeadingSequence.
 */

/** Finds the heading (h1–h6) whose text matches `label` exactly, then the first `[...]`
 *  in the content between that heading and the next one (or the end of the page).
 *  Returns null if either isn't found, so the caller can fall back to its own hardcoded
 *  default rather than clearing an existing value. The surrounding prose is never parsed
 *  beyond that first bracket — a GM can write as much free-form text as they like. */
export function extractBracketedHint(html, label) {
  const container = document.createElement("div");
  container.innerHTML = html;
  const heading = Array.from(container.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .find((h) => h.textContent.trim() === label);
  if (!heading) return null;

  let text = "";
  for (let node = heading.nextElementSibling; node && !/^H[1-6]$/.test(node.tagName); node = node.nextElementSibling) {
    text += node.textContent + " ";
  }
  const match = text.match(/\[([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

/** Finds the FIRST bullet or numbered list (<ul>/<ol>) on a page and returns its items'
 *  trimmed text content, in document order (blank items skipped). Everything else on the
 *  page — intro prose, notes above or below the list — is free-form and never parsed;
 *  only that first list is read, so a GM can safely write example lists further down the
 *  page without them being picked up. Returns [] if no list is found (page missing the
 *  list entirely, or no page at all), so the caller can fall back to its own hardcoded
 *  default array rather than clearing an existing one. */
export function extractListItems(html) {
  const container = document.createElement("div");
  container.innerHTML = html;
  const list = container.querySelector("ul, ol");
  if (!list) return [];
  return Array.from(list.children)
    .filter((el) => el.tagName === "LI")
    .map((li) => li.textContent.trim())
    .filter(Boolean);
}

/** Finds every heading matching `selector` (e.g. "h3") on a page, in document order, and
 *  reads back BOTH its own text — the "name" slot, freely rewritable, unlike
 *  extractBracketedHint's fixed-label match — and the first [bracketed] hint found in the
 *  content between it and the next heading of ANY level (or the end of the page), same
 *  scan as extractBracketedHint. Identity here comes from POSITION, not text: the caller
 *  zips the returned array against its own fixed-order list by index, so the COUNT and
 *  ORDER of matching headings on the page must stay in sync with that list — inserting,
 *  deleting, or reordering one shifts every entry after it to the wrong slot. A GM adding
 *  their own extra notes to the page should use a DIFFERENT heading level than `selector`
 *  so it isn't picked up. Returns [] if no matching heading is found at all. */
export function extractHeadingSequence(html, selector) {
  const container = document.createElement("div");
  container.innerHTML = html;
  return Array.from(container.querySelectorAll(selector)).map((heading) => {
    let text = "";
    for (let node = heading.nextElementSibling; node && !/^H[1-6]$/.test(node.tagName); node = node.nextElementSibling) {
      text += node.textContent + " ";
    }
    const match = text.match(/\[([^\]]+)\]/);
    return { name: heading.textContent.trim(), hint: match ? match[1].trim() : null };
  });
}
