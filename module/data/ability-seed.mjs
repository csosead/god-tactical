/**
 * GOD Tactical — Class Abilities (Способности) Seed Data
 *
 * Transcribed from the "Способности" section of the GOD rules (Craft doc).
 * Used by seed-compendiums.mjs to populate the abilities compendium on world
 * startup. Each entry's `folder` is the in-compendium folder it lands in
 * (one folder per class) — seedAbilities() creates the folder if missing.
 */

export const ABILITIES = [
  {
    name: "Точка опоры",
    folder: "Воин",
    img: "icons/svg/upgrade.svg",
    system: {
      activation: "passive",
      description:
        "<p>Пока Воин не двигался в этот раунд, его поглощение получает второе срабатывание — накрывает вторую входящую атаку на выбор. Если вдобавок объявлено Уклонение — третье.</p>",
    },
  },
  {
    name: "Зона контроля",
    folder: "Воин",
    img: "icons/svg/upgrade.svg",
    system: {
      activation: "passive",
      description:
        "<p>Враг, чей маршрут проходит через клетку по соседству с Воином, обязан пройти проверку, чтобы не остановиться перед ним (как «юниты на пути», но в радиусе вокруг Воина, а не только на его клетке).</p>",
    },
  },
  {
    name: "Импровизированная атака",
    folder: "Воин",
    img: "icons/svg/upgrade.svg",
    system: {
      activation: "passive",
      description:
        "<p>Можно объявить любой предмет как оружие во время подготовки. (в обычной ситуации можно это сделать только если предмет похож на оружие которым ты владеешь).</p>",
    },
  },
  {
    name: "Читка",
    folder: "Бродяга",
    img: "icons/svg/upgrade.svg",
    system: {
      activation: "passive",
      description:
        "<p>При планировании Бродяга указывает зону своей направленной атаки. Если цель, уклоняясь, въезжает в эту зону — атака Бродяги по ней наносит +1 урона.</p>",
    },
  },
  {
    name: "Контра",
    folder: "Бродяга",
    img: "icons/svg/upgrade.svg",
    system: {
      activation: "passive",
      description:
        "<p>Если Бродяга уклонением ушёл из-под удара цели, его атака в этом же раунде по этой цели получает +1 урона.</p>",
    },
  },
  {
    name: "Все под рукой",
    folder: "Бродяга",
    img: "icons/svg/upgrade.svg",
    system: {
      activation: "active",
      recoveryMode: "period",
      recoveryPeriod: "scene",
      description:
        "<p>Один раз за сцену можно извлечь любой предмет из рюкзака, не тратя на это время и действие.</p>",
    },
  },
];
