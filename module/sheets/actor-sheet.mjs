/**
 * GOD Tactical — Character Actor Sheet (ActorSheetV2)
 * Brutalist biopunk redesign
 */

import { GOD, formatMeters, cellsToMeters, playSound, shakeElement, sparkRepair, charRaiseXpCost, charPointXpCost, mezzaninePriorityDescription } from "../config.mjs";
import { skillRankCharPrereq, skillRankRaiseCost, maxRankForChar } from "../data-models.mjs";
import { GODRollDialog, applyMezzanine } from "../rolls/roll-dialog.mjs";
import { checkConsumable } from "../rolls/consumable-check.mjs";
import { computeWoundState, getGritCells } from "../combat/wounds.mjs";
import { bindInventoryReorder, REORDER_MIME } from "./item-reorder.mjs";
import { bindInventoryContextMenu, bindContextMenu, bindContextMenuOnElement, fakeItemEvent, showPopupMenu } from "./item-context-menu.mjs";
import { bindInventorySearch, bindAbilitySearch } from "./item-search.mjs";
import { GODCharacterBuilder } from "../apps/character-builder.mjs";
import { injectTooltipToggleButton } from "./tooltip-toggle.mjs";
import { clampRarity } from "./rarity-pips.mjs";
import { showCreateItemMenu } from "./item-create-menu.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

