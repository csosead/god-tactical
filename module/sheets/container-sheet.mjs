/**
 * GOD Tactical — Container Item Sheet (ItemSheetV2)
 */

import { GOD } from "../config.mjs";
import { clampRarity, rarityTierName } from "./rarity-pips.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

export class GODContainerSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "item", "container"],
    position: { width: 620, height: 640 },
    window: { resizable: true, minimizable: false },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/item/container-sheet.hbs",
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
    context.containerTypes = [
      { value: "deep",  label: "Deep Storage Container" },
      { value: "quick", label: "Quick Slot Container" },
    ];
    context.sizes = [
      { value: "small",  label: "Маленькое" },
      { value: "medium", label: "Среднее" },
      { value: "large",  label: "Большое" },
      { value: "huge",   label: "Огромное" },
    ];

    // Resolved labels for display mode
    context.containerTypeLabel = this.#resolveLabel(context.containerTypes, item.system.containerType);
    context.sizeLabel = this.#resolveLabel(context.sizes, item.system.size);

    // Rarity — a number + a single gem icon instead of a colored tier name (see
    // rarity-pips.mjs). Reuses Armor's GOD.Armor.Rarity* loc keys, not dedicated
    // Container ones — this sheet's old hardcoded rarity text ("Очень
    // распространена"/"Распространена"/…) was byte-identical to Armor's already (both
    // feminine-gendered nouns).
    context.rarityValue = clampRarity(item.system.rarity);
    context.rarityMax = GOD.RARITY_TIERS.length;
    context.rarityTierName = rarityTierName(item.system.rarity, "Armor");

    return context;
  }

  #resolveLabel(list, value) {
    const entry = list.find((e) => e.value === value);
    return entry ? entry.label : value;
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
      btn.title = this._isEditing ? "Готово" : "Редактировать";
      btn.className = `ws-edit-btn${this._isEditing ? " active" : ""}`;
      btn.innerHTML = `<i class="fa-solid ${this._isEditing ? "fa-check" : "fa-pencil"}"></i>`;
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

  static async #onSubmitForm(event, form, formData) {
    const submitData = foundry.utils.expandObject(formData.object);
    await this.document.update(submitData);
  }
}
