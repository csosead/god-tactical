/**
 * GOD Tactical — Creature Item Sheet (ItemSheetV2)
 * Bestiary equivalent of the Race sheet — Размер, Жизни, Вес.
 */

const { HandlebarsApplicationMixin } = foundry.applications.api;

export class GODCreatureSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "item", "creature"],
    position: { width: 560, height: 600 },
    window: { resizable: true, minimizable: false },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/item/creature-sheet.hbs",
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
      { value: "swarm",            label: "GOD.Race.SizeSwarm" },
      { value: "small",            label: "GOD.Race.SizeSmall" },
      { value: "medium",           label: "GOD.Race.SizeMedium" },
      { value: "large",            label: "GOD.Race.SizeLarge" },
      { value: "veryLarge",        label: "GOD.Race.SizeVeryLarge" },
      { value: "incrediblyLarge",  label: "GOD.Race.SizeIncrediblyLarge" },
    ];
    context.weights = [
      { value: "weightless",        label: "GOD.Race.WeightWeightless" },
      { value: "light",             label: "GOD.Race.WeightLight" },
      { value: "medium",            label: "GOD.Race.WeightMedium" },
      { value: "heavy",             label: "GOD.Race.WeightHeavy" },
      { value: "veryHeavy",         label: "GOD.Race.WeightVeryHeavy" },
      { value: "incrediblyHeavy",   label: "GOD.Race.WeightIncrediblyHeavy" },
    ];
    context.sizeLabel   = this.#resolveLabel(context.sizes, item.system.size);
    context.weightLabel = this.#resolveLabel(context.weights, item.system.weight);

    return context;
  }

  #resolveLabel(list, value) {
    const entry = list.find((e) => e.value === value);
    return entry ? game.i18n.localize(entry.label) : value;
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender(context, options);

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
