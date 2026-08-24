/**
 * GOD Tactical — NPC/Creature Nicknames (клички)
 *
 * Auto-assigns a random, unique "кличка" to every newly created "npc" or "creature"
 * actor — including drag-drop from a compendium — so two copies of the same NPC stay
 * distinguishable in the Actors sidebar (e.g. "Волк «Клык»" vs "Волк «Уголёк»").
 * Stored separately in system.nickname and appended to the actor's Name.
 */

// Neutral/fantasy flavor — animals, nature/elements, materials, and short epithets.
// No hard requirement to fit a specific setting, so this stays broadly usable.
export const NICKNAMES = [
  "Волк", "Лис", "Сокол", "Ворон", "Барс", "Рысь", "Кабан", "Гончая", "Стриж", "Коршун",
  "Цапля", "Ястреб", "Скорпион", "Гадюка", "Кобра", "Шакал", "Гриф", "Сова", "Филин", "Крот",
  "Хорёк", "Куница", "Горностай", "Выдра", "Бобёр", "Олень", "Лань", "Косуля", "Лось", "Зубр",
  "Кречет", "Беркут", "Орлан", "Аист", "Дятел", "Кукушка", "Иволга", "Синица", "Снегирь", "Грач",
  "Галка", "Сорока", "Жаворонок", "Стрекоза", "Шершень", "Оса", "Шмель", "Богомол", "Ящер", "Саламандра",
  "Гроза", "Молния", "Вьюга", "Метель", "Иней", "Изморозь", "Град", "Ливень", "Туман", "Роса",
  "Заря", "Закат", "Рассвет", "Полночь", "Прибой", "Волна", "Омут", "Родник", "Ручей", "Утёс",
  "Скала", "Обрыв", "Овраг", "Пустошь", "Топь", "Трясина", "Чаща", "Бурелом", "Пепел", "Зола",
  "Уголёк", "Искра", "Пламя", "Дым", "Пар", "Сажа", "Смоль", "Снег", "Медь", "Бронза",
  "Сталь", "Кремень", "Гранит", "Обсидиан", "Янтарь", "Агат", "Опал", "Сумрак", "Тень", "Полынь",
  "Мята", "Шалфей", "Чертополох", "Крапива", "Репейник", "Терн", "Плющ", "Мох", "Лишайник", "Папоротник",
  "Камыш", "Осока", "Ковыль", "Быстрый", "Тихий", "Хмурый", "Ясный", "Резкий", "Ловкий", "Меткий",
  "Цепкий", "Стойкий", "Верный", "Хитрый", "Дерзкий", "Молчун", "Ворчун", "Хромой", "Одноглазый", "Косой",
  "Рыжий", "Чёрныш", "Беляк", "Пятнистый", "Полосатый", "Клык", "Коготь", "Оскал", "Хвост", "Грива",
  "Перо", "Крыло", "Рог", "Панцирь", "Чешуя", "Игла", "Шип", "Заноза", "Осколок", "Обломок",
  "Уступ", "Пик", "Гребень", "Хребет", "Излом", "Разлом", "Провал", "Бездна", "Пропасть", "Лабиринт",
  "Пустота", "Шёпот", "Гул", "Скрип", "Хруст", "Шорох", "Свист", "Вой", "Рык", "Тишина",
  "Морок", "Наваждение", "Химера", "Мираж", "Призрак", "Фантом",
];

/** Nicknames already in use by any npc/creature actor in the world. */
function _usedNicknames() {
  const used = new Set();
  for (const a of game.actors ?? []) {
    if (a.type !== "npc" && a.type !== "creature") continue;
    const n = a.system?.nickname;
    if (n) used.add(n);
  }
  return used;
}

/** Pick a random nickname not currently in use; falls back to "<word>-<n>" once the
 *  whole list is taken so uniqueness always holds. */
function _pickNickname() {
  const used = _usedNicknames();
  const free = NICKNAMES.filter((n) => !used.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];

  const base = NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)];
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export function registerNpcNicknames() {
  Hooks.on("createActor", async (actor, options, userId) => {
    if (userId !== game.user.id) return; // only the client performing the create should act
    if (actor.type !== "npc" && actor.type !== "creature") return;
    // Still a compendium document, not a real World Actor yet — no nickname until it's
    // actually dropped/imported into the world (e.g. seeding/assembling a template
    // inside a compendium shouldn't hand out a кличка).
    if (actor.pack) return;

    const nickname = _pickNickname();
    // Strip any existing "«...»" suffix first, in case this actor was duplicated from
    // one that already had a nickname baked into its name.
    const baseName = actor.name.replace(/\s*«[^»]+»\s*$/, "").trim();
    await actor.update({ "system.nickname": nickname, name: `${baseName} «${nickname}»` });
  });
}
