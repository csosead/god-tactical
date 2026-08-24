/**
 * GOD Tactical — Tools Item Sheet (ItemSheetV2)
 */

import { GOD } from "../config.mjs";
import { clampRarity, rarityTierName } from "./rarity-pips.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

export class GODToolsSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "item", "tools"],
    position: { width: 560, height: 460 },
    window: { resizable: true, minimizable: false },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/item/tools-sheet.hbs",
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
    // Flat list of every GOD.COMPETENCY_GROUPS entry, category name prefixed for
    // readability — same "Категория · Название" style weapon-sheet.mjs's skillOptions
    // already uses for its own flat cross-category picker (Weapon's `skill` field).
    context.competencyOptions = [
      { value: "", label: "—" },
      ...GOD.COMPETENCY_GROUPS.flatMap((g) =>
        g.competencies.map((name) => ({ value: name, label: `${g.name} · ${name}` }))),
    ];

    context.sizeLabel = this.#resolveLabel(context.sizes, item.system.size);

    // Rarity — a number + a single gem icon instead of a colored tier name (see
    // rarity-pips.mjs). Reuses the generic Item tier-name set (GOD.Item.Rarity*), same
    // as Trophy/Consumable.
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
    // same pattern as weapon/armor/container/trophy/consumable sheets.
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
    await this.document.update(submitData);
  }
}
