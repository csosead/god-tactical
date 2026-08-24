/**
 * GOD Tactical — Global Configuration
 */

import { extractListItems, extractHeadingSequence } from "./data/rulebook-hints.mjs";

export const GOD = {};

/* -------------------------------------------- */
/*  Skill Map                                   */
/* -------------------------------------------- */

GOD.SKILL_MAP = {
  cognition: {
    name: "КОГНИЦИЯ",
    css: "cognition",
    charKey: "char_cognition",
    desc: "Ментальный интеллект, обработка данных и эрудиция.",
    skills: [
      { key: "mnemonics", name: "Мнемоника", desc: "Память, знание истории, кодексов, языков, извлечение фактов из подсознания." },
      { key: "logic", name: "Логика", desc: "Дедукция, разгадывание загадок, анализ улик, планирование, тактическое мышление." },
      { key: "calculation", name: "Просчет", desc: "Математика, оценка стоимости лута, навигация по звездам, взлом шифровальных механизмов, предположение вероятности событий." },
      { key: "eloquence", name: "Красноречие", desc: "Академический спор, аргументация, ведение переговоров на основе фактов, знание этикета." },
    ],
  },
  neurodynamics: {
    name: "ПНЕВМА",
    css: "neurodynamics",
    charKey: "char_neurodynamics",
    desc: "Ментальная стойкость, харизма, сила духа и восприятие сути.",
    skills: [
      { key: "selfcontrol", name: "Самоконтроль", desc: "Сопротивление пыткам, допросам, страху, магии разума, сокрытие собственных эмоций (покерфейс)." },
      { key: "suggestion", name: "Внушение", desc: "Ложь, актерская игра, обман, манипуляция эмоциями (жалость, влюблённость), дипломатия «эмпатии»." },
      { key: "presence", name: "Присутствие", desc: "Запугивание, лидерство, приказы, доминирование, подавление чужой воли авторитетом." },
      { key: "instinct", name: "Чутье", desc: "Чтение языка тела, интуиция, обнаружение лжи, шестое чувство на опасность." },
    ],
  },
  // 2026-08-19 characteristic restructure (GM call): "Рефлексы" (precision) retired as a
  // characteristic entirely, along with its Наводка and Точность skills (no successor —
  // dropped outright). Its other two skills, Ловкость and Восприятие, moved here in place
  // of Контакт/Плотность (also retired outright). Контакт's melee-combat concept folds
  // into Импульс's description (one skill now covers both); Ресурс was simply RENAMED to
  // Выносливость (same skill, same key-rename-carries-data treatment as any other
  // GOD.SKILL_KEY_RENAMES entry — see below) since its own flavor ("внутренний баланс
  // тела... способность бодрствовать сутками") already reads as endurance. Roll wiring
  // moved to match: melee damage off Импульс + ranged damage off Восприятие (see
  // combat-damage.mjs's ATTACK_SKILLS, replacing Контакт/Наводка), Fortitude off
  // Выносливость (roll-dialog.mjs's DEFENSE_SKILLS, replacing Плотность) — Ловкость stays
  // Dodge's skill, unchanged.
  // Renamed 2026-08-21: biodynamics/ПЛОТЬ → corpus/КОРПУС. `key`, `css`, and `charKey` all
  // changed too (not just display text) — GOD.CHAR_KEY_RENAMES below repoints an existing
  // actor's stored characteristic value/flaw/exp-marker (data-models.mjs's
  // CharacterDataModel.chars/charFlaws/charExp, all built off `charKey`), plus NPCDataModel's
  // own hardcoded `chars` field and RaceDataModel's `charBonuses` field (items.mjs), which
  // aren't built from GOD.SKILL_MAP and so needed their literal field names updated too.
  corpus: {
    name: "КОРПУС",
    css: "corpus",
    charKey: "char_corpus",
    desc: "Физическая сила, выносливость, грубое воздействие на мир.",
    skills: [
      { key: "impulse", name: "Импульс", desc: "Грубая сила, контактный бой, атлетика, бег, прыжки, выбивание дверей, поднятие тяжестей, метание тяжелых предметов, борьба." },
      { key: "endurance", name: "Выносливость", desc: "Внутренний баланс тела, метаболизм, выживание в экстремальной среде, сопротивление ядам/болезням, способность бодрствовать сутками и регенерировать за счет скрытых резервов." },
      { key: "agility", name: "Ловкость", desc: "Уклонение от ударов, акробатика, сохранение равновесия на скользком канате, грация движений." },
      { key: "sensorics", name: "Восприятие", desc: "Стрельба, метание предметов, расчет траектории полета снарядов, острота зрения и слуха, поиск скрытых рычагов, чтение следов на земле, ночное зрение." },
    ],
  },
};

// Old → new characteristic `charKey` for every rename GOD.SKILL_MAP's top-level keys have
// gone through (mirrors GOD.SKILL_KEY_RENAMES below, but for the 3 characteristic-level
// fields instead of the 12 skill-level ones) — see renameCharKeys() in data-models.mjs.
GOD.CHAR_KEY_RENAMES = {
  char_biodynamics: "char_corpus",
};

