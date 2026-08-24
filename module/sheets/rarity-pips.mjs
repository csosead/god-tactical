/**
 * GOD Tactical — Rarity Display Widget
 * Rarity is a 0–8 rank, shown as that number next to a single gem icon (.rarity-value,
 * god-tactical.css) — replaces the old row of N filled/unfilled pips, which stopped being
 * legible once the tier count grew past a handful. Ranks 1–8 are GOD.RARITY_TIERS (see
 * items.mjs's migrateRarity()); rank 0 is a deliberate extra value BELOW that range —
 * "Сломан"/Broken, for junk loot or a trophy that's been damaged/spent — handled as a
 * special case in rarityTierName() below rather than living in GOD.RARITY_TIERS itself
 * (inserting it there would shift every other tier's index, silently reinterpreting every
 * already-stored 1–8 rarity value in the world). Editing is a plain
 * `<input type="number">` like any other numeric field on these sheets (wired through the
 * sheet's own submitOnChange form handler) — there's no click-to-set binding to wire up
 * anymore.
 */

import { GOD } from "../config.mjs";

/** Clamp a stored rarity value into the valid 0–RARITY_TIERS.length range — a
 *  corrupt/out-of-range stored value still renders a sane number instead of something
 *  nonsensical. */
export function clampRarity(rank) {
  return Math.max(0, Math.min(GOD.RARITY_TIERS.length, rank ?? 1));
}

/** Localized name of the tier a rarity rank used to be ("Редкое"/"Редкая"/…) — shown as
 *  the rarity display's hover tooltip. `namespace` picks which GOD.<Namespace>.Rarity<Tier>
 *  key set to read (Weapon/Armor/Item each have their own — grammatical gender differs
 *  per item noun in Russian, e.g. "Редкое" оружие vs "Редкая" броня). Rank 0 ("Сломан"/
 *  Broken) isn't in GOD.RARITY_TIERS at all (see this file's top doc comment), so it's
 *  special-cased here rather than indexed into the array like every other rank. Falls
 *  back to the bare rank number if somehow still out of range. */
export function rarityTierName(rank, namespace) {
  const r = clampRarity(rank);
  if (r === 0) return game.i18n.localize(`GOD.${namespace}.RarityBroken`);
  const key = GOD.RARITY_TIERS[r - 1];
  if (!key) return String(rank);
  const cap = key.charAt(0).toUpperCase() + key.slice(1);
  return game.i18n.localize(`GOD.${namespace}.Rarity${cap}`);
}