export class GODActorSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ActorSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "actor", "character"],
    position: { width: 960, height: 800 },
    window: { resizable: true, minimizable: true },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/actor/character-sheet.hbs",
      // Foundry's own PARTS.scrollable was tried here and confirmed (via instrumentation)
      // to be ineffective for this sheet — by the time it reads the outgoing element's
      // scrollTop, something has already reset it to 0. See the live-scroll tracking in
      // _onRender() instead, which works around that by never depending on reading the
      // value after the fact.
    },
  };

  /* -------------------------------------------- */

  /** Item types that have a "size" (Container slot cost) and can be packed into a Container.
   *  Spell is not storable — it lives in the Abilities tab, not Inventory (see FEATURE_TYPES
   *  in #prepareContext), so it can't be packed into a container either. */
  static #STORABLE_TYPES = ["weapon", "armor", "consumable", "trophies", "tools"];

  /** #STORABLE_TYPES plus Container itself — the set of item types that count against the
   *  attached Race's own carrying capacity (see #prepareCarryCapacity) when sitting
   *  top-level in the inventory (not packed into a container). Container is excluded from
   *  #STORABLE_TYPES because it can't be packed into another container, but an unequipped
   *  backpack still takes up room on the body, so it belongs here. */
  static #CARRY_WEIGHT_TYPES = ["weapon", "armor", "consumable", "trophies", "tools", "container"];

  /**
   * Inject (or update) a pencil-style edit toggle into the window header.
   * Mirrors the weapon-sheet pattern.
   */
  static injectEditToggle(root, editMode, onClick) {
    const header = root.closest(".application")?.querySelector(".window-header")
                ?? root.querySelector(".window-header");
    if (!header) return;
    let btn = header.querySelector(".sheet-edit-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sheet-edit-btn";
      const firstCtrl = header.querySelector("[data-action='toggleControls'], [data-action='close']");
      if (firstCtrl) header.insertBefore(btn, firstCtrl);
      else header.appendChild(btn);
    }
    btn.title = editMode ? "Готово" : "Редактировать анкету";
    btn.className = `sheet-edit-btn${editMode ? " active" : ""}`;
    btn.innerHTML = `<i class="fa-solid ${editMode ? "fa-check" : "fa-pencil"}"></i>`;
    btn.onclick = (e) => { e.preventDefault(); onClick(); };
  }

  /**
   * Inject the Character Builder launch button into the window header.
   * Mirrors injectEditToggle's insertion logic.
   */
  static injectBuilderButton(root, onClick) {
    const header = root.closest(".application")?.querySelector(".window-header")
                ?? root.querySelector(".window-header");
    if (!header) return;
    let btn = header.querySelector(".god-builder-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "god-builder-btn";
      btn.title = game.i18n.localize("GOD.CharBuilder.ButtonTooltip");
      btn.innerHTML = `<i class="fa-solid fa-dna"></i>`;
      const firstCtrl = header.querySelector(".sheet-edit-btn")
                      ?? header.querySelector("[data-action='toggleControls'], [data-action='close']");
      if (firstCtrl) header.insertBefore(btn, firstCtrl);
      else header.appendChild(btn);
    }
    btn.onclick = (e) => { e.preventDefault(); onClick(); };
  }

  /**
   * Lock/unlock anketa fields (name, biography, chars, skill ranks).
   * Always-allowed: rolls, NF buttons, flaw boxes, tabs, item drag/drop & buttons.
   * Skill rank pips aren't <input> elements — they're gated purely via the .locked-edit
   * class (pointer-events: none in CSS), not the readonly toggle below.
   */
  static applyEditLock(root, editMode) {
    root.classList.toggle("locked-edit", !editMode);
    const isLockedField = (el) => {
      const n = el.getAttribute("name") || "";
      if (n === "name") return true;
      if (n.startsWith("system.biography")) return true;
      if (n.startsWith("system.chars.")) return true;
      if (n.startsWith("system.age")) return true;
      return false;
    };
    root.querySelectorAll("input, textarea").forEach((el) => {
      if (!isLockedField(el)) return;
      if (editMode) el.removeAttribute("readonly");
      else el.setAttribute("readonly", "");
    });
  }

  static #ITEM_ICON = {
    weapon:      "fa-khanda",
    spell:       "fa-hat-wizard",
    armor:       "fa-shield-alt",
    consumable:  "fa-flask",
    tools:       "fa-toolbox",
    trophies:    "fa-gem",
    ability:     "fa-star",
    class:       "fa-user-graduate",
    race:        "fa-dna",
    container:   "fa-backpack",
  };

  static #TYPE_LABEL = {
    weapon:     "Оружие",
    spell:      "Заклинание",
    armor:      "Броня",
    consumable: "Расходник",
    tools:      "Инструменты",
    trophies:   "Трофей",
    ability:    "Способность",
    class:      "Класс",
    race:       "Раса",
    container:  "Контейнер",
  };

  /** Resolve a Race/Creature size or weight key (e.g. "veryLarge") through the lang files
   *  (the GOD.Race.Size... / GOD.Race.Weight... keys), instead of a hardcoded label map. */
  static #localizeBestiaryKey(prefix, key) {
    if (!key) return "—";
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    return game.i18n.localize(`GOD.Race.${prefix}${cap}`);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.document;

    context.actor = actor;
    context.system = actor.system;
    context.charMin = GOD.CHAR_MIN;
    context.charHardMax = GOD.CHAR_HARD_MAX;
    context.combined = this.#prepareCombined();
    context.biography = actor.system.biography ?? {};
    context.portrait = actor.img;
    context.hasCriticalFlaw = Object.values(actor.system.charFlaws ?? {}).some((v) => v >= 3);
    // "chars" is no longer one of the tab-rail's tabs (see tab-rail.hbs) — the
    // characteristics/skills stack now renders unconditionally in its own column
    // (.chars-col, character-sheet.hbs), so the default landing tab is Inventory.
    context.activeTab = this._activeTab || "inventory";
    context.editMode = !!actor.getFlag("god-tactical", "editMode");
    context.raceItem = this.#prepareRaceItem();
    context.classItem = this.#prepareClassItem();

    const HANDS_LABEL       = { main: "Осн.", off: "Не осн.", two: "Две руки", versatile: "Осн./Две руки", verbal: "Вербальный" };
    const SIZE_LABEL        = { small: "Малое", medium: "Среднее", large: "Большое", huge: "Огромное" };
    const TEMPLATE_SHAPE_LABEL = { none: "Нет шаблона", line: "Линия", wideline: "Широкая линия", circle: "Круг", triangle: "Конус", square: "Квадрат" };
    // Bare number in metres, no unit suffix — for the inventory chip, where the "м" is
    // redundant (the chip's own label already reads as a distance/size).
    const _formatMetersValue = (cells) => {
      const m = cellsToMeters(cells);
      return Number.isInteger(m) ? String(m) : m.toFixed(1);
    };
    // Each mode (Настильный/Навесной) is a list of entries — build one chip-ready object per entry.
    const _buildRangeEntries = (sys, mode, modeLabel) => sys[mode].map((entry, idx) => ({
      label:              sys[mode].length > 1 ? `${modeLabel} ${idx + 1}` : modeLabel,
      rangeModifier:      entry.rangeModifier,
      rangeModifierLabel: formatMeters(entry.rangeModifier),
      rangeModifierValue: _formatMetersValue(entry.rangeModifier),
      hasTemplate:        entry.templateShape !== "none",
      templateShapeLabel: TEMPLATE_SHAPE_LABEL[entry.templateShape] ?? entry.templateShape,
      templateSize:       entry.templateSize,
      templateSizeLabel:  formatMeters(entry.templateSize),
      templateSizeValue:  _formatMetersValue(entry.templateSize),
      // Only circle/square have a separate size — every other shape's reach is fully
      // described by rangeModifier alone (see weapon-sheet.mjs's identical buildEntries
      // and module/canvas/weapon-template-drop.mjs).
      hasTemplateSize:    entry.templateShape === "circle" || entry.templateShape === "square",
    }));
    const SKILL_NAME_BY_KEY = Object.fromEntries(
      Object.values(GOD.SKILL_MAP).flatMap((cat) => cat.skills.map((s) => [s.key, s.name]))
    );
    const DAMAGE_TYPE_LABEL = Object.fromEntries(GOD.DAMAGE_TYPES.map((d) => [d.key, d.name]));
    const DAMAGE_NATURE_ABBR = Object.fromEntries(GOD.DAMAGE_NATURES.map((d) => [d.key, d.abbr]));
    // Matches GOD.Item.Trophy.Category* (lang files).
    const TROPHY_CATEGORY_LABEL = {
      luxury: "Предметы роскоши", art: "Искусство", relics: "Реликвии", jewelry: "Украшения",
      antiques: "Антиквариат", living: "Живое", alchemical: "Алхимические",
    };
    const ARCHETYPE_LABEL   = { light: "Лёгкая", heavy: "Тяжёлая" };
    const ARMOR_SUBTYPE_LABEL = Object.fromEntries(GOD.ARMOR_SUBTYPES.map((s) => [s.key, s.name]));
    // GOD.ABILITY_SUBTYPES' own `name` is an internal English tag, not a display label
    // (unlike ARMOR_SUBTYPES above) — the real label lives only as an i18n key
    // (GOD.Ability.Subtype*, see ability-sheet.mjs), so it's hardcoded here to match.
    const ABILITY_SUBTYPE_LABEL = {
      gift: "Гифт",
      tacticalManeuver: "Тактический манёвр",
      simpleManeuver: "Простой манёвр",
    };
    const ACTIVATION_LABEL = { passive: "Пассивная", active: "Активная" };
    // Weapon/Spell/Armor/Ability/Consumable's own activationTypes checkbox group (see
    // items.mjs) — unrelated to ACTIVATION_LABEL above (Ability's separate passive/active
    // field). Matches lang/ru.json's GOD.Item.Activation* labels.
    const ACTIVATION_TYPE_LABEL = {
      permanent: "Перманентная активация", instant: "Подготовка, активация",
      control: "Контроль, активация", closing: "Финал раунда, активация",
    };

    const INV_TYPES     = ["weapon", "armor", "consumable", "tools", "trophies", "container"];
    const FEATURE_TYPES = ["ability", "spell"];
    const CONTAINER_TYPE_LABEL = { deep: "Deep Storage Container", quick: "Quick Slot Container" };

    const allItems = [...actor.items].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map((item) => {
      const entry = {
        id:          item.id,
        name:        item.name,
        img:         item.img,
        type:        item.type,
        typeIcon:    GODActorSheet.#ITEM_ICON[item.type] ?? "fa-box",
        typeLabel:   GODActorSheet.#TYPE_LABEL[item.type] ?? item.type,
        // A number + a single gem icon instead of a colored tier name (see
        // rarity-pips.mjs) — null (not a fallback rank) for item types that don't have a
        // rarity concept: Class/Race (no rarity field at all), Ability (has the field on
        // its schema, but it's never exposed on ability-sheet.hbs and every ability just
        // sits on the unedited default), and Spell (has the field on its schema too, but
        // not exposed on weapon-sheet.hbs either — see its isSpell-gated .ws-rarity
        // block). Only actual equipment carries a meaningful rarity here.
        rarityValue: (item.type !== "ability" && item.type !== "spell" && typeof item.system?.rarity === "number") ? clampRarity(item.system.rarity) : null,
        rarityKey:   item.system?.rarity ?? "",
        containerId: item.system?.containerId ?? "",
        // Spell shares Weapon's exact card (natisk/brosok/hands/damageType/skill — see
        // items.mjs's weaponCardSchema), so it reuses the same inventory meta chips below.
        isWeapon:    item.type === "weapon" || item.type === "spell",
        isArmor:     item.type === "armor",
        isClass:     item.type === "class",
        isRace:      item.type === "race",
        isContainer: item.type === "container",
        isConsumable: item.type === "consumable",
        isTools:     item.type === "tools",
        isTrophy:    item.type === "trophies",
        isAbility:   item.type === "ability",
        // Blank ("") for every type but Ability (which sets it below) — same blank-string
        // convention as containerId above. Drives the per-subtype accent-stripe color
        // (see .inv-card[data-item-subtype] in god-tactical.css).
        subtypeKey:    "",
        // "" for Trophy/Container/Class/Race, which don't have a Features block at all
        // (item.system.features is simply undefined for those types). 2026-08-17: each
        // Features entry now carries its OWN activation stage (items.mjs's
        // featureEntryField) instead of one whole-card checkbox group — this label
        // collects the unique non-blank stages across all of them.
        activationTypesLabel: [...new Set((item.system.features ?? []).map((f) => f.activation).filter(Boolean))]
          .map((k) => ACTIVATION_TYPE_LABEL[k] ?? k).join(", "),
      };
      if (item.type === "class") {
        const sys = item.system;
        // PHY melee/ranged · MPH melee/ranged (see items.mjs's ClassDataModel doc
        // comment on the 4-way base split) — compact chip text, English abbreviations
        // matching GOD.DAMAGE_NATURES' own abbr convention (config.mjs).
        entry.damageSummary    = `PHY ${sys.baseMelee ?? 0}/${sys.baseRanged ?? 0} · MPH ${sys.baseMetaphysicalMelee ?? 0}/${sys.baseMetaphysicalRanged ?? 0}`;
        entry.dodgeSummary     = `${sys.dodgeBase ?? 0}`;
        entry.fortitudeSummary = `${sys.fortitudeBase ?? 0}`;
      }
      if (item.type === "race") {
        const sys = item.system;
        entry.sizeLabel   = GODActorSheet.#localizeBestiaryKey("Size", sys.size);
        entry.weightLabel = GODActorSheet.#localizeBestiaryKey("Weight", sys.weight);
        entry.woundSteps  = sys.woundSteps;
        entry.speed       = sys.speed;
        entry.capacity    = sys.capacity;
      }
      if (item.type === "weapon" || item.type === "spell") {
        const sys = item.system;
        entry.handsLabel      = HANDS_LABEL[sys.hands] ?? "—";
        entry.sizeLabel       = SIZE_LABEL[sys.size] ?? (sys.size || "—");
        entry.damageTypeLabel = DAMAGE_TYPE_LABEL[sys.damageType] ?? "—";
        entry.damageNatureAbbr = DAMAGE_NATURE_ABBR[sys.damageNature] ?? "—";
        entry.skillLabel      = SKILL_NAME_BY_KEY[sys.skill] ?? "";
        // Настильный/Навесной are independent lists — each may hold zero, one, or
        // several entries.
        entry.natiskEntries = _buildRangeEntries(sys, "natisk", "Настильный");
        entry.brosokEntries = _buildRangeEntries(sys, "brosok", "Навесной");
      }
      if (item.type === "ability") {
        const sys = item.system;
        entry.subtypeKey   = sys.subtype;
        entry.subtypeLabel = ABILITY_SUBTYPE_LABEL[sys.subtype] ?? sys.subtype;
        entry.activationLabel = ACTIVATION_LABEL[sys.activation] ?? sys.activation;
      }
      if (item.type === "armor") {
        const sys = item.system;
        entry.archetypeLabel     = ARCHETYPE_LABEL[sys.archetype] ?? sys.archetype;
        entry.subtypeLabel       = ARMOR_SUBTYPE_LABEL[sys.subtype] ?? sys.subtype;
        entry.equipped           = sys.equipped ?? false;
        entry.sizeLabel          = SIZE_LABEL[sys.size] ?? sys.size;
      }
      if (item.type === "consumable" || item.type === "trophies" || item.type === "tools") {
        entry.sizeLabel = SIZE_LABEL[item.system.size] ?? item.system.size;
      }
      if (item.type === "consumable") {
        // Запас (Stock) — current stock-dice chain length / GM-set max, see
        // rolls/consumable-check.mjs's doc comment.
        entry.stockDice = item.system.stockDice;
        entry.stockMax = item.system.stockMax;
      }
      if (item.type === "tools") {
        entry.competency = item.system.competency || "";
      }
      if (item.type === "trophies") {
        entry.categoryLabel = TROPHY_CATEGORY_LABEL[item.system.category] ?? item.system.category;
      }
      if (item.type === "container") {
        const sys = item.system;
        entry.containerTypeLabel = CONTAINER_TYPE_LABEL[sys.containerType] ?? sys.containerType;
        entry.equipped           = sys.equipped ?? false;
        entry.capacity           = sys.capacity;
        entry.occupied           = this.#containerOccupied(item.id);
        entry.color              = sys.color;
        entry.sizeLabel          = SIZE_LABEL[sys.size] ?? sys.size;
        entry.restriction        = sys.restriction || "";
      }
      // Tag storable items that are packed into a container with that container's color,
      // so at a glance you can see what's in what (see #containerOccupied/#STORABLE_TYPES).
      if (GODActorSheet.#STORABLE_TYPES.includes(item.type) && item.system.containerId) {
        const container = actor.items.get(item.system.containerId);
        if (container) {
          entry.containerColor = container.system.color;
          entry.containerName  = container.name;
        }
      }
      return entry;
    });

    // Containers act like folders: whatever's packed into one (system.containerId) is
    // nested under that container's own card (entry.contents) instead of also showing
    // as a separate top-level row — collapsed by default (#onToggleContainerExpand),
    // same as a closed folder showing nothing of what's inside it. `packedIds` is what
    // invItems below excludes; STORABLE_TYPES is the only set of types that can ever
    // carry a containerId in the first place (see items.mjs).
    this._expandedContainers ??= new Set();
    for (const entry of allItems) {
      if (entry.isContainer) {
        entry.expanded = this._expandedContainers.has(entry.id);
        entry.contents = allItems.filter((it) => it.containerId === entry.id);
      }
    }
    const packedIds = new Set(allItems.filter((it) => it.containerId).map((it) => it.id));

    const BIO_TYPES = ["class", "race"];

    const invItems     = allItems.filter((it) => INV_TYPES.includes(it.type) && !packedIds.has(it.id));
    const featureItems = allItems.filter((it) => FEATURE_TYPES.includes(it.type));
    const bioItems     = allItems.filter((it) => BIO_TYPES.includes(it.type));

    context.hasItems      = invItems.length > 0;

    // Always a flat list now (no more grouped-by-type view/toggle) — same items/same
    // global sort order, no per-type split, so drag-reorder (item-reorder.mjs, scoped to
    // siblings within one .inv-list) can freely mix types and a container's own nested
    // list can show everything packed into it as one continuous list instead of split by
    // type. Items are colored by type instead (see .inv-card[data-item-type] in
    // god-tactical.css) so the type is still readable at a glance without an actual
    // group split.
    context.flatItems = invItems;

    context.hasFeatures   = featureItems.length > 0;
    context.flatFeatureItems = featureItems;

    context.flatBioItems = bioItems;
    context.hasBioItems   = bioItems.length > 0;

    context.woundTrack = this.#prepareWoundTrack();
    context.armorLoadout = this.#prepareArmorLoadout();
    context.gritTrack = this.#prepareGritTrack();
    context.effectsMini = this.#prepareEffectsMini();
    context.mezzanine = this.#prepareMezzanine();
    context.carryCapacity = this.#prepareCarryCapacity();
    context.quickConsumables = this.#prepareQuickConsumables();

    return context;
  }

  /* -------------------------------------------- */

  /** The (at most one) Class item attached to this actor — damage/dodge/fortitude/push
   *  triplets and competency tags shown under the portrait. */
  #prepareClassItem() {
    const item = this.document.items.find((it) => it.type === "class");
    if (!item) return null;
    return {
      id: item.id,
      name: item.name,
      baseMelee: item.system.baseMelee,
      baseRanged: item.system.baseRanged,
      baseMetaphysicalMelee: item.system.baseMetaphysicalMelee,
      baseMetaphysicalRanged: item.system.baseMetaphysicalRanged,
      dodgeBase: item.system.dodgeBase,
      fortitudeBase: item.system.fortitudeBase,
      push: item.system.push,
      // Normally already real competency NAMES here — the character builder resolves
      // and copies them onto the actor's own class-item copy at chargen (see
      // GODCharacterBuilder#onFinish). A class dragged straight onto an actor instead
      // (bypassing the builder) still carries its raw GOD.COMPETENCY_GROUPS category
      // KEYS (see class-sheet.mjs's #onPickCompetency) — resolve those to their
      // category's display name here too, so this always shows something readable
      // either way; a value that matches no category key is assumed to already be a
      // real name and passes through unchanged.
      competencies: (item.system.competencies ?? [])
        .map((c) => GOD.COMPETENCY_GROUPS.find((g) => g.key === c)?.name ?? c),
    };
  }

  /** The (at most one) Race item attached to this actor — size/weight/speed/resolve
   *  shown under the portrait. */
  #prepareRaceItem() {
    const item = this.document.items.find((it) => it.type === "race");
    if (!item) return null;
    return {
      id: item.id,
      name: item.name,
      sizeLabel: GODActorSheet.#localizeBestiaryKey("Size", item.system.size),
      weightLabel: GODActorSheet.#localizeBestiaryKey("Weight", item.system.weight),
      speed: item.system.speed,
      resolve: item.system.resolve,
    };
  }

  /** How much of the attached Race's own carrying capacity (system.capacity — see
   *  items.mjs's RaceDataModel) is used up by whatever's sitting loose in the top-level
   *  inventory (not packed into a Container, which already enforces its own capacity
   *  separately). Every #CARRY_WEIGHT_TYPES item costs GOD.ITEM_SIZE_SLOT_COST[size]
   *  slots, same weighting a Container uses for its own contents — except an EQUIPPED
   *  armor piece or container costs nothing (it's worn, not carried loose); unequipped,
   *  it costs like anything else. No race, or a race left at the default 0 capacity,
   *  means no limit at all (hasLimit: false) — this is advisory (over never blocks
   *  anything, just flags red on the Inventory tab), so a GM who hasn't set a race's
   *  capacity yet doesn't suddenly find every character's inventory locked. */
  #prepareCarryCapacity() {
    const raceItem = this.document.items.find((it) => it.type === "race");
    const max = raceItem?.system.capacity ?? 0;
    if (!max) return { hasLimit: false };

    const used = this.document.items
      .filter((it) => GODActorSheet.#CARRY_WEIGHT_TYPES.includes(it.type) && !it.system.containerId)
      .filter((it) => !it.system.equipped)
      .reduce((sum, it) => sum + (GOD.ITEM_SIZE_SLOT_COST[it.system.size] ?? 0), 0);

    return { hasLimit: true, used, max, over: used > max };
  }

  /** Consumables packed into an EQUIPPED Quick Slot Container — shown as a row of
   *  clickable icons in the sheet's topbar (see character-sheet.hbs's .sys-version) for
   *  at-a-glance/at-hand access, e.g. a "Колчан" holding "Стрелы". Deep Storage
   *  containers and unequipped Quick Slot ones don't surface here — same "actively worn"
   *  reasoning as #prepareCarryCapacity's equipped-container exemption. Clicking one (or
   *  the "Проверить" inventory context-menu entry, which works for any consumable
   *  regardless of container) runs the Запас (Stock) wear check — see
   *  rolls/consumable-check.mjs. */
  #prepareQuickConsumables() {
    const quickContainerIds = new Set(
      this.document.items
        .filter((it) => it.type === "container" && it.system.containerType === "quick" && it.system.equipped)
        .map((it) => it.id)
    );
    return this.document.items
      .filter((it) => it.type === "consumable" && quickContainerIds.has(it.system.containerId))
      .map((it) => ({ id: it.id, name: it.name, img: it.img, stockDice: it.system.stockDice, stockMax: it.system.stockMax }));
  }

  /** Build the wound track from shared wound state (race woundSteps). */
  #prepareWoundTrack() {
    const state = computeWoundState(this.document);
    if (!state) return { hasTrack: false };

    return {
      hasTrack: true,
      max: state.max,
      current: state.current,
      incapacitated: state.incapacitated,
      badgeLabel: state.incapacitated ? "НЕДЕЕСПОСОБЕН" : "",
    };
  }

  /** Armor loadout row: one entry per currently-equipped armor piece (up to one per
   *  GOD.ARMOR_SUBTYPES slot). Click toggles the struck-through "broken" flag
   *  (#onArmorPieceClick) — no roll involved, no mechanical effect of its own (armor no
   *  longer carries vulnerabilities or a GRIT bonus either, see ArmorDataModel). The
   *  cuirass is the one exception: it's never breakable (no click at all) and instead
   *  passively feeds CharacterDataModel.prepareDerivedData's system.defense bonus
   *  (Light → +1 Dodge, Heavy → +2 Fortitude) off its own `archetype` field — its
   *  tooltip explains that instead of a broken/repair hint, and its icon renders silver
   *  for Heavy (armor-loadout.hbs's `state-cuirass-heavy`). */
  #prepareArmorLoadout() {
    const pieces = this.document.items
      .filter((it) => it.type === "armor" && it.system.equipped)
      .map((it) => {
        const subtypeMeta = GOD.ARMOR_SUBTYPES.find((s) => s.key === it.system.subtype);
        const subtypeLabel = subtypeMeta?.name ?? it.system.subtype;
        const isCuirass = it.system.subtype === "cuirass";
        const isHeavy = it.system.archetype === "heavy";

        if (isCuirass) {
          const bonusHint = isHeavy ? "+2 к Фортитьюду." : "+1 к Доджу.";
          return {
            id: it.id,
            icon: subtypeMeta?.icon ?? "fa-shield-alt",
            cuirass: true,
            heavy: isHeavy,
            broken: false,
            tooltip: `${it.name} (${subtypeLabel}) — ${bonusHint}`,
          };
        }

        const brokenHint = it.system.broken ? "клик восстановит" : "клик пометит как повреждённую";
        return {
          id: it.id,
          icon: subtypeMeta?.icon ?? "fa-shield-alt",
          cuirass: false,
          heavy: false,
          broken: it.system.broken,
          tooltip: `${it.name} (${subtypeLabel}) — ${brokenHint}.`,
        };
      });
    return { hasArmor: pieces.length > 0, pieces };
  }

  /** "GRIT" cell block: always present for a Character — a flat base pool, see
   *  GOD.BASE_GRIT (armor no longer contributes to it). Falls back to a zeroed shape
   *  (not just {hasGrit:false}) when baseGrit is 0 — the template still renders that in
   *  edit mode (see its own guard) and the max field's RMB needs a real 0 to count up
   *  from. */
  #prepareGritTrack() {
    const grit = getGritCells(this.document);
    if (!grit) return { hasGrit: false, whole: 0, filled: 0, cracked: 0, count: 0, effectiveMax: 0 };

    return { hasGrit: true, ...grit };
  }

  /* -------------------------------------------- */

  /** Per-effect entry shape for the compact mini-box (shared by #prepareEffectsMini()
   *  and the single-row DOM patch — see _patchEffectInsert()). */
  #effectMiniEntry(effect) {
    return {
      id: effect.id,
      name: effect.name,
      img: effect.img,
      disabled: effect.disabled,
      negative: [...effect.statuses].some((id) => GOD.NEGATIVE_STATUS_IDS.has(id)),
    };
  }

  /** Compact effects summary shown in the header, next to name/nickname (see
   *  templates/actor/parts/header-effects.hbs) — the only in-sheet effects UI now that
   *  the Effects tab is gone. Split into temporary/permanent (disabled effects stay in
   *  their natural group, just dimmed) and tags harmful statuses red. */
  #prepareEffectsMini() {
    const groups = { temporary: [], passive: [] };
    for (const effect of this.document.effects) {
      const entry = this.#effectMiniEntry(effect);
      if (effect.isTemporary) groups.temporary.push(entry);
      else groups.passive.push(entry);
    }
    // Passive abilities (activation:"passive" — the default) show up alongside real
    // Active Effects in the same "permanent" group — same blue-border treatment, no
    // actual ActiveEffect document involved (id is item-scoped, not effect-scoped, so
    // the right-click menu — keyed off this.document.effects — is a harmless no-op here).
    for (const item of this.document.items) {
      if (item.type !== "ability") continue;
      if (item.system.activation !== "passive") continue;
      groups.passive.push({ id: item.id, name: item.name, img: item.img, disabled: false, negative: false });
    }
    return groups;
  }

  /** Right-click menu entries for an effects mini-box row — open the effect's own
   *  sheet, or delete it. Shared between the bulk _onRender() bind and the single-row
   *  bind used when patching a newly-inserted row (see _patchEffectInsert()). */
  #effectContextMenuEntries(effectId) {
    const effect = this.document.effects.get(effectId);
    if (!effect) return null;
    return [
      {
        label: "Открыть карточку",
        icon: "fa-pen",
        className: "is-equip",
        onClick: () => effect.sheet?.render(true),
      },
      {
        label: "Удалить",
        icon: "fa-xmark",
        className: "is-remove",
        onClick: () => effect.delete(),
      },
    ];
  }

  /** Insert a newly-created effect's row into the mini-box without a full re-render —
   *  mirrors the render:false + manual-DOM-patch pattern already used for flaw boxes /
   *  wound marks / skill ranks on this sheet, extended to ActiveEffect create/delete (see
   *  the preCreateActiveEffect/preDeleteActiveEffect hooks at the bottom of this file) so
   *  toggling a status from the Token HUD doesn't blow away the sheet's scroll position
   *  with a full re-render. Skips effects created already-disabled — they'll appear on
   *  the next natural render. Icon-only (no name span) — the header strip has no room
   *  for text, the name is available on hover via the tooltip instead. */
  _patchEffectInsert(effect) {
    if (effect.disabled) return;

    const list = this.element.querySelector(
      `.effects-box-section[data-effect-group="${effect.isTemporary ? "temporary" : "passive"}"] .effects-box-list`
    );
    if (!list) return;

    const entry = this.#effectMiniEntry(effect);
    const row = document.createElement("div");
    row.className = `effects-mini-row${entry.negative ? " negative" : ""}${entry.disabled ? " is-disabled" : ""}`;
    row.dataset.effectId = entry.id;
    row.dataset.tooltip = entry.name;
    row.dataset.tooltipDirection = "DOWN";
    row.innerHTML = `<img class="effects-mini-icon" src="${entry.img}" alt="">`;
    list.appendChild(row);
    bindContextMenuOnElement(row, "effectId", this.#effectContextMenuEntries.bind(this));
  }

  /** Remove a deleted effect's row from the mini-box. Counterpart to
   *  _patchEffectInsert() — see the deleteActiveEffect hook at the bottom of this file. */
  _patchEffectRemove(effectId) {
    this.element.querySelector(`.effects-mini-row[data-effect-id="${effectId}"]`)?.remove();
  }

  /* -------------------------------------------- */

  /** Мезонин panel (templates/actor/parts — inlined directly in character-sheet.hbs,
   *  right under the portrait): dice pool boxes plus the 5 drives in their fixed
   *  GOD.MEZZANINE_DRIVES order, each tagged with its current priority rank (or null if
   *  never assigned — e.g. a character built before this feature existed). See
   *  #onMezzanineDriveClick for what a row click actually does. Sorted by priority rank
   *  (1 on top) once assigned — unranked drives (a character built before this feature
   *  existed, or mid-assignment) fall back after them in GOD.MEZZANINE_DRIVES' fixed
   *  order, so the list never jumps around while a rank is still missing. */
  #prepareMezzanine() {
    const order = this.document.system.mezzanine?.order ?? [];
    const dice = this.document.system.mezzanine?.dice ?? 0;
    const max = GOD.MEZZANINE_MAX_DICE;
    const diceBoxes = [];
    for (let i = 0; i < max; i++) diceBoxes.push({ filled: i < dice });
    const drives = GOD.MEZZANINE_DRIVES
      .map((d) => {
        const idx = order.indexOf(d.key);
        const rank = idx >= 0 ? idx + 1 : null;
        return { key: d.key, name: d.name, rank, hint: rank ? mezzaninePriorityDescription(rank) : null };
      })
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    return { dice, max, diceBoxes, canRefill: dice < max, drives };
  }

  /* -------------------------------------------- */

  #prepareCombined() {
    const combined = [];
    let skillNum = 1;
    for (const [catKey, cat] of Object.entries(GOD.SKILL_MAP)) {
      const flaws = this.document.system.charFlaws?.[cat.charKey] ?? 0;
      const flawBoxes = [];
      for (let i = 0; i < 3; i++) {
        flawBoxes.push({ index: i, active: i < flaws });
      }
      // `value` (raw, stored) stays bound to the number input — never inflated by the
      // race bonus, or editing/saving that field would silently bake the bonus in as
      // permanent base points. `rollValue`/`effectiveValue` (base + race bonus, capped at
      // GOD.CHAR_HARD_MAX — see CharacterDataModel#prepareDerivedData) is what skill growth
      // and the char's own roll trigger should use instead.
      const charValue = this.document.system.chars[cat.charKey] ?? GOD.CHAR_MIN;
      const raceBonus = this.document.system.charRaceBonus?.[cat.charKey] ?? 0;
      const effectiveCharValue = this.document.system.charsEffective?.[cat.charKey] ?? charValue;
      const expMarks = this.document.system.charExp?.[cat.charKey] ?? 0;
      const expBoxes = [];
      for (let i = 0; i < 3; i++) {
        expBoxes.push({ index: i, active: i < expMarks });
      }

      const raceBonusFormatted = raceBonus > 0 ? `+${raceBonus}` : String(raceBonus);
      // Cost of the NEXT single point on the RAW (purchasable) value — null once the raw
      // value has itself hit the hard cap, since there's nothing left to buy regardless of
      // what the race-bonus-adjusted effective value shows (see charPointXpCost() in
      // config.mjs — the price tier depends on the value BEFORE that point).
      const nextPointCost = charValue >= GOD.CHAR_HARD_MAX ? null : charPointXpCost(charValue);
      const valueTooltipParts = [];
      if (raceBonus) valueTooltipParts.push(`Базовое значение ${charValue}, бонус расы ${raceBonusFormatted}`);
      if (nextPointCost !== null) valueTooltipParts.push(`Следующее очко: ${nextPointCost} XP`);

      const char = {
        key: cat.charKey,
        name: cat.name,
        css: cat.css,
        desc: cat.desc,
        value: charValue,
        raceBonus,
        raceBonusFormatted,
        rollValue: effectiveCharValue,
        flaws: flaws,
        flawBoxes: flawBoxes,
        expMarks: expMarks,
        expBoxes: expBoxes,
        valueTooltip: valueTooltipParts.join(" · "),
        // At the hard cap the characteristic can't be raised any further via purchase.
        atMax: effectiveCharValue >= GOD.CHAR_HARD_MAX,
      };
      const skills = cat.skills.map((skill) => {
        const rank        = this.document.system.skillRanks?.[skill.key] ?? 0;
        // +1 per occurrence of this skill in the attached Class's skillRankBonuses (see
        // CharacterDataModel#prepareDerivedData) — clamped at 4, same as the base rank field.
        const classBonus  = this.document.system.skillClassBonus?.[skill.key] ?? 0;
        const effectiveRank = Math.min(4, rank + classBonus);
        const value     = this.document.system.skills[skill.key] ?? 0;
        const rankBoxes = [];
        // The first `classBonus` stars (leftmost) are ALWAYS the class's free bonus —
        // fixed in place regardless of the raw purchased rank, so the bonus star never
        // visually "moves" as the player buys ranks (it used to sit right after the raw
        // rank and shift rightward with every purchase, which read as confusing). Stars
        // past that fixed block, up to effectiveRank, are the player's own purchased ranks.
        // Boxes above the current rank that the characteristic can't yet support are
        // `locked` — clicking them is blocked in #onSkillRankClick, and the template dims
        // them and shows `tooltip` explaining the missing prerequisite (see
        // GOD.SKILL_RANK_CHAR_PREREQ).
        for (let i = 1; i <= 4; i++) {
          const prereq = skillRankCharPrereq(i);
          const isBonus = i <= classBonus;
          const locked = i > effectiveRank && effectiveCharValue < prereq;
          let tooltip = `Ранг ${i}`;
          if (locked) tooltip = `Требуется ${cat.name} ${prereq}`;
          else if (isBonus) tooltip = `Ранг ${i} (бонус класса)`;
          rankBoxes.push({ index: i, active: i <= effectiveRank, isBonus, locked, tooltip });
        }
        // What it takes to buy the NEXT rank beyond the current effective one — the
        // characteristic threshold (GOD.SKILL_RANK_CHAR_PREREQ) and the XP price
        // (skillRankRaiseCost, a single step from the current effective rank). null once
        // the skill is already at rank 4 (nothing further to buy).
        let nextRankHint = null;
        if (effectiveRank < 4) {
          const nextRank = effectiveRank + 1;
          const nextPrereq = skillRankCharPrereq(nextRank);
          const nextCost = skillRankRaiseCost(effectiveRank, nextRank);
          const nextLocked = effectiveCharValue < nextPrereq;
          nextRankHint = {
            rank: nextRank,
            cost: nextCost,
            locked: nextLocked,
            tooltip: nextLocked
              ? `Ранг ${nextRank}: нужно ${cat.name} ${nextPrereq} (сейчас ${effectiveCharValue}), ${nextCost} XP`
              : `Ранг ${nextRank}: ${nextCost} XP`,
          };
        }
        return {
          key: skill.key,
          name: skill.name,
          desc: skill.desc,
          charKey: cat.charKey,
          value,
          rank,
          rankBoxes,
          num: String(skillNum++).padStart(2, "0"),
          nextRankHint,
        };
      });
      combined.push({ char, skills });
    }
    return combined;
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender(context, options);

    // Scroll preservation: the tab panes themselves (.tab-pane) never actually scroll —
    // despite their own overflow-y:auto, the real scrollable element is
    // character-sheet.hbs's own root div (.god-tactical.character-sheet, overflow-y:auto)
    // — NOT this.element (the outer <form class="application sheet ...">, which stays
    // overflow:visible and never scrolls at all; a stale claim in a previous version of
    // this comment said otherwise, which is exactly why this was still visibly resetting
    // scroll on every full render despite this block's existence — it was tracking a node
    // that can never scroll). The "sheet" PART's root node can in principle get replaced
    // wholesale by Foundry across renders, so re-find it and check ITS OWN dataset flag
    // (not a this-instance flag, which would wrongly say "already bound" for a brand new
    // node) every time, rather than assuming one binding outlives every future render.
    // Track scrollTop continuously and forcibly re-apply the last known value a frame
    // after every render — this doesn't depend on catching the "right" synchronous moment
    // relative to whatever triggered the render.
    const scrollRoot = this.element.querySelector(".character-sheet") ?? this.element;
    if (!scrollRoot.dataset.godScrollBound) {
      scrollRoot.dataset.godScrollBound = "1";
      scrollRoot.addEventListener("scroll", () => {
        this._liveScroll = scrollRoot.scrollTop;
      });
    }
    requestAnimationFrame(() => {
      if (this._liveScroll) scrollRoot.scrollTop = this._liveScroll;
    });

    // Edit toggle injected into window header (pencil ↔ check)
    const editMode = !!this.document.getFlag("god-tactical", "editMode");
    GODActorSheet.injectEditToggle(this.element, editMode, async () => {
      await this.document.setFlag("god-tactical", "editMode", !editMode);
    });
    GODActorSheet.applyEditLock(this.element, editMode);

    // Character Builder launch button — DISABLED (2026-08-19 characteristic restructure,
    // GM call): the builder still walks the retired 4-characteristic/16-skill layout and
    // hasn't been updated for the new Корпус roster yet, so its entry point is pulled for
    // now rather than left reachable and broken. character-builder.mjs itself is untouched
    // (not deleted) — re-enable by restoring this call once the builder's chargen math is
    // updated for the new skill map.
    // GODActorSheet.injectBuilderButton(this.element, () => {
    //   GODCharacterBuilder.open(this.document);
    // });

    // Tooltip on/off toggle (see module/sheets/tooltip-toggle.mjs) — client-wide, not
    // per-actor, but injected here same as the other header buttons above.
    injectTooltipToggleButton(this.element);

    // "+" in the ИНВЕНТАРЬ/СПОСОБНОСТИ section headers (same markup/style as the NPC
    // sheet's) — build a brand-new blank Item straight on the actor (weapon/armor/etc.,
    // or an ability preset to Дар/Простой манёвр/Тактический манёвр), the second way to
    // get an Item onto the sheet besides dragging one in from a compendium.
    this.element.querySelectorAll(".npc-section-add-btn").forEach((btn) => {
      btn.addEventListener("click", (event) => showCreateItemMenu(this.document, event));
    });

    // Competency chips (edit mode): "+" opens a popup of not-yet-taken competency names
    // (flattened GOD.COMPETENCY_GROUPS, "Категория · Компетенция" labels); the × on each
    // chip removes it. Both write straight to the attached Class item's own
    // system.competencies — see #onPickCompetency/#onRemoveCompetency below.
    this.element.querySelectorAll(".comp-chip-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveCompetency.bind(this));
    });
    this.element.querySelector(".comp-add-btn")?.addEventListener("click", this.#onPickCompetency.bind(this));

    // Flaw box clicks
    this.element.querySelectorAll(".flaw-box").forEach((box) => {
      box.addEventListener("click", this.#onFlawClick.bind(this));
    });

    // Мезонин panel — drive rows (reorder priority in edit mode, else fire a reroll) and
    // the dice refill button.
    this.element.querySelectorAll(".mz-drive-row").forEach((row) => {
      row.addEventListener("click", this.#onMezzanineDriveClick.bind(this));
    });
    this.element.querySelector(".mz-dice-refill")?.addEventListener("click", this.#onMezzanineRefillClick.bind(this));

    // Characteristic experience-marker clicks
    this.element.querySelectorAll(".char-exp-mark").forEach((mark) => {
      mark.addEventListener("click", this.#onCharExpClick.bind(this));
    });

    // Жизни counter: LMB on the whole-value takes one wound, RMB restores one — see
    // #onWoundLoseClick/#onWoundRestoreClick.
    this.element.querySelector(".wound-counter-value")?.addEventListener("click", this.#onWoundLoseClick.bind(this));
    this.element.querySelector(".wound-counter-value")?.addEventListener("contextmenu", this.#onWoundRestoreClick.bind(this));

    // Incapacitated glow lives on .grit-track, not .wound-track (see #syncIncapacitatedGlow) —
    // this template only sets .grit-track's own state via gritTrack, so it's synced in JS.
    this.#syncIncapacitatedGlow(!!context.woundTrack?.incapacitated);

    // GRIT counter: LMB/RMB on the whole-value spends/restores one point; LMB/RMB on the
    // max field burns/repairs one cell (the max FIELD itself shows the reduced ceiling,
    // no separate "cracked" indicator) — see #onGritWholeClick/#onGritWholeContextMenu/
    // #onGritBurnClick/#onGritRepairClick.
    this.element.querySelector(".grit-counter-value")?.addEventListener("click", this.#onGritWholeClick.bind(this));
    this.element.querySelector(".grit-counter-value")?.addEventListener("contextmenu", this.#onGritWholeContextMenu.bind(this));
    this.element.querySelector(".grit-counter-max")?.addEventListener("click", this.#onGritBurnClick.bind(this));
    this.element.querySelector(".grit-counter-max")?.addEventListener("contextmenu", this.#onGritRepairClick.bind(this));

    // Edit-mode "+"/"-" buttons: raise/lower the GRIT/Жизни MAX by one (system.baseGrit,
    // or the attached race item's system.woundSteps) — see #onGritMaxAddClick/
    // #onGritMaxSubtractClick/#onWoundMaxAddClick/#onWoundMaxSubtractClick.
    this.element.querySelector(".grit-max-add")?.addEventListener("click", this.#onGritMaxAddClick.bind(this));
    this.element.querySelector(".grit-max-sub")?.addEventListener("click", this.#onGritMaxSubtractClick.bind(this));
    this.element.querySelector(".wound-max-add")?.addEventListener("click", this.#onWoundMaxAddClick.bind(this));
    this.element.querySelector(".wound-max-sub")?.addEventListener("click", this.#onWoundMaxSubtractClick.bind(this));

    // Armor loadout piece: click toggles the struck-through "broken" visual (see
    // #prepareArmorLoadout's doc comment — a cuirass piece (data-cuirass) skips this
    // bind entirely, it's never breakable).
    this.element.querySelectorAll(".armor-loadout-piece:not([data-cuirass])").forEach((piece) => {
      piece.addEventListener("click", this.#onArmorPieceClick.bind(this));
    });
    // The cuirass piece has no toggle of its own, but the whole strip now renders inside
    // .portrait (see .topbar-portrait in character-sheet.hbs) — without this, clicking it
    // would bubble up into .portrait's own click handler and pop the image FilePicker.
    this.element.querySelectorAll(".armor-loadout-piece[data-cuirass]").forEach((piece) => {
      piece.addEventListener("click", (event) => event.stopPropagation());
    });

    // Skill rank pip clicks
    this.element.querySelectorAll(".skill-rank-mark").forEach((mark) => {
      mark.addEventListener("click", this.#onSkillRankClick.bind(this));
    });

    // Skill roll clicks (name and roll arrow)
    this.element.querySelectorAll("[data-action='roll-skill']").forEach((el) => {
      el.addEventListener("click", this.#onSkillRollClick.bind(this));
    });

    // Char roll clicks (heading name and value badge)
    this.element.querySelectorAll("[data-action='roll-char']").forEach((el) => {
      el.addEventListener("click", this.#onCharRollClick.bind(this));
    });

    // Portrait click → FilePicker
    const portrait = this.element.querySelector(".portrait");
    if (portrait) {
      portrait.addEventListener("click", this.#onPortraitClick.bind(this));
    }

    // Tabs
    this.element.querySelectorAll(".tab[data-tab]").forEach((tab) => {
      tab.addEventListener("click", this.#onTabClick.bind(this));
    });

    // Number inputs — intercept change to clamp values and fix img before the form submits
    this.element.querySelectorAll('input[type="number"]').forEach((input) => {
      input.addEventListener("change", this.#onNumberInputChange.bind(this));
    });

    // Inventory: right-click a card → open / add to action log / equip armor / remove.
    // Opening is context-menu-only now — the whole card is a plain drag target, no
    // click/dblclick sub-area competing with drag-and-drop.
    bindInventoryContextMenu(this.element, (itemId) => {
      const item = this.document.items.get(itemId);
      if (!item) return null;

      const entries = [{
        label: "Открыть",
        icon: "fa-pen",
        className: "is-equip",
        onClick: () => item.sheet?.render(true),
      }];

      if (item.type === "armor") {
        entries.push({
          label: item.system.equipped ? "Снять броню" : "Надеть броню",
          icon: "fa-shield-alt",
          className: `is-equip${item.system.equipped ? " is-active" : ""}`,
          onClick: () => this.#onToggleArmorEquip(fakeItemEvent(itemId)),
        });
      }

      // Any Consumable, regardless of container — the quick-consumable icon strip
      // (topbar) only ever surfaces the ones in an equipped Quick Slot Container, this
      // works from anywhere (see rolls/consumable-check.mjs).
      if (item.type === "consumable") {
        entries.push({
          label: "Проверить",
          icon: "fa-dice",
          className: "is-equip",
          onClick: () => checkConsumable(this.document, item),
        });
      }

      if (item.type === "container") {
        entries.push({
          label: item.system.equipped ? "Снять контейнер" : "Экипировать контейнер",
          icon: "fa-backpack",
          className: `is-equip${item.system.equipped ? " is-active" : ""}`,
          onClick: () => this.#onToggleContainerEquip(fakeItemEvent(itemId)),
        }, {
          label: this._expandedContainers?.has(itemId) ? "Свернуть" : "Развернуть",
          icon: this._expandedContainers?.has(itemId) ? "fa-chevron-down" : "fa-chevron-right",
          className: "is-equip",
          onClick: () => this.#onToggleContainerExpand(itemId),
        });
      }

      if (GODActorSheet.#STORABLE_TYPES.includes(item.type)) {
        if (item.system.containerId) {
          entries.push({
            label: "Достать из контейнера",
            icon: "fa-box-open",
            className: "is-equip",
            // A real render (not the usual render:false + DOM patch) — the item now
            // needs to actually move from nested-inside-the-container-card back to a
            // top-level row (see #onToggleContainerExpand's doc comment), not just lose
            // a color tag in place.
            onClick: () => item.update({ "system.containerId": null }),
          });
        } else {
          const equippedContainers = this.document.items.filter((it) =>
            it.type === "container" && it.system.equipped && GODActorSheet.#itemAllowedInContainer(item.name, it)
          );
          if (equippedContainers.length) {
            entries.push({
              label: "Поместить в контейнер",
              icon: "fa-backpack",
              className: "is-equip",
              onClick: () => this.#onPlaceInContainer(itemId, equippedContainers),
            });
          }
        }
      }

      entries.push({
        label: "Удалить",
        icon: "fa-xmark",
        className: "is-remove",
        onClick: () => this.#onRemoveItem(fakeItemEvent(itemId)),
      });

      return entries;
    });

    // Container "folder" chevron — left-click as a quicker alternative to the
    // right-click "Развернуть"/"Свернуть" menu entry above. stopPropagation so it never
    // also starts a card drag (the whole card is draggable="true").
    this.element.querySelectorAll(".inv-container-toggle[data-item-id]").forEach((toggle) => {
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#onToggleContainerExpand(toggle.dataset.itemId);
      });
    });

    // Quick-consumable icon strip (topbar) — click to run the depletion check (see
    // rolls/consumable-check.mjs). Same action as the inventory's "Проверить" context-
    // menu entry, just one click away for whatever's in an equipped Quick Slot Container.
    this.element.querySelectorAll(".quick-consumable-icon[data-item-id]").forEach((el) => {
      el.addEventListener("click", (event) => {
        event.preventDefault();
        const item = this.document.items.get(el.dataset.itemId);
        if (item) checkConsumable(this.document, item);
      });
    });

    // Effects mini-box (left column): right-click → open effect sheet / delete
    bindContextMenu(this.element, ".effects-mini-row[data-effect-id]", "effectId", this.#effectContextMenuEntries.bind(this));

    // Tag weapon (and spell — same card, see items.mjs's weaponCardSchema) cards for
    // weapon-specific styling
    this.element.querySelectorAll('.inv-card[data-item-id]').forEach((card) => {
      const item = this.document.items.get(card.dataset.itemId);
      if (item?.type === "weapon" || item?.type === "spell") card.classList.add("inv-weapon-row");
    });

    // Drag-drop zones: inventory, features, biography (class/race). ActiveEffect drops
    // are accepted on any of these — see #onDropItem — since there's no effects-specific
    // pane; the compact mini-box handles all effect management via right-click.
    for (const selector of ['.tab-pane[data-tab="inventory"]', '.tab-pane[data-tab="abilities"]', '.tab-pane[data-tab="biography"]']) {
      const pane = this.element.querySelector(selector);
      if (pane) {
        pane.addEventListener("dragover", (e) => { e.preventDefault(); pane.classList.add("drag-over"); });
        pane.addEventListener("dragleave", () => pane.classList.remove("drag-over"));
        pane.addEventListener("drop", this.#onDropItem.bind(this));
      }
    }

    // Reorder: drag an item/ability card onto another one in the same list to swap places
    bindInventoryReorder(this.element, this.document);

    // Equipped containers as drop targets: drag any item straight onto one — from this
    // actor's own inventory, or fresh from a compendium/sidebar — to pack it in, instead
    // of the right-click "Поместить в контейнер" round-trip.
    this.#bindContainerDropTargets();

    // Inventory search. State persists on the sheet instance (not just the DOM) so a
    // re-render triggered by something else — e.g. dragging a card to reorder it —
    // doesn't silently drop whatever the user had typed.
    this._invSearchState ??= {};
    bindInventorySearch(this.element, this._invSearchState);

    // Abilities search — same mechanics as Inventory's above, own state/bar (see
    // item-search.mjs).
    this._featureSearchState ??= {};
    bindAbilitySearch(this.element, this._featureSearchState);

  }

  /* -------------------------------------------- */

  static async #onSubmitForm(event, form, formData) {
    const actor = this.document;
    const updates = { ...formData.object };

    // Never touch portrait/token through form submission — it's handled by #onPortraitClick
    delete updates.img;
    delete updates["prototypeToken.texture.src"];

    // Never overwrite array fields managed by custom handlers (inventory, perks, effects)
    const protectedPaths = ["system.inventory", "system.perks", "system.statusEffects", "system.controlEffects"];
    for (const path of protectedPaths) {
      if (path in updates) delete updates[path];
      // Also protect nested paths like system.inventory.0 etc.
      for (const key of Object.keys(updates)) {
        if (key.startsWith(path + ".") || key === path) delete updates[key];
      }
    }

    // Normalize empty number fields back to schema defaults and clamp ranges
    for (const key of Object.keys(updates)) {
      if (key.startsWith("system.chars.")) {
        const val = parseInt(updates[key], 10);
        if (updates[key] === "" || updates[key] == null || Number.isNaN(val)) {
          updates[key] = GOD.CHAR_MIN;
        } else {
          updates[key] = Math.max(GOD.CHAR_MIN, Math.min(GOD.CHAR_HARD_MAX, val));
        }
      }
    }

    try {
      await actor.update(updates);
    } catch (err) {
      console.warn("Actor update failed, forcing default portrait...", err);
      await actor.update({
        img: "icons/svg/mystery-man.svg",
        "prototypeToken.texture.src": "icons/svg/mystery-man.svg"
      });
      await actor.update(updates);
    }
  }

  /* -------------------------------------------- */

  async #onFlawClick(event) {
    event.stopPropagation();
    const charKey = event.currentTarget.dataset.char;
    const index = parseInt(event.currentTarget.dataset.index, 10);
    const current = this.document.system.charFlaws[charKey] ?? 0;
    const target = current === index + 1 ? 0 : index + 1;

    await this.document.update({ [`system.charFlaws.${charKey}`]: target }, { render: false });

    // Manually update flaw box visuals without re-rendering the whole sheet
    const boxes = this.element.querySelectorAll(`.flaw-box[data-char="${charKey}"]`);
    boxes.forEach((box, i) => {
      box.classList.toggle('active', i < target);
    });

    // Update critical portrait state (B&W + overlay)
    const hasCriticalFlaw = Object.values(this.document.system.charFlaws).some((v) => v >= 3);
    const portrait = this.element.querySelector('.portrait');
    if (portrait) portrait.classList.toggle('critical-state', hasCriticalFlaw);

    // Chat alert when the 3rd flaw is marked
    if (target === 3) {
      const catEntry = Object.values(GOD.SKILL_MAP).find((c) => c.charKey === charKey);
      const charName = catEntry?.name || charKey;
      const content = `
        <div class="god-flaw-critical">
          <div class="flaw-header">КРИТИЧЕСКОЕ ПОВРЕЖДЕНИЕ</div>
          <div class="flaw-title">${this.document.name} — НЕДЕЕСПОСОБЕН</div>
          <div class="flaw-sub">${charName}: максимум помех (3/3)</div>
        </div>
      `;
      ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.document }),
        content,
        style: CONST.CHAT_MESSAGE_STYLES.EMOTE,
      });
    }
  }

  /* -------------------------------------------- */

  /** Мезонин drive row click — dual purpose, split by the sheet's global edit-mode flag
   *  (same "editing the anketa vs. playing" split already used for skill ranks/chars):
   *  in edit mode, clicking reorders priority (click an unranked drive to append it as
   *  the next priority, click an already-ranked one to remove it and close the gap —
   *  same model as GODCharacterBuilder's drive-priority step); outside edit mode, it
   *  fires an actual Мезонин reroll against the actor's most recent eligible failed
   *  skill check (applyMezzanine(), roll-dialog.mjs) — a big enough action (new roll,
   *  new chat card, dice count changes) that a full render is fine there. The edit-mode
   *  reorder, though, is a quiet toggle like charFlaws/charExp/wounds elsewhere on this
   *  sheet — render:false + DOM patch, same reasoning: the sheet's scrollable element is
   *  the WHOLE root (this.element, not a per-panel container — see _onRender's
   *  scroll-preservation comment), so even though this panel sits at the top, a full
   *  render here still snaps the CURRENTLY VIEWED tab's scroll back to the top. */
  #onMezzanineDriveClick(event) {
    const driveKey = event.currentTarget.dataset.drive;
    const editMode = !!this.document.getFlag("god-tactical", "editMode");
    if (editMode) {
      const order = foundry.utils.deepClone(this.document.system.mezzanine?.order ?? []);
      const idx = order.indexOf(driveKey);
      if (idx >= 0) order.splice(idx, 1);
      else if (order.length < GOD.MEZZANINE_DRIVES.length) order.push(driveKey);
      this.document.update({ "system.mezzanine.order": order }, { render: false });
      this.#patchMezzanineDrives(order);
      return;
    }
    applyMezzanine(this.document, driveKey);
  }

  /** Re-sorts the Мезонин drive rows by the new priority order and refreshes each row's
   *  rank badge/tooltip in place — same DOM shape/sort as #prepareMezzanine (ranked
   *  drives first in priority order, then unranked ones in GOD.MEZZANINE_DRIVES' fixed
   *  order). */
  #patchMezzanineDrives(order) {
    const list = this.element.querySelector(".mz-drive-list");
    if (!list) return;
    const rows = new Map([...list.querySelectorAll(".mz-drive-row")].map((r) => [r.dataset.drive, r]));
    const unranked = GOD.MEZZANINE_DRIVES.map((d) => d.key).filter((k) => !order.includes(k));
    for (const key of [...order, ...unranked]) {
      const row = rows.get(key);
      if (!row) continue;
      list.appendChild(row);
      const rank = order.indexOf(key) + 1 || null;
      const rankEl = row.querySelector(".mz-drive-rank");
      if (rankEl) {
        rankEl.textContent = rank ? String(rank) : "—";
        rankEl.classList.toggle("unset", !rank);
      }
      row.dataset.tooltip = rank
        ? `Приоритет ${rank} — ${mezzaninePriorityDescription(rank)}`
        : "Приоритет не задан — назначьте в режиме редактирования листа";
    }
  }

  /** Manual "+1 die" button — there's no narrative Мезонин-recovery mechanic defined yet
   *  (per the design discussion this feature was built from), so this is the only way to
   *  refill the pool for now. Capped at GOD.MEZZANINE_MAX_DICE; hidden by the template
   *  once full. render:false + DOM patch, same reasoning as #onMezzanineDriveClick's
   *  edit-mode reorder above — this used to be a full render() and was the main visible
   *  case of the sheet's scroll snapping back on a quiet toggle. */
  async #onMezzanineRefillClick() {
    const dice = this.document.system.mezzanine?.dice ?? 0;
    if (dice >= GOD.MEZZANINE_MAX_DICE) return;
    const next = dice + 1;
    await this.document.update({ "system.mezzanine.dice": next }, { render: false });
    this.element.querySelectorAll(".mz-dice-box").forEach((box, i) => {
      box.classList.toggle("filled", i < next);
    });
    if (next >= GOD.MEZZANINE_MAX_DICE) this.element.querySelector(".mz-dice-refill")?.remove();
  }

  /* -------------------------------------------- */

  /** Experience-marker click (0–3 per characteristic, three separate cross marks) —
   *  checked off by the player, e.g. once XP has been spent raising it. Same
   *  click-a-box-to-set-the-level-there / click-the-top-filled-box-to-clear behavior as
   *  #onFlawClick above. render:false + manual DOM patch, same pattern as flaw boxes /
   *  wound marks / skill ranks elsewhere on this sheet, so toggling it never resets the
   *  sheet's scroll. */
  async #onCharExpClick(event) {
    event.stopPropagation();
    const charKey = event.currentTarget.dataset.char;
    const index = parseInt(event.currentTarget.dataset.index, 10);
    const current = this.document.system.charExp?.[charKey] ?? 0;
    const target = current === index + 1 ? 0 : index + 1;

    await this.document.update({ [`system.charExp.${charKey}`]: target }, { render: false });

    const marks = this.element.querySelectorAll(`.char-exp-mark[data-char="${charKey}"]`);
    marks.forEach((mark, i) => {
      mark.classList.toggle("active", i < target);
    });

    const heading = marks[0]?.closest(".char-heading");
    const glow = heading?.querySelector(".char-exp-glow");
    if (target > 0 && !glow && heading) {
      const el = document.createElement("div");
      el.className = "char-exp-glow";
      el.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 8; i++) {
        const spark = document.createElement("span");
        spark.className = "spark";
        el.appendChild(spark);
      }
      heading.appendChild(el);
    } else if (target === 0 && glow) {
      glow.remove();
    }
  }

  /* -------------------------------------------- */

  /** Skill rank pips (0–5, shown as 5 marks representing the EFFECTIVE rank — raw
   *  purchased rank plus the class's free bonus, see skillClassBonus). Click a pip to jump
   *  the effective rank straight to it; click the pip that's already the current effective
   *  rank to step the RAW rank down by one (floored at 0 — you can't sell back what the
   *  class grants for free). Raising is a purchase: it requires the linked characteristic
   *  to meet GOD.SKILL_RANK_CHAR_PREREQ for the TARGET effective rank, and spends
   *  system.xp.value per GOD.SKILL_RANK_XP_COST, priced off the current EFFECTIVE rank —
   *  e.g. a base rank 1 with a +1 class bonus already reads as effective rank 2, so buying
   *  up to effective rank 3 only charges rank 3's own step price, not ranks 2 and 3 both
   *  (see skillRankRaiseCost()). Lowering stays free and never refunds XP. Saved with
   *  render:false and patched by hand (like the flaw boxes) so a full re-render never
   *  happens — that's what was resetting the tab's scroll to the top on every click. */
  async #onSkillRankClick(event) {
    event.stopPropagation();
    const skillKey = event.currentTarget.dataset.skill;
    const charKey  = event.currentTarget.dataset.char;
    const index    = parseInt(event.currentTarget.dataset.index, 10);
    const current       = this.document.system.skillRanks?.[skillKey] ?? 0;
    const classBonus    = this.document.system.skillClassBonus?.[skillKey] ?? 0;
    const currentEffective = Math.min(4, current + classBonus);

    const newRaw = currentEffective === index ? Math.max(0, current - 1) : Math.max(0, index - classBonus);
    if (newRaw === current) return;

    const newEffective = Math.min(4, newRaw + classBonus);
    const update = { [`system.skillRanks.${skillKey}`]: newRaw };

    if (newEffective > currentEffective) {
      const effectiveCharValue = this.document.system.charsEffective?.[charKey] ?? 0;
      const prereq = skillRankCharPrereq(newEffective);
      if (effectiveCharValue < prereq) {
        const catEntry = Object.values(GOD.SKILL_MAP).find((c) => c.charKey === charKey);
        ui.notifications.warn(`Требуется ${catEntry?.name ?? charKey} ${prereq}`);
        return;
      }

      const cost = skillRankRaiseCost(currentEffective, newEffective);
      const xpAvailable = this.document.system.xp?.value ?? 0;
      if (cost > xpAvailable) {
        ui.notifications.warn(`Недостаточно XP: нужно ${cost}, доступно ${xpAvailable}`);
        return;
      }

      update["system.xp.value"] = xpAvailable - cost;
    }

    await this.document.update(update, { render: false });

    // DOM update AFTER await — document now holds the confirmed rank + derived value
    // (prepareDerivedData runs on every update regardless of the sheet's render option).
    const confirmedRank = this.document.system.skillRanks?.[skillKey] ?? newRaw;
    // Same class-bonus math as #prepareCombined — the patched stars must stay consistent
    // with a full re-render's rankBoxes (base rank + class bonus, capped at 4).
    const effectiveRank = Math.min(4, confirmedRank + classBonus);
    const value = this.document.system.skills?.[skillKey] ?? 0;

    const catEntry = Object.values(GOD.SKILL_MAP).find((c) => c.charKey === charKey);
    const effectiveCharValue = this.document.system.charsEffective?.[charKey] ?? 0;

    const marks = this.element.querySelectorAll(`.skill-rank-mark[data-skill="${skillKey}"]`);
    marks.forEach((m, i) => {
      const boxRank = i + 1;
      // The first `classBonus` stars are the fixed bonus block — see #prepareCombined.
      const boxIsBonus = boxRank <= classBonus;
      m.classList.toggle("filled", boxRank <= effectiveRank);
      m.classList.toggle("bonus", boxIsBonus);
      const boxPrereq = skillRankCharPrereq(boxRank);
      const boxLocked = boxRank > effectiveRank && effectiveCharValue < boxPrereq;
      m.classList.toggle("locked", boxLocked);
      let tooltip = `Ранг ${boxRank}`;
      if (boxLocked) tooltip = `Требуется ${catEntry?.name ?? charKey} ${boxPrereq}`;
      else if (boxIsBonus) tooltip = `Ранг ${boxRank} (бонус класса)`;
      m.dataset.tooltip = tooltip;
    });

    const skillRow = this.element.querySelector(`.skill[data-skill="${skillKey}"]`);
    if (skillRow) {
      const nameEl = skillRow.querySelector(".name");
      if (nameEl) nameEl.dataset.value = value;
      const valEl = skillRow.querySelector(".val");
      if (valEl) {
        valEl.textContent = value;
        valEl.classList.toggle("hi", value >= 60);
      }

      const hintEl = skillRow.querySelector(".skill-next-hint");
      if (hintEl) {
        if (effectiveRank < 4) {
          const nextRank = effectiveRank + 1;
          const nextPrereq = skillRankCharPrereq(nextRank);
          const nextCost = skillRankRaiseCost(effectiveRank, nextRank);
          const nextLocked = effectiveCharValue < nextPrereq;
          hintEl.textContent = `Р${nextRank}: ${nextCost}XP`;
          hintEl.dataset.tooltip = nextLocked
            ? `Ранг ${nextRank}: нужно ${catEntry?.name ?? charKey} ${nextPrereq} (сейчас ${effectiveCharValue}), ${nextCost} XP`
            : `Ранг ${nextRank}: ${nextCost} XP`;
          hintEl.classList.toggle("locked", nextLocked);
          hintEl.style.display = "";
        } else {
          hintEl.style.display = "none";
        }
      }
    }

    this.#patchXpDisplay();
  }

  /** Reflect the actor's current system.xp.value into the topbar readout without a full
   *  re-render — same manual-DOM-patch pattern as the rank/flaw handlers above, used after
   *  any purchase that spends XP (#onSkillRankClick, #onNumberInputChange). */
  #patchXpDisplay() {
    const el = this.element.querySelector(".xp-value");
    if (el) el.value = this.document.system.xp?.value ?? 0;
  }

  /* -------------------------------------------- */

  /** LMB on the Жизни whole-value: takes one wound (push "hit" onto system.wounds),
   *  clamped at the species' own woundSteps. Posts the incapacitation chat card once
   *  the ladder fills — same trigger the old per-heart click had, just off a plain
   *  push instead of an index jump (2026-08-24, numeric-counter redesign — mirrors
   *  GRIT's own #onGritWholeClick, but Жизни has no "burn" concept, see wounds.mjs's
   *  computeWoundState doc comment). */
  async #onWoundLoseClick(event) {
    event.stopPropagation();
    const raceItem = this.document.items.find((it) => it.type === "race");
    const max = raceItem?.system.woundSteps ?? 1;
    const wounds = foundry.utils.deepClone(this.document.system.wounds ?? []);
    if (wounds.length >= max) return;

    wounds.push("hit");
    await this.document.update({ "system.wounds": wounds }, { render: false });
    await this.#patchWoundTrack();

    if (wounds.length >= max) {
      const content = `
        <div class="god-flaw-critical">
          <div class="flaw-header">ВСЕ ЖИЗНИ ПОТЕРЯНЫ</div>
          <div class="flaw-title">${this.document.name} — НЕДЕЕСПОСОБЕН</div>
        </div>
      `;
      ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.document }),
        content,
        style: CONST.CHAT_MESSAGE_STYLES.EMOTE,
      });
    }
  }

  /** RMB on the Жизни whole-value: restores one wound (pop the last entry off
   *  system.wounds). */
  async #onWoundRestoreClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const wounds = foundry.utils.deepClone(this.document.system.wounds ?? []);
    if (!wounds.length) return;

    wounds.pop();
    await this.document.update({ "system.wounds": wounds }, { render: false });
    await this.#patchWoundTrack();
  }

  /* -------------------------------------------- */

  /** LMB on the GRIT whole-value: spends one point (gritFilled + 1), clamped so it
   *  never eats into cells already cracked. */
  async #onGritWholeClick(event) {
    event.stopPropagation();
    const grit = getGritCells(this.document);
    if (!grit) return;
    const filled = this.document.system.gritFilled ?? 0;
    const next = Math.min(grit.count - grit.cracked, filled + 1);
    if (next === filled) return;
    playSound("systems/god-tactical/assets/sounds/armor-hit.mp3");
    shakeElement(this.element.querySelector(".portrait"));
    await this.document.update({ "system.gritFilled": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** RMB on the GRIT whole-value: restores one spent point (gritFilled - 1). */
  async #onGritWholeContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const filled = this.document.system.gritFilled ?? 0;
    const next = Math.max(0, filled - 1);
    if (next === filled) return;
    playSound("systems/god-tactical/assets/sounds/armor-restore.mp3");
    sparkRepair(this.element.querySelector(".portrait"));
    await this.document.update({ "system.gritFilled": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** LMB on the GRIT max: burns one more cell permanently (gritCracked + 1) — the max
   *  FIELD itself shows the reduced ceiling (effectiveMax = count - cracked in
   *  getGritCells), no separate indicator (2026-08-24: folded the old standalone
   *  cracked badge's mechanic straight onto this field, per user feedback — book flavor
   *  is "burned", not "cracked"). Anchored to the LEFT edge, never touches gritFilled. */
  async #onGritBurnClick(event) {
    event.stopPropagation();
    const grit = getGritCells(this.document);
    if (!grit) return;
    const cracked = this.document.system.gritCracked ?? 0;
    const next = Math.min(grit.count, cracked + 1);
    if (next === cracked) return;
    playSound("systems/god-tactical/assets/sounds/armor-crack.mp3");
    shakeElement(this.element.querySelector(".portrait"));
    await this.document.update({ "system.gritCracked": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** RMB on the GRIT max: repairs one burned cell (gritCracked - 1), raising the
   *  displayed max back up. */
  async #onGritRepairClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const cracked = this.document.system.gritCracked ?? 0;
    const next = Math.max(0, cracked - 1);
    if (next === cracked) return;
    playSound("systems/god-tactical/assets/sounds/armor-restore.mp3");
    sparkRepair(this.element.querySelector(".portrait"));
    await this.document.update({ "system.gritCracked": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** Edit-mode "+" on the GRIT block: raises the Character's own RAW base pool
   *  (system.baseGrit, GOD.BASE_GRIT's per-actor override) by one — the only lever for
   *  a GM to hand a character a bigger pool than the default 9. Deliberately edit-mode
   *  only (2026-08-24, reverted from a brief always-live version): resizing the pool
   *  itself is a character-build decision, not a play-time action like burning/spending
   *  a point is — per user feedback, "зачем мне отдельно менять максимум... не в
   *  редакторе листа, мне не понятно." */
  async #onGritMaxAddClick(event) {
    event.stopPropagation();
    const next = (this.document.system.baseGrit ?? 0) + 1;
    await this.document.update({ "system.baseGrit": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** Edit-mode "-" on the GRIT block — same lever as #onGritMaxAddClick, opposite
   *  direction, clamped at the field's own schema min (0, data-models.mjs). getGritCells
   *  (wounds.mjs) already clamps gritFilled/gritCracked down to whatever the new, smaller
   *  count allows when building the display, so a max drop below either never needs a
   *  separate fixup here. */
  async #onGritMaxSubtractClick(event) {
    event.stopPropagation();
    const next = Math.max(0, (this.document.system.baseGrit ?? 0) - 1);
    await this.document.update({ "system.baseGrit": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** Re-render just the "GRIT" block after a whole/max/crack change, instead of the
   *  whole sheet (see the render:false calls in #onGritWholeClick/#onGritWholeContextMenu/
   *  #onGritBurnClick/#onGritRepairClick/#onGritMaxAddClick/#onGritMaxSubtractClick).
   *  Inserts or removes the block if gritTrack.hasGrit (or edit mode — see
   *  grit-track.hbs's own guard) flipped, otherwise just replaces its markup with the
   *  freshly computed count. */
  async #patchGritTrack() {
    const gritTrack = this.#prepareGritTrack();
    const editMode = !!this.document.getFlag("god-tactical", "editMode");
    const existing = this.element.querySelector(".grit-track");

    if (!gritTrack.hasGrit && !editMode) {
      existing?.remove();
      return;
    }

    const html = await foundry.applications.handlebars.renderTemplate(
      "systems/god-tactical/templates/actor/parts/grit-track.hbs",
      { gritTrack, editMode }
    );
    if (existing) {
      existing.outerHTML = html;
    } else {
      // grit-track is now .flesh-row's own first row — portrait/armor-loadout moved into
      // the topbar header (see .topbar-portrait in character-sheet.hbs) and are no longer
      // siblings here.
      this.element.querySelector(".flesh-row")?.insertAdjacentHTML("afterbegin", html);
    }

    this.element.querySelector(".grit-track .grit-counter-value")?.addEventListener("click", this.#onGritWholeClick.bind(this));
    this.element.querySelector(".grit-track .grit-counter-value")?.addEventListener("contextmenu", this.#onGritWholeContextMenu.bind(this));
    this.element.querySelector(".grit-track .grit-counter-max")?.addEventListener("click", this.#onGritBurnClick.bind(this));
    this.element.querySelector(".grit-track .grit-counter-max")?.addEventListener("contextmenu", this.#onGritRepairClick.bind(this));
    this.element.querySelector(".grit-track .grit-max-add")?.addEventListener("click", this.#onGritMaxAddClick.bind(this));
    this.element.querySelector(".grit-track .grit-max-sub")?.addEventListener("click", this.#onGritMaxSubtractClick.bind(this));

    // A fresh grit-track element has no "incapacitated" class of its own (grit-track.hbs
    // carries no wound-state data) — reapply it here, since outerHTML above just replaced
    // whatever element (and classes) were there before.
    this.#syncIncapacitatedGlow(!!this.#prepareWoundTrack().incapacitated);
  }

  /** Edit-mode "+" on the Жизни block: raises the attached Race item's own woundSteps by
   *  one — that field (not anything on the actor itself) is what
   *  computeWoundState/#prepareWoundTrack actually read, see wounds.mjs. No-op if no
   *  Race item is attached (nothing to raise — the block isn't even rendered then, see
   *  wound-track.hbs's hasTrack-only guard, so this shouldn't normally fire without one). */
  async #onWoundMaxAddClick(event) {
    event.stopPropagation();
    const raceItem = this.document.items.find((it) => it.type === "race");
    if (!raceItem) return;
    await raceItem.update({ "system.woundSteps": (raceItem.system.woundSteps ?? 1) + 1 }, { render: false });
    await this.#patchWoundTrack();
  }

  /** Edit-mode "-" on the Жизни block — same lever as #onWoundMaxAddClick, opposite
   *  direction, clamped at 1 (woundSteps' own schema min, items.mjs — a species always
   *  has at least one life). */
  async #onWoundMaxSubtractClick(event) {
    event.stopPropagation();
    const raceItem = this.document.items.find((it) => it.type === "race");
    if (!raceItem) return;
    const next = Math.max(1, (raceItem.system.woundSteps ?? 1) - 1);
    await raceItem.update({ "system.woundSteps": next }, { render: false });
    await this.#patchWoundTrack();
  }

  /** Toggles a worn armor piece's struck-through "broken" visual — purely cosmetic, no
   *  roll, no mechanical effect (see ArmorDataModel's `broken` field doc comment). Never
   *  bound to a cuirass piece at all (see #prepareArmorLoadout/#patchArmorLoadout's
   *  `:not([data-cuirass])` selector) — defensive no-op here too in case a stale
   *  listener somehow fires for one anyway. */
  async #onArmorPieceClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const itemId = event.currentTarget.dataset.itemId;
    const item = this.document.items.get(itemId);
    if (!item || item.type !== "armor" || item.system.subtype === "cuirass") return;
    await item.update({ "system.broken": !item.system.broken }, { render: false });
    await this.#patchArmorLoadout();
  }

  /** Re-render just the Armor loadout block after an equip/toggle change, instead of the
   *  whole sheet — same pattern as #patchGritTrack. */
  async #patchArmorLoadout() {
    const armorLoadout = this.#prepareArmorLoadout();
    const existing = this.element.querySelector(".armor-loadout");

    if (!armorLoadout.hasArmor) {
      existing?.remove();
      return;
    }

    const html = await foundry.applications.handlebars.renderTemplate(
      "systems/god-tactical/templates/actor/parts/armor-loadout.hbs",
      { armorLoadout }
    );
    if (existing) {
      existing.outerHTML = html;
    } else {
      // armor-loadout now renders as an overlay strip across the bottom of the header
      // portrait (see .topbar-portrait/.portrait in character-sheet.hbs) — appended as
      // .portrait's last child so it sits on top of .portrait-img via position:absolute.
      this.element.querySelector(".portrait")?.insertAdjacentHTML("beforeend", html);
    }

    this.element.querySelectorAll(".armor-loadout .armor-loadout-piece:not([data-cuirass])").forEach((piece) => {
      piece.addEventListener("click", this.#onArmorPieceClick.bind(this));
    });
    this.element.querySelectorAll(".armor-loadout .armor-loadout-piece[data-cuirass]").forEach((piece) => {
      piece.addEventListener("click", (event) => event.stopPropagation());
    });
  }

  /** Toggles the "incapacitated" red glow onto .grit-track (moved off .wound-track by
   *  design — see the CSS comment on .grit-track.incapacitated) any time the sheet
   *  (re)renders or either track gets patched independently, since grit-track.hbs has
   *  no wound-state data of its own to drive this from a template conditional. */
  #syncIncapacitatedGlow(incapacitated) {
    this.element.querySelector(".grit-track")?.classList.toggle("incapacitated", !!incapacitated);
  }

  /** Re-render just the "Жизни" (wound/lives) block after a lose/restore click, instead
   *  of the whole sheet (see the render:false calls in #onWoundLoseClick/
   *  #onWoundRestoreClick) — a full
   *  document.update-triggered re-render was resetting the sheet's scroll position.
   *  Also keeps the portrait's own incapacitated-state class, and .grit-track's own
   *  incapacitated glow (see #syncIncapacitatedGlow), in sync — both are driven by
   *  woundTrack.incapacitated but live outside this block's own markup. */
  async #patchWoundTrack() {
    const woundTrack = this.#prepareWoundTrack();
    const existing = this.element.querySelector(".wound-track");

    this.element.querySelector(".portrait")
      ?.classList.toggle("incapacitated-state", !!woundTrack.incapacitated);
    this.#syncIncapacitatedGlow(woundTrack.incapacitated);

    if (!woundTrack.hasTrack) {
      existing?.remove();
      return;
    }

    const html = await foundry.applications.handlebars.renderTemplate(
      "systems/god-tactical/templates/actor/parts/wound-track.hbs",
      { woundTrack, editMode: !!this.document.getFlag("god-tactical", "editMode") }
    );
    if (existing) {
      existing.outerHTML = html;
    } else {
      // Appended at the end of .flesh-row so it lands after grit-track (which inserts
      // itself at .flesh-row's start — see #patchGritTrack), matching character-sheet.hbs's
      // own grit-track → wound-track order.
      this.element.querySelector(".flesh-row")?.insertAdjacentHTML("beforeend", html);
    }

    this.element.querySelector(".wound-track .wound-counter-value")?.addEventListener("click", this.#onWoundLoseClick.bind(this));
    this.element.querySelector(".wound-track .wound-counter-value")?.addEventListener("contextmenu", this.#onWoundRestoreClick.bind(this));
    this.element.querySelector(".wound-track .wound-max-add")?.addEventListener("click", this.#onWoundMaxAddClick.bind(this));
    this.element.querySelector(".wound-track .wound-max-sub")?.addEventListener("click", this.#onWoundMaxSubtractClick.bind(this));
  }

  /* -------------------------------------------- */

  /** Equip/unequip armor — one piece per subtype (GOD.ARMOR_SUBTYPES) can be equipped
   *  at a time; equipping another of the same subtype replaces it. Different subtypes
   *  stack freely (e.g. a cuirass + a helmet + greaves at once). */
  async #onToggleArmorEquip(event) {
    event.preventDefault();
    event.stopPropagation();
    const itemId = event.currentTarget.dataset.itemId;
    const item = this.document.items.get(itemId);
    if (!item || item.type !== "armor") return;

    const equipping = !item.system.equipped;
    const subtype = item.system.subtype;
    // Captured up front — updateEmbeddedDocuments expands the dotted "system.equipped"
    // key into a nested object on these same update objects, so reading it back out of
    // `updates` afterward would silently return undefined.
    const equipStates = this.document.items
      .filter((it) => it.type === "armor" && (it.id === itemId || (equipping && it.system.subtype === subtype)))
      .map((it) => [it.id, it.id === itemId ? equipping : false]);
    const updates = equipStates.map(([id, equipped]) => ({ _id: id, "system.equipped": equipped }));
    if (updates.length) await this.document.updateEmbeddedDocuments("Item", updates, { render: false });
    for (const [id, equipped] of equipStates) this.#patchEquippedBadge(id, equipped);
    this.#patchCarryCapacity();
    this.#patchDefenseStats();
    await this.#patchArmorLoadout();
  }

  /** Re-syncs the core-stats headline's Fortitude/Dodge numbers (system.defense) after
   *  an armor equip toggle changes the cuirass — those two spans aren't their own
   *  standalone-rendered partial like grit-track/armor-loadout, so this just patches the
   *  text directly instead of introducing a whole sibling #patch method for a 2-cell
   *  block. `this.document.system.defense` is already fresh by this point — a document
   *  update recomputes prepareDerivedData synchronously as part of resolving the
   *  updateEmbeddedDocuments call above, {render:false} only skips the DOM re-render. */
  #patchDefenseStats() {
    const vals = this.element.querySelectorAll(".core-stats-row .core-stat-val");
    if (vals[1]) vals[1].textContent = this.document.system.defense.fortitude;
    if (vals[2]) vals[2].textContent = this.document.system.defense.dodge;
  }

  /* -------------------------------------------- */

  /** Equip/unequip a container. "Deep Storage" containers are mutually exclusive — only
   *  one may be equipped at a time, equipping a new one unequips the old. "Quick Slot"
   *  containers have no such limit and stack freely. */
  async #onToggleContainerEquip(event) {
    event.preventDefault();
    event.stopPropagation();
    const itemId = event.currentTarget.dataset.itemId;
    const item = this.document.items.get(itemId);
    if (!item || item.type !== "container") return;

    const equipping = !item.system.equipped;
    const isDeep = item.system.containerType === "deep";
    const equipStates = this.document.items
      .filter((it) => it.type === "container" && (it.id === itemId || (equipping && isDeep && it.system.containerType === "deep")))
      .map((it) => [it.id, it.id === itemId ? equipping : false]);
    const updates = equipStates.map(([id, equipped]) => ({ _id: id, "system.equipped": equipped }));
    if (!updates.length) return;

    await this.document.updateEmbeddedDocuments("Item", updates, { render: false });
    for (const [id, equipped] of equipStates) this.#patchEquippedBadge(id, equipped);
    this.#patchCarryCapacity();
  }

  /** "Развернуть"/"Свернуть" — a container acts like a folder: whatever's packed into
   *  it (system.containerId) is hidden from the top-level Inventory list entirely and
   *  only rendered nested under the container's own card, and only while expanded (see
   *  _prepareContext's `packedIds`/`entry.contents` and weapon-inventory-row.hbs's
   *  nested .inv-list). State persists on the sheet instance like the filter bars, so
   *  it survives a re-render triggered by something else. A real render, unlike the
   *  equip toggle above — which items even show up in the top-level list changes. */
  #onToggleContainerExpand(itemId) {
    this._expandedContainers ??= new Set();
    if (this._expandedContainers.has(itemId)) this._expandedContainers.delete(itemId);
    else this._expandedContainers.add(itemId);
    this.render();
  }

  /** Add/remove the small "Экипировано" checkmark badge on an item's inventory card,
   *  used by both armor and container equip toggles to reflect the new state without
   *  a full re-render (see the render:false calls that use it). Lives inside
   *  .inv-card-title, right after the name (see weapon-inventory-row.hbs) — NOT a direct
   *  child of .inv-card; it used to be an absolutely-positioned corner badge there
   *  before the inventory card layout changed to put rarity in the corner instead (see
   *  that change's own history), and this patch was never updated to match, so it kept
   *  creating a SECOND badge in the old spot without ever finding (to remove) the real
   *  one now living in the new spot. */
  #patchEquippedBadge(itemId, equipped) {
    const card = this.element.querySelector(`.inv-card[data-item-id="${itemId}"]`);
    if (!card) return;
    const title = card.querySelector(":scope > .inv-card-head > .inv-card-title");
    if (!title) return;
    let badge = title.querySelector(":scope > .inv-equipped-badge");
    if (equipped && !badge) {
      badge = document.createElement("i");
      badge.className = "fas fa-circle-check inv-equipped-badge";
      badge.dataset.tooltip = "Экипировано";
      title.appendChild(badge);
    } else if (!equipped && badge) {
      badge.remove();
    }
  }

  /** Refresh the "Грузоподъёмность расы: X/Y" banner (character-sheet.hbs's
   *  carryCapacity, computed by #prepareCarryCapacity) after an armor/container equip
   *  toggle — those use render:false + #patchEquippedBadge above instead of a full
   *  re-render, so without this the banner would keep showing stale numbers since
   *  equipped gear stops/starts counting against it. Same DOM-patch pattern, no full
   *  re-render. */
  #patchCarryCapacity() {
    const tab = this.element.querySelector('.tab-pane[data-tab="inventory"]');
    if (!tab) return;
    const capacity = this.#prepareCarryCapacity();
    let el = tab.querySelector(":scope > .inv-carry-capacity");
    if (!capacity.hasLimit) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.className = "inv-carry-capacity";
      tab.insertBefore(el, tab.firstChild);
    }
    el.classList.toggle("over", capacity.over);
    el.innerHTML = `<i class="fas fa-boxes-stacked"></i><span>Грузоподъёмность расы: ${capacity.used}/${capacity.max}</span>`
      + (capacity.over ? '<span class="inv-carry-capacity-warn"><i class="fas fa-triangle-exclamation"></i> Превышена грузоподъёмность</span>' : "");
  }

  /* -------------------------------------------- */

  /** Slots currently occupied inside a container — sum of GOD.ITEM_SIZE_SLOT_COST[size]
   *  over every storable item on this actor whose containerId points at it. */
  #containerOccupied(containerId) {
    return this.document.items
      .filter((it) => GODActorSheet.#STORABLE_TYPES.includes(it.type) && it.system.containerId === containerId)
      .reduce((sum, it) => sum + (GOD.ITEM_SIZE_SLOT_COST[it.system.size] ?? 0), 0);
  }

  /** Whether `itemName` may be packed into `container` — a container's system.restriction
   *  (see items.mjs's ContainerDataModel doc comment) is blank by default (any storable
   *  item welcome); once set (e.g. "Стрелы" on a "Колчан"), only items whose name
   *  contains that text, case-insensitive, are allowed in. */
  static #itemAllowedInContainer(itemName, container) {
    const restriction = container.system.restriction?.trim();
    if (!restriction) return true;
    return itemName.toLowerCase().includes(restriction.toLowerCase());
  }

  /** "Поместить в контейнер" — places directly if only one container is equipped, otherwise
   *  asks which one via a dialog. */
  async #onPlaceInContainer(itemId, equippedContainers) {
    const target = equippedContainers.length === 1
      ? equippedContainers[0]
      : await this.#chooseContainer(equippedContainers);
    if (!target) return;
    await this.#packItemIntoContainer(itemId, target.id);
  }

  /** Packs an item into an equipped container — shared by the right-click "Поместить в
   *  контейнер" menu entry above and the drag-and-drop pack targets below
   *  (#bindContainerDropTargets). Refuses (with a warning) if the target is already
   *  full. Overwrites any existing containerId outright, so dragging an item straight
   *  from one container into another moves it in one step. */
  async #packItemIntoContainer(itemId, containerId) {
    const item = this.document.items.get(itemId);
    const container = this.document.items.get(containerId);
    if (!item || !container || itemId === containerId) return;
    if (item.system.containerId === containerId) return;

    if (!GODActorSheet.#itemAllowedInContainer(item.name, container)) {
      ui.notifications?.warn(`В этот контейнер можно положить только «${container.system.restriction}».`);
      return;
    }

    const slotCost = GOD.ITEM_SIZE_SLOT_COST[item.system.size] ?? 0;
    if (this.#containerOccupied(containerId) + slotCost > container.system.capacity) {
      ui.notifications?.warn("Недостаточно места в контейнере.");
      return;
    }
    // A real render (not the usual render:false + DOM patch) — the item now needs to
    // actually move to nested-inside-the-target-container's-card (see
    // #onToggleContainerExpand's doc comment), not just gain a color tag in place.
    await item.update({ "system.containerId": containerId });
  }

  /** Equipped containers as drop targets — dragging any item onto one packs it in
   *  directly: an existing item from this actor's own inventory (via
   *  item-reorder.mjs's REORDER_MIME) or a brand-new one fresh from a compendium/
   *  sidebar (via the standard Foundry item-drop payload, same as #onDropItem). Paired
   *  with bindInventoryReorder's equipped-container skip, which is what keeps an
   *  equipped container's own card from being a drag source or a plain reorder-drop
   *  target — so dropping something onto it here is never ambiguous with "reorder past
   *  it". Only STORABLE_TYPES accepted, same restriction #onPlaceInContainer's own menu
   *  entry already enforces (it only ever offers storable items in the first place). */
  #bindContainerDropTargets() {
    this.element.querySelectorAll(".inv-card[data-item-id]").forEach((card) => {
      const container = this.document.items.get(card.dataset.itemId);
      if (!container || container.type !== "container" || !container.system.equipped) return;

      card.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.stopPropagation();
        card.classList.add("drag-over-card");
      });
      card.addEventListener("dragleave", () => card.classList.remove("drag-over-card"));

      card.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        card.classList.remove("drag-over-card");

        const reorderId = event.dataTransfer.getData(REORDER_MIME);
        if (reorderId) {
          await this.#packItemIntoContainer(reorderId, container.id);
          return;
        }

        let data;
        try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
        catch { return; }
        if (data?.type !== "Item") return;

        const source = await fromUuid(data.uuid);
        if (!source || !GODActorSheet.#STORABLE_TYPES.includes(source.type)) return;

        if (!GODActorSheet.#itemAllowedInContainer(source.name, container)) {
          ui.notifications?.warn(`В этот контейнер можно положить только «${container.system.restriction}».`);
          return;
        }

        const slotCost = GOD.ITEM_SIZE_SLOT_COST[source.system.size] ?? 0;
        if (this.#containerOccupied(container.id) + slotCost > container.system.capacity) {
          ui.notifications?.warn("Недостаточно места в контейнере.");
          return;
        }
        const itemData = source.toObject();
        itemData.system.containerId = container.id;
        await Item.create(itemData, { parent: this.document });
      });
    });
  }

  /** Button-per-container picker dialog, used when more than one container is equipped. */
  async #chooseContainer(containers) {
    return foundry.applications.api.DialogV2.wait({
      window: { title: "Выбор контейнера" },
      content: "<p>В какой контейнер положить предмет?</p>",
      buttons: containers.map((c) => ({
        action: c.id,
        label: `${c.name} (${this.#containerOccupied(c.id)}/${c.system.capacity})`
          + (c.system.restriction ? ` — только «${c.system.restriction}»` : ""),
        callback: () => c,
      })),
      rejectClose: false,
    }).catch(() => null);
  }

  /* -------------------------------------------- */

  async #onSkillRollClick(event) {
    const el = event.currentTarget;
    const skillKey = el.dataset.skill;
    const value = parseInt(el.dataset.value, 10);

    const catEntry = Object.values(GOD.SKILL_MAP).find((c) =>
      c.skills.some((s) => s.key === skillKey)
    );
    const name = catEntry?.skills.find((s) => s.key === skillKey)?.name || skillKey;
    const charKey = catEntry?.charKey;
    const flaws = charKey ? (this.document.system.charFlaws?.[charKey] ?? 0) : 0;
    const classItem = this.document.items.find((it) => it.type === "class");
    const raceItem = this.document.items.find((it) => it.type === "race");

    new GODRollDialog(this.document, {
      name,
      value,
      isChar: false,
      charKey,
      skillKey,
      flaws,
      classItem: classItem ? classItem.system : null,
      raceItem: raceItem ? raceItem.system : null,
    }).render(true);
  }

  /* -------------------------------------------- */

  async #onCharRollClick(event) {
    const el = event.currentTarget;
    const charKey = el.dataset.char;
    const value = parseInt(el.dataset.value, 10);

    const catEntry = Object.values(GOD.SKILL_MAP).find((c) => c.charKey === charKey);
    const name = catEntry?.name || charKey;
    const flaws = this.document.system.charFlaws?.[charKey] ?? 0;
    const classItem = this.document.items.find((it) => it.type === "class");
    const raceItem = this.document.items.find((it) => it.type === "race");

    new GODRollDialog(this.document, {
      name,
      value,
      isChar: true,
      charKey,
      flaws,
      classItem: classItem ? classItem.system : null,
      raceItem: raceItem ? raceItem.system : null,
    }).render(true);
  }

  /* -------------------------------------------- */

  async #onPortraitClick(event) {
    event.preventDefault();
    const fp = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: this.document.img,
      callback: (path) => {
        this.document.update({ img: path });
      },
    });
    await fp.browse();
  }

  /* -------------------------------------------- */

  async #onNumberInputChange(event) {
    event.stopImmediatePropagation();
    const input = event.currentTarget;
    const name = input.name;
    let value = parseInt(input.value, 10);

    if (Number.isNaN(value)) {
      if (name.startsWith("system.chars.")) value = GOD.CHAR_MIN;
      else if (name === "system.xp.value") value = 0;
      else value = 10;
    }

    if (name === "system.xp.value") {
      const clamped = Math.max(0, value);
      input.value = clamped;
      await this.document.update({ [name]: clamped });
      return;
    }

    // Raising a characteristic is a purchase (GOD.charPointXpCost's piecewise 1/2/3 XP-per-
    // point ladder, summed across the whole jump — see charRaiseXpCost()), handled
    // separately from every other number field: it needs to check/spend system.xp.value and
    // can reject the edit outright (revert the input, no update) if XP is short, rather than
    // just clamping the typed value like the generic path below does.
    if (name.startsWith("system.chars.")) {
      const charKey = name.split(".")[2];
      // The input always shows/accepts the EFFECTIVE value (base + race bonus) — see
      // character-sheet.hbs's char-value-num, bound to combined.char.rollValue rather than
      // the raw base, so the race bonus stays visible (and stays applied) whether or not
      // the sheet is in edit mode. What the user typed is therefore a target EFFECTIVE
      // value; convert it back to the raw stored value (what system.chars.<key> actually
      // holds) before doing anything else, so the bonus is never re-typed or double-counted.
      const raceBonus = this.document.system.charRaceBonus?.[charKey] ?? 0;
      const toEffective = (raw) => Math.max(0, Math.min(GOD.CHAR_HARD_MAX, raw + raceBonus));
      const clamped = Math.max(GOD.CHAR_MIN, Math.min(GOD.CHAR_HARD_MAX, value - raceBonus));
      const oldValue = this.document.system.chars?.[charKey] ?? GOD.CHAR_MIN;

      if (clamped > oldValue) {
        const cost = charRaiseXpCost(oldValue, clamped);
        const xpAvailable = this.document.system.xp?.value ?? 0;
        if (cost > xpAvailable) {
          ui.notifications.warn(`Недостаточно XP: нужно ${cost}, доступно ${xpAvailable}`);
          input.value = toEffective(oldValue);
          return;
        }
        input.value = toEffective(clamped);
        await this.document.update({ [name]: clamped, "system.xp.value": xpAvailable - cost });
        this.#patchXpDisplay();
        return;
      }

      const update = { [name]: clamped };

      // Lowering a characteristic can drop it below a rank's prerequisite for skills in
      // this block that already bought past it — auto-clamp the RAW purchased rank back
      // down to whatever the new value still supports (never touches a class-granted
      // bonus rank, only the purchased portion — see maxRankForChar()). No XP is refunded;
      // this only prevents a skill from sitting at a rank its characteristic no longer
      // backs after a deliberate decrease, it doesn't undo the XP already spent getting
      // there.
      if (clamped < oldValue) {
        const maxEffectiveRank = maxRankForChar(toEffective(clamped));
        const cat = Object.values(GOD.SKILL_MAP).find((c) => c.charKey === charKey);
        const downgraded = [];
        for (const skill of cat?.skills ?? []) {
          const classBonus = this.document.system.skillClassBonus?.[skill.key] ?? 0;
          const maxRaw = Math.max(0, maxEffectiveRank - classBonus);
          const currentRaw = this.document.system.skillRanks?.[skill.key] ?? 0;
          if (currentRaw > maxRaw) {
            update[`system.skillRanks.${skill.key}`] = maxRaw;
            downgraded.push(skill.name);
          }
        }
        if (downgraded.length) {
          ui.notifications.warn(`Характеристика больше не позволяет: ранг понижен у навыков — ${downgraded.join(", ")}`);
        }
      }

      input.value = toEffective(clamped);
      await this.document.update(update);
      return;
    }

    const clamped = value;

    // Immediately correct the field visually so the user sees the clamped value
    input.value = clamped;

    const update = { [name]: clamped };

    // Fix missing portrait/token to prevent validation errors
    const isValidImg = (src) => src && /\.(svg|png|jpg|jpeg|webp|gif|avif)$/i.test(src);
    if ("img" in update && !isValidImg(update.img)) {
      update.img = "icons/svg/mystery-man.svg";
    }
    if ("prototypeToken.texture.src" in update && !isValidImg(update["prototypeToken.texture.src"])) {
      update["prototypeToken.texture.src"] = "icons/svg/mystery-man.svg";
    }

    try {
      await this.document.update(update);
    } catch (err) {
      console.warn("Actor update failed, forcing default portrait...", err);
      await this.document.update({
        img: "icons/svg/mystery-man.svg",
        "prototypeToken.texture.src": "icons/svg/mystery-man.svg"
      });
      await this.document.update(update);
    }
  }

  /* -------------------------------------------- */

  #onTabClick(event) {
    const tabEl = event.currentTarget;
    const tabId = tabEl.dataset.tab;
    const group = tabEl.dataset.group || "primary";
    this._activeTab = tabId;

    // Deactivate all tabs and panes in this group
    this.element.querySelectorAll(`.tab[data-group="${group}"]`).forEach((t) => t.classList.remove("active"));
    this.element.querySelectorAll(`.tab-pane[data-group="${group}"]`).forEach((p) => p.classList.remove("active"));

    // Activate selected
    tabEl.classList.add("active");
    const pane = this.element.querySelector(`.tab-pane[data-tab="${tabId}"][data-group="${group}"]`);
    if (pane) pane.classList.add("active");
  }

  /* -------------------------------------------- */

  async #onDropItem(event) {
    event.preventDefault();
    event.stopPropagation();
    const pane = event.currentTarget;
    pane.classList.remove("drag-over");
    const tab = pane.dataset.tab;

    // Dragging an item already on THIS actor onto the general list background (as
    // opposed to onto another specific card, which item-reorder.mjs's own per-card
    // drop handles, or onto an equipped container, which #bindContainerDropTargets'
    // pack-drop handles) means "take it out of whatever container it's packed in" —
    // the drag-to-unpack counterpart of #bindContainerDropTargets' drag-to-pack. Every
    // reorderable card carries BOTH this MIME and the plain "text/plain" Item payload
    // below (see item-reorder.mjs's dragstart) — checking this one FIRST is what keeps
    // dropping an owned item here from instead falling through to the "brand new item"
    // path further down and cloning it.
    const reorderId = event.dataTransfer.getData(REORDER_MIME);
    if (reorderId) {
      const item = this.document.items.get(reorderId);
      if (item?.system.containerId) await item.update({ "system.containerId": null });
      return;
    }

    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }

    if (data.type === "ActiveEffect") {
      const source = await fromUuid(data.uuid);
      if (!source) return;
      await ActiveEffect.create(source.toObject(), { parent: this.document });
      return;
    }
    if (data.type !== "Item") return;

    const source = await fromUuid(data.uuid);
    if (!source) return;

    // Only class/race belong in the Biography tab — everything else (weapons, abilities,
    // etc.) must go through the Inventory/Abilities panes.
    if (tab === "biography" && source.type !== "class" && source.type !== "race") {
      ui.notifications?.warn("В биографию можно перетащить только класс или расу.");
      return;
    }

    // "Only one class / one race" and the class skill-bonus math are enforced globally by
    // registerClassRaceRules() (module/data/class-race-rules.mjs) on createItem/deleteItem,
    // so they apply no matter how the item lands on the actor — not just through this handler.
    await Item.create(source.toObject(), { parent: this.document });
  }

  async #onRemoveItem(event) {
    event.preventDefault();
    const itemId = event.currentTarget.dataset.itemId;
    const item = this.document.items.get(itemId);
    // Class skill-bonus reversal on deletion is handled globally by registerClassRaceRules()
    // (module/data/class-race-rules.mjs), regardless of how the item gets removed.
    if (item) await item.delete();
  }

  /* -------------------------------------------- */

  /** "+" button under the Competencies chip row (edit mode only) — a popup listing every
   *  competency name from GOD.COMPETENCY_GROUPS not already on the attached Class item,
   *  grouped as "Категория · Компетенция" (same label shape as class-sheet.mjs's
   *  #onPickSkillBonus). Writes straight to the Class item's own system.competencies —
   *  post-chargen that array holds real names, not category keys (see items.mjs's doc
   *  comment on ClassDataModel#competencies and #prepareClassItem above), so unlike
   *  class-sheet.mjs's own #onPickCompetency (which offers whole categories, pre-chargen)
   *  this offers individual competency names directly. */
  #onPickCompetency(event) {
    event.preventDefault();
    const item = this.document.items.find((it) => it.type === "class");
    if (!item) return; // button only renders when a class is attached — see character-sheet.hbs
    const current = item.system.competencies ?? [];
    const entries = GOD.COMPETENCY_GROUPS.flatMap((group) =>
      group.competencies
        .filter((name) => !current.includes(name))
        .map((name) => ({
          label: `${group.name} · ${name}`,
          icon: "fa-list-check",
          onClick: () => item.update({ "system.competencies": [...current, name] }),
        })));
    showPopupMenu(entries, event.clientX, event.clientY);
  }

  /** × on a single competency chip — removes it from the Class item's system.competencies.
   *  The chip's data-idx comes from #prepareClassItem's mapped display array, which is a
   *  1:1, same-order transform of the raw array (see that method's own doc comment), so
   *  indexing the raw array by the displayed index is safe. */
  async #onRemoveCompetency(event) {
    event.preventDefault();
    const item = this.document.items.find((it) => it.type === "class");
    if (!item) return;
    const idx = Number(event.currentTarget.dataset.idx);
    const competencies = (item.system.competencies ?? []).filter((_, i) => i !== idx);
    await item.update({ "system.competencies": competencies });
  }

}

