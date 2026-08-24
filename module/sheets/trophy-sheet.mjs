/**
 * GOD Tactical — Trophy Item Sheet (ItemSheetV2)
 */

import { GOD } from "../config.mjs";
import { clampRarity, rarityTierName } from "./rarity-pips.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

export class GODTrophySheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "item", "trophy"],
    position: { width: 560, height: 460 },
    window: { resizable: true, minimizable: false },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/item/trophy-sheet.hbs",
      scrollable: [".ws-body"],
    },
  };

  _isEditing = false;

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.document;

    context.item = item;
    context.system = item.system;
    context.isEditing = this._isEditing;

    context.sizes = [
      { value: "small",  label: "Маленькое" },
      { value: "medium", label: "Среднее" },
      { value: "large",  label: "Большое" },
      { value: "huge",   label: "Огромное" },
    ];
    // What kind of trophy this is (luxury item, art, relic, …).
    context.categories = [
      { value: "luxury",     label: "GOD.Item.Trophy.CategoryLuxury" },
      { value: "art",        label: "GOD.Item.Trophy.CategoryArt" },
      { value: "relics",     label: "GOD.Item.Trophy.CategoryRelics" },
      { value: "jewelry",    label: "GOD.Item.Trophy.CategoryJewelry" },
      { value: "antiques",   label: "GOD.Item.Trophy.CategoryAntiques" },
      { value: "living",     label: "GOD.Item.Trophy.CategoryLiving" },
      { value: "alchemical", label: "GOD.Item.Trophy.CategoryAlchemical" },
    ];

    context.sizeLabel     = this.#resolveLabel(context.sizes, item.system.size);
    context.categoryLabel = game.i18n.localize(
      this.#resolveLabel(context.categories, item.system.category)
    );

    // Особенности/Features — repeatable {text, activation} entries (items.mjs's
    // featureEntryField, 2026-08-17 redesign). Trophy never had a whole-card activation
    // checkbox group (a trophy isn't "activated"), but each Feature entry still gets the
    // same per-stage select as every other card type, for consistency.
    context.activationOptions = [
      { value: "", label: "—" },
      ...GOD.ACTIVATION_TYPES.map((key) => ({
        value: key,
        label: `GOD.Item.Activation${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      })),
    ];
    context.features = (item.system.features ?? []).map((entry, idx) => ({
      index: idx,
      text: entry.text,
      activation: entry.activation,
      activationLabel: entry.activation ? game.i18n.localize(this.#resolveLabel(context.activationOptions, entry.activation)) : "",
    }));

    // Rarity — a number + a single gem icon instead of a colored tier name (see
    // rarity-pips.mjs). Reuses the generic Item tier-name set (GOD.Item.Rarity*), same
    // as the old Consumable/Trophy shared sheet used before Trophy got this dedicated one.
    context.rarityValue = clampRarity(item.system.rarity);
    context.rarityMax = GOD.RARITY_TIERS.length;
    context.rarityTierName = rarityTierName(item.system.rarity, "Item");

    return context;
  }

  #resolveLabel(list, value) {
    const entry = list.find((e) => e.value === value);
    return entry ? entry.label : value;
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender(context, options);

    // Edit button injected into window header, left of the first control button —
    // same pattern as weapon/armor/container sheets.
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
      btn.title = this._isEditing ? "Готово" : "Редактировать";
      btn.className = `ws-edit-btn${this._isEditing ? " active" : ""}`;
      btn.innerHTML = `<i class="fa-solid ${this._isEditing ? "fa-check" : "fa-pencil"}"></i>`;
    }

    this.element.querySelector(".ws-feature-add")?.addEventListener("click", this.#onAddFeature.bind(this));
    this.element.querySelectorAll(".ws-feature-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveFeature.bind(this));
    });
  }

  /* -------------------------------------------- */

  #onToggleEdit(event) {
    event.preventDefault();
    this._isEditing = !this._isEditing;
    this.render();
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
    // features is an array of entries — expandObject turns numeric-keyed form fields into
    // a plain object ({0: ..., 1: ...}), convert it back before saving.
    if (submitData.system?.features) {
      submitData.system.features = Object.values(submitData.system.features);
    }
    await this.document.update(submitData);
  }
}