/**
 * Overrides each characteristic's and skill's hardcoded `name` AND `desc` above (both
 * shown on the character sheet — actor-sheet.mjs's #prepareContext reads char.name/desc
 * and skill.name/desc straight off this live table on every render — and the NPC sheet)
 * with the live text from the rulebook journal's "Характеристики и навыки" entry (see
 * seed-compendiums.mjs's seedRulesJournal), if that entry exists and still has headings
 * on the matching page. Unlike GOD.ACTIONS_DB/PHASES' own hint overrides (which match a
 * heading by its EXACT, fixed text — see phase-controls.mjs's
 * loadPhaseStageHintsFromRulebook doc comment), the heading text itself is the editable
 * part here, so it can't double as the match key — matching happens by POSITION instead
 * (see rulebook-hints.mjs's extractHeadingSequence): the 1st `<h3>` on the "Характеристики"
 * page is Когниция, the 2nd Пневма, the 3rd Корпус (GOD.SKILL_MAP's own fixed key order —
 * renaming a characteristic never reorders it or moves its skills); the "Навыки" page
 * works the same way with `<h4>` across all 12 skills, in the same characteristic-block
 * order. Each heading's own text becomes the new display `name`; the
 * [bracketed] sentence right after it becomes the new `desc`, exactly like the other
 * hint overrides. Only `name`/`desc` ever change this way — `key`/`charKey`/`css` (what
 * the character sheet's actual data fields and roll math are wired to) are NEVER touched,
 * so renaming is purely cosmetic and can't break anything mechanical.
 *
 * A GM can therefore freely retheme a characteristic or skill's name (even translate it),
 * on top of the already-existing hint-sentence rewrite — every reference picks up the
 * change on next reload, since everything reads GOD.SKILL_MAP live. The one thing to keep
 * intact is the COUNT and ORDER of `<h3>`s/`<h4>`s on their respective page — adding,
 * deleting, or reordering one shifts every name/hint after it onto the wrong
 * characteristic/skill; a GM wanting to add their own free-form notes to either page
 * should use a different heading level (h2, h5, h6, …) so it isn't counted. Free-form
 * prose elsewhere on either page (including the hardcoded intro paragraphs naming the
 * three characteristics by their ORIGINAL names) is never touched by a rename — a GM who
 * cares about that staying in sync edits it by hand alongside the heading.
 *
 * Safe to call for every connected client (GM or player) — this only reads already-
 * seeded, world-shared compendium data, never writes anything. Called once from the
 * system's ready hook (god-tactical.mjs), after seedCompendiums() has had a chance to
 * create the entry for a fresh world.
 */
export async function loadSkillMapDescsFromRulebook() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;
  const index = await pack.getIndex();
  const entryIndex = index.find((e) => e.name === "Характеристики и навыки");
  if (!entryIndex) return;
  const entry = await pack.getDocument(entryIndex._id);
  if (!entry) return;

  const charPage  = entry.pages.find((p) => p.name === "Характеристики");
  const skillPage = entry.pages.find((p) => p.name === "Навыки");

  const cats = Object.values(GOD.SKILL_MAP);
  const charHeadings = extractHeadingSequence(charPage?.text?.content ?? "", "h3");
  cats.forEach((cat, i) => {
    const h = charHeadings[i];
    if (!h) return;
    if (h.name) cat.name = h.name;
    if (h.hint) cat.desc = h.hint;
  });

  const skills = cats.flatMap((cat) => cat.skills);
  const skillHeadings = extractHeadingSequence(skillPage?.text?.content ?? "", "h4");
  skills.forEach((skill, i) => {
    const h = skillHeadings[i];
    if (!h) return;
    if (h.name) skill.name = h.name;
    if (h.hint) skill.desc = h.hint;
  });
}

/** Old skill key → current skill key, for every rename this system's skill keys have
 *  gone through — so stored actor/item data under a retired key gets silently repointed
 *  at load (see renameSkillKeys() in data-models.mjs and its uses in items.mjs). Keys
 *  earlier than the ones currently in GOD.SKILL_MAP (e.g. "metabolism") never appear
 *  there anymore — only here, as migration source.
 *
 *  Object key ORDER matters here: renameSkillKeys walks these entries in one single pass,
 *  so a chain (e.g. metabolism→contact→impulse) only fully resolves if the earlier link
 *  in the chain is listed first — contact/aiming below must stay AFTER metabolism/
 *  kinesthetics/ballistics, which still target them.
 *
 *  2026-08-19 characteristic restructure (GM call): Плотность/Наводка/Точность retired
 *  outright, no successor — an actor's ranks in them are simply dropped (accepted data
 *  loss, not migrated). Контакт/Наводка DO get repointed here, but only so an already-
 *  placed weapon/ability item's `skill` selector (items.mjs) doesn't dangle on a dead key
 *  — repointing it onto whichever skill now actually plays that combat role (impulse for
 *  melee, sensorics for ranged — see combat-damage.mjs's ATTACK_SKILLS) keeps existing
 *  weapon cards working. An actor's own skillRanks happen to get the same repoint attempt
 *  (renameSkillKeys is shared), which is harmless: it only ever writes into an EMPTY
 *  target key, and every character already has real Impulse/Sensorics ranks of their own,
 *  so it's always a no-op there. Ресурс is the one genuine rename (same skill, new name
 *  "Выносливость") — its data is meant to carry over, unlike the others. */
GOD.SKILL_KEY_RENAMES = {
  metabolism: "contact",
  modeling: "calculation",
  perception: "instinct",
  myokinetics: "impulse",
  ballistics: "aiming",
  kinematics: "agility",
  kinesthetics: "contact",
  terror: "presence",
  resource: "endurance",
  contact: "impulse",
  aiming: "sensorics",
};

/* -------------------------------------------- */
/*  Skill Ranks                                 */
/* -------------------------------------------- */

// A skill's value is derived from its rank (0–4, see buildSkillRankFields in
// data-models.mjs) as floor(characteristic / 2) + this flat bonus, then clamped down to
// (characteristic - 5) and to 95 — see skillValueFromRank() in data-models.mjs. Indexed
// by rank — rank 0 means "no rank at all" (never purchased, no bonus at all — only a
// class-granted bonus rank can put a skill above 0 for free); every purchasable rank
// (1–4) costs real XP, there's no more free baseline rank.
GOD.SKILL_RANK_BONUS = [0, 10, 20, 30, 40];

// Fixed XP cost to buy INTO a given rank, paid once when stepping up from the rank right
// below it (rank 0 itself is never bought — it's just "nothing purchased yet"). Indexed
// by rank.
GOD.SKILL_RANK_XP_COST = [0, 4, 10, 18, 28];

