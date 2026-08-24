/**
 * GOD Tactical — Armor Item Sheet (ItemSheetV2)
 */

import { GOD } from "../config.mjs";
import { clampRarity, rarityTierName } from "./rarity-pips.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

export class GODArmorSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "item", "armor"],
    position: { width: 620, height: 640 },
    window: { resizable: true, minimizable: false },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/item/armor-sheet.hbs",
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

    // Dropdown options
    context.archetypes = [
      { value: "light", label: "GOD.Armor.ArchetypeLight" },
      { value: "heavy", label: "GOD.Armor.ArchetypeHeavy" },
    ];
    context.subtypes = GOD.ARMOR_SUBTYPES.map((s) => ({
      value: s.key,
      label: `GOD.Armor.Subtype${s.key.charAt(0).toUpperCase()}${s.key.slice(1)}`,
    }));
    context.sizes = [
      { value: "small",  label: "Маленькое" },
      { value: "medium", label: "Среднее" },
      { value: "large",  label: "Большое" },
      { value: "huge",   label: "Огромное" },
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
    context.archetypeLabel    = this.#resolveLabel(context.archetypes, item.system.archetype);
    context.subtypeLabel      = this.#resolveLabel(context.subtypes, item.system.subtype);
    context.sizeLabel          = this.#resolveLabel(context.sizes, item.system.size);
    context.domainLabel = this.#resolveLabel(context.domainOptions, item.system.domain ?? "");
    // Особенности — repeatable {text, activation} entries (items.mjs's featureEntryField,
    // 2026-08-17 redesign).
    context.features = (item.system.features ?? []).map((entry, idx) => ({
      index: idx,
      text: entry.text,
      activation: entry.activation,
      activationLabel: entry.activation ? this.#resolveLabel(context.activationOptions, entry.activation) : "",
    }));

    // Rarity — a number + a single gem icon instead of a colored tier name (see rarity-pips.mjs).
    context.rarityValue = clampRarity(item.system.rarity);
    context.rarityMax = GOD.RARITY_TIERS.length;
    context.rarityTierName = rarityTierName(item.system.rarity, "Armor");

    return context;
  }

  #resolveLabel(list, value) {
    const entry = list.find((e) => e.value === value);
    return entry ? game.i18n.localize(entry.label) : value;
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

    this.element.querySelector(".ws-feature-add")?.addEventListener("click", this.#onAddFeature.bind(this));
    this.element.querySelectorAll(".ws-feature-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveFeature.bind(this));
    });
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

  static async #onSubmitForm(event, form, formData) {
    const submitData = foundry.utils.expandObject(formData.object);
    // features is an array of entries — expandObject turns numeric-keyed form fields into
    // a plain object ({0: ..., 1: ...}), convert it back before saving.
    if (submitData.system?.features) {
      submitData.system.features = Object.values(submitData.system.features);
    }
    await this.document.update(submitData);
  }
}
