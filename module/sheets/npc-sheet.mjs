/**
 * GOD Tactical — NPC Actor Sheet (ActorSheetV2)
 * Compact single-page sheet for NPCs / enemies
 */

import { GOD, formatMeters, cellsToMeters, playSound, shakeElement, sparkRepair } from "../config.mjs";
import { GODRollDialog } from "../rolls/roll-dialog.mjs";
import { dealNpcDamage } from "../rolls/npc-attack.mjs";
import { computeWoundState, getGritCells } from "../combat/wounds.mjs";
import { bindInventoryReorder, REORDER_MIME } from "./item-reorder.mjs";
import { bindInventoryContextMenu, bindContextMenu, bindContextMenuOnElement, fakeItemEvent } from "./item-context-menu.mjs";
import { clampRarity } from "./rarity-pips.mjs";
import { showCreateItemMenu } from "./item-create-menu.mjs";
import { injectTooltipToggleButton } from "./tooltip-toggle.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

/** Same icon/color per tier as GOD.NPC_HIERARCHY_META (config.mjs) — also shared with
 *  the token canvas badge (canvas/npc-hierarchy-badge.mjs) — plus the i18n key for this
 *  sheet's own tooltip/label use, which the canvas side has no need for. */
const NPC_HIERARCHY_META = Object.fromEntries(
  GOD.NPC_HIERARCHY_TIERS.map((key) => [
    key,
    { ...GOD.NPC_HIERARCHY_META[key], labelKey: `GOD.Npc.Hierarchy${key.charAt(0).toUpperCase()}${key.slice(1)}` },
  ])
);