// Minimum EFFECTIVE characteristic required to buy/hold a given rank. Indexed by rank.
GOD.SKILL_RANK_CHAR_PREREQ = [0, 45, 60, 75, 90];

// Hard ceiling for a characteristic's raw stored value (see buildCharFields in
// data-models.mjs) — also the ceiling used when clamping the race-bonus-adjusted
// effective value. Deliberately equal to the top skill rank's own prerequisite
// (GOD.SKILL_RANK_CHAR_PREREQ[4]) — rank 4 is only reachable at the characteristic's
// absolute maximum, no headroom above it.
GOD.CHAR_HARD_MAX = 90;

// Floor for a characteristic's raw stored value (see buildCharFields in data-models.mjs) —
// also the value chargen starts every characteristic at (GODCharacterBuilder.CHAR_MIN in
// character-builder.mjs).
GOD.CHAR_MIN = 40;

// Every character (not NPC) has this many "GRIT" cells — CharacterDataModel.baseGrit's
// own initial value (data-models.mjs), a flat total with no armor bonus (see
// module/combat/wounds.mjs's getGritCells). NPCs have their own flat GM-set total
// instead (NPCDataModel.gritMax).
GOD.BASE_GRIT = 5;

/** XP cost of the NEXT single characteristic point, given the value before that point. */
export function charPointXpCost(currentValue) {
  if (currentValue < 50) return 1;
  if (currentValue < 70) return 2;
  return 3;
}

/** Total XP cost to raise a characteristic from `from` to `to` (to > from) — sums each
 *  individual point's cost since the per-point rate changes as the value climbs. */
export function charRaiseXpCost(from, to) {
  let total = 0;
  for (let v = from; v < to; v++) total += charPointXpCost(v);
  return total;
}

/* -------------------------------------------- */
/*  Phase Colors                                */
/* -------------------------------------------- */

GOD.PHASE_COLORS = {
  move: {
    fill: [0, 255, 80],
    stroke: [80, 255, 130],
    shadow: "rgba(0,255,80,0.7)",
  },
  execution: {
    fill: [0, 180, 255],
    stroke: [0, 220, 255],
    shadow: "rgba(0,200,255,0.7)",
  },
};

/* -------------------------------------------- */
/*  Actions Database                            */
/* -------------------------------------------- */

GOD.ACTIONS_DB = {
  melee: { name: "Ближний бой", phase: "execution", tags: ["action"] },
  ranged: { name: "Дальний бой", phase: "execution", tags: ["action"] },
  push: { name: "Толчок", phase: "execution", tags: ["action", "focus", "control"] },
  grab: { name: "Захват", phase: "execution", tags: ["action", "focus"] },
  trip: { name: "Опрокинуть", phase: "execution", tags: ["action", "focus", "control"] },
  distract: { name: "Отвлечение", phase: "execution", tags: ["action", "focus"] },
  stabilize: { name: "Восстановление", phase: "execution", tags: ["action", "focus"] },
  accelerate: { name: "Ускорение", phase: "move", tags: ["focus"] },
  defense: { name: "Оборона", phase: "execution", tags: ["action"] },
  quick: { name: "Интеракция", phase: "execution", tags: ["action"] },
  reload: { name: "Перезарядка", phase: "execution", tags: ["focus"] },
  assess: { name: "Оценить врага", phase: "execution", tags: ["action", "focus"] },
  chase: { name: "Преследование", phase: "execution", tags: ["action", "focus"] },
  escape: { name: "Выйти из захвата", phase: "execution", tags: ["action"] },
  bag: { name: "Достать из хранения", phase: "execution", tags: ["action"] },
  move: { name: "Перемещение", phase: "move", tags: [] },
  standup: { name: "Встать", phase: "move", tags: [] },
  hide: { name: "Скрыться", phase: "move", tags: ["focus"] },
};

/* -------------------------------------------- */
/*  Phase Keys                                  */
/* -------------------------------------------- */

GOD.PHASES = {
  MOVE: "move",
  EXECUTION: "execution",
};

/* -------------------------------------------- */
/*  Damage Types                                 */
/* -------------------------------------------- */

GOD.DAMAGE_TYPES = [
  { key: "cutting",  name: "Рубящий" },
  { key: "piercing", name: "Пробивной" },
  { key: "crushing", name: "Дробящий" },
  { key: "burning",  name: "Жгучий" },
  { key: "freezing", name: "Леденящий" },
  { key: "electric", name: "Электрический" },
  // Composite groups — "counts as all three of ..." for a weapon/spell/ability/armor
  // vulnerability whose type is meant to match any one of a physical (S/P/C) or
  // elemental (B/F/E) triad at once, rather than one single fixed type. Purely a
  // vocabulary/label addition like every other entry here — this system has no
  // automated damage-type-vs-vulnerability resolution anywhere in code (see
  // actor-sheet.mjs#prepareGritTrack's doc comment), so nothing needs to "understand"
  // that S/P/C unpacks to cutting/piercing/crushing; a GM just reads the initials. Kept
  // as fixed Latin-letter jargon rather than translated per language, same as the item
  // sheet dropdown's own GOD.DamageType.Spc/Bfe lang strings (lang/ru.json, lang/en.json).
  { key: "spc", name: "S/P/C" },
  { key: "bfe", name: "B/F/E" },
];

/** One representative FontAwesome icon per damage type — used wherever a damage type
 *  needs a compact glyph instead of its full text label (e.g. armor vulnerability
 *  badges on the character sheet's GRIT block, see actor-sheet.mjs#prepareGritTrack). */
