/**
 * GOD Tactical — Item Data Models
 */

import { GOD } from "../config.mjs";

const { SchemaField, NumberField, StringField, HTMLField, ArrayField, BooleanField } = foundry.data.fields;

/** Rarity used to be one of GOD.RARITY_TIERS' string keys (veryCommon…artifact), shown
 *  as a name with a per-tier color; it's now just that tier's 1-8 RANK (its index in
 *  GOD.RARITY_TIERS + 1), shown as a number + a single gem icon instead — see
 *  module/sheets/rarity-pips.mjs. Shared by every DataModel below that has the field.
 *  Rank 0 is a deliberate extra value BELOW the GOD.RARITY_TIERS range — "Сломан"/Broken,
 *  for junk loot or a trophy that's been damaged/spent (see rarity-pips.mjs's
 *  rarityTierName, which special-cases it rather than indexing into the tiers array). An
 *  unrecognized string (e.g. "common", the stray default a couple of these fields shipped
 *  with — never actually one of the real tiers) still falls back to rank 1, not 0 — that's
 *  corrupt/unset legacy data, not a deliberate "this is broken" mark. */
function migrateRarity(source) {
  if (typeof source.rarity !== "string") return;
  const rank = GOD.RARITY_TIERS.indexOf(source.rarity) + 1;
  source.rarity = rank > 0 ? rank : 1;
}

/* -------------------------------------------- */
/*  Base Item Model                             */
/* -------------------------------------------- */

export class BaseItemModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: true, initial: "" }),
      // 0–8, see migrateRarity() above.
      rarity: new NumberField({ required: true, nullable: false, initial: 1, min: 0, max: 8, integer: true }),
      quantity: new NumberField({ required: true, initial: 1, min: 0, integer: true }),
      weight: new NumberField({ required: true, initial: 0, min: 0 }),
      price: new NumberField({ required: true, initial: 0, min: 0, integer: true }),
      // small | medium | large | huge — how many Container slots this item costs
      // (see GOD.ITEM_SIZE_SLOT_COST in config.mjs).
      size: new StringField({ required: true, initial: "medium" }),
      // Id of the Container item (on the same actor) this item is currently stored
      // in, or null if it isn't packed into one.
      containerId: new StringField({ required: false, nullable: true, initial: null }),
    };
  }
}

/* -------------------------------------------- */
/*  Weapon                                      */
/* -------------------------------------------- */
/*  Формат карточки оружия (раздел «Снаряжение» правил): Руки, Размер,
 *  Свойство, Тип воздействия, Редкость, Навык. Настильный и Навесной — два
 *  НЕЗАВИСИМЫХ режима дальности; у каждого может быть НЕСКОЛЬКО записей
 *  (например, Настильный 1 и Настильный 2 с разными бонусами/шаблонами)
 *  или ни одной. У Настильного — полный набор форм шаблона (линия/широкая
 *  линия/круг/конус/квадрат), у Навесного — только круг/квадрат.
 *  Вес/цена/таблица урона — не часть карточки. */

/** One entry within a range mode's list — its own range bonus and an optional area template.
 *  `shapes` is validated per-mode in the sheet, not the schema. */
function weaponRangeEntryField() {
  return new SchemaField({
    rangeModifier: new NumberField({ required: true, initial: 0, integer: true }),
    // none | line | wideline | circle | triangle | square — purely descriptive, not wired to the
    // canvas drawing tool. NOTE: "line" here means the old thin/DDA line, a different geometric
    // concept from the canvas tool's "line" shape type (module/canvas/geometry-core.mjs, a 1.2-wide
    // corridor). Don't reuse this value directly as a computeCoverage() shapeConfig.type if this
    // ever gets wired up — translate it explicitly.
    templateShape: new StringField({ required: true, initial: "none" }),
    // radius/half-size/length in cells. For a Настильный (direct) circle/square this is
    // the AOE radius; rangeModifier ABOVE then decides HOW it's delivered — 0 = centered
    // on the caster (a self AOE, no aim step), >0 = a reach line FROM the caster out to
    // rangeModifier, with the AOE placed at its tip (see weapon-template-drop.mjs's
    // "self" vs "compound" routing). Навесной (brosok) circle/square stays a lobbed throw.
    templateSize:  new NumberField({ required: true, initial: 1, min: 1, integer: true }),
    // Which hit-resolution logic THIS template entry uses — per-entry (not per-item), so
    // different range entries on the same weapon/ability can each pick their own. Forward-
    // looking: today there's only one implementation ("base" — plain flat cell-membership hit,
    // directionalWallClip, see template-canvas.mjs's _recomputeDraw), the sheet's select just
    // has one option so far. Reserved for a future alternate per-template hit-resolution logic.
    hitLogic: new StringField({ required: true, initial: "base" }),
  });
}

/** One Особенности/Features entry — free text plus which phase-tracker stage it activates on
 *  (2026-08-17 redesign: replaces the old single free-text `property` field PLUS the separate
 *  whole-card `activationTypes` checkbox group with a repeatable list, each entry carrying its
 *  own single stage instead of the whole card sharing one set of checkboxes). Shared by every
 *  DataModel that carries a Features block (Weapon/Spell via weaponCardSchema, Armor,
 *  Consumable, Trophy, Ability) — see migrateFeaturesField for the old-shape upgrade. */
function featureEntryField() {
  return new SchemaField({
    text: new HTMLField({ required: true, initial: "" }),
    // "" | one of GOD.ACTIVATION_TYPES (instant | control | prepMovement | closing) — ""
    // means no particular stage (a passive/always-on description). Single choice, not a
    // checkbox group — a feature that genuinely needs to trigger on two different stages
    // is two separate entries.
    activation: new StringField({ required: true, initial: "", blank: true }),
  });
}