/* -------------------------------------------- */
/*  ActiveEffect create/delete — patch the DOM instead of a full re-render           */
/* -------------------------------------------- */

/** Suppresses this actor's automatic sheet re-render when one of its ActiveEffects is
 *  created or deleted — regardless of source (this sheet's own controls, the mini-box
 *  context menu, a Token HUD status toggle, a macro, …). Registered once at module
 *  load, not per sheet instance/render. The corresponding createActiveEffect /
 *  deleteActiveEffect hooks below patch the DOM by hand instead (_patchEffectInsert /
 *  _patchEffectRemove), the same render:false + manual-patch approach already used for
 *  flaw boxes, wound marks and skill ranks elsewhere on this sheet.
 *  preCreateActiveEffect and preDeleteActiveEffect have different argument shapes
 *  (document, data, options, userId) vs. (document, options, userId) — two separate
 *  handlers, not one shared by position, so `options` is never confused with `userId`. */
function _suppressCreateEffectRender(effect, data, options) {
  const sheet = effect.parent?.sheet;
  if (sheet instanceof GODActorSheet) options.render = false;
}
function _suppressDeleteEffectRender(effect, options) {
  const sheet = effect.parent?.sheet;
  if (sheet instanceof GODActorSheet) options.render = false;
}
Hooks.on("preCreateActiveEffect", _suppressCreateEffectRender);
Hooks.on("preDeleteActiveEffect", _suppressDeleteEffectRender);