GOD.DAMAGE_TYPE_ICON = {
  cutting:  "fa-khanda",
  piercing: "fa-syringe",
  crushing: "fa-hammer",
  burning:  "fa-fire",
  freezing: "fa-snowflake",
  electric: "fa-bolt",
  spc:      "fa-hand-fist",
  bfe:      "fa-atom",
};

/* -------------------------------------------- */
/*  Damage Nature (physical / metaphysical)      */
/* -------------------------------------------- */

// Orthogonal to GOD.DAMAGE_TYPES above (that's flavor — cutting/burning/etc. — with no
// mechanical consumer anywhere). Nature is the physical-vs-metaphysical split a weapon/
// ability's damage belongs to; combined with the card's existing `attackType` (melee/
// ranged/self, see items.mjs's weaponCardSchema) it reads as the 4-way physical-melee /
// physical-ranged / metaphysical-melee / metaphysical-ranged split — no separate
// melee/ranged field needed here, `attackType` already carries that half. `abbr` is the
// compact Latin-jargon chip label (same convention as DAMAGE_TYPES' "S/P/C"/"B/F/E"),
// shown on the item sheet/inventory card instead of the full localized name.
GOD.DAMAGE_NATURES = [
  { key: "physical",     name: "Физический",     abbr: "PHY" },
  { key: "metaphysical", name: "Метафизический", abbr: "MPH" },
];

GOD.DAMAGE_NATURE_ICON = {
  physical:     "fa-fist-raised",
  metaphysical: "fa-hand-sparkles",
};

/* -------------------------------------------- */
/*  Armor Subtypes                               */
/* -------------------------------------------- */

// Equip slot an armor piece occupies. Exactly one armor item per subtype can be
// equipped at a time — equipping a new one of the same subtype replaces the old.
// Different subtypes stack freely (e.g. a cuirass + a helmet + greaves at once).
// `icon` (FontAwesome 6 Free solid) is used by the Character sheet's Armor loadout row
// (module/sheets/actor-sheet.mjs's #prepareArmorLoadout) — icon-only pills, one per slot.
// "underarmor" is the internal key (matches every already-seeded armor item's stored
// system.subtype) but the slot itself is now flavored as "Плащ"/Cloak, not the old
// "Поддоспешник"/Underarmor — renamed 2026-08-18, key kept as-is to avoid a data
// migration for a purely cosmetic change.
GOD.ARMOR_SUBTYPES = [
  { key: "cuirass",    name: "Кираса",  icon: "fa-vest" },
  { key: "underarmor", name: "Плащ",    icon: "fa-user-ninja" },
  { key: "helmet",     name: "Шлем",    icon: "fa-hard-hat" },
  { key: "arms",       name: "Наручи",  icon: "fa-mitten" },
  { key: "legs",       name: "Поножи",  icon: "fa-socks" },
];

/* -------------------------------------------- */
/*  Ability (Способность) Subtypes               */
/* -------------------------------------------- */

// Used to be 6 keys — a "class"-prefixed variant of each family that required picking a
// className on the ability sheet, alongside a "common" one that didn't. The class-tied
// half (classGift/classTacticalManeuver/classSimpleManeuver) was retired — see
// AbilityDataModel.migrateData (items.mjs) for the old→new subtype repoint.
GOD.ABILITY_SUBTYPES = [
  { key: "gift",             name: "Gift" },
  { key: "tacticalManeuver", name: "Tactical Maneuver" },
  { key: "simpleManeuver",   name: "Simple Maneuver" },
];

/* -------------------------------------------- */
/*  Rarity Tiers (weapon/armor/container/etc)    */
/* -------------------------------------------- */

// `system.rarity` itself is now just this array's 1-based INDEX (1–8, see items.mjs's
// migrateRarity()) — shown as a number + a single gem icon (see rarity-pips.mjs) instead
// of a tier name, no more per-tier color. This array survives only as the migration/
// tooltip reference: GOD.RARITY_TIERS[rank - 1] is the tier a given rank used to be
// named, still used to build the rarity display's hover tooltip (see
// module/sheets/rarity-pips.mjs).
GOD.RARITY_TIERS = ["veryCommon", "widespread", "rare", "veryRare", "priceless", "legendary", "mythical", "artifact"];

/* -------------------------------------------- */
/*  Activation Types (weapon/spell/ability/armor/consumable header tag) */
/* -------------------------------------------- */

// "" (blank, shown as "—") means no activation type set. Distinct from
// AbilityDataModel's own `activation` field (passive | active, a different concept —
// whether the ability triggers on its own vs. needs to be actively used). "permanent"
// used to be a checkbox here too, manually flagging an ability to show up in the
// character sheet header's passive-effects strip — removed as redundant now that any
// ability with activation:"passive" does that automatically (see #prepareEffectsMini in
// actor-sheet.mjs/npc-sheet.mjs), which is the field actually meant to answer that
// question. Old items may still carry a stray "permanent" in their stored
// activationTypes array; GOD.Item.ActivationPermanent stays in the lang files so any
// such leftover still renders a real label instead of a raw key, it just can't be
// (re)checked from the sheet anymore.
//
// Both combat phases (Атака/Движения — phase-controls.mjs's PHASES) have their OWN
// "Подготовка" stage — "instant" used to mean "either one, ambiguously" (matched by
// stage KEY alone in phase-activation-reminder.mjs). Split into "instant" (kept, now
// scoped specifically to the Атака phase's own Подготовка — the original/far more common
// case, so existing items keep working unmigrated) and "prepMovement" (new — the
// Движения phase's own Подготовка) so a card can say which one it actually means. See
// phase-activation-reminder.mjs's ACTIVATION_BY_STAGE for where this maps back to an
// exact {phase,stage} pair.
GOD.ACTIVATION_TYPES = ["instant", "control", "prepMovement", "closing"];

/* -------------------------------------------- */
/*  Domain (weapon/spell/ability/armor/consumable header tag)  */
/* -------------------------------------------- */

