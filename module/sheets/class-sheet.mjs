/**
 * GOD Tactical — Class Item Sheet (ItemSheetV2)
 */

import { GOD } from "../config.mjs";
import { showPopupMenu } from "./item-context-menu.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

const GRANT_REORDER_MIME = "text/god-grant-reorder";
const START_REORDER_MIME = "text/god-start-reorder";

export class GODClassSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    classes: ["god-tactical", "item", "class"],
    position: { width: 560, height: 600 },
    window: { resizable: true, minimizable: false },
    form: {
      handler: this.#onSubmitForm,
      submitOnChange: true,
    },
  };

  static PARTS = {
    sheet: {
      template: "systems/god-tactical/templates/item/class-sheet.hbs",
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
    context.grantedItems = (item.system.grantedItems ?? []).map((entry, idx) => ({
      ...entry,
      idx,
      typeLabel: this.#typeLabel(entry.type),
    }));
    context.startingItems = (item.system.startingItems ?? []).map((entry, idx) => ({
      ...entry,
      idx,
      typeLabel: this.#typeLabel(entry.type),
    }));
    // Each entry is a GOD.COMPETENCY_GROUPS category KEY (which categories this class
    // allows picking from — see #onPickCompetency), shown here by its category's own
    // display name (see #competencyCategoryLabel).
    context.competencies = (item.system.competencies ?? []).map((key, idx) => ({
      key, idx, name: this.#competencyCategoryLabel(key),
    }));
    context.skillBonuses = (item.system.skillRankBonuses ?? []).map((key, idx) => ({
      key, idx, label: this.#skillLabel(key),
    }));

    return context;
  }

  #typeLabel(type) {
    if (!type) return "";
    const key = `GOD.Item.Types.${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    const label = game.i18n.localize(key);
    return label === key ? type : label;
  }

  /** "Категория · Навык" for a GOD.SKILL_MAP skill key — same "Категория · Навык" style
   *  weapon-sheet.mjs's skillOptions already uses, so it reads consistently everywhere
   *  a flat list of all 16 skills is offered. Falls back to the raw key if not found
   *  (e.g. a skill that's since been renamed/removed). */
  #skillLabel(key) {
    for (const cat of Object.values(GOD.SKILL_MAP)) {
      const skill = cat.skills.find((s) => s.key === key);
      if (skill) return `${cat.name} · ${skill.name}`;
    }
    return key;
  }

  /** Display name for a GOD.COMPETENCY_GROUPS category key (e.g. "meleeCombat" →
   *  "Боевые (ближний бой)"). Falls back to the raw key if not found (e.g. stale data
   *  from before this field switched from free competency names to category keys — see
   *  items.mjs's ClassDataModel.competencies doc comment). */
  #competencyCategoryLabel(key) {
    return GOD.COMPETENCY_GROUPS.find((g) => g.key === key)?.name ?? key;
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

    const startDropzone = this.element.querySelector(".cls-start-dropzone");
    if (startDropzone) {
      startDropzone.addEventListener("dragover", (e) => { e.preventDefault(); startDropzone.classList.add("drag-over"); });
      startDropzone.addEventListener("dragleave", () => startDropzone.classList.remove("drag-over"));
      startDropzone.addEventListener("drop", this.#onDropStartingItem.bind(this));
    }
    this.element.querySelectorAll(".cls-start-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveStartingItem.bind(this));
    });
    this.element.querySelectorAll(".cls-start-name").forEach((el) => {
      el.addEventListener("dblclick", this.#onOpenStartingItem.bind(this));
    });

    this.element.querySelectorAll(".cls-comp-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveCompetency.bind(this));
    });
    this.element.querySelector(".cls-comp-add-btn")?.addEventListener("click", this.#onPickCompetency.bind(this));

    this.element.querySelectorAll(".cls-skillbonus-remove").forEach((btn) => {
      btn.addEventListener("click", this.#onRemoveSkillBonus.bind(this));
    });
    this.element.querySelector(".cls-skillbonus-add-btn")?.addEventListener("click", this.#onPickSkillBonus.bind(this));

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

      this.element.querySelectorAll(".cls-start-row[data-idx]").forEach((row) => {
        row.addEventListener("dragstart", (e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(START_REORDER_MIME, row.dataset.idx);
          row.classList.add("is-dragging");
        });
        row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
        row.addEventListener("dragover", (e) => {
          if (!e.dataTransfer.types.includes(START_REORDER_MIME)) return;
          e.preventDefault();
          e.stopPropagation();
          row.classList.add("drag-over-row");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drag-over-row"));
        row.addEventListener("drop", this.#onReorderStartingItem.bind(this));
      });
    }
  }

  /* -------------------------------------------- */

  #onToggleEdit(event) {
    event.preventDefault();
    this._isEditing = !this._isEditing;
    this.render();
  }

  /** A class card living inside a locked compendium pack silently refuses to update —
   *  Foundry doesn't surface an error for it, it just no-ops. Catch that up front with a
   *  clear message instead of letting drops/edits appear to do nothing. */
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

  /* -------------------------------------------- */

  /** Drop an Ability/whatever item onto the class sheet to add it to the granted-items
   *  list — a snapshot (name/img/type) is stored for display, the uuid is what actually
   *  gets copied onto an actor's sheet when this class is added (class-race-rules.mjs). */
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

  /** "+" button next to the competency-category list — a popup listing every
   *  GOD.COMPETENCY_GROUPS category not already picked (picking a category again would
   *  be a pointless duplicate — unlike skill bonuses, there's no "stack it" meaning
   *  here, so it's filtered out instead of just left to the player to avoid). Picking a
   *  category doesn't commit to any specific competency within it — the character
   *  builder's FIRST competency step lets the player choose which of that category's own
   *  competencies to actually take (see #selectedClassCompetencies in
   *  character-builder.mjs). */
  #onPickCompetency(event) {
    event.preventDefault();
    if (!this.#checkUnlocked()) return;
    const current = this.document.system.competencies;
    const entries = GOD.COMPETENCY_GROUPS
      .filter((g) => !current.includes(g.key))
      .map((g) => ({
        label: g.name,
        icon: "fa-list-check",
        onClick: () => this.#addCompetency(g.key),
      }));
    showPopupMenu(entries, event.clientX, event.clientY);
  }

  async #addCompetency(key) {
    const competencies = [...this.document.system.competencies, key];
    await this.document.update({ "system.competencies": competencies });
  }

  async #onRemoveCompetency(event) {
    event.preventDefault();
    if (!this.#checkUnlocked()) return;
    const idx = Number(event.currentTarget.dataset.idx);
    const competencies = this.document.system.competencies.filter((_, i) => i !== idx);
    await this.document.update({ "system.competencies": competencies });
  }

  /** "+" button next to the skill-bonus list — a popup listing all 16 skills (flat,
   *  "Категория · Навык" labels). No de-duplication: picking the same skill again is
   *  a valid, deliberate way to stack another +1 on it (see items.mjs's
   *  skillRankBonuses doc comment). */
  #onPickSkillBonus(event) {
    event.preventDefault();
    if (!this.#checkUnlocked()) return;
    const entries = Object.values(GOD.SKILL_MAP).flatMap((cat) =>
      cat.skills.map((skill) => ({
        label: `${cat.name} · ${skill.name}`,
        icon: "fa-star",
        onClick: () => this.#addSkillBonus(skill.key),
      })));
    showPopupMenu(entries, event.clientX, event.clientY);
  }

  async #addSkillBonus(key) {
    const skillRankBonuses = [...this.document.system.skillRankBonuses, key];
    await this.document.update({ "system.skillRankBonuses": skillRankBonuses });
  }

  async #onRemoveSkillBonus(event) {
    event.preventDefault();
    if (!this.#checkUnlocked()) return;
    const idx = Number(event.currentTarget.dataset.idx);
    const skillRankBonuses = this.document.system.skillRankBonuses.filter((_, i) => i !== idx);
    await this.document.update({ "system.skillRankBonuses": skillRankBonuses });
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

  /** Drop an item (equipment, trophy, whatever) onto the class sheet's "Стартовые
   *  предметы" dropzone — a separate pool from grantedItems above: nothing here is
   *  auto-copied by the createItem hook. Instead the Character Builder's item-selection
   *  step reads this list directly off the class item (module/apps/character-builder.mjs)
   *  to build the player's default kit + starting trophy currency. Same
   *  snapshot-plus-uuid shape as #onDropGrantedItem. */
  async #onDropStartingItem(event) {
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

    const startingItems = [
      ...this.document.system.startingItems,
      { uuid: source.uuid, name: source.name, img: source.img, type: source.type },
    ];
    await this.document.update({ "system.startingItems": startingItems });
  }

  async #onRemoveStartingItem(event) {
    event.preventDefault();
    if (!this.#checkUnlocked()) return;
    const idx = Number(event.currentTarget.dataset.idx);
    const startingItems = this.document.system.startingItems.filter((_, i) => i !== idx);
    await this.document.update({ "system.startingItems": startingItems });
  }

  async #onReorderStartingItem(event) {
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget;
    row.classList.remove("drag-over-row");
    if (!this.#checkUnlocked()) return;

    const fromIdx = Number(event.dataTransfer.getData(START_REORDER_MIME));
    const toIdx = Number(row.dataset.idx);
    if (Number.isNaN(fromIdx) || Number.isNaN(toIdx) || fromIdx === toIdx) return;

    const startingItems = [...this.document.system.startingItems];
    const [moved] = startingItems.splice(fromIdx, 1);
    startingItems.splice(toIdx, 0, moved);
    await this.document.update({ "system.startingItems": startingItems });
  }

  async #onOpenStartingItem(event) {
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
    await this.document.update(submitData);
  }
}
