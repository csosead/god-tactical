/**
 * GOD Tactical — Rulebook Class Seed Data
 *
 * Transcribed from the "Классы" section of the GOD rules (Craft doc).
 * Used by seed-compendiums.mjs to populate the classes compendium on
 * world startup. Only Damage/Dodge are modeled so far — Стиль,
 * Особенности, Способности and Классовая способность are not part of the
 * card yet.
 */

export const CLASSES = [
  {
    name: "Воин",
    img: "systems/god-tactical/packs/icons/classes/Воин.png",
    system: {
      damage: { fail: 1, success: 3, triumph: 5 },
      dodge: { fail: 1, success: 2, triumph: 4 },
    },
  },
  {
    name: "Бродяга",
    img: "systems/god-tactical/packs/icons/classes/Бродяга.png",
    system: {
      damage: { fail: 2, success: 3, triumph: 6 },
      dodge: { fail: 1, success: 2, triumph: 3 },
    },
  },
  {
    name: "Маг",
    img: "icons/svg/mystery-man.svg",
    system: {},
  },
];
