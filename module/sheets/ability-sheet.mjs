/**
 * GOD Tactical — Ability Item Sheet (ItemSheetV2)
 */

import { GOD, cellsToMeters, metersToCells, formatMeters } from "../config.mjs";
import { showPopupMenu } from "./item-context-menu.mjs";
import { GODRollDialog } from "../rolls/roll-dialog.mjs";
import { dealNpcDamage } from "../rolls/npc-attack.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

export class GODAbilitySheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "item", "ability"],
    position: { width: 620, height: 660 },
    window: { resizable: true, minimizable: false },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/item/ability-sheet.hbs",
      scrollable: [".ws-body"],
    },
  };

  _isEditing = false;
  _activeTab = "description";

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.document;
    const sys = item.system;

    context.item = item;
    context.system = sys;
    context.isEditing = this._isEditing;
    context.activeTab = this._activeTab;
    // Attack button (see #onAttack below, mirrors weapon-sheet.mjs) — needs an owning
    // actor either way; a Character also needs this card's own skill assigned, an
    // NPC/Creature never rolls at all so attackType/damageNature alone suffice.
    const isNpcActor = item.actor?.type === "npc" || item.actor?.type === "creature";
    context.canAttack = !!item.actor && (isNpcActor || !!sys.skill);

    context.subtypeOptions = GOD.ABILITY_SUBTYPES.map((s) => ({
      value: s.key,
      label: `GOD.Ability.Subtype${s.key.charAt(0).toUpperCase()}${s.key.slice(1)}`,
    }));
    context.activationOptions = [
      { value: "passive", label: "GOD.Ability.Passive" },
      { value: "active",  label: "GOD.Ability.Active" },
    ];
    context.recoveryModeOptions = [
      { value: "stabilize", label: "GOD.Ability.RecoveryStabilize" },
      { value: "period",    label: "GOD.Ability.RecoveryPeriod" },
      { value: "none",      label: "GOD.Ability.RecoveryNone" },
    ];
    context.periodOptions = [
      { value: "scene", label: "GOD.Ability.PeriodScene" },
      { value: "week",  label: "GOD.Ability.PeriodWeek" },
      { value: "month", label: "GOD.Ability.PeriodMonth" },
      { value: "year",  label: "GOD.Ability.PeriodYear" },
      { value: "none",  label: "GOD.Ability.PeriodNone" },
    ];

    // -- Weapon-shared combat parameters (mirrors weapon-sheet.mjs) --
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
    // metaphysical-melee/metaphysical-ranged split (mirrors weapon-sheet.mjs).
    context.damageNatures = [
      { value: "", label: "GOD.DamageNature.None" },
      ...GOD.DAMAGE_NATURES.map((d) => ({
        value: d.key,
        label: `GOD.DamageNature.${d.key.charAt(0).toUpperCase()}${d.key.slice(1)}`,
      })),
    ];
    context.skillOptions = [
      { value: "", label: "—" },
      ...Object.values(GOD.SKILL_MAP).flatMap((cat) =>
        cat.skills.map((s) => ({ value: s.key, label: `${cat.name} · ${s.name}` }))),
    ];
    // Натиск/Залп — which base action this ability's attacks log as (see items.mjs's
    // attackType doc comment / weapon-sheet.mjs's identical context field). Independent
    // of the Настильный/Навесной trajectory lists below. "" is for cards with nothing to
    // attack with at all (pure passives/utility).
    context.attackTypes = [
      { value: "",       label: "GOD.Weapon.AttackTypeNone" },
      { value: "melee",  label: "GOD.Weapon.AttackTypeMelee" },
      { value: "ranged", label: "GOD.Weapon.AttackTypeRanged" },
      { value: "self",   label: "GOD.Weapon.AttackTypeSelf" },
    ];
    // Up to GOD.ABILITY_MAX_STATUS_EFFECTS chips (see items.mjs's statusEffects doc
    // comment) — "+" popup below (see #onPickStatusEffect) offers whatever's not
    // already picked, and disappears once the cap is reached. Names are plain strings
    // out of GOD.STATUS_EFFECTS, not i18n keys, same as skillOptions above.
    context.statusEffects = (sys.statusEffects ?? []).map((id, idx) => ({
      id, idx, name: GOD.STATUS_EFFECTS.find((s) => s.id === id)?.name ?? id,
    }));
    context.canAddStatusEffect = context.statusEffects.length < GOD.ABILITY_MAX_STATUS_EFFECTS;
    context.statusEffectHint = game.i18n.format("GOD.Item.StatusEffectHint", { max: GOD.ABILITY_MAX_STATUS_EFFECTS });
    // Per-Feature activation-stage select (items.mjs's featureEntryField) — one choice per
    // entry, replaces the old whole-card activationTypes checkbox group (2026-08-17). Named
    // featureActivationOptions (not activationOptions) — that name's already taken above by
    // the UNRELATED passive/active `system.activation` select.
    context.featureActivationOptions = [
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

    context.handsLabel      = this.#resolveLabel(context.handOptions, sys.hands);
    context.damageTypeLabel = this.#resolveLabel(context.damageTypes, sys.damageType);
    // Compact Latin-jargon chip ("PHY"/"MPH") — see GOD.DAMAGE_NATURES' abbr doc comment.
    context.damageNatureAbbr = GOD.DAMAGE_NATURES.find((d) => d.key === sys.damageNature)?.abbr ?? "—";
    context.skillLabel      = this.#resolveSkillLabel(sys.skill);
    context.attackTypeLabel = this.#resolveLabel(context.attackTypes, sys.attackType);
    // View-mode summary for the two ranged-only flight flags — see weapon-sheet.mjs's
    // identical field (items.mjs's canHitLowFlight/canHitHighFlight doc comment).
    context.flightBandsLabel = [
      sys.canHitLowFlight ? game.i18n.localize("GOD.Weapon.CanHitLowFlight") : null,
      sys.canHitHighFlight ? game.i18n.localize("GOD.Weapon.CanHitHighFlight") : null,
    ].filter(Boolean).join(", ") || game.i18n.localize("GOD.Weapon.CanHitFlightNone");
    context.statusEffectLabel = context.statusEffects.length
      ? context.statusEffects.map((s) => s.name).join(", ")
      : "—";
    context.domainLabel = this.#resolveLabel(context.domainOptions, sys.domain ?? "");
    // Особенности — repeatable {text, activation} entries (items.mjs's featureEntryField,
    // 2026-08-17 redesign). Each entry's `activation` is unrelated to this ability's own
    // passive/active `system.activation` field above.
    context.features = (sys.features ?? []).map((entry, idx) => ({
      index: idx,
      text: entry.text,
      activation: entry.activation,
      activationLabel: entry.activation ? this.#resolveLabel(context.featureActivationOptions, entry.activation) : "",
    }));

    const allShapes = Object.values(TEMPLATE_SHAPE_OPTIONS);
    const allHitLogics = Object.values(HIT_LOGIC_OPTIONS);
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
    context.natiskEntries = buildEntries(sys.natisk, game.i18n.localize("GOD.Weapon.VerbNatisk"));
    context.brosokEntries = buildEntries(sys.brosok, game.i18n.localize("GOD.Weapon.VerbBrosok"));

    context.isActive    = sys.activation === "active";
    context.isStabilize = sys.recoveryMode === "stabilize";
    context.isPeriod    = sys.recoveryMode === "period";

    // Resolved labels for view (non-edit) mode
    context.subtypeLabel      = this.#resolveLabel(context.subtypeOptions, sys.subtype);
    context.activationLabel   = this.#resolveLabel(context.activationOptions, sys.activation);
    context.recoveryModeLabel = this.#resolveLabel(context.recoveryModeOptions, sys.recoveryMode);
    context.periodLabel       = this.#resolveLabel(context.periodOptions, sys.recoveryPeriod);

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

    this.element.querySelectorAll(".ws-status-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveStatusEffect.bind(this));
    });
    this.element.querySelector(".ws-status-add-btn")?.addEventListener("click", this.#onPickStatusEffect.bind(this));

    this.element.querySelector(".ws-attack-btn")?.addEventListener("click", this.#onAttack.bind(this));

    this.element.querySelector(".ws-feature-add")?.addEventListener("click", this.#onAddFeature.bind(this));
    this.element.querySelectorAll(".ws-feature-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveFeature.bind(this));
    });
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

  /** "+" button next to the status-effect chips — a popup listing every
   *  GOD.STATUS_EFFECTS entry not already picked (picking one twice would be a
   *  pointless duplicate). Hidden once GOD.ABILITY_MAX_STATUS_EFFECTS are already
   *  picked (see the template's canAddStatusEffect gate), but guarded here too in case
   *  it's still in the DOM from before a cap-lowering edit elsewhere. */
  #onPickStatusEffect(event) {
    event.preventDefault();
    const current = this.document.system.statusEffects ?? [];
    if (current.length >= GOD.ABILITY_MAX_STATUS_EFFECTS) return;
    const entries = GOD.STATUS_EFFECTS
      .filter((s) => !current.includes(s.id))
      .map((s) => ({
        label: s.name,
        icon: "fa-disease",
        onClick: () => this.#addStatusEffect(s.id),
      }));
    showPopupMenu(entries, event.clientX, event.clientY);
  }

  async #addStatusEffect(id) {
    const statusEffects = [...(this.document.system.statusEffects ?? []), id];
    await this.document.update({ "system.statusEffects": statusEffects });
  }

  async #onRemoveStatusEffect(event) {
    event.preventDefault();
    const idx = Number(event.currentTarget.dataset.idx);
    const statusEffects = (this.document.system.statusEffects ?? []).filter((_, i) => i !== idx);
    await this.document.update({ "system.statusEffects": statusEffects });
  }

  /* -------------------------------------------- */

  /** "Атаковать" — see weapon-sheet.mjs's identical #onAttack for the full doc comment
   *  (including the NPC/Creature branch); same shape, just reading this card's own
   *  skill/attackType/damageNature fields. */
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

  static async #onSubmitForm(event, form, formData) {
    const submitData = foundry.utils.expandObject(formData.object);
    // No recovery condition → no period either. The period <select> is hidden once
    // recoveryMode is "none" (see ability-sheet.hbs), so it never appears in submitData
    // on its own — force it here rather than leaving the old period value stuck.
    if (submitData.system?.recoveryMode === "none") {
      submitData.system.recoveryPeriod = "none";
    }
    // natisk/brosok are arrays of entries — expandObject turns numeric-keyed form
    // fields into plain objects ({0: ..., 1: ...}), so convert them back before saving.
    // The range/size inputs hold METRES; convert back to whole cells (the stored unit) here.
    for (const mode of ["natisk", "brosok"]) {
      if (!submitData.system?.[mode]) continue;
      submitData.system[mode] = Object.values(submitData.system[mode]).map((e) => ({
        ...e,
        rangeModifier: metersToCells(e.rangeModifier),
        templateSize: Math.max(1, metersToCells(e.templateSize)),
      }));
    }
    // features is also an array of entries — same numeric-keyed-object-back-to-array
    // fixup as natisk/brosok above.
    if (submitData.system?.features) {
      submitData.system.features = Object.values(submitData.system.features);
    }
    await this.document.update(submitData);
  }
}
