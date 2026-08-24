/**
 * GOD Tactical — Rulebook Race Seed Data
 *
 * Transcribed from the "Расы" section of the GOD rules. Used by
 * seed-compendiums.mjs to populate the races compendium on world startup.
 * Only Размер и Жизни (до смерти) are modeled so far — other race
 * traits are not part of the card yet.
 */

export const RACES = [
  {
    name: "Человек",
    img: "icons/svg/mystery-man.svg",
    system: {
      size: "medium",
      weight: "medium",
      woundSteps: 1,
    },
  },
];
