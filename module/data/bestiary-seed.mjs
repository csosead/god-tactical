/**
 * GOD Tactical — Bestiary Actor Seed Data
 *
 * Used by seed-compendiums.mjs to populate the bestiary compendium on world
 * startup. Unlike the Item seed files, entries here carry their own `type`
 * (npc | creature) since the bestiary pack holds both kinds of Actor.
 */

export const NPCS = [
  {
    name: "Разбойник",
    type: "npc",
    img: "icons/svg/mystery-man.svg",
    system: {},
  },
  {
    name: "Браконьер",
    type: "npc",
    img: "icons/svg/mystery-man.svg",
    system: {},
  },
  {
    name: "Дикий Батрахойд",
    type: "creature",
    img: "icons/svg/mystery-man.svg",
    system: {},
  },
];