Hooks.on("createActiveEffect", (effect) => {
  const sheet = effect.parent?.sheet;
  if (sheet instanceof GODActorSheet && sheet.rendered) sheet._patchEffectInsert(effect);
});
Hooks.on("deleteActiveEffect", (effect) => {
  const sheet = effect.parent?.sheet;
  if (sheet instanceof GODActorSheet && sheet.rendered) sheet._patchEffectRemove(effect.id);
});

/* -------------------------------------------- */
/*  Remote-client resync for render:false updates                                    */
/* -------------------------------------------- */

/** Every `render:false` update above (rank clicks, flaw/wound/grit marks, equip toggles,
 *  inventory drag-reorder, …) exists to keep the CLICKING client's own scroll position
 *  stable by patching the DOM by hand instead of a full re-render. The catch: `render:false`
 *  is part of the update options Foundry broadcasts to every connected client, not just the
 *  one that made the change — so without this, every OTHER client with the same actor's
 *  sheet open (another player, the GM) silently stops seeing updates until they manually
 *  reload. These two hooks restore a normal full re-render, but only for clients that
 *  DIDN'T originate the change (`userId !== game.user.id`) — the originating client already
 *  patched its own DOM locally and would just get a redundant/scroll-jumping re-render if
 *  included here too. Covers both the actor's own fields (updateActor) and its embedded
 *  items (updateItem — inventory equip toggles, drag-reorder). */
Hooks.on("updateActor", (actor, changes, options, userId) => {
  if (userId === game.user.id) return;
  const sheet = actor.sheet;
  if (sheet instanceof GODActorSheet && sheet.rendered) sheet.render();
});
Hooks.on("updateItem", (item, changes, options, userId) => {
  if (userId === game.user.id) return;
  const sheet = item.parent?.sheet;
  if (sheet instanceof GODActorSheet && sheet.rendered) sheet.render();
});