// "" (blank, shown as "—") means no domain set.
GOD.ITEM_DOMAINS = ["social", "combat"];

/* -------------------------------------------- */
/*  NPC/Creature Hierarchy (combat-role tag)     */
/* -------------------------------------------- */

GOD.NPC_HIERARCHY_TIERS = ["pawn", "equal", "boss"];

/** Icon + accent color per tier — Pawn reads as minor/disposable (dim steel, plain pawn
 *  glyph), Equal as a plain rank-and-file combatant (neutral bone), Boss as the standout
 *  threat (the same bronze/gold accent used elsewhere for "important" markers — Мезонин
 *  dice, weapon-hold state). `color` is shared between the NPC sheet's own portrait
 *  badge (npc-sheet.mjs, as CSS) and the token canvas badge (canvas/npc-hierarchy-
 *  badge.mjs, parsed into a PIXI color int) so both read the same tier the same way. */
GOD.NPC_HIERARCHY_META = {
  pawn:  { icon: "fa-chess-pawn", color: "#6b767b" },
  equal: { icon: "fa-chess",      color: "#ddd2b8" },
  boss:  { icon: "fa-chess-king", color: "#c9a578" },
};

// Same tier names as the bestiary's CreatureItemDataModel.size (items.mjs) — GM-set on
// NPCDataModel.size, drives this token's assumed height for the height-based blind-spot
// check (see blind-spot.mjs's HEIGHT_BY_SIZE), since width alone can't distinguish
// several tiers that share the same 1x1 token footprint (swarm/small/medium).
GOD.NPC_SIZE_TIERS = ["swarm", "small", "medium", "large", "veryLarge", "incrediblyLarge"];

/* -------------------------------------------- */
/*  Container slot cost by item size             */
/* -------------------------------------------- */

GOD.ITEM_SIZE_SLOT_COST = {
  small: 1,
  medium: 2,
  large: 3,
  huge: 4,
};

/* -------------------------------------------- */
/*  Container ownership caps                     */
/* -------------------------------------------- */

// How many Container items of each containerType an actor may own at once (not just have
// equipped — see module/data/container-rules.mjs, which blocks creating one past this cap
// regardless of how it lands on the actor: sheet drop, canvas drop, macro, etc.). "deep" =
// Deep Storage Container (already limited to one EQUIPPED at a time — see
// #onToggleContainerEquip in actor-sheet.mjs/npc-sheet.mjs — this caps owning more than
// one in the first place); "quick" = Quick Slot Container.
GOD.CONTAINER_TYPE_CAP = {
  deep: 1,
  quick: 3,
};

/* -------------------------------------------- */
/*  Status Effects (Token HUD)                   */
/* -------------------------------------------- */

// Pure markers — none of these carry `changes`. Damage-tick and behavioral-gating
// logic reads them later through isStatusActive() (module/combat/status-effects.mjs).
GOD.STATUS_EFFECTS = [
  { id: "bleed",       name: "Кровавая рана",     img: "icons/svg/blood.svg" },
  { id: "burn",        name: "Воспламенение",     img: "icons/svg/fire.svg" },
  { id: "poison",      name: "Интоксикация",      img: "icons/svg/poison.svg" },
  { id: "immobilized", name: "Обездвиживание",    img: "icons/svg/net.svg" },
  { id: "blinded",     name: "Частичная слепота", img: "icons/svg/blind.svg" },
  // TODO: механика отложена в правилах — сейчас чистый маркер, без поведения. Тот же
  // значок, что у частичной слепоты выше — подходящей отдельной иконки для "совсем
  // ничего не видит" в core-наборе Foundry нет, различаются по названию/тултипу.
  { id: "blindedfull", name: "Полная слепота",    img: "icons/svg/blind.svg" },
  { id: "stunned",     name: "Оглушение",         img: "icons/svg/daze.svg" },
  // TODO: механика отложена в правилах — сейчас чистый маркер, без поведения.
  { id: "suppressed",  name: "Шатание",           img: "icons/svg/downgrade.svg" },
  // core не содержит prone.svg — используется тот же файл, что и в дефолтном наборе Foundry.
  { id: "prone",       name: "Опрокидывание",     img: "icons/svg/falling.svg" },
  // TODO: механика отложена в правилах — сейчас чистый маркер, без поведения.
  { id: "slowed",      name: "Замедление",        img: "icons/svg/anchor.svg" },
  { id: "unconscious", name: "Без сознания",      img: "icons/svg/unconscious.svg" },
  // core не содержит dead.svg — используется тот же файл, что и в дефолтном наборе Foundry.
  { id: "dead",        name: "Мертвец",           img: "icons/svg/skull.svg" },
  // Чистые маркеры, без поведения — как и у Шатания выше, механика не описана в правилах.
  { id: "radiation",   name: "Облучение",         img: "icons/svg/radiation.svg" },
  { id: "panic",       name: "Паника",            img: "icons/svg/terror.svg" },
  // Чистый маркер, без поведения — обладатель получает урон от своих (friendly fire).
  { id: "kinstrike",   name: "Кинстрайк",         img: "icons/svg/target.svg" },
  // 4 цветных маркера — никакого встроенного значения и никакой механики вообще, просто
  // цвет на токене/листе, который ГМ вешает под свою собственную задачу (порядок хода,
  // фракция, «этот — мой», что угодно). Иконки — свои (assets/images/marker-*.svg),
  // сплошной цветной круг, т.к. core-набор Foundry цветных иконок не даёт. Никогда не
  // считаются вредными (см. NEGATIVE_STATUS_IDS ниже) — у них нет заряда «хорошо/плохо».
  { id: "marker-red",    name: "Красная метка",   img: "systems/god-tactical/assets/images/marker-red.svg" },
  { id: "marker-blue",   name: "Синяя метка",     img: "systems/god-tactical/assets/images/marker-blue.svg" },
  { id: "marker-green",  name: "Зелёная метка",   img: "systems/god-tactical/assets/images/marker-green.svg" },
  { id: "marker-yellow", name: "Жёлтая метка",    img: "systems/god-tactical/assets/images/marker-yellow.svg" },
];

