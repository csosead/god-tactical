/**
 * GOD Tactical — Weapon Item Sheet (ItemSheetV2)
 */

import { GOD, cellsToMeters, metersToCells, formatMeters } from "../config.mjs";
import { clampRarity, rarityTierName } from "./rarity-pips.mjs";
import { GODRollDialog } from "../rolls/roll-dialog.mjs";
import { dealNpcDamage } from "../rolls/npc-attack.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

const GRANT_REORDER_MIME = "text/god-grant-reorder";

export class GODWeaponSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "item", "weapon"],
    position: { width: 620, height: 640 },
    window: { resizable: true, minimizable: false },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/item/weapon-sheet.hbs",
      scrollable: [".ws-body"],
    },
  };

  _isEditing = false;
  _activeTab = "properties";

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.document;

    context.item = item;
    context.system = item.system;
    context.isEditing = this._isEditing;
    context.activeTab = this._activeTab;
    // Attack button (see #onAttack below) — needs an owning actor either way. A Character
    // needs this card's own skill assigned (that's what actually gets rolled); an
    // NPC/Creature never rolls at all (see npc-attack.mjs), so attackType/damageNature
    // alone are enough to pick which flat damage number to deal.
    const isNpcActor = item.actor?.type === "npc" || item.actor?.type === "creature";
    context.canAttack = !!item.actor && (isNpcActor || !!item.system.skill);
    // Granted Items only makes sense for Weapon — Spell shares this same card/sheet
    // (see items.mjs's weaponCardSchema) but doesn't expose that block.
    context.isSpell = item.type === "spell";

    // Dropdown options
    context.sizes = [
      { value: "",       label: "—" }, // no size — 0 Container slots (GOD.ITEM_SIZE_SLOT_COST)
      { value: "small",  label: "Маленькое" },
      { value: "medium", label: "Среднее" },
      { value: "large",  label: "Большое" },
      { value: "huge",   label: "Огромное" },
    ];
    // Настильный gets the full shape set; Навесной is limited to circle/square (no directional
    // shapes for a lobbed throw). Keys match module/canvas/template-geometry.mjs's shapes.
    const TEMPLATE_SHAPE_OPTIONS = {
      none:     { value: "none",     label: "GOD.Weapon.TemplateShapeNone" },
      line:     { value: "line",     label: "GOD.Weapon.TemplateShapeLine" },
      wideline: { value: "wideline", label: "GOD.Weapon.TemplateShapeWideLine" },
      circle:   { value: "circle",   label: "GOD.Weapon.TemplateShapeCircle" },
      triangle: { value: "triangle", label: "GOD.Weapon.TemplateShapeCone" },
      square:   { value: "square",   label: "GOD.Weapon.TemplateShapeSquare" },
    };
    context.natiskTemplateShapes = ["none", "line", "wideline", "circle", "triangle", "square"]
      .map((key) => TEMPLATE_SHAPE_OPTIONS[key]);
    context.brosokTemplateShapes = ["none", "circle", "square"]
      .map((key) => TEMPLATE_SHAPE_OPTIONS[key]);
    // Per-entry hit-resolution logic (items.mjs's `hitLogic` field) — forward-looking, only
    // one option exists today. Same select markup pattern as templateShape, just one value.
    const HIT_LOGIC_OPTIONS = {
      base: { value: "base", label: "GOD.Weapon.HitLogicBase" },
    };
    context.hitLogicOptions = ["base"].map((key) => HIT_LOGIC_OPTIONS[key]);
    context.handOptions = [
      { value: "",          label: "GOD.Weapon.HandsNone" },
      { value: "main",      label: "GOD.Weapon.HandsMain" },
      { value: "off",       label: "GOD.Weapon.HandsOff"  },
      { value: "two",       label: "GOD.Weapon.HandsTwo"  },
      { value: "versatile", label: "GOD.Weapon.HandsVersatile" },
      { value: "verbal",    label: "GOD.Weapon.HandsVerbal" },
    ];
    context.damageTypes = [
      { value: "", label: "GOD.DamageType.None" },
      ...GOD.DAMAGE_TYPES.map((d) => ({
        value: d.key,
        label: `GOD.DamageType.${d.key.charAt(0).toUpperCase()}${d.key.slice(1)}`,
      })),
    ];
    // Physical/metaphysical damage nature (GOD.DAMAGE_NATURES, config.mjs) — combines
    // with attackTypes below (melee/ranged) for the physical-melee/physical-ranged/
    // metaphysical-melee/metaphysical-ranged split.
    context.damageNatures = [
      { value: "", label: "GOD.DamageNature.None" },
      ...GOD.DAMAGE_NATURES.map((d) => ({
        value: d.key,
        label: `GOD.DamageNature.${d.key.charAt(0).toUpperCase()}${d.key.slice(1)}`,
      })),
    ];
    // Натиск/Залп — which base action this weapon's attacks log as (see items.mjs's
    // attackType doc comment). Independent of the Настильный/Навесной trajectory lists
    // below. "" is for cards with nothing to attack with at all (pure passives/utility).
    context.attackTypes = [
      { value: "",       label: "GOD.Weapon.AttackTypeNone" },
      { value: "melee",  label: "GOD.Weapon.AttackTypeMelee" },
      { value: "ranged", label: "GOD.Weapon.AttackTypeRanged" },
      { value: "self",   label: "GOD.Weapon.AttackTypeSelf" },
    ];
    // Flat list of all 16 skills, category name prefixed for readability — not i18n keys,
    // the names come straight out of GOD.SKILL_MAP (see #resolveSkillLabel below).
    context.skillOptions = [
      { value: "", label: "—" },
      ...Object.values(GOD.SKILL_MAP).flatMap((cat) =>
        cat.skills.map((s) => ({ value: s.key, label: `${cat.name} · ${s.name}` }))),
    ];
    // Spell-only header field (see items.mjs's SpellDataModel) — names are plain strings
    // out of GOD.STATUS_EFFECTS, not i18n keys, same as skillOptions above.
    context.statusEffectOptions = [
      { value: "", label: "—" },
      ...GOD.STATUS_EFFECTS.map((s) => ({ value: s.id, label: s.name })),
    ];
    // Per-Feature activation-stage select (items.mjs's featureEntryField) — one choice per
    // entry, replaces the old whole-card activationTypes checkbox group (2026-08-17).
    context.activationOptions = [
      { value: "", label: "—" },
      ...GOD.ACTIVATION_TYPES.map((key) => ({
        value: key,
        label: `GOD.Item.Activation${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      })),
    ];
    // Header field (see items.mjs's domain doc comment) — single-select.
    context.domainOptions = [
      { value: "", label: "—" },
      ...GOD.ITEM_DOMAINS.map((key) => ({
        value: key,
        label: `GOD.Item.Domain${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      })),
    ];

    // Resolved labels for display mode
    context.sizeLabel       = this.#resolveLabel(context.sizes, item.system.size);
    context.handsLabel      = this.#resolveLabel(context.handOptions, item.system.hands);
    context.damageTypeLabel = this.#resolveLabel(context.damageTypes, item.system.damageType);
    // Compact Latin-jargon chip ("PHY"/"MPH") — see GOD.DAMAGE_NATURES' abbr doc comment.
    context.damageNatureAbbr = GOD.DAMAGE_NATURES.find((d) => d.key === item.system.damageNature)?.abbr ?? "—";
    context.skillLabel      = this.#resolveSkillLabel(item.system.skill);
    context.attackTypeLabel = this.#resolveLabel(context.attackTypes, item.system.attackType);
    // View-mode summary for the two ranged-only flight flags (items.mjs's canHitLowFlight/
    // canHitHighFlight) — only rendered at all when attackType is "ranged" (see the hbs).
    context.flightBandsLabel = [
      item.system.canHitLowFlight ? game.i18n.localize("GOD.Weapon.CanHitLowFlight") : null,
      item.system.canHitHighFlight ? game.i18n.localize("GOD.Weapon.CanHitHighFlight") : null,
    ].filter(Boolean).join(", ") || game.i18n.localize("GOD.Weapon.CanHitFlightNone");
    context.statusEffectLabel = this.#resolveLabel(context.statusEffectOptions, item.system.statusEffect ?? "");
    context.domainLabel = this.#resolveLabel(context.domainOptions, item.system.domain ?? "");
    // Особенности — repeatable {text, activation} entries (items.mjs's featureEntryField,
    // 2026-08-17 redesign). activationLabel feeds the VIEW-mode tag; the select itself
    // (edit mode) is built straight off activationOptions/entry.activation in the hbs.
    context.features = (item.system.features ?? []).map((entry, idx) => ({
      index: idx,
      text: entry.text,
      activation: entry.activation,
      activationLabel: entry.activation ? this.#resolveLabel(context.activationOptions, entry.activation) : "",
    }));

    // Настильный and Навесной each hold a LIST of entries — zero, one, or several, each with
    // its own range bonus and template. Numbered ("Настильный 1/2/…") only once there's more
    // than one, so the common single-entry case doesn't show a redundant "1".
    const allShapes = Object.values(TEMPLATE_SHAPE_OPTIONS);
    const allHitLogics = Object.values(HIT_LOGIC_OPTIONS);
    // Range & template size are stored in cells but shown/entered in metres (1 cell = 0.5 м).
    // *M fields feed the number inputs (metres), *Label fields feed the read-only display.
    const buildEntries = (list, modeLabel) => list.map((entry, idx) => ({
      index: idx,
      label: list.length > 1 ? `${modeLabel} ${idx + 1}` : modeLabel,
      rangeModifier: entry.rangeModifier,
      rangeModifierM: cellsToMeters(entry.rangeModifier),
      rangeModifierLabel: formatMeters(entry.rangeModifier),
      templateShape: entry.templateShape,
      templateSize: entry.templateSize,
      templateSizeM: cellsToMeters(entry.templateSize),
      templateSizeLabel: formatMeters(entry.templateSize),
      templateShapeLabel: this.#resolveLabel(allShapes, entry.templateShape),
      hasTemplate: entry.templateShape !== "none",
      // Only circle/square have a separate size — every other shape's reach is fully
      // described by rangeModifier alone (see weapon-template-drop.mjs).
      hasTemplateSize: entry.templateShape === "circle" || entry.templateShape === "square",
      hitLogic: entry.hitLogic,
      hitLogicLabel: this.#resolveLabel(allHitLogics, entry.hitLogic),
    }));
    context.natiskEntries = buildEntries(item.system.natisk, game.i18n.localize("GOD.Weapon.VerbNatisk"));
    context.brosokEntries = buildEntries(item.system.brosok, game.i18n.localize("GOD.Weapon.VerbBrosok"));

    // Abilities (or anything else) attached to this card — same drag-drop pattern as a
    // Class's grantedItems (see class-sheet.mjs), but reference-only here: nothing
    // auto-copies onto an actor just because this weapon/spell is in their inventory
    // (see items.mjs's grantedItemsField doc comment).
    context.grantedItems = (item.system.grantedItems ?? []).map((entry, idx) => ({
      ...entry,
      idx,
      typeLabel: this.#typeLabel(entry.type),
    }));

    // Rarity — a number + a single gem icon instead of a colored tier name (see rarity-pips.mjs).
    context.rarityValue = clampRarity(item.system.rarity);
    context.rarityMax = GOD.RARITY_TIERS.length;
    context.rarityTierName = rarityTierName(item.system.rarity, "Weapon");

    return context;
  }

  #resolveLabel(list, value) {
    const entry = list.find((e) => e.value === value);
    return entry ? game.i18n.localize(entry.label) : value;
  }

  /** Skill names are plain strings from GOD.SKILL_MAP, not i18n keys — resolve without localize(). */
  #resolveSkillLabel(skillKey) {
    if (!skillKey) return "";
    for (const cat of Object.values(GOD.SKILL_MAP)) {
      const skill = cat.skills.find((s) => s.key === skillKey);
      if (skill) return skill.name;
    }
    return skillKey;
  }

  /** Same helper as class-sheet.mjs's #typeLabel — localizes an item type key
   *  ("ability" → "Способность") via GOD.Item.Types, falling back to the raw key. */
  #typeLabel(type) {
    if (!type) return "";
    const key = `GOD.Item.Types.${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    const label = game.i18n.localize(key);
    return label === key ? type : label;
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender(context, options);

    this.element.querySelectorAll(".ws-tab[data-tab]").forEach((tab) => {
      tab.addEventListener("click", this.#onTabClick.bind(this));
    });

    // Edit button injected into window header, left of the first control button
    const header = this.element.querySelector(".window-header");
    if (header) {
      let btn = header.querySelector(".ws-edit-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ws-edit-btn";
        btn.addEventListener("click", this.#onToggleEdit.bind(this));
        const firstCtrl = header.querySelector("[data-action='toggleControls'], [data-action='close']");
        if (firstCtrl) header.insertBefore(btn, firstCtrl);
        else header.appendChild(btn);
      }
      btn.title = this._isEditing ? game.i18n.localize("GOD.Sheet.Done") : game.i18n.localize("GOD.Sheet.Edit");
      btn.className = `ws-edit-btn${this._isEditing ? " active" : ""}`;
      btn.innerHTML = `<i class="fa-solid ${this._isEditing ? "fa-check" : "fa-pencil"}"></i>`;
    }

    this.element.querySelectorAll(".ws-range-add").forEach((btn) => {
      btn.addEventListener("click", this.#onAddRangeEntry.bind(this));
    });
    this.element.querySelectorAll(".ws-range-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveRangeEntry.bind(this));
    });

    this.element.querySelector(".ws-attack-btn")?.addEventListener("click", this.#onAttack.bind(this));

    this.element.querySelector(".ws-feature-add")?.addEventListener("click", this.#onAddFeature.bind(this));
    this.element.querySelectorAll(".ws-feature-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveFeature.bind(this));
    });

    // Granted items (abilities dropped onto this card) — same wiring as class-sheet.mjs
    const dropzone = this.element.querySelector(".cls-grant-dropzone");
    if (dropzone) {
      dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); });
      dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
      dropzone.addEventListener("drop", this.#onDropGrantedItem.bind(this));
    }
    this.element.querySelectorAll(".cls-grant-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveGrantedItem.bind(this));
    });
    this.element.querySelectorAll(".cls-grant-name").forEach((el) => {
      el.addEventListener("dblclick", this.#onOpenGrantedItem.bind(this));
    });
    if (this._isEditing) {
      this.element.querySelectorAll(".cls-grant-row[data-idx]").forEach((row) => {
        row.addEventListener("dragstart", (e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(GRANT_REORDER_MIME, row.dataset.idx);
          row.classList.add("is-dragging");
        });
        row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
        row.addEventListener("dragover", (e) => {
          if (!e.dataTransfer.types.includes(GRANT_REORDER_MIME)) return;
          e.preventDefault();
          e.stopPropagation();
          row.classList.add("drag-over-row");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drag-over-row"));
        row.addEventListener("drop", this.#onReorderGrantedItem.bind(this));
      });
    }
  }

  /* -------------------------------------------- */

  #onTabClick(event) {
    const tabId = event.currentTarget.dataset.tab;
    this._activeTab = tabId;

    this.element.querySelectorAll(".ws-tab[data-tab]").forEach((t) => t.classList.remove("active"));
    this.element.querySelectorAll(".ws-pane[data-tab]").forEach((p) => p.classList.remove("active"));

    event.currentTarget.classList.add("active");
    const pane = this.element.querySelector(`.ws-pane[data-tab="${tabId}"]`);
    if (pane) pane.classList.add("active");
  }

  /* -------------------------------------------- */

  #onToggleEdit(event) {
    event.preventDefault();
    this._isEditing = !this._isEditing;
    this.render();
  }

  /* -------------------------------------------- */

  async #onAddRangeEntry(event) {
    event.preventDefault();
    const mode = event.currentTarget.dataset.mode; // "natisk" | "brosok"
    const entries = [...this.document.system[mode], { rangeModifier: 0, templateShape: "none", templateSize: 1 }];
    await this.document.update({ [`system.${mode}`]: entries });
  }

  async #onRemoveRangeEntry(event) {
    event.preventDefault();
    const mode = event.currentTarget.dataset.mode;
    const idx = Number(event.currentTarget.dataset.idx);
    const entries = this.document.system[mode].filter((_, i) => i !== idx);
    await this.document.update({ [`system.${mode}`]: entries });
  }

  /* -------------------------------------------- */

  /** "Атаковать" — the roll now STARTS from the weapon/spell card (2026-08-19) instead
   *  of only being reachable by clicking a skill row on the actor sheet (which has no
   *  idea which weapon, if any, is involved). Resolves the actor's current rank in this
   *  card's own `system.skill` and opens the same GODRollDialog actor-sheet.mjs's
   *  #onSkillRollClick uses, but ALSO passes this item's attackType/damageNature so the
   *  attack-damage block (roll-dialog.mjs, via combat-damage.mjs's classBaseField) reads
   *  the correct one of the Class item's 4 base-damage fields.
   *
   *  An NPC/Creature-owned card never rolls (COMBAT-REDESIGN: "НПС не бросают никогда")
   *  — it goes straight to dealNpcDamage's flat-number confirm dialog instead, still
   *  passing attackType/damageNature so it reads the matching one of the actor's own 4
   *  flat damage fields (module/combat/combat-damage.mjs's npcDamageField). */
  async #onAttack(event) {
    event.preventDefault();
    const item = this.document;
    const actor = item.actor;
    if (!actor) return;

    if (actor.type === "npc" || actor.type === "creature") {
      dealNpcDamage(actor, { attackType: item.system.attackType, damageNature: item.system.damageNature });
      return;
    }

    const skillKey = item.system.skill;
    if (!skillKey) return;

    const catEntry = Object.values(GOD.SKILL_MAP).find((c) => c.skills.some((s) => s.key === skillKey));
    const skill = catEntry?.skills.find((s) => s.key === skillKey);
    const name = skill?.name || skillKey;
    const charKey = catEntry?.charKey;
    const flaws = charKey ? (actor.system.charFlaws?.[charKey] ?? 0) : 0;
    const value = actor.system.skills?.[skillKey] ?? 0;
    const classItem = actor.items.find((it) => it.type === "class");
    const raceItem = actor.items.find((it) => it.type === "race");

    new GODRollDialog(actor, {
      name,
      value,
      isChar: false,
      charKey,
      skillKey,
      flaws,
      classItem: classItem ? classItem.system : null,
      raceItem: raceItem ? raceItem.system : null,
      attackType: item.system.attackType,
      damageNature: item.system.damageNature,
    }).render(true);
  }

  /* -------------------------------------------- */

  async #onAddFeature(event) {
    event.preventDefault();
    const entries = [...(this.document.system.features ?? []), { text: "", activation: "" }];
    await this.document.update({ "system.features": entries });
  }

  async #onRemoveFeature(event) {
    event.preventDefault();
    const idx = Number(event.currentTarget.dataset.idx);
    const entries = this.document.system.features.filter((_, i) => i !== idx);
    await this.document.update({ "system.features": entries });
  }

  /* -------------------------------------------- */

  /** A card living inside a locked compendium pack silently refuses to update — Foundry
   *  doesn't surface an error for it, it just no-ops. Catch that up front with a clear
   *  message instead of letting drops/edits appear to do nothing (same as class-sheet.mjs). */
  #checkUnlocked() {
    const packId = this.document.pack;
    if (!packId) return true;
    const pack = game.packs.get(packId);
    if (pack?.locked) {
      ui.notifications?.warn("Компендиум заблокирован — разблокируйте его (иконка замка в списке компендиумов), чтобы редактировать этот предмет.");
      return false;
    }
    return true;
  }

  /** Drop an Ability/whatever item onto this card to add it to the granted-items list —
   *  a snapshot (name/img/type) is stored for display; the uuid is kept so it can be
   *  opened later. Unlike Class's grantedItems, nothing here is auto-copied onto an
   *  actor — see items.mjs's grantedItemsField doc comment. */
  async #onDropGrantedItem(event) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.classList.remove("drag-over");
    if (!this.#checkUnlocked()) return;

    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (data.type !== "Item") return;

    const source = await fromUuid(data.uuid);
    if (!source) return;

    const grantedItems = [
      ...this.document.system.grantedItems,
      { uuid: source.uuid, name: source.name, img: source.img, type: source.type },
    ];
    await this.document.update({ "system.grantedItems": grantedItems });
  }

  async #onRemoveGrantedItem(event) {
    event.preventDefault();
    if (!this.#checkUnlocked()) return;
    const idx = Number(event.currentTarget.dataset.idx);
    const grantedItems = this.document.system.grantedItems.filter((_, i) => i !== idx);
    await this.document.update({ "system.grantedItems": grantedItems });
  }

  async #onReorderGrantedItem(event) {
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget;
    row.classList.remove("drag-over-row");
    if (!this.#checkUnlocked()) return;

    const fromIdx = Number(event.dataTransfer.getData(GRANT_REORDER_MIME));
    const toIdx = Number(row.dataset.idx);
    if (Number.isNaN(fromIdx) || Number.isNaN(toIdx) || fromIdx === toIdx) return;

    const grantedItems = [...this.document.system.grantedItems];
    const [moved] = grantedItems.splice(fromIdx, 1);
    grantedItems.splice(toIdx, 0, moved);
    await this.document.update({ "system.grantedItems": grantedItems });
  }

  async #onOpenGrantedItem(event) {
    event.preventDefault();
    const uuid = event.currentTarget.dataset.uuid;
    if (!uuid) return;
    const source = await fromUuid(uuid);
    if (!source) {
      ui.notifications?.warn("Не удалось найти предмет — возможно, он был удалён или перемещён.");
      return;
    }
    source.sheet?.render(true);
  }

  /* -------------------------------------------- */

  static async #onSubmitForm(event, form, formData) {
    const submitData = foundry.utils.expandObject(formData.object);
    // natisk/brosok are arrays of entries — expandObject turns numeric-keyed form
    // fields into plain objects ({0: ..., 1: ...}), so convert them back before saving
    // (see class-sheet.mjs). The range/size inputs hold METRES; convert back to whole
    // cells (the stored unit) here.
    for (const mode of ["natisk", "brosok"]) {
      if (!submitData.system?.[mode]) continue;
      submitData.system[mode] = Object.values(submitData.system[mode]).map((e) => ({
        ...e,
        rangeModifier: metersToCells(e.rangeModifier),
        templateSize: Math.max(1, metersToCells(e.templateSize)),
      }));
    }
    // features is also an array of entries — same numeric-keyed-object-back-to-array
    // fixup as natisk/brosok above (see class-sheet.mjs).
    if (submitData.system?.features) {
      submitData.system.features = Object.values(submitData.system.features);
    }
    await this.document.update(submitData);
  }
}