/** Запас (Stock) — "wear" tracking shared by Consumable and Armor (2026-08-18: extended
 *  to Armor). See "Расходники" → "Заряды и запас" in the rulebook. Items that don't track
 *  an exact charge/durability count (ammo packs, patched shields, worn armor) instead
 *  track how many d10 currently sit in a "stock dice chain" (`stockDice`) — starts at 1,
 *  never resets between scenes — against a GM-set max chain length (`stockMax`). Checking
 *  (module/rolls/consumable-check.mjs / armor-check.mjs) rolls stockDice d10; any die
 *  showing 2 or less grows the chain by one. Growing past stockMax exhausts the item —
 *  what "exhausted" MEANS differs per item type (a Consumable is fully spent and deleted;
 *  Armor can't just vanish, so it gets marked `broken` instead — see ArmorDataModel's
 *  `broken` field). The player can also manually shrink stockDice (restocked/repaired) via
 *  the sheet's "-1" control. NPCs never check stock — their gear doesn't wear. */
function stockFields() {
  return {
    stockDice: new NumberField({ required: true, initial: 1, min: 1, integer: true }),
    stockMax: new NumberField({ required: true, initial: 1, min: 1, integer: true }),
  };
}

/** Особенности/Features upgrade (2026-08-17): the old single free-text `property` HTMLField
 *  and the separate whole-card `activationTypes` checkbox group are both retired in favor of
 *  one repeatable `features` list (featureEntryField above) — each entry has its own text AND
 *  its own single activation stage. Migration: old `property` text (if any) becomes the first
 *  entry, tagged with the old `activationTypes`' FIRST value (if any) — a multi-checked old
 *  card can't be losslessly split into "which stage goes with which sentence", so it keeps
 *  just one; a GM who needs the paragraph on two stages can split it into two features by hand
 *  after migration. Shared by every DataModel that had `property`/`activationTypes`. */
function migrateFeaturesField(source) {
  if (!("features" in source) && ("property" in source || "activationTypes" in source)) {
    const text = typeof source.property === "string" ? source.property : "";
    const activation = Array.isArray(source.activationTypes) ? (source.activationTypes[0] ?? "") : "";
    source.features = text ? [{ text, activation }] : [];
  }
  delete source.property;
  delete source.activationTypes;
}

/** Items attached to a card — dropped onto its sheet (any item type: ability, weapon,
 *  etc.). A snapshot (name/img/type) is kept for display without an async resolve;
 *  `uuid` is the source of truth. Same shape used by Class (see ClassDataModel below,
 *  where it's auto-copied to an actor on pickup — module/data/class-race-rules.mjs) and
 *  by Weapon/Spell (see weaponCardSchema below, reference-only — a weapon/spell moves in
 *  and out of inventory too freely for the Class/Race auto-grant pattern to make sense
 *  the same way, so class-race-rules.mjs is deliberately NOT wired up to these). */
function grantedItemsField() {
  return new ArrayField(
    new SchemaField({
      uuid: new StringField({ required: true, initial: "" }),
      name: new StringField({ required: true, initial: "" }),
      img: new StringField({ required: true, initial: "icons/svg/item-bag.svg" }),
      type: new StringField({ required: true, initial: "" }),
    }),
    { required: true, initial: [] },
  );
}

/** Shared by WeaponDataModel and SpellDataModel — a spell's card is deliberately
 *  identical to a weapon's (same Настильный/Навесной range lists, Натиск/Залп attack
 *  type, damage type, rarity, skill — "hands" even already has a "Вербальный" option,
 *  for a spell with no somatic component). Kept as one function so the two schemas
 *  can never drift apart by accident. */
function weaponCardSchema() {
  return {
    description: new HTMLField({ required: true, initial: "" }),
    hands: new StringField({ required: true, initial: "main" }),        // main | off | two
    size: new StringField({ required: true, initial: "medium", blank: true }), // "" | small | medium | large | huge — "" = no size (0 Container slots, see GOD.ITEM_SIZE_SLOT_COST)
    natisk: new ArrayField(weaponRangeEntryField(), { required: true, initial: [] }), // Настильный (Direct) entries — full template shape set
    brosok: new ArrayField(weaponRangeEntryField(), { required: true, initial: [] }), // Навесной (Vertical) entries — circle/square only
    // RETIRED toggle — kept in the schema only so existing weapons don't throw a
    // validation error; nothing reads it anymore. Height-aware 3D-Direct hit/clip
    // resolution is now ALWAYS on for Настильный (Direct) attacks (see
    // weapon-template-drop.mjs, which stamps direct3D:true unconditionally). The old
    // flat-plane 2D mode was removed because it ignored elevation entirely — a shot
    // aimed high still "hit" units on the ground. The UI checkbox was dropped from
    // weapon-sheet.hbs / ability-sheet.hbs. Safe to delete this field in a future
    // migration pass.
    direct3D: new BooleanField({ required: true, initial: false }),
    // Which base action (Натиск/melee or Залп/ranged — see BASE_ACTIONS.execution in
    // action-log.mjs) this counts as. Deliberately independent of natisk/brosok
    // above — those describe a template's TRAJECTORY (Настильный: a horizontal
    // line-of-sight shot, blocked by walls; Навесной: a lobbed, single-stage
    // "thrown" arc that clears walls and can hit floor/ceiling), not whether the
    // attack itself is melee or ranged. A bow's shot is still Залп even when it's a
    // Настильный (Direct) line — see module/canvas/weapon-template-drop.mjs, which reads
    // this field directly rather than inferring it from which list a dropped entry came
    // from. "self" (self-applied items — buffs/heals/etc.) has no corresponding
    // BASE_ACTIONS entry — canvas-drop logging just leaves actionId/actionName null for
    // it (see ACTION_FOR_ATTACK_TYPE in weapon-template-drop.mjs).
    attackType: new StringField({ required: true, initial: "melee" }), // melee | ranged | self
    // Only meaningful when attackType === "ranged" — a ranged attack can touch the "ground"
    // height band (config.mjs-adjacent, see aim-height-damage.mjs's HEIGHT_BANDS) unconditionally,
    // but needs one of these two explicitly checked to touch "lowFlight"/"highFlight" at all (a
    // dead-on hit doesn't bypass this — see aimHeightDamageTier). Melee is never gated by these;
    // GM decision 2026-08-17: most weapons simply can't threaten the sky without a special
    // property (a longbow, a ballista, an anti-air spell), so it defaults OFF.
    canHitLowFlight: new BooleanField({ required: true, initial: false }),
    canHitHighFlight: new BooleanField({ required: true, initial: false }),
    damageType: new StringField({ required: true, initial: "" }),       // "" | cutting | piercing | crushing | burning | freezing | electric
    // "" | physical | metaphysical — see GOD.DAMAGE_NATURES (config.mjs). Orthogonal to
    // attackType (melee/ranged/self) above; the two combine into the physical-melee/
    // physical-ranged/metaphysical-melee/metaphysical-ranged split.
    damageNature: new StringField({ required: true, initial: "physical" }),
    // "" | one of GOD.ITEM_DOMAINS (social | combat) — header tag, shared label/field
    // across Weapon/Spell/Armor/Ability/Consumable, same pattern as activationTypes.
    domain: new StringField({ required: true, initial: "", blank: true }),
    // Особенности — repeatable list of {text, activation} entries (featureEntryField above).
    // Label is GOD.Weapon.Property, reused (same key) by Armor/Ability's identical field.
    features: new ArrayField(featureEntryField(), { required: true, initial: [] }),
    rarity: new NumberField({ required: true, nullable: false, initial: 2, min: 0, max: 8, integer: true }), // 0–8, see migrateRarity() above
    skill: new StringField({ required: true, initial: "" }),            // "" | one of GOD.SKILL_MAP's 16 skill keys — the skill this rolls against
    // Id of the Container item (on the same actor) this is currently stored in, or null
    // if it isn't packed into one.
    containerId: new StringField({ required: false, nullable: true, initial: null }),
    // See grantedItemsField's doc comment — reference-only, not auto-granted.
    grantedItems: grantedItemsField(),
  };
}