// Statuses treated as harmful for effect-highlighting purposes (e.g. the compact
// effects summary in the sheet header) — every status except the 4 neutral color
// markers above, which carry no positive/negative connotation on their own.
GOD.NEGATIVE_STATUS_IDS = new Set(
  GOD.STATUS_EFFECTS.map((s) => s.id).filter((id) => !id.startsWith("marker-"))
);

// Max number of GOD.STATUS_EFFECTS an Ability card can carry in its own statusEffects
// list at once (see items.mjs's AbilityDataModel.statusEffects, ability-sheet.mjs's
// #onPickStatusEffect) — some maneuvers genuinely inflict more than one condition
// together (e.g. a knockdown-and-bleed combo hit), but this keeps the header tag row
// from growing unbounded.
GOD.ABILITY_MAX_STATUS_EFFECTS = 3;

/* -------------------------------------------- */
/*  Мезонин — drive priorities & dice pool       */
/* -------------------------------------------- */

// Not to be confused with the old "Мезанин" status/roll-zone mechanic (removed — see
// RECENT-CHANGES.md) — different mechanic entirely, unfortunate near-homophone in
// Russian. Every character ranks these 5 named drives 1–5 (character builder step, also
// editable later on the sheet in edit mode) — the rank picked for whichever drive
// motivated a failed SKILL check decides how a Мезонин-die reroll (against the linked
// CHARACTERISTIC instead of the skill) behaves. See GOD.MEZZANINE_PRIORITY_RULES below
// and CharacterDataModel.mezzanine (data-models.mjs) for storage; the actual reroll logic
// is applyMezzanine() in module/rolls/roll-dialog.mjs.
// Renamed 2026-08-21: power/Власть → domination/Доминирование, bond/Связь → blood/Кровь,
// curiosity/Любопытство → obsession/Одержимость, duty/Долг → brand/Клеймо. Both the key
// AND the name changed (not just display text) — GOD.MEZZANINE_KEY_RENAMES below repoints
// an existing actor's CharacterDataModel.mezzanine.order (data-models.mjs), which stores
// these `key` strings, the same way GOD.SKILL_KEY_RENAMES repoints retired skill keys.
GOD.MEZZANINE_DRIVES = [
  { key: "domination", name: "Доминирование" },
  { key: "blood",      name: "Кровь" },
  { key: "gain",       name: "Выгода" },
  { key: "obsession",  name: "Одержимость" },
  { key: "brand",      name: "Клеймо" },
];

GOD.MEZZANINE_KEY_RENAMES = {
  power: "domination",
  bond: "blood",
  curiosity: "obsession",
  duty: "brand",
};

// A character always has (at most) this many Мезонин dice — no per-drive pool, one shared
// pool spent regardless of which drive is invoked.
GOD.MEZZANINE_MAX_DICE = 3;

// Behavior of a Мезонин-die reroll, keyed by the invoked drive's current priority rank
// (1–5, from CharacterDataModel.mezzanine.order — see applyMezzanine() in roll-dialog.mjs
// for how this is actually applied):
//  - alwaysSpend: false only for rank 1 — the die is spent ONLY if the reroll succeeds;
//    a reroll that still fails costs nothing. Every other rank spends the die regardless
//    of the reroll's outcome.
//  - capSuccess: ranks 4/5 can never turn a reroll into a clean success or triumph — only
//    a success tagged with a light/heavy narrative consequence (the GM calls the actual
//    effect; this is just the tag shown on the card). null for ranks 1–3, which resolve
//    the reroll normally (including a double landing as a clean triumph).
// Ranks 2 and 3 are intentionally identical — two priority slots with the same mechanical
// weight, not a copy-paste gap.
GOD.MEZZANINE_PRIORITY_RULES = {
  1: { alwaysSpend: false, capSuccess: null },
  2: { alwaysSpend: true,  capSuccess: null },
  3: { alwaysSpend: true,  capSuccess: null },
  4: { alwaysSpend: true,  capSuccess: "light" },
  5: { alwaysSpend: true,  capSuccess: "heavy" },
};

/** {cap, spend} phrase pair describing what a Мезонин reroll does at a given priority
 *  rank (1–5) — built straight off GOD.MEZZANINE_PRIORITY_RULES so the wording can never
 *  drift from the actual behavior. Split in two so the rulebook journal page
 *  (seed-compendiums.mjs) can lay them out as separate table columns;
 *  mezzaninePriorityDescription() below joins them into the single inline line the
 *  sheet/chat-card tooltips use. Returns null for an out-of-range rank. */
export function mezzaninePriorityRuleText(rank) {
  const rule = GOD.MEZZANINE_PRIORITY_RULES[rank];
  if (!rule) return null;
  const cap = rule.capSuccess === "light"
    ? "чистый успех невозможен — только успех с лёгким последствием"
    : rule.capSuccess === "heavy"
      ? "чистый успех невозможен — только успех с тяжёлым последствием"
      : "переброс разрешается как обычно (дубль в успехе — чистый триумф)";
  const spend = rule.alwaysSpend
    ? "кубик тратится всегда, независимо от результата"
    : "кубик тратится только при успехе; при провале сохраняется";
  return { cap, spend };
}

/** Single-line version of mezzaninePriorityRuleText() — used by the sheet's drive
 *  tooltip (actor-sheet.mjs) and the chat card's drive-pick button title
 *  (roll-dialog.mjs), where there's no room for a two-column table. */
export function mezzaninePriorityDescription(rank) {
  const text = mezzaninePriorityRuleText(rank);
  return text ? `${text.cap}; ${text.spend}.` : "";
}

