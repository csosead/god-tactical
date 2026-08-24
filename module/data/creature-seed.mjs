/**
 * GOD Tactical — Bestiary Creature Seed Data
 *
 * Used by seed-compendiums.mjs to populate the creatures compendium on world
 * startup. Same shape as race-seed.mjs (Размер, Жизни), plus Вес.
 */

export const CREATURES = [
  {
    name: "Анура",
    img: "icons/svg/mystery-man.svg",
    system: {
      size: "medium",
      weight: "medium",
      woundSteps: 1,
    },
  },
];