export class GODNPCSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ActorSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "actor", "npc"],
    position: { width: 520, height: 720 },
    window: { resizable: true, minimizable: true },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/actor/npc-sheet.hbs",
      // Foundry's own PARTS.scrollable was tried here and confirmed (via instrumentation
      // on the character sheet) to be ineffective — by the time it reads the outgoing
      // element's scrollTop, something has already reset it to 0. See the live-scroll
      // tracking in _onRender() instead, which works around that by never depending on
      // reading the value after the fact.
    },
    // Separate part, sibling of "sheet" rather than markup nested inside it — see
    // actor-sheet.mjs's identical PARTS.tabs comment for why (the sheet part scrolls
    // internally, so a tab rail meant to poke past its right edge can't be its descendant).
    tabs: {
      template: "systems/god-tactical/templates/actor/parts/npc-tab-rail.hbs",
    },
  };

  /* -------------------------------------------- */

  /** Item types that have a "size" (Container slot cost) and can be packed into a Container.
   *  Spell is not storable — it lives in the Свойства (bio) tab's ability list, not
   *  Inventory (see FEATURE_TYPES in #prepareContext), so it can't be packed into a
   *  container either. */
  static #STORABLE_TYPES = ["weapon", "armor", "consumable", "trophies", "tools"];

  static #injectEditToggle(root, editMode, onClick) {
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

  static #applyEditLock(root, editMode) {
    root.classList.toggle("locked-edit", !editMode);
    const isLockedField = (el) => {
      const n = el.getAttribute("name") || "";
      if (n === "name") return true;
      if (n.startsWith("system.biography")) return true;
      if (n.startsWith("system.chars.")) return true;
      if (n.startsWith("system.damage.")) return true;
      if (n === "system.dodge.value") return true;
      if (n === "system.fortitude.value") return true;
      return false;
    };
    root.querySelectorAll("input, textarea").forEach((el) => {
      if (!isLockedField(el)) return;
      if (editMode) el.removeAttribute("readonly");
      else el.setAttribute("readonly", "");
    });
  }

  static #TYPE_LABEL = {
    weapon:     "Оружие",
    spell:      "Заклинание",
    armor:      "Броня",
    consumable: "Расходник",
    tools:      "Инструменты",
    trophies:   "Трофей",
    ability:    "Способность",
    container:  "Контейнер",
  };

  /** Resolve a Creature size or weight key (e.g. "veryLarge") through the lang files
   *  (the GOD.Race.Size... / GOD.Race.Weight... keys — shared with Race), instead of a
   *  hardcoded label map. */
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
    context.portrait = actor.img;
    context.chars = this.#prepareChars();
    context.damage = actor.system.damage;
    context.dodge = actor.system.dodge;
    context.fortitude = actor.system.fortitude;
    context.biography = actor.system.biography || "";
    context.hasCriticalFlaw = Object.values(actor.system.charFlaws ?? {}).some((v) => v >= 3);
    context.editMode = !!actor.getFlag("god-tactical", "editMode");
    context.activeTab = this._activeTab || "bio";

    // Combat-role tag, GM-set, no mechanical behavior wired to it (see data-models.mjs's
    // NPCDataModel.hierarchy and GOD.NPC_HIERARCHY_TIERS).
    context.hierarchies = GOD.NPC_HIERARCHY_TIERS.map((key) => ({
      value: key,
      label: `GOD.Npc.Hierarchy${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    }));
    // Icon/color badge for whichever tier is actually set — shown on the portrait itself
    // (and next to the hierarchy select) so the combat role reads at a glance instead of
    // only from the dropdown's text. Pawn stays dim/minor, Boss gets the same bronze
    // accent as other "important" markers elsewhere (Мезонин dice, weapon-hold state).
    context.hierarchyMeta = NPC_HIERARCHY_META[actor.system.hierarchy] ?? NPC_HIERARCHY_META.equal;

    // Size tag (GOD.NPC_SIZE_TIERS) — drives this token's assumed height for the
    // height-based blind-spot check (see data-models.mjs's NPCDataModel.size).
    context.sizes = GOD.NPC_SIZE_TIERS.map((key) => ({
      value: key,
      label: `GOD.Npc.Size${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    }));

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

    const CONTAINER_TYPE_LABEL = { deep: "Deep Storage Container", quick: "Quick Slot Container" };

    const nonCreatureItems = [...actor.items]
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .filter((it) => it.type !== "creature" && it.type !== "race");
    const items = nonCreatureItems.map((item) => {
      const entry = {
        id:          item.id,
        name:        item.name,
        img:         item.img,
        type:        item.type,
        typeLabel:   GODNPCSheet.#TYPE_LABEL[item.type] ?? item.type,
        // A number + a single gem icon instead of a colored tier name (see
        // rarity-pips.mjs) — Ability and Spell are excluded like on the character sheet
        // (module/sheets/actor-sheet.mjs): neither exposes its rarity field on its own
        // sheet, so it's not a meaningful rarity here.
        rarityValue: (item.type !== "ability" && item.type !== "spell" && typeof item.system?.rarity === "number") ? clampRarity(item.system.rarity) : null,
        containerId: item.system?.containerId ?? "",
        // Spell shares Weapon's exact card (see items.mjs's weaponCardSchema), so it
        // reuses the same inventory meta chips below.
        isWeapon:    item.type === "weapon" || item.type === "spell",
        isArmor:     item.type === "armor",
        isContainer: item.type === "container",
        isConsumable: item.type === "consumable",
        isTools:     item.type === "tools",
        isTrophy:    item.type === "trophies",
        isAbility:   item.type === "ability",
        // Blank ("") for every type but Ability — matches containerId's blank-string
        // convention above. The NPC sheet has no filter/search bar of its own (its lists
        // are short enough not to need one) — these are just carried along for parity
        // with the same item-mapping shape actor-sheet.mjs builds.
        subtypeKey:    "",
        activationKey: "",
        // "" for Trophy/Container/Class/Race, which don't have a Features block at all
        // (item.system.features is simply undefined for those types). 2026-08-17: each
        // Features entry now carries its OWN activation stage (items.mjs's
        // featureEntryField) instead of one whole-card checkbox group — this label
        // collects the unique non-blank stages across all of them.
        activationTypesLabel: [...new Set((item.system.features ?? []).map((f) => f.activation).filter(Boolean))]
          .map((k) => ACTIVATION_TYPE_LABEL[k] ?? k).join(", "),
      };
      if (item.type === "weapon" || item.type === "spell") {
        const sys = item.system;
        entry.handsLabel      = HANDS_LABEL[sys.hands] ?? "—";
        entry.sizeLabel       = SIZE_LABEL[sys.size] ?? (sys.size || "—");
        entry.damageTypeLabel = DAMAGE_TYPE_LABEL[sys.damageType] ?? "—";
        entry.damageNatureAbbr = DAMAGE_NATURE_ABBR[sys.damageNature] ?? "—";
        entry.skillLabel      = SKILL_NAME_BY_KEY[sys.skill] ?? "";
        entry.natiskEntries = _buildRangeEntries(sys, "natisk", "Настильный");
        entry.brosokEntries = _buildRangeEntries(sys, "brosok", "Навесной");
      }
      if (item.type === "ability") {
        const sys = item.system;
        entry.subtypeKey   = sys.subtype;
        entry.subtypeLabel = ABILITY_SUBTYPE_LABEL[sys.subtype] ?? sys.subtype;
        entry.activationKey   = sys.activation;
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
        entry.sizeLabel          = SIZE_LABEL[sys.size] ?? sys.size;
        entry.occupied           = this.#containerOccupied(item.id);
        entry.color              = sys.color;
        entry.restriction        = sys.restriction || "";
      }
      if (GODNPCSheet.#STORABLE_TYPES.includes(item.type) && item.system.containerId) {
        const container = actor.items.get(item.system.containerId);
        if (container) {
          entry.containerColor = container.system.color;
          entry.containerName  = container.name;
        }
      }
      return entry;
    });

    // Containers act like folders — see actor-sheet.mjs's identical comment for the
    // rationale. `packedIds` is what invItems below excludes.
    this._expandedContainers ??= new Set();
    for (const entry of items) {
      if (entry.isContainer) {
        entry.expanded = this._expandedContainers.has(entry.id);
        entry.contents = items.filter((it) => it.containerId === entry.id);
      }
    }
    const packedIds = new Set(items.filter((it) => it.containerId).map((it) => it.id));

    const INV_TYPES     = ["weapon", "armor", "consumable", "tools", "trophies", "container"];
    const FEATURE_TYPES = ["ability", "spell"];

    const invItems     = items.filter((it) => INV_TYPES.includes(it.type) && !packedIds.has(it.id));
    const featureItems = items.filter((it) => FEATURE_TYPES.includes(it.type));

    // No Inventory filter bar on this sheet anymore (removed — see git history). Both
    // lists render flat, unsorted-by-type (see npc-sheet.hbs) — items already carry
    // their own typeLabel field for display.
    context.hasItems  = invItems.length > 0;
    context.flatItems = invItems;

    context.hasFeatures   = featureItems.length > 0;
    context.flatFeatures  = featureItems;

    context.creatureItem = this.#prepareCreatureItem();
    context.woundTrack    = this.#prepareWoundTrack();
    context.gritTrack     = this.#prepareGritTrack();
    context.effectsMini   = this.#prepareEffectsMini();

    return context;
  }

  /* -------------------------------------------- */

  #prepareChars() {
    const chars = [];
    for (const [catKey, cat] of Object.entries(GOD.SKILL_MAP)) {
      const value = this.document.system.chars[cat.charKey] ?? 47;
      const flaws = this.document.system.charFlaws?.[cat.charKey] ?? 0;
      const flawBoxes = [];
      for (let i = 0; i < 3; i++) {
        flawBoxes.push({ index: i, active: i < flaws });
      }
      chars.push({
        key: cat.charKey,
        name: cat.name,
        css: cat.css,
        value,
        flaws,
        flawBoxes,
      });
    }
    return chars;
  }

  /* -------------------------------------------- */

  /** The (at most one) species card attached to this actor — a Creature item (Bestiary) or a
   *  Race item (for humanoid NPCs); both share the same size/weight/woundSteps shape. */
  #prepareCreatureItem() {
    const item = this.document.items.find((it) => it.type === "creature" || it.type === "race");
    if (!item) return null;
    return {
      id: item.id,
      name: item.name,
      img: item.img,
      sizeLabel: GODNPCSheet.#localizeBestiaryKey("Size", item.system.size),
      weightLabel: GODNPCSheet.#localizeBestiaryKey("Weight", item.system.weight),
      speed: item.system.speed,
      woundSteps: item.system.woundSteps,
    };
  }

  /* -------------------------------------------- */

  /** Wound track — appears once a species card (Creature or Race) is attached. Uses the
   *  shared wound state (woundSteps). */
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

  /** "GRIT" cell block — NPCs no longer have armor at all, so this is a flat GM-set
   *  max (system.gritMax) instead of anything armor-derived. Falls back to a zeroed
   *  shape (not just {hasGrit:false}) when gritMax is 0 — see actor-sheet.mjs's
   *  identical method for why. */
  #prepareGritTrack() {
    const grit = getGritCells(this.document);
    if (!grit) return { hasGrit: false, whole: 0, filled: 0, cracked: 0, count: 0, effectiveMax: 0 };

    return { hasGrit: true, ...grit };
  }

  /* -------------------------------------------- */

  /** Per-effect entry shape for the compact mini-box (same shape as the character sheet's
   *  #effectMiniEntry() — shared by #prepareEffectsMini() and the single-row DOM patch). */
  #effectMiniEntry(effect) {
    return {
      id: effect.id,
      name: effect.name,
      img: effect.img,
      disabled: effect.disabled,
      negative: [...effect.statuses].some((id) => GOD.NEGATIVE_STATUS_IDS.has(id)),
    };
  }

  /** Compact effects summary shown in the header, next to the name (see
   *  templates/actor/parts/header-effects.hbs) — the only in-sheet effects UI for NPCs
   *  (no separate tab). Split into temporary/permanent (disabled effects stay in their
   *  natural group, just dimmed) and tags harmful statuses red. */
  #prepareEffectsMini() {
    const groups = { temporary: [], passive: [] };
    for (const effect of this.document.effects) {
      const entry = this.#effectMiniEntry(effect);
      if (effect.isTemporary) groups.temporary.push(entry);
      else groups.passive.push(entry);
    }
    // Passive abilities (activation:"passive" — the default) show up alongside real
    // Active Effects in the same "permanent" group — see actor-sheet.mjs's identical block.
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
   *  see actor-sheet.mjs's _patchEffectInsert() for the full rationale. Skips effects
   *  created already-disabled — they'll appear on the next natural render. Icon-only (no
   *  name span) — the header strip has no room for text, the name is available on hover
   *  via the tooltip instead. */
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
   *  _patchEffectInsert(). */
  _patchEffectRemove(effectId) {
    this.element.querySelector(`.effects-mini-row[data-effect-id="${effectId}"]`)?.remove();
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender(context, options);

    // Scroll preservation: the tab panes (.tab-pane) don't actually scroll themselves —
    // the real scrollable element is npc-sheet.hbs's own root div (.npc-sheet, which has
    // its own overflow-y:auto) — NOT this.element (the outer <form class="application
    // sheet ...">, which stays overflow:visible and never scrolls at all; a stale claim
    // in a previous version of this comment said otherwise, which is exactly why this
    // was still visibly resetting scroll on every full render despite this block's
    // existence — it was tracking a node that can never scroll). The one genuine
    // exception is .npc-items .inv-groups (the Снаряжение list on the anketa tab), which
    // has its own independent overflow-y:auto nested inside that scroll. The "sheet"
    // PART's root node can in principle get replaced wholesale by Foundry across
    // renders, so re-find it and check ITS OWN dataset flag (not a this-instance flag,
    // which would wrongly say "already bound" for a brand new node) every time, rather
    // than assuming one binding outlives every future render; .inv-groups gets a fresh
    // element each render regardless, so it's rebound every time either way.
    const scrollRoot = this.element.querySelector(".npc-sheet") ?? this.element;
    if (!scrollRoot.dataset.godScrollBound) {
      scrollRoot.dataset.godScrollBound = "1";
      scrollRoot.addEventListener("scroll", () => {
        this._liveScroll = scrollRoot.scrollTop;
      });
    }
    this.element.querySelector(".npc-items .inv-groups")?.addEventListener("scroll", (e) => {
      this._liveInvGroupsScroll = e.target.scrollTop;
    });
    requestAnimationFrame(() => {
      if (this._liveScroll) scrollRoot.scrollTop = this._liveScroll;
      const invGroups = this.element?.querySelector(".npc-items .inv-groups");
      if (invGroups && this._liveInvGroupsScroll) invGroups.scrollTop = this._liveInvGroupsScroll;
    });

    // Edit toggle injected into window header (pencil ↔ check)
    const editMode = !!this.document.getFlag("god-tactical", "editMode");
    GODNPCSheet.#injectEditToggle(this.element, editMode, async () => {
      await this.document.setFlag("god-tactical", "editMode", !editMode);
    });
    GODNPCSheet.#applyEditLock(this.element, editMode);

    // Tooltip on/off toggle (see module/sheets/tooltip-toggle.mjs) — client-wide, not
    // per-actor, but injected here same as the edit toggle above.
    injectTooltipToggleButton(this.element);

    // Portrait click → FilePicker
    const portrait = this.element.querySelector(".npc-portrait");
    if (portrait) {
      portrait.addEventListener("click", this.#onPortraitClick.bind(this));
    }

    // Characteristic roll clicks
    this.element.querySelectorAll("[data-action='roll-char']").forEach((el) => {
      el.addEventListener("click", this.#onRollChar.bind(this));
    });

    // Damage stat click — deal the NPC's flat base damage (no roll, see npc-attack.mjs).
    this.element.querySelector("[data-action='deal-damage']")?.addEventListener("click", () => {
      dealNpcDamage(this.document);
    });

    // Flaw box clicks
    this.element.querySelectorAll(".flaw-box").forEach((box) => {
      box.addEventListener("click", this.#onFlawClick.bind(this));
    });

    // Жизни counter: LMB on the whole-value takes one wound, RMB restores one — see
    // #onWoundLoseClick/#onWoundRestoreClick.
    this.element.querySelector(".wound-counter-value")?.addEventListener("click", this.#onWoundLoseClick.bind(this));
    this.element.querySelector(".wound-counter-value")?.addEventListener("contextmenu", this.#onWoundRestoreClick.bind(this));

    // Incapacitated glow lives on .grit-track, not .wound-track — see #syncIncapacitatedGlow.
    this.#syncIncapacitatedGlow(!!context.woundTrack?.incapacitated);

    // GRIT counter: LMB/RMB on the whole-value spends/restores one point; LMB/RMB on the
    // max field burns/repairs one cell (the max FIELD itself shows the reduced ceiling,
    // no separate "cracked" indicator) — see #onGritWholeClick/#onGritWholeContextMenu/
    // #onGritBurnClick/#onGritRepairClick.
    this.element.querySelector(".grit-counter-value")?.addEventListener("click", this.#onGritWholeClick.bind(this));
    this.element.querySelector(".grit-counter-value")?.addEventListener("contextmenu", this.#onGritWholeContextMenu.bind(this));
    this.element.querySelector(".grit-counter-max")?.addEventListener("click", this.#onGritBurnClick.bind(this));
    this.element.querySelector(".grit-counter-max")?.addEventListener("contextmenu", this.#onGritRepairClick.bind(this));

    // Edit-mode "+"/"-" buttons: raise/lower the GRIT/Жизни MAX by one (system.gritMax,
    // or the attached creature-or-race item's system.woundSteps) — see
    // #onGritMaxAddClick/#onGritMaxSubtractClick/#onWoundMaxAddClick/#onWoundMaxSubtractClick.
    this.element.querySelector(".grit-max-add")?.addEventListener("click", this.#onGritMaxAddClick.bind(this));
    this.element.querySelector(".grit-max-sub")?.addEventListener("click", this.#onGritMaxSubtractClick.bind(this));
    this.element.querySelector(".wound-max-add")?.addEventListener("click", this.#onWoundMaxAddClick.bind(this));
    this.element.querySelector(".wound-max-sub")?.addEventListener("click", this.#onWoundMaxSubtractClick.bind(this));

    // Creature/race card: right-click → open / delete — same convention as regular
    // .inv-card items now (no more inline click-to-open name / × button).
    bindContextMenu(this.element, ".npc-creature-card[data-item-id]", "itemId", (itemId) => {
      const item = this.document.items.get(itemId);
      if (!item) return null;
      return [
        {
          label: "Открыть",
          icon: "fa-pen",
          className: "is-equip",
          onClick: () => this.#onOpenItem(fakeItemEvent(itemId)),
        },
        {
          label: "Удалить",
          icon: "fa-xmark",
          className: "is-remove",
          onClick: () => this.#onRemoveItem(fakeItemEvent(itemId)),
        },
      ];
    });

    // "+" in the СНАРЯЖЕНИЕ/СПОСОБНОСТИ section headers — build a brand-new blank Item
    // straight on the actor, the second way to get an Item onto the sheet besides
    // dragging one in from a compendium.
    this.element.querySelectorAll(".npc-section-add-btn").forEach((btn) => {
      btn.addEventListener("click", (event) => showCreateItemMenu(this.document, event));
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

      // No "Проверить" entry here, unlike actor-sheet.mjs's identical context menu — NPCs
      // never check Запас (Stock): their ammo/shields don't wear down (see rolls/
      // consumable-check.mjs's doc comment).

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

      if (GODNPCSheet.#STORABLE_TYPES.includes(item.type)) {
        if (item.system.containerId) {
          entries.push({
            label: "Достать из контейнера",
            icon: "fa-box-open",
            className: "is-equip",
            // Real render — the item needs to move from nested-inside-the-container-
            // card back to a top-level row (see #onToggleContainerExpand's doc comment).
            onClick: () => item.update({ "system.containerId": null }),
          });
        } else {
          const equippedContainers = this.document.items.filter((it) =>
            it.type === "container" && it.system.equipped && GODNPCSheet.#itemAllowedInContainer(item.name, it)
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
    // right-click "Развернуть"/"Свернуть" menu entry above (see actor-sheet.mjs's
    // identical binding).
    this.element.querySelectorAll(".inv-container-toggle[data-item-id]").forEach((toggle) => {
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#onToggleContainerExpand(toggle.dataset.itemId);
      });
    });

    // Tag weapon (and spell — same card) cards for weapon-specific styling (hover highlight)
    this.element.querySelectorAll('.inv-card[data-item-id]').forEach((card) => {
      const item = this.document.items.get(card.dataset.itemId);
      if (item?.type === "weapon" || item?.type === "spell") card.classList.add("inv-weapon-row");
    });

    // Effects mini-box: right-click → open effect sheet / delete (same as the character sheet)
    bindContextMenu(this.element, ".effects-mini-row[data-effect-id]", "effectId", this.#effectContextMenuEntries.bind(this));

    // Tabs
    this.element.querySelectorAll(".npc-tabs .tab[data-tab]").forEach((tab) => {
      tab.addEventListener("click", this.#onTabClick.bind(this));
    });

    // Number inputs — clamp values
    this.element.querySelectorAll('input[type="number"]').forEach((input) => {
      input.addEventListener("change", this.#onNumberInputChange.bind(this));
    });

    // Drag-drop zones: Biography (creature items only), Inventory (general items).
    // ActiveEffect drops are accepted on any of these — see #onDropItem — since
    // there's no effects-specific pane; the compact mini-box handles all effect
    // management via right-click.
    for (const selector of ['.tab-pane[data-tab="bio"]', '.tab-pane[data-tab="anketa"]']) {
      const pane = this.element.querySelector(selector);
      if (pane) {
        pane.addEventListener("dragover", (e) => { e.preventDefault(); pane.classList.add("drag-over"); });
        pane.addEventListener("dragleave", () => pane.classList.remove("drag-over"));
        pane.addEventListener("drop", this.#onDropItem.bind(this));
      }
    }

    // Reorder: drag an item card onto another one in the same list to swap places
    bindInventoryReorder(this.element, this.document);

    // Equipped containers as drop targets: drag any item straight onto one to pack it
    // in, instead of the right-click "Поместить в контейнер" round-trip.
    this.#bindContainerDropTargets();

  }

  /* -------------------------------------------- */

  static async #onSubmitForm(event, form, formData) {
    const actor = this.document;
    const updates = { ...formData.object };

    // Never touch portrait through form submission
    delete updates.img;
    delete updates["prototypeToken.texture.src"];

    // Never overwrite array fields managed by custom handlers
    const protectedPaths = ["system.perks"];
    for (const path of protectedPaths) {
      if (path in updates) delete updates[path];
    }

    // Normalize empty number fields back to schema defaults and clamp ranges. Unlike PCs (whose
    // 47 floor comes from chargen — the weakest a raised skill spread can produce), NPCs/creatures
    // have no such floor: a weak monster can be well below 47.
    for (const key of Object.keys(updates)) {
      if (key.startsWith("system.chars.")) {
        const val = parseInt(updates[key], 10);
        updates[key] = (updates[key] === "" || updates[key] == null || Number.isNaN(val))
          ? 47
          : Math.max(1, Math.min(99, val));
      }
      if (key.startsWith("system.damage.") || key === "system.dodge.value" || key === "system.fortitude.value") {
        const val = parseInt(updates[key], 10);
        updates[key] = (updates[key] === "" || updates[key] == null || Number.isNaN(val))
          ? 0
          : Math.max(0, val);
      }
    }

    try {
      await actor.update(updates);
    } catch (err) {
      console.warn("Actor update failed, forcing default portrait...", err);
      await actor.update({
        img: "icons/svg/mystery-man.svg",
        "prototypeToken.texture.src": "icons/svg/mystery-man.svg",
      });
      await actor.update(updates);
    }
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

  async #onRollChar(event) {
    const charKey = event.currentTarget.dataset.char;
    const system = this.document.system;
    const value = system.chars[charKey] ?? 50;
    const flaws = system.charFlaws?.[charKey] ?? 0;

    const catEntry = Object.values(GOD.SKILL_MAP).find((c) => c.charKey === charKey);
    const name = catEntry?.name || charKey;

    new GODRollDialog(this.document, {
      name,
      value,
      isChar: true,
      charKey,
      flaws,
    }).render(true);
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
      box.classList.toggle("active", i < target);
    });

    // Update critical portrait state
    const hasCriticalFlaw = Object.values(this.document.system.charFlaws).some((v) => v >= 3);
    const portrait = this.element.querySelector(".npc-portrait");
    if (portrait) portrait.classList.toggle("critical-state", hasCriticalFlaw);

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
        type: CONST.CHAT_MESSAGE_STYLES.EMOTE,
      });
    }
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
  }

  /** Add/remove the small "Экипировано" checkmark badge on an item's inventory card,
   *  used by both armor and container equip toggles to reflect the new state without
   *  a full re-render (see the render:false calls that use it). Lives inside
   *  .inv-card-title, right after the name (see weapon-inventory-row.hbs) — NOT a direct
   *  child of .inv-card; see actor-sheet.mjs's identical method for why this used to
   *  create a duplicate badge instead of toggling the real one. */
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

  /* -------------------------------------------- */

  /** Slots currently occupied inside a container — sum of GOD.ITEM_SIZE_SLOT_COST[size]
   *  over every storable item on this actor whose containerId points at it. */
  #containerOccupied(containerId) {
    return this.document.items
      .filter((it) => GODNPCSheet.#STORABLE_TYPES.includes(it.type) && it.system.containerId === containerId)
      .reduce((sum, it) => sum + (GOD.ITEM_SIZE_SLOT_COST[it.system.size] ?? 0), 0);
  }

  /** Whether `itemName` may be packed into `container` — see actor-sheet.mjs's identical
   *  method for the full rationale. */
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

  /** Packs an item into an equipped container — see actor-sheet.mjs's identical method
   *  for the full rationale. Shared by the right-click menu entry above and the
   *  drag-and-drop pack targets below (#bindContainerDropTargets). */
  async #packItemIntoContainer(itemId, containerId) {
    const item = this.document.items.get(itemId);
    const container = this.document.items.get(containerId);
    if (!item || !container || itemId === containerId) return;
    if (item.system.containerId === containerId) return;

    if (!GODNPCSheet.#itemAllowedInContainer(item.name, container)) {
      ui.notifications?.warn(`В этот контейнер можно положить только «${container.system.restriction}».`);
      return;
    }

    const slotCost = GOD.ITEM_SIZE_SLOT_COST[item.system.size] ?? 0;
    if (this.#containerOccupied(containerId) + slotCost > container.system.capacity) {
      ui.notifications?.warn("Недостаточно места в контейнере.");
      return;
    }
    // Real render — the item needs to move to nested-inside-the-target-container's-card
    // (see #onToggleContainerExpand's doc comment).
    await item.update({ "system.containerId": containerId });
  }

  /** Equipped containers as drop targets — see actor-sheet.mjs's identical method for
   *  the full rationale. Paired with bindInventoryReorder's equipped-container skip. */
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
        if (!source || !GODNPCSheet.#STORABLE_TYPES.includes(source.type)) return;

        if (!GODNPCSheet.#itemAllowedInContainer(source.name, container)) {
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

  /** "Развернуть"/"Свернуть" — see actor-sheet.mjs's identical method for the full
   *  rationale. State persists on the sheet instance like actor-sheet.mjs's. */
  #onToggleContainerExpand(itemId) {
    this._expandedContainers ??= new Set();
    if (this._expandedContainers.has(itemId)) this._expandedContainers.delete(itemId);
    else this._expandedContainers.add(itemId);
    this.render();
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

  /** LMB on the GRIT whole-value: spends one point — see actor-sheet.mjs's identical
   *  method for the full rationale. */
  async #onGritWholeClick(event) {
    event.stopPropagation();
    const grit = getGritCells(this.document);
    if (!grit) return;
    const filled = this.document.system.gritFilled ?? 0;
    const next = Math.min(grit.count - grit.cracked, filled + 1);
    if (next === filled) return;
    playSound("systems/god-tactical/assets/sounds/armor-hit.mp3");
    shakeElement(this.element.querySelector(".npc-portrait"));
    await this.document.update({ "system.gritFilled": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** RMB on the GRIT whole-value: restores one spent point. */
  async #onGritWholeContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const filled = this.document.system.gritFilled ?? 0;
    const next = Math.max(0, filled - 1);
    if (next === filled) return;
    playSound("systems/god-tactical/assets/sounds/armor-restore.mp3");
    sparkRepair(this.element.querySelector(".npc-portrait"));
    await this.document.update({ "system.gritFilled": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** LMB on the GRIT max: burns one more cell permanently — see actor-sheet.mjs's
   *  identical method for the full rationale. Never touches gritFilled. */
  async #onGritBurnClick(event) {
    event.stopPropagation();
    const grit = getGritCells(this.document);
    if (!grit) return;
    const cracked = this.document.system.gritCracked ?? 0;
    const next = Math.min(grit.count, cracked + 1);
    if (next === cracked) return;
    playSound("systems/god-tactical/assets/sounds/armor-crack.mp3");
    shakeElement(this.element.querySelector(".npc-portrait"));
    await this.document.update({ "system.gritCracked": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** RMB on the GRIT max: repairs one burned cell. */
  async #onGritRepairClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const cracked = this.document.system.gritCracked ?? 0;
    const next = Math.max(0, cracked - 1);
    if (next === cracked) return;
    playSound("systems/god-tactical/assets/sounds/armor-restore.mp3");
    sparkRepair(this.element.querySelector(".npc-portrait"));
    await this.document.update({ "system.gritCracked": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** Edit-mode "+" on the GRIT block: raises the NPC's own flat GM-set RAW max
   *  (system.gritMax) by one — deliberately edit-mode only, see actor-sheet.mjs's
   *  identical #onGritMaxAddClick for the full rationale. */
  async #onGritMaxAddClick(event) {
    event.stopPropagation();
    const next = (this.document.system.gritMax ?? 0) + 1;
    await this.document.update({ "system.gritMax": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** Edit-mode "-" on the GRIT block — same lever as #onGritMaxAddClick, opposite
   *  direction, clamped at the field's own schema min (0, data-models.mjs). */
  async #onGritMaxSubtractClick(event) {
    event.stopPropagation();
    const next = Math.max(0, (this.document.system.gritMax ?? 0) - 1);
    await this.document.update({ "system.gritMax": next }, { render: false });
    await this.#patchGritTrack();
  }

  /** Re-render just the "GRIT" block after equip/crack/repair/max-add changes, instead of
   *  the whole sheet — see actor-sheet.mjs's identical method for the full rationale. */
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
      this.element.querySelector(".npc-stat-mini-row")?.insertAdjacentHTML("afterend", html);
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

  /** Toggles the "incapacitated" red glow onto .grit-track — see actor-sheet.mjs's
   *  identical method for the full rationale (moved off .wound-track by design). */
  #syncIncapacitatedGlow(incapacitated) {
    this.element.querySelector(".grit-track")?.classList.toggle("incapacitated", !!incapacitated);
  }

  /** Re-render just the "Жизни" (wound/lives) block after a lose/restore click, instead
   *  of the whole sheet — see actor-sheet.mjs's identical method for the full rationale.
   *  Also keeps .grit-track's own incapacitated glow (see #syncIncapacitatedGlow) in
   *  sync, since it's driven by woundTrack.incapacitated but lives outside this block. */
  async #patchWoundTrack() {
    const woundTrack = this.#prepareWoundTrack();
    const existing = this.element.querySelector(".wound-track");

    this.element.querySelector(".npc-portrait")
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
      const anchor = this.element.querySelector(".grit-track") ?? this.element.querySelector(".npc-stat-mini-row");
      anchor?.insertAdjacentHTML("afterend", html);
    }

    this.element.querySelector(".wound-track .wound-counter-value")?.addEventListener("click", this.#onWoundLoseClick.bind(this));
    this.element.querySelector(".wound-track .wound-counter-value")?.addEventListener("contextmenu", this.#onWoundRestoreClick.bind(this));
    this.element.querySelector(".wound-track .wound-max-add")?.addEventListener("click", this.#onWoundMaxAddClick.bind(this));
    this.element.querySelector(".wound-track .wound-max-sub")?.addEventListener("click", this.#onWoundMaxSubtractClick.bind(this));
  }

  /** Edit-mode "+" on the Жизни block: raises the attached species item's (Creature or
   *  Race — see #onWoundLoseClick's own lookup) woundSteps by one. No-op with nothing
   *  attached — the block isn't rendered then either, see wound-track.hbs's hasTrack-
   *  only guard. */
  async #onWoundMaxAddClick(event) {
    event.stopPropagation();
    const creatureItem = this.document.items.find((it) => it.type === "creature" || it.type === "race");
    if (!creatureItem) return;
    await creatureItem.update({ "system.woundSteps": (creatureItem.system.woundSteps ?? 1) + 1 }, { render: false });
    await this.#patchWoundTrack();
  }

  /** Edit-mode "-" on the Жизни block — same lever as #onWoundMaxAddClick, opposite
   *  direction, clamped at 1 (woundSteps' own schema min, items.mjs — a species always
   *  has at least one life). */
  async #onWoundMaxSubtractClick(event) {
    event.stopPropagation();
    const creatureItem = this.document.items.find((it) => it.type === "creature" || it.type === "race");
    if (!creatureItem) return;
    const next = Math.max(1, (creatureItem.system.woundSteps ?? 1) - 1);
    await creatureItem.update({ "system.woundSteps": next }, { render: false });
    await this.#patchWoundTrack();
  }

  /* -------------------------------------------- */

  /** LMB on the Жизни whole-value: takes one wound — see actor-sheet.mjs's identical
   *  method for the full rationale. */
  async #onWoundLoseClick(event) {
    event.stopPropagation();
    const creatureItem = this.document.items.find((it) => it.type === "creature" || it.type === "race");
    const max = creatureItem?.system.woundSteps ?? 1;
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

  /** RMB on the Жизни whole-value: restores one wound. */
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

  #onTabClick(event) {
    const tabEl = event.currentTarget;
    const tabId = tabEl.dataset.tab;
    this._activeTab = tabId;
    this.element.querySelectorAll('.npc-tabs .tab[data-group="primary"]').forEach((t) => t.classList.remove("active"));
    this.element.querySelectorAll('.tab-pane[data-group="primary"]').forEach((p) => p.classList.remove("active"));
    tabEl.classList.add("active");
    const pane = this.element.querySelector(`.tab-pane[data-tab="${tabId}"][data-group="primary"]`);
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
    // opposed to onto another specific card, which item-reorder.mjs's own per-card drop
    // handles, or onto an equipped container, which #bindContainerDropTargets' pack-drop
    // handles) means "take it out of whatever container it's packed in" — see
    // actor-sheet.mjs's identical #onDropItem comment for the full rationale.
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

    // A species card (Creature or Race) or a feature (ability/spell) belongs in the
    // Properties tab — equipment (weapons, armor, etc.) must go through the Inventory
    // pane. "Only one species card" is enforced globally by registerClassRaceRules()
    // (module/data/class-race-rules.mjs) regardless of drop source.
    const BIO_TYPES = ["creature", "race", "ability", "spell"];
    if (tab === "bio" && !BIO_TYPES.includes(source.type)) {
      ui.notifications?.warn("В свойства можно перетащить только карточку существа, расы или способность.");
      return;
    }
    if (tab === "anketa" && BIO_TYPES.includes(source.type)) {
      ui.notifications?.warn("Это нужно перетащить во вкладку «Свойства».");
      return;
    }

    await Item.create(source.toObject(), { parent: this.document });
  }

  /* -------------------------------------------- */

  #onOpenItem(event) {
    event.preventDefault();
    const itemId = event.currentTarget.dataset.itemId;
    const item = this.document.items.get(itemId);
    item?.sheet?.render(true);
  }

  /* -------------------------------------------- */

  async #onRemoveItem(event) {
    event.preventDefault();
    const itemId = event.currentTarget.dataset.itemId;
    const item = this.document.items.get(itemId);
    if (item) await item.delete();
  }

  /* -------------------------------------------- */

  async #onNumberInputChange(event) {
    event.stopImmediatePropagation();
    const input = event.currentTarget;
    const name = input.name;
    let value = parseInt(input.value, 10);

    if (Number.isNaN(value)) {
      value = name.startsWith("system.chars.") ? 47 : 0;
    }

    let clamped;
    if (name.startsWith("system.chars.")) {
      clamped = Math.max(1, Math.min(99, value));
    } else if (name.startsWith("system.damage.") || name === "system.dodge.value" || name === "system.fortitude.value") {
      clamped = Math.max(0, value);
    } else {
      clamped = value;
    }

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
        "prototypeToken.texture.src": "icons/svg/mystery-man.svg",
      });
      await this.document.update(update);
    }
  }
}

/* -------------------------------------------- */
/*  ActiveEffect create/delete — patch the DOM instead of a full re-render           */
/* -------------------------------------------- */

/** See actor-sheet.mjs's identical block for the full rationale. preCreateActiveEffect
 *  and preDeleteActiveEffect have different argument shapes, so two separate handlers
 *  rather than one shared by position. */
function _suppressCreateEffectRender(effect, data, options) {
  const sheet = effect.parent?.sheet;
  if (sheet instanceof GODNPCSheet) options.render = false;
}
function _suppressDeleteEffectRender(effect, options) {
  const sheet = effect.parent?.sheet;
  if (sheet instanceof GODNPCSheet) options.render = false;
}
Hooks.on("preCreateActiveEffect", _suppressCreateEffectRender);
Hooks.on("preDeleteActiveEffect", _suppressDeleteEffectRender);

Hooks.on("createActiveEffect", (effect) => {
  const sheet = effect.parent?.sheet;
  if (sheet instanceof GODNPCSheet && sheet.rendered) sheet._patchEffectInsert(effect);
});
Hooks.on("deleteActiveEffect", (effect) => {
  const sheet = effect.parent?.sheet;
  if (sheet instanceof GODNPCSheet && sheet.rendered) sheet._patchEffectRemove(effect.id);
});

/* -------------------------------------------- */
/*  Remote-client resync for render:false updates                                    */
/* -------------------------------------------- */

/** Same fix as actor-sheet.mjs's identical hooks — see the comment there for the full
 *  explanation. Short version: render:false (used throughout this sheet to keep the
 *  clicking client's own scroll position stable) also silently suppresses the automatic
 *  re-render on every OTHER connected client with the same NPC sheet open, since Foundry
 *  broadcasts those update options to everyone. These hooks force a normal re-render for
 *  every client except the one that made the change. */
Hooks.on("updateActor", (actor, changes, options, userId) => {
  if (userId === game.user.id) return;
  const sheet = actor.sheet;
  if (sheet instanceof GODNPCSheet && sheet.rendered) sheet.render();
});
Hooks.on("updateItem", (item, changes, options, userId) => {
  if (userId === game.user.id) return;
  const sheet = item.parent?.sheet;
  if (sheet instanceof GODNPCSheet && sheet.rendered) sheet.render();
});