/** activationType (single string) was replaced by activationTypes (array) — a card can
 *  now carry more than one activation type at once. Shared by every DataModel that has
 *  the field (Weapon/Spell via migrateWeaponCardData below, plus Armor/Ability/
 *  Consumable's own migrateData methods). */
function migrateActivationType(source) {
  if (typeof source.activationType === "string" && !("activationTypes" in source)) {
    source.activationTypes = source.activationType ? [source.activationType] : [];
    delete source.activationType;
  }
}

/** Migrate older shapes into the current natisk/brosok arrays-of-entries format:
 *  1) oldest — a single `verb` + flat rangeModifier/templateShape/templateSize
 *  2) middle — natisk/brosok as single {enabled, rangeModifier, templateShape, templateSize} objects
 *  Shared by WeaponDataModel and SpellDataModel. */
function migrateWeaponCardData(source) {
  if ("verb" in source && !("natisk" in source)) {
    const wasNatisk = source.verb !== "brosok";
    const entry = {
      rangeModifier: source.rangeModifier ?? 0,
      templateShape: source.templateShape ?? "none",
      templateSize:  source.templateSize ?? 1,
    };
    source.natisk = wasNatisk ? [entry] : [];
    source.brosok = !wasNatisk ? [entry] : [];

    delete source.verb;
    delete source.rangeModifier;
    delete source.templateShape;
    delete source.templateSize;
  }

  for (const key of ["natisk", "brosok"]) {
    const val = source[key];
    if (val && !Array.isArray(val) && typeof val === "object") {
      source[key] = val.enabled ? [{
        rangeModifier: val.rangeModifier ?? 0,
        templateShape: val.templateShape ?? "none",
        templateSize:  val.templateSize ?? 1,
      }] : [];
    }
  }

  // Skill keys get renamed over time (GOD.SKILL_KEY_RENAMES, config.mjs) — repoint any
  // weapon still rolling against a retired one.
  if (GOD.SKILL_KEY_RENAMES[source.skill]) source.skill = GOD.SKILL_KEY_RENAMES[source.skill];

  // Order matters: migrateActivationType first normalizes an even OLDER singular
  // `activationType` string (if any) into the `activationTypes` array shape, so
  // migrateFeaturesField (which only reads the array) has something to fold in rather than
  // silently losing a very old item's activation stage.
  migrateActivationType(source);
  migrateFeaturesField(source);
  migrateRarity(source);
}