/* -------------------------------------------- */
/*  Competencies (character builder step)        */
/* -------------------------------------------- */

// Free-text proficiency tags a class can grant (see ClassDataModel.competencies,
// items.mjs) — grouped here as a curated picklist for the character builder's SECOND
// competency step (character-builder.mjs), NOT an enum: a class's own competencies
// field stays free text on the class sheet, and nothing there is validated against this
// list. The player picks exactly GOD.COMPETENCY_PICK_COUNT of these, unrestricted by the
// selected class (see GOD.CLASS_COMPETENCY_PICK_COUNT below for the FIRST step, which
// picks straight off the class's own list instead). Both picks together become the
// actor's OWN copy of the class item's competencies array at chargen (see
// GODCharacterBuilder#onFinish) — the compendium source class is never touched.
GOD.COMPETENCY_GROUPS = [
  { key: "meleeCombat",  name: "Боевые (ближний бой)", competencies: ["Одноручные клинки", "Двуручные клинки", "Одноручные булавы", "Двуручные булавы", "Одноручные топоры", "Двуручные топоры", "Древковое", "Посохи", "Безоружный бой", "Кинжалы", "Цепное", "Щиты"] },
  { key: "rangedCombat", name: "Боевые (дальний бой)", competencies: ["Луки", "Арбалеты", "Метательное", "Пращи", "Огнестрельное"] },
  { key: "defense",      name: "Защита", competencies: ["Лёгкие доспехи", "Тяжёлые доспехи", "Оборона"] },
  { key: "craft",        name: "Крафт и ремонт", competencies: ["Ремонт", "Алхимия", "Травничество"] },
  { key: "survival",     name: "Выживание", competencies: ["Ориентирование", "Лазание", "Плавание", "Верховая езда", "Слежение", "Выживание"] },
  { key: "underworld",   name: "Криминальный мир", competencies: ["Взлом", "Воровство", "Фальсификация", "Азартные игры"] },
  { key: "social",       name: "Социальные", competencies: ["Убеждение", "Запугивание", "Обман", "Переговоры", "Лидерство", "Этикет"] },
  { key: "knowledge",    name: "Знания", competencies: ["История", "Религия", "Медицина", "Зоология", "Ботаника"] },
  { key: "practical",    name: "Практические", competencies: ["Первая помощь", "Оценка", "Кулинария", "Циркачество"] },
];

/**
 * REPLACES the hardcoded array above wholesale with the live set of categories from the
 * rulebook journal's "Компетенции" entry (see seed-compendiums.mjs's
 * seedCompetenciesJournal), if that entry exists and has at least one page besides
 * "Обзор" — the CATEGORIES themselves are no longer fixed by this file, only seeded from
 * it: every page other than "Обзор" becomes one category (in the journal's own page
 * order), its page name doubling as both `key` and `name` (there's no separate technical
 * key exposed to a GM — a category simply IS its page name), and its `competencies` read
 * from that page's own bullet list (see rulebook-hints.mjs's extractListItems; a page
 * with no list yet just gets an empty array, not dropped — a GM mid-edit still sees the
 * category exist). A GM can therefore add a brand-new category (add a page), delete one
 * (delete its page), or rename one (rename the page — note this changes its `key`, so
 * any class that had that category checked on its own sheet, see class-sheet.mjs's
 * #onPickCompetency, silently loses the link and needs it re-picked under the new name,
 * same "renaming breaks the link" rule every other rulebook-driven override in this
 * codebase already follows), on top of the already-existing edit-in-place of a category's
 * own competency list. The character builder's competency pickers (character-
 * builder.mjs's #buildCompetencyContext/#selectedClassCompetencies, both of which always
 * read GOD.COMPETENCY_GROUPS live rather than a cached copy) pick up any of this on next
 * reload. Deleting every non-"Обзор" page (or the whole entry) leaves the array on its
 * hardcoded default above; nothing else breaks.
 *
 * Safe to call for every connected client (GM or player) — this only reads already-
 * seeded, world-shared compendium data, never writes anything. Called once from the
 * system's ready hook (god-tactical.mjs), after seedCompendiums() has had a chance to
 * create the entry for a fresh world.
 */
export async function loadCompetencyGroupsFromRulebook() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;
  const index = await pack.getIndex();
  const entryIndex = index.find((e) => e.name === "Компетенции");
  if (!entryIndex) return;
  const entry = await pack.getDocument(entryIndex._id);
  if (!entry) return;

  const pages = entry.pages.contents
    .filter((p) => p.name !== "Обзор")
    .sort((a, b) => a.sort - b.sort);
  if (!pages.length) return;

  GOD.COMPETENCY_GROUPS = pages.map((page) => ({
    key: page.name,
    name: page.name,
    competencies: extractListItems(page.text?.content ?? ""),
  }));
}

// How many competencies the character builder's second competency step (the general,
// class-unrestricted list above) lets the player pick.
GOD.COMPETENCY_PICK_COUNT = 2;

// How many of the selected class's OWN competencies (ClassDataModel.competencies) the
// character builder's FIRST competency step lets the player pick — the class no longer
// grants its whole list automatically, only whichever this many the player chooses (see
// GODCharacterBuilder#classCompetencyPickCount, which clamps this down to the class's
// actual competency count for a class with fewer than this many, e.g. Маг has none).
GOD.CLASS_COMPETENCY_PICK_COUNT = 4;

/* -------------------------------------------- */
/*  Distance units — cells ⇄ metres              */
/* -------------------------------------------- */

// The game's native unit is the grid cell. One cell = 0.5 m. All ranges,
// range modifiers and template sizes are STORED in whole cells (that's what
// the mechanics operate on); these helpers only convert them to metres for
// display / entry — the stored templates and ranges are never shrunk.
export const METERS_PER_CELL = 0.5;

/** Cell count → metres. 6 cells → 3, 7 → 3.5, 1 → 0.5. */
export function cellsToMeters(cells) {
  return (Number(cells) || 0) * METERS_PER_CELL;
}

/** Metres entered in the UI → whole cells (the stored unit). Inverse of cellsToMeters. */
export function metersToCells(meters) {
  return Math.round((Number(meters) || 0) / METERS_PER_CELL);
}

/** Cell count converted to metres, with an "м" suffix. 6 cells → "3 м", 7 → "3.5 м",
 *  1 → "0.5 м". Everything in this system is measured/displayed in real-world metres —
 *  see METERS_PER_CELL/cellsToMeters above. */
export function formatMeters(cells) {
  const m = cellsToMeters(cells);
  const num = Number.isInteger(m) ? String(m) : m.toFixed(1);
  return `${num} м`;
}

/* -------------------------------------------- */
/*  Sound effects                                */
/* -------------------------------------------- */

/** Play a one-shot sound effect, broadcast to every connected client (a hit landing is
 *  a shared tabletop moment, not just something the acting player hears). `src` is a
 *  path relative to the Foundry Data root (e.g. "systems/god-tactical/assets/sounds/...").
 *  Namespaced foundry.audio.AudioHelper (v11+) with a fallback to the older global, same
 *  pattern as god-tactical.mjs's _loadTpl. */
export function playSound(src, { volume = 0.8 } = {}) {
  const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
  helper?.play({ src, volume, autoplay: true, loop: false }, true);
}

/* -------------------------------------------- */
/*  Impact effects                               */
/* -------------------------------------------- */

/** Retrigger the "god-shake" CSS animation (see .god-shake in god-tactical.css) on an
 *  element — a portrait rattling from a hit landing. Local to this client only (unlike
 *  playSound, which broadcasts) — it's a reaction to something already visible on this
 *  sheet, not a shared signal other clients need. Remove-reflow-readd is the standard
 *  way to force a CSS animation to restart even if it's still mid-play from a rapid
 *  previous trigger, since just re-adding an already-present class is a no-op. */
export function shakeElement(el) {
  if (!el) return;
  el.classList.remove("god-shake");
  void el.offsetWidth;
  el.classList.add("god-shake");
  el.addEventListener("animationend", () => el.classList.remove("god-shake"), { once: true });
}

/** Repair flourish — a soft glow around `el` (e.g. the portrait, see .god-repair-glow
 *  in god-tactical.css) plus a burst of small spark particles from random points along
 *  its FRAME, each flung outward away from the portrait — like a hammer striking
 *  sparks off the edge while mending armor, never crossing over the picture itself.
 *  Local to this client only, same as shakeElement.
 *
 *  The particles are position:fixed and appended straight to document.body — placing
 *  them in any ancestor of `el` (even one that's position:relative, and even one that's
 *  exactly `el`'s own size) still let some other ancestor further up clip or paint over
 *  them the moment they crossed outside whichever box actually established the nearest
 *  overflow/stacking boundary, which is exactly what kept happening. Escaping to
 *  document.body sidesteps that entirely — coordinates come straight from `el`'s own
 *  getBoundingClientRect(), which is already viewport-relative (exactly what
 *  position:fixed wants), so no parent's box size or clipping matters anymore. Each
 *  spark removes itself once its own Web Animation finishes — nothing lingers if this
 *  fires again before the previous burst has fully faded. */
export function sparkRepair(el, { count = 14 } = {}) {
  if (!el) return;

  el.classList.remove("god-repair-glow");
  void el.offsetWidth;
  el.classList.add("god-repair-glow");
  el.addEventListener("animationend", () => el.classList.remove("god-repair-glow"), { once: true });

  const rect = el.getBoundingClientRect();

  const layer = document.createElement("div");
  layer.className = "god-spark-layer";
  document.body.appendChild(layer);

  const EDGES = ["top", "right", "bottom", "left"];
  for (let i = 0; i < count; i++) {
    const spark = document.createElement("span");
    spark.className = "god-spark";
    layer.appendChild(spark);

    const edge = EDGES[Math.floor(Math.random() * EDGES.length)];
    const t = Math.random(); // how far along that edge, 0–1

    // Start point (viewport px, matching position:fixed) and the outward-facing angle
    // (standard math convention: 0° = +x/right, 90° = +y/down) for that edge.
    let startX, startY, baseAngle;
    switch (edge) {
      case "top":    startX = rect.left + rect.width * t;  startY = rect.top;                   baseAngle = -90; break;
      case "bottom": startX = rect.left + rect.width * t;  startY = rect.top + rect.height;      baseAngle = 90;  break;
      case "left":   startX = rect.left;                   startY = rect.top + rect.height * t;  baseAngle = 180; break;
      default:       startX = rect.left + rect.width;      startY = rect.top + rect.height * t;  baseAngle = 0;   break; // right
    }
    spark.style.left = `${startX}px`;
    spark.style.top = `${startY}px`;

    const angle = (baseAngle + (Math.random() * 50 - 25)) * (Math.PI / 180); // ±25° spread around the outward normal
    const dist = 16 + Math.random() * 34; // px, just clear of the frame
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const duration = 450 + Math.random() * 350;

    spark.animate(
      [
        { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0 },
        { transform: `translate(calc(-50% + ${(dx * 0.4).toFixed(1)}px), calc(-50% + ${(dy * 0.4).toFixed(1)}px)) scale(0.85)`, opacity: 1, offset: 0.3 },
        { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(0.15)`, opacity: 0, offset: 1 },
      ],
      { duration, easing: "cubic-bezier(.2,.6,.3,1)", fill: "forwards" }
    ).finished.catch(() => {}).finally(() => spark.remove());
  }

  // The layer itself is just a positioning wrapper — drop it once every spark inside
  // has finished removing itself (a little past the longest possible spark duration).
  setTimeout(() => layer.remove(), 900);
}