export class WeaponDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return weaponCardSchema();
  }

  static migrateData(source) {
    migrateWeaponCardData(source);
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Spell (Заклинание)                          */
/* -------------------------------------------- */
/*  Same card as Weapon (see weaponCardSchema's doc comment) — a spell is attacked/cast
 *  through the exact same Настильный/Навесной + Натиск/Залп mechanism as a weapon, so
 *  it can be dragged onto the canvas during combat the same way (see
 *  module/canvas/weapon-template-drop.mjs). */

export class SpellDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      ...weaponCardSchema(),
      // "" | one of GOD.STATUS_EFFECTS' ids — the status this spell inflicts/is
      // associated with, or "" for none. Weapon doesn't get this field (see
      // module/sheets/weapon-sheet.mjs's isSpell-gated header tag).
      statusEffect: new StringField({ required: true, initial: "", blank: true }),
    };
  }

  static migrateData(source) {
    migrateWeaponCardData(source);
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Armor                                       */
/* -------------------------------------------- */
/*  Формат карточки брони (раздел «Снаряжение» правил): Архетип,
 *  Недостаток (имя + описание), Редкость. Player-only — NPCs don't equip armor.       */

export class ArmorDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: true, initial: "" }),
      archetype: new StringField({ required: true, initial: "light" }),   // light | heavy
      // Equip slot — cuirass | underarmor | helmet | arms | legs (GOD.ARMOR_SUBTYPES).
      // One equipped item per subtype; equipping another of the same subtype replaces it.
      subtype: new StringField({ required: true, initial: "cuirass" }),
      drawbackName: new StringField({ required: true, initial: "" }),
      drawbackText: new HTMLField({ required: true, initial: "" }),
      // Особенности — repeatable {text, activation} list, same field/label as
      // Weapon/Spell/Ability's (see featureEntryField).
      features: new ArrayField(featureEntryField(), { required: true, initial: [] }),
      rarity: new NumberField({ required: true, nullable: false, initial: 2, min: 0, max: 8, integer: true }), // 0–8, see migrateRarity() above
      // "" | one of GOD.ITEM_DOMAINS — see weaponCardSchema's domain doc comment above.
      domain: new StringField({ required: true, initial: "", blank: true }),
      equipped: new BooleanField({ required: true, initial: false }),
      // Struck-through marker for the actor sheet's Armor loadout row (module/sheets/
      // actor-sheet.mjs's #prepareArmorLoadout) — clicked by hand, no roll involved, no
      // mechanical effect beyond the visual (armor no longer feeds GRIT at all, see
      // module/combat/wounds.mjs's getGritCells). A cuirass (subtype "cuirass") is
      // exempt — never breakable, see #prepareArmorLoadout's own doc comment for why.
      broken: new BooleanField({ required: true, initial: false }),
      // small | medium | large | huge — how many Container slots this item costs
      // (see GOD.ITEM_SIZE_SLOT_COST in config.mjs).
      size: new StringField({ required: true, initial: "medium" }),
      // Id of the Container item (on the same actor) this armor is currently stored
      // in, or null if it isn't packed into one.
      containerId: new StringField({ required: false, nullable: true, initial: null }),
    };
  }

  static migrateData(source) {
    migrateActivationType(source);
    migrateFeaturesField(source);
    migrateRarity(source);
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Container                                   */
/* -------------------------------------------- */
/*  Backpack-like storage item. "Deep Storage" containers can only have one
 *  equipped at a time; "Quick Slot" containers have no such limit (see
 *  #onToggleContainerEquip in actor-sheet.mjs/npc-sheet.mjs). Capacity is in
 *  slots — items cost 1/2/3/4 slots by size (GOD.ITEM_SIZE_SLOT_COST). */

export class ContainerDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: true, initial: "" }),
      rarity: new NumberField({ required: true, nullable: false, initial: 2, min: 0, max: 8, integer: true }), // 0–8, see migrateRarity() above
      // deep | quick — deep = only one may be equipped at a time; quick = unlimited.
      containerType: new StringField({ required: true, initial: "quick" }),
      capacity: new NumberField({ required: true, initial: 4, min: 0, integer: true }),
      // small | medium | large | huge — how many slots this container itself costs when
      // carried unequipped (see GOD.ITEM_SIZE_SLOT_COST) — same weighting used for what's
      // packed inside it. Only matters while unequipped; an equipped container costs
      // nothing against a Race's own carrying capacity (see actor-sheet.mjs's
      // #prepareCarryCapacity).
      size: new StringField({ required: true, initial: "medium" }),
      // Hex color used to tag items stored inside this container, and to tint its
      // own backpack icon on the inventory card.
      color: new StringField({ required: true, initial: "#39ff14" }),
      equipped: new BooleanField({ required: true, initial: false }),
      // Free-text restriction on what may be packed into this container — blank means
      // unrestricted (any storable item). When set (e.g. "Стрелы" on a "Колчан"), only
      // items whose name contains this text (case-insensitive) may be packed in — see
      // actor-sheet.mjs's/npc-sheet.mjs's #itemAllowedInContainer.
      restriction: new StringField({ required: true, initial: "", blank: true }),
    };
  }

  static migrateData(source) {
    migrateRarity(source);
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Consumable                                  */
/* -------------------------------------------- */

export class ConsumableDataModel extends BaseItemModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      // Запас (Stock) — see stockFields() above. Exhausting a Consumable's chain deletes
      // it (pack empty / shield broken — see rolls/consumable-check.mjs).
      ...stockFields(),
      // "" | one of GOD.ITEM_DOMAINS — see weaponCardSchema's domain doc comment. Not on
      // BaseItemModel itself since Trophy (the other BaseItemModel subclass) doesn't
      // use this field.
      domain: new StringField({ required: true, initial: "", blank: true }),
      // Особенности/Features — repeatable {text, activation} list, same field/label as
      // Weapon/Armor/Ability's (see featureEntryField). What a consumable's effect actually
      // does belongs here now — no separate one-line `effect` field anymore (see
      // consumable-sheet.hbs).
      features: new ArrayField(featureEntryField(), { required: true, initial: [] }),
    };
  }

  static migrateData(source) {
    migrateActivationType(source);
    migrateFeaturesField(source);
    migrateRarity(source);
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Tools (Инструменты)                          */
/* -------------------------------------------- */
/*  A tool kit — distinct from Consumable (not used up, doesn't have charges/activation).
 *  Carries a free-text Competency this kit is meant to be used with (picked off the same
 *  curated GOD.COMPETENCY_GROUPS list the character builder's competency step uses — see
 *  tools-sheet.mjs's competencyOptions), plus Rarity/Size like every other piece of
 *  equipment (via BaseItemModel) — no Особенности/Features block, unlike Weapon/Armor/
 *  Ability/Consumable.                                                                */

export class ToolsDataModel extends BaseItemModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      // Free-text competency this tool kit requires — picked off GOD.COMPETENCY_GROUPS,
      // not an enum: any string is valid, same non-enforcement as a Class's own
      // competencies list (see ClassDataModel.competencies' doc comment).
      competency: new StringField({ required: true, initial: "", blank: true }),
    };
  }

  static migrateData(source) {
    migrateRarity(source);
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Trophy (item sub-type key: "trophies")      */
/* -------------------------------------------- */
/*  Карточка трофея (own dedicated equip-sheet — see trophy-sheet.hbs/.mjs — not the
 *  generic Consumable/Item one, hence its own schema below rather than extending
 *  BaseItemModel: no Quantity/Weight/Price, those don't mean anything for a trophy):
 *  Редкость, Размер — a trophy is always a whole item at its full rarity ("Intact").
 *  Trading it away is all-or-nothing — there used to be a divisible "Scrap" variant
 *  (right-click → "Разделить") but that type and its split logic have been removed;
 *  every trophy now behaves the old "intact" way.                                    */

export class TrophyDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: true, initial: "" }),
      // 0–8, see migrateRarity() above.
      rarity: new NumberField({ required: true, nullable: false, initial: 2, min: 0, max: 8, integer: true }),
      // small | medium | large | huge — how many Container slots this item costs
      // (see GOD.ITEM_SIZE_SLOT_COST in config.mjs).
      size: new StringField({ required: true, initial: "medium" }),
      // What kind of trophy this is — luxury | art | relics | jewelry | antiques |
      // living | alchemical (GOD.Item.Trophy.Category* labels, trophy-sheet.hbs).
      category: new StringField({ required: true, initial: "luxury", choices: ["luxury", "art", "relics", "jewelry", "antiques", "living", "alchemical"] }),
      // Особенности/Features — repeatable {text, activation} list, same field as
      // Weapon/Armor/Ability/Spell's (see featureEntryField) — labeled "FEATURES" here
      // rather than reusing GOD.Weapon.Property's Russian label. Trophy never had a
      // whole-card activationTypes checkbox group (a trophy isn't "activated"), so
      // migrateFeaturesField's activation always comes out "" for a migrated entry here.
      features: new ArrayField(featureEntryField(), { required: true, initial: [] }),
      // Id of the Container item (on the same actor) this item is currently stored
      // in, or null if it isn't packed into one.
      containerId: new StringField({ required: false, nullable: true, initial: null }),
    };
  }

  static migrateData(source) {
    migrateFeaturesField(source);
    migrateRarity(source);
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Ability (Способность)                        */
/* -------------------------------------------- */
/*  Карточка способности класса (раздел «Способности» правил): тип способности —
 *  gift/tacticalManeuver/simpleManeuver (see GOD.ABILITY_SUBTYPES; a "class"-prefixed
 *  classed counterpart of each used to exist too, tied to a className field — both were
 *  retired, see migrateData below), пассивная или активная, и — если активная — условие
 *  восстановления. Три варианта восстановления:
 *   - "stabilize": возвращается через действие Восстановление, применённое
 *     нужное число раз (recoveryCount);
 *   - "period": срабатывает один раз за период (сцена/неделя/месяц/год);
 *   - "none": условия восстановления нет — recoveryPeriod принудительно
 *     сбрасывается в "none" вместе с ним (см. sheets/ability-sheet.mjs).
 *  Also carries the same combat parameters as a Weapon (Руки, Натиск/Залп, Настильный/
 *  Навесной, Тип воздействия, Навык) so a tactical/simple maneuver can describe its own
 *  attack shape without needing a separate weapon item — including dragging its card
 *  straight onto the canvas to draw a configured template, exactly like a weapon does
 *  (see module/canvas/weapon-template-drop.mjs). Сила эффекта (effect strength) is no
 *  longer per-item — it lives once per class (ClassDataModel.effect). */

export class AbilityDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: true, initial: "" }),
      subtype: new StringField({ required: true, initial: "gift" }),        // GOD.ABILITY_SUBTYPES key
      activation: new StringField({ required: true, initial: "passive" }),  // passive | active
      // "" | one of GOD.ITEM_DOMAINS — see weaponCardSchema's domain doc comment.
      domain: new StringField({ required: true, initial: "", blank: true }),
      recoveryMode: new StringField({ required: true, initial: "stabilize" }), // stabilize | period | none (только для active)
      recoveryCount: new NumberField({ required: true, nullable: false, initial: 1, min: 1, integer: true }), // stabilize: сколько раз
      recoveryPeriod: new StringField({ required: true, initial: "scene" }),   // period: scene | week | month | year | none
      rarity: new NumberField({ required: true, nullable: false, initial: 1, min: 0, max: 8, integer: true }), // 0–8, see migrateRarity() above
      // -- Weapon-shared combat parameters (see WeaponDataModel above) --
      hands: new StringField({ required: true, initial: "main" }),        // main | off | two
      // Натиск/Залп — which base action this ability's attack counts as, and whether it can
      // reach the "lowFlight"/"highFlight" height bands when ranged — see weaponCardSchema's
      // attackType/canHitLowFlight/canHitHighFlight doc comments above (same fields, same
      // defaults). Also what lets an ability with a template be dragged onto the canvas the
      // same way a weapon is (module/canvas/weapon-template-drop.mjs's _armDraw reads this).
      attackType: new StringField({ required: true, initial: "melee" }), // melee | ranged | self
      canHitLowFlight: new BooleanField({ required: true, initial: false }),
      canHitHighFlight: new BooleanField({ required: true, initial: false }),
      natisk: new ArrayField(weaponRangeEntryField(), { required: true, initial: [] }), // Настильный (Direct) entries
      brosok: new ArrayField(weaponRangeEntryField(), { required: true, initial: [] }), // Навесной (Vertical) entries
      direct3D: new BooleanField({ required: true, initial: false }), // 3D height-aware Direct — see weaponCardSchema's direct3D doc comment
      damageType: new StringField({ required: true, initial: "" }),       // "" | cutting | piercing | crushing | burning | freezing | electric
      // "" | physical | metaphysical — see weaponCardSchema's damageNature doc comment above.
      damageNature: new StringField({ required: true, initial: "physical" }),
      skill: new StringField({ required: true, initial: "" }),            // "" | one of GOD.SKILL_MAP's 16 skill keys
      // Особенности — repeatable {text, activation} list (see featureEntryField; same
      // field/label, shared across Weapon/Spell/Armor/Ability). Each entry's own
      // `activation` is unrelated to this DataModel's own `activation` field above
      // (passive/active trigger vs. per-feature phase-tracker stage).
      features: new ArrayField(featureEntryField(), { required: true, initial: [] }),
      // Zero to GOD.ABILITY_MAX_STATUS_EFFECTS (config.mjs) of GOD.STATUS_EFFECTS' ids —
      // every status this ability inflicts/is associated with. Was a single free
      // StringField (see migrateData below for the old-shape upgrade) — some maneuvers
      // genuinely apply more than one condition at once. The cap itself is only
      // enforced by the sheet's own "+" picker (ability-sheet.mjs's #onPickStatusEffect),
      // not by the schema — nothing else reads more than GOD.ABILITY_MAX_STATUS_EFFECTS
      // of it, so an item edited by hand past that limit just shows every one of them.
      statusEffects: new ArrayField(new StringField({ required: true, blank: false }), { required: true, initial: [] }),
    };
  }

  /** Same natisk/brosok migration as WeaponDataModel — kept in sync in case an older
   *  shape ever needs it here too (see WeaponDataModel.migrateData for the history). */
  static migrateData(source) {
    for (const key of ["natisk", "brosok"]) {
      const val = source[key];
      if (val && !Array.isArray(val) && typeof val === "object") {
        source[key] = val.enabled ? [{
          rangeModifier: val.rangeModifier ?? 0,
          templateShape: val.templateShape ?? "none",
          templateSize:  val.templateSize ?? 1,
        }] : [];
      }
    }

    // "statusEffect" (a single free StringField) was replaced by "statusEffects" (an
    // array) — repoint any ability still storing the old single-value shape.
    if (typeof source.statusEffect === "string" && !("statusEffects" in source)) {
      source.statusEffects = source.statusEffect ? [source.statusEffect] : [];
      delete source.statusEffect;
    }

    // Skill keys get renamed over time (GOD.SKILL_KEY_RENAMES, config.mjs) — repoint any
    // ability still rolling against a retired one.
    if (GOD.SKILL_KEY_RENAMES[source.skill]) source.skill = GOD.SKILL_KEY_RENAMES[source.skill];

    // "commonGift" was renamed to "gift" for symmetry with the maneuver subtypes
    // (gift/classGift, tacticalManeuver/classTacticalManeuver, simpleManeuver/classSimpleManeuver).
    if (source.subtype === "commonGift") source.subtype = "gift";

    // The "class"-prefixed subtype half (classGift/classTacticalManeuver/
    // classSimpleManeuver) was retired — the className field they alone used is gone too
    // (GOD.ABILITY_SUBTYPES, config.mjs). Repoint any ability still on one of the old
    // class-tied keys onto its plain counterpart, and drop the now-meaningless className
    // rather than leaving it stuck on the item.
    const CLASS_SUBTYPE_RENAMES = {
      classGift: "gift",
      classTacticalManeuver: "tacticalManeuver",
      classSimpleManeuver: "simpleManeuver",
    };
    if (CLASS_SUBTYPE_RENAMES[source.subtype]) source.subtype = CLASS_SUBTYPE_RENAMES[source.subtype];
    delete source.className;

    migrateRarity(source);

    migrateActivationType(source);
    migrateFeaturesField(source);

    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Class                                       */
/* -------------------------------------------- */
/*  Формат карточки класса (раздел «Классы» правил): Урон, Поглощение и Эффект —
 *  четвёрки фиаско/провал/успех/триумф (Эффект — число восстановлений, которое
 *  потребуется применить, чтобы снять эффект от удара; раньше это поле было на
 *  каждом оружии/способности отдельно, теперь одно на класс), Компетенции —
 *  свободный список тегов профессиональных навыков, Бонусы навыков — список
 *  ссылок на конкретные навыки (GOD.SKILL_MAP), каждое вхождение даёт +1 к
 *  эффективному рангу этого навыка (см. CharacterDataModel.prepareDerivedData в
 *  module/data-models.mjs — считается на лету, на actor.system.skillRanks не
 *  записывается), Выдаваемые предметы — способности/что угодно, копируемые
 *  актёру при добавлении класса (см. grantClassItems в
 *  module/data/class-race-rules.mjs), Стартовые предметы — отдельный набор
 *  (снаряжение + трофеи), который не выдаётся автоматически, а предлагается
 *  игроку на шаге выбора предметов Мастера создания персонажа (см.
 *  module/apps/character-builder.mjs). Стиль и Классовая способность — не
 *  часть карточки пока (добавляются позже).    */

/** Same shape as the retired tripletField() but free text instead of integers — used by effect (see
 *  ClassDataModel below), whose four cells describe whatever the class's own re-flavored
 *  row actually means ("1d6 огня", "Оглушение", a dice formula, plain prose, …) rather
 *  than a fixed recovery count. */
function textTripletField() {
  return new SchemaField({
    fiasco: new StringField({ required: true, initial: "" }),
    fail: new StringField({ required: true, initial: "" }),
    success: new StringField({ required: true, initial: "" }),
    triumph: new StringField({ required: true, initial: "" }),
  });
}

export class ClassDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      // Damage was a single BASE number (COMBAT-REDESIGN.md): the per-attack value was
      // computed as base + ceil(attackSkill/20), gated by the roll's outcome tier (see
      // module/combat/combat-damage.mjs), replacing the old fiasco/fail/success/triumph
      // Damage triplet — migrateData below seeded `base` from the retired triplet's
      // `success` cell. Dodge/Fortitude went through the SAME flattening later
      // (2026-08-18) — dodgeBase/fortitudeBase below, migrateData seeds them the same
      // way. Push stays a free-text triplet (textTripletField()) pending its own rework.
      //
      // 2026-08-19: `base` split FOUR ways — physical/metaphysical × melee/ranged (see
      // weaponCardSchema's damageNature doc comment above) — since a weapon/ability card
      // now declares its own damage nature + attackType, and an attack roll (see
      // module/combat/combat-damage.mjs's classBaseField, module/rolls/roll-dialog.mjs)
      // must read the ONE class base number matching what the triggering card actually
      // is. migrateData below folds the old flat `base` into BOTH baseMelee and
      // baseRanged (the old model never distinguished them either, so this preserves
      // existing balance); the two metaphysical fields start at 0 — a brand-new concept
      // with nothing to migrate from, opt-in per class.
      baseMelee: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      baseRanged: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      baseMetaphysicalMelee: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      baseMetaphysicalRanged: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      // Dodge/Fortitude base — flat class values (COMBAT-REDESIGN, 2026-08-18), exactly
      // like `base` above: the character sheet's headline Dodge/Fortitude
      // (CharacterDataModel.prepareDerivedData's system.defense) is this number plus
      // whatever the equipped cuirass's own archetype adds (Light → +1 Dodge, Heavy →
      // +2 Fortitude — see actor-sheet.mjs's #prepareArmorLoadout). A Выносливость
      // (endurance) or Ловкость (agility) skill ROLL separately computes a tiered
      // Fortitude/Dodge VALUE off this same base, via the identical
      // damageForTier/rollBonus formula the damage roll uses (see
      // module/rolls/roll-dialog.mjs's DEFENSE_SKILLS block) — this field is that
      // roll's "B", same role `base` plays for weapon damage.
      dodgeBase: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      fortitudeBase: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      push: textTripletField(),
      // Which GOD.COMPETENCY_GROUPS categories (config.mjs) this class allows picking
      // from on the character builder's FIRST competency step — a subset of the
      // groups' own `key`s (e.g. "meleeCombat"), edited as a checklist on the class
      // sheet (see class-sheet.mjs's #onPickCompetency), NOT free competency names
      // directly anymore. The builder resolves each allowed category into its actual
      // competency names live (character-builder.mjs's #selectedClassCompetencies), so
      // a rulebook edit to a category's competency list (loadCompetencyGroupsFromRulebook)
      // changes what a class with that category offers too. At chargen, the two
      // competency-step picks (real names, not categories) REPLACE this array on the
      // actor's own copy of the class item (see GODCharacterBuilder#onFinish) — the
      // compendium source class's own category list is never touched. A class item
      // dragged straight onto an actor instead of through the builder still carries its
      // raw category keys; actor-sheet.mjs's #prepareClassItem resolves those to a
      // display name defensively for that case.
      competencies: new ArrayField(new StringField({ required: true, blank: false }), { required: true, initial: [] }),
      // Skill-rank bonuses this class grants — an array of GOD.SKILL_MAP skill keys, no
      // cap on length; each occurrence of a key is +1 to that skill's EFFECTIVE rank
      // (duplicates stack, e.g. the same key twice is +2). Read straight off the class
      // item by CharacterDataModel#prepareDerivedData (module/data-models.mjs) when
      // computing skill values — never copied onto the actor, same live-read pattern as
      // damage/dodge/fortitude/push/competencies above.
      skillRankBonuses: new ArrayField(new StringField({ required: true, blank: false }), { required: true, initial: [] }),
      // Items this class grants — dropped onto the class sheet (any item type: ability,
      // weapon, etc.). uuid is the source of truth used to actually create the copy on
      // an actor when the class is added (see module/data/class-race-rules.mjs) — see
      // grantedItemsField's doc comment above for the shape (shared with Weapon/Spell).
      grantedItems: grantedItemsField(),
      // Starting equipment pool — dropped onto the class sheet's own "Стартовые
      // предметы" dropzone (separate from grantedItems above: these are never
      // auto-copied by the createItem hook). Read directly by the Character Builder's
      // item-selection step (module/apps/character-builder.mjs): non-trophy entries
      // are the class's free default kit; trophy entries (type "trophies") are the
      // player's starting barter currency for that step — its rarity is a spendable
      // budget, tradeable for one or more equipment-compendium items whose rarities add
      // up to at most that much (not necessarily an exact match — cheaper items just
      // leave the rest to spend on something else, and any leftover is forfeited once the
      // player moves on); several same-rarity trophies may also be combined into one
      // offer worth one rarity rank higher per extra trophy (see
      // GODCharacterBuilder#onTradeEquipment). Same shape as grantedItemsField() (uuid is
      // the source of truth; name/img/type are just a display snapshot).
      startingItems: grantedItemsField(),
    };
  }

  static migrateData(source) {
    // Skill keys get renamed over time (GOD.SKILL_KEY_RENAMES, config.mjs) — repoint any
    // bonus still targeting a retired one.
    if (Array.isArray(source.skillRankBonuses)) {
      source.skillRankBonuses = source.skillRankBonuses.map((key) => GOD.SKILL_KEY_RENAMES[key] ?? key);
    }
    // "effect" (per-class customizable via the now-removed effectLabel field) was
    // renamed to "power" (fixed row name, like Damage/Absorption) — repoint any class
    // still storing its data under the old key. effectLabel itself just gets dropped;
    // nothing reads it anymore.
    if (source.effect !== undefined && source.power === undefined) {
      source.power = source.effect;
    }
    // The STRIFE table's rows were renamed Damage/Absorption/Power → Damage/Guard/Push —
    // repoint any class still storing progress under the old absorption/power keys.
    // Chained right after the effect→power step above so a very old class (still on
    // "effect") lands on the current keys in a single migrateData pass.
    if (source.absorption !== undefined && source.guard === undefined) {
      source.guard = source.absorption;
      delete source.absorption;
    }
    if (source.power !== undefined && source.push === undefined) {
      source.push = source.power;
      delete source.power;
    }
    // "Guard" was renamed to "Dodge" (Уворот) — a new "Fortitude" (Стойкость) row was
    // added alongside it at the same time (see the schema above), but that one has no
    // predecessor to migrate from; it just starts at 0 for every existing class.
    if (source.guard !== undefined && source.dodge === undefined) {
      source.dodge = source.guard;
      delete source.guard;
    }
    // "resolve" (the one SOCIAL triplet) moved off Class onto Race — see
    // RaceDataModel.resolve below. Not migrated forward: a class with old resolve data
    // has nowhere on Class left to put it, and Race items don't inherit from Class ones.
    // Damage triplet → single `base` (COMBAT-REDESIGN): seed base from the retired
    // triplet's `success` cell (GM tunes it afterwards); drop the old triplet.
    if (source.damage !== undefined && source.base === undefined) {
      source.base = Number(source.damage?.success) || 0;
      delete source.damage;
    }
    // Flat `base` → baseMelee/baseRanged/baseMetaphysicalMelee/baseMetaphysicalRanged
    // (2026-08-19) — see the schema's doc comment above. Chained right after the
    // damage-triplet migration above so a very old class (still on "damage") lands on
    // the new 4-way split in a single pass too.
    if (source.base !== undefined && source.baseMelee === undefined && source.baseRanged === undefined) {
      source.baseMelee = Number(source.base) || 0;
      source.baseRanged = Number(source.base) || 0;
      delete source.base;
    }
    // Dodge/Fortitude triplets → single dodgeBase/fortitudeBase (COMBAT-REDESIGN,
    // 2026-08-18) — same flattening `damage` got above, chained after the guard→dodge
    // repoint so an old "guard"-keyed class lands on the new flat field in one pass too.
    if (source.dodge !== undefined && source.dodgeBase === undefined) {
      source.dodgeBase = Number(source.dodge?.success) || 0;
      delete source.dodge;
    }
    if (source.fortitude !== undefined && source.fortitudeBase === undefined) {
      source.fortitudeBase = Number(source.fortitude?.success) || 0;
      delete source.fortitude;
    }
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Race / Creature — shared card shape          */
/* -------------------------------------------- */
/*  Формат карточки расы/существа (разделы «Расы»/«Существа» правил):
 *  Размер и Вес — фиксированные шкалы из 6 категорий каждая (см. ключи
 *  GOD.Race.Size... и GOD.Race.Weight... в lang-файлах), плюс количество
 *  ступеней раны до смерти (лестница ран сама по себе одна для всех —
 *  здесь только счётчик ступеней) и скорость перемещения в метрах (одна
 *  клетка = 1 метр). Остальные поля добавляются позже.                   */

function sizeWeightWoundSchema() {
  return {
    size: new StringField({ required: true, initial: "medium" }),   // swarm|small|medium|large|veryLarge|incrediblyLarge
    weight: new StringField({ required: true, initial: "medium" }), // weightless|light|medium|heavy|veryHeavy|incrediblyHeavy
    woundSteps: new NumberField({ required: true, nullable: false, initial: 1, min: 1, integer: true }),
    speed: new NumberField({ required: true, nullable: false, initial: 4, min: 0, integer: true }), // metres per round (1 cell = 1m)
  };
}

export class RaceDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      ...sizeWeightWoundSchema(),
      description: new HTMLField({ required: true, initial: "" }),
      // Characteristic bonuses this race grants — one signed value per characteristic,
      // set directly (there's only 3 of them, so a repeatable "+1 per click" list like the
      // class's skillRankBonuses would just be a clumsier way to type the same number).
      // Read live off the race item by CharacterDataModel#prepareDerivedData
      // (module/data-models.mjs) — never copied onto the actor's own system.chars.
      charBonuses: new SchemaField({
        char_cognition:     new NumberField({ required: true, nullable: false, initial: 0, integer: true }),
        char_neurodynamics: new NumberField({ required: true, nullable: false, initial: 0, integer: true }),
        char_corpus:        new NumberField({ required: true, nullable: false, initial: 0, integer: true }),
      }),
      // The one DRAMA triplet (moved here from Class — see ClassDataModel.migrateData's
      // doc comment above) — same free-text fiasco/fail/success/triumph shape as Class's
      // STRIFE triplets (Damage/Dodge/Fortitude/Push), fixed row name ("Resolve"), no
      // separate label field.
      resolve: textTripletField(),
      // Carrying capacity the race's own body provides, on top of whatever containers the
      // character is carrying — same unit/shape as a Container's capacity field above, just
      // typed directly on the race card instead of on a separate item.
      capacity: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
    };
  }

  /** "biodynamics"/ПЛОТЬ was renamed to "corpus"/КОРПУС 2026-08-21 (GOD.CHAR_KEY_RENAMES,
   *  config.mjs) — repoint any race still storing its bonus under the old char_biodynamics
   *  key (charBonuses is hardcoded above, not built off GOD.SKILL_MAP). */
  static migrateData(source) {
    for (const [oldKey, newKey] of Object.entries(GOD.CHAR_KEY_RENAMES)) {
      if (source.charBonuses?.[oldKey] !== undefined && source.charBonuses[newKey] === undefined) {
        source.charBonuses[newKey] = source.charBonuses[oldKey];
        delete source.charBonuses[oldKey];
      }
    }
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Creature (Bestiary equivalent of Race)      */
/* -------------------------------------------- */

export class CreatureItemDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return sizeWeightWoundSchema();
  }
}
