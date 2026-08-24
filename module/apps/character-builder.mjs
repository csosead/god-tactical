/**
 * GOD Tactical — Character Builder
 * An 8-step chargen wizard opened from a new Character actor's sheet header:
 * name/nickname → race (from the "races" compendium) → class (from the
 * "classes" compendium) → class competencies (pick GOD.CLASS_COMPETENCY_PICK_COUNT off
 * whichever GOD.COMPETENCY_GROUPS categories the selected class allows — see
 * #selectedClassCompetencies) → general competencies (pick GOD.COMPETENCY_PICK_COUNT off
 * every GOD.COMPETENCY_GROUPS category, unrestricted by class) →
 * starting items (the selected class's own startingItems kit — free default gear plus
 * whatever trophies came with it, each barterable by rarity for one or more items off the
 * "equipment" compendium, spendable across several cheaper items instead of just an exact
 * match — several same-rarity trophies may also be combined into one offer a rank higher
 * per extra trophy, see #onTradeEquipment) → Мезонин drive priorities → point-buy
 * of characteristics and skill ranks against a fixed starting XP pool. The two
 * competency picks together become the actor's own copy of the class item's
 * competencies array — the class's full original list is no longer granted wholesale
 * (see #onFinish).
 */

import { GOD, charPointXpCost, charRaiseXpCost } from "../config.mjs";
import { skillValueFromRank, skillRankCharPrereq, skillRankRaiseCost, maxRankForChar } from "../data-models.mjs";
import { clampRarity, rarityTierName } from "../sheets/rarity-pips.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Escapes HTML-significant characters before splicing dynamic text (race/class names,
 *  free-text competencies) into a tooltip's HTML string — this content comes straight off
 *  compendium items, which could contain "<"/"&"/etc. Foundry's TooltipManager also runs
 *  the final string through foundry.utils.cleanHTML() before rendering it (defense in
 *  depth against anything more than a rendering glitch), but proper escaping keeps stray
 *  "<"/"&" in a name from ever mangling the markup in the first place. */
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** One label:value line in a tooltip (see .cb-tt-row, god-tactical.css). */
function ttRow(label, value) {
  return `<div class="cb-tt-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
}

/** Rich hover-tooltip HTML for a race pick card — every RaceDataModel stat (size, weight,
 *  wound steps, speed, all 4 characteristic bonuses), so the player can compare races
 *  without opening each one's full sheet (the "i" button still does that). Rendered
 *  through Foundry's native data-tooltip-html (TooltipManager#activate auto-clamps
 *  position to the viewport) — see .cb-info-tooltip in god-tactical.css for the
 *  max-width/wrap rules that keep it legible on small screens. */
function raceTooltipHtml(doc) {
  const sys = doc.system ?? {};
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const rows = [
    ttRow(game.i18n.localize("GOD.Race.Size"), sys.size ? game.i18n.localize(`GOD.Race.Size${cap(sys.size)}`) : "—"),
    ttRow(game.i18n.localize("GOD.Race.Weight"), sys.weight ? game.i18n.localize(`GOD.Race.Weight${cap(sys.weight)}`) : "—"),
    ttRow(game.i18n.localize("GOD.Race.WoundSteps"), sys.woundSteps ?? "—"),
    ttRow(game.i18n.localize("GOD.Race.Speed"), `${sys.speed ?? 0} ${game.i18n.localize("GOD.Race.SpeedUnit")}`),
  ].join("");

  const charRows = Object.values(GOD.SKILL_MAP).map((cat) => {
    const value = sys.charBonuses?.[cat.charKey] ?? 0;
    return ttRow(cat.name, value > 0 ? `+${value}` : String(value));
  }).join("");

  // Resolve — the one DRAMA triplet, moved here from Class (see ClassDataModel's
  // migrateData doc comment, items.mjs). Fixed row name, no per-race label field.
  const resolveTable = `
    <table class="cb-tt-table">
      <thead>
        <tr>
          <th></th>
          <th>${escapeHtml(game.i18n.localize("GOD.Class.Fiasco"))}</th>
          <th>${escapeHtml(game.i18n.localize("GOD.Class.Fail"))}</th>
          <th>${escapeHtml(game.i18n.localize("GOD.Class.Success"))}</th>
          <th>${escapeHtml(game.i18n.localize("GOD.Class.Triumph"))}</th>
        </tr>
      </thead>
      <tbody>
        ${ttTripletRow(game.i18n.localize("GOD.Class.Resolve"), sys.resolve)}
      </tbody>
    </table>`;

  return `<div class="cb-tooltip">
    <div class="cb-tt-title">${escapeHtml(doc.name)}</div>
    ${rows}
    <div class="cb-tt-sep"></div>
    <div class="cb-tt-subtitle">${escapeHtml(game.i18n.localize("GOD.Race.CharBonuses"))}</div>
    ${charRows}
    <div class="cb-tt-sep"></div>
    <div class="cb-tt-subtitle">${escapeHtml(game.i18n.localize("GOD.Class.Drama"))}</div>
    ${resolveTable}
  </div>`;
}

/** One row of a triplet (fiasco/fail/success/triumph) table — used by Push in
 *  classTooltipHtml() below, and by Resolve in raceTooltipHtml() above (Damage/Dodge/
 *  Fortitude flattened to single base numbers, rendered as their own plain rows
 *  instead). Push/Resolve are free text (see textTripletField(), items.mjs) so their
 *  cells are escaped the same as any other class/race-authored string here. */
function ttTripletRow(label, triplet) {
  const t = triplet ?? {};
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(t.fiasco)}</td><td>${escapeHtml(t.fail)}</td><td>${escapeHtml(t.success)}</td><td>${escapeHtml(t.triumph)}</td></tr>`;
}

/** Rich hover-tooltip HTML for a class pick card — every ClassDataModel stat
 *  (Damage/Dodge/Fortitude as flat base numbers, Push still a fiasco/fail/success/
 *  triumph triplet, competencies, skill-rank bonuses tallied and labeled "Категория ·
 *  Навык"). Same rendering path/viewport-safety as raceTooltipHtml() above. */
function classTooltipHtml(doc) {
  const sys = doc.system ?? {};

  const table = `
    <table class="cb-tt-table">
      <thead>
        <tr>
          <th></th>
          <th>${escapeHtml(game.i18n.localize("GOD.Class.Fiasco"))}</th>
          <th>${escapeHtml(game.i18n.localize("GOD.Class.Fail"))}</th>
          <th>${escapeHtml(game.i18n.localize("GOD.Class.Success"))}</th>
          <th>${escapeHtml(game.i18n.localize("GOD.Class.Triumph"))}</th>
        </tr>
      </thead>
      <tbody>
        <tr><th>${escapeHtml(game.i18n.localize("GOD.Class.Damage"))}</th><td colspan="4">PHY ${escapeHtml(String(sys.baseMelee ?? 0))}/${escapeHtml(String(sys.baseRanged ?? 0))} · MPH ${escapeHtml(String(sys.baseMetaphysicalMelee ?? 0))}/${escapeHtml(String(sys.baseMetaphysicalRanged ?? 0))}</td></tr>
        <tr><th>${escapeHtml(game.i18n.localize("GOD.Class.Dodge"))}</th><td colspan="4">${escapeHtml(String(sys.dodgeBase ?? 0))}</td></tr>
        <tr><th>${escapeHtml(game.i18n.localize("GOD.Class.Fortitude"))}</th><td colspan="4">${escapeHtml(String(sys.fortitudeBase ?? 0))}</td></tr>
        ${ttTripletRow(game.i18n.localize("GOD.Class.Push"), sys.push)}
      </tbody>
    </table>`;

  // sys.competencies now holds GOD.COMPETENCY_GROUPS category KEYS (which categories
  // this class allows picking from), not competency names directly — see class-sheet.mjs's
  // #onPickCompetency and #selectedClassCompetencies' doc comment — so resolve each to
  // its category's own display name for this tooltip.
  const competencies = sys.competencies?.length
    ? `<div class="cb-tt-tags">${sys.competencies.map((key) => {
        const label = GOD.COMPETENCY_GROUPS.find((g) => g.key === key)?.name ?? key;
        return `<span>${escapeHtml(label)}</span>`;
      }).join("")}</div>`
    : `<div class="cb-tt-empty">—</div>`;

  const bonusCounts = {};
  for (const key of sys.skillRankBonuses ?? []) bonusCounts[key] = (bonusCounts[key] ?? 0) + 1;
  const bonusLabels = Object.entries(bonusCounts).map(([key, count]) => {
    let label = key;
    for (const cat of Object.values(GOD.SKILL_MAP)) {
      const skill = cat.skills.find((s) => s.key === key);
      if (skill) { label = `${cat.name} · ${skill.name}`; break; }
    }
    return count > 1 ? `${label} ×${count}` : label;
  });
  const skillBonuses = bonusLabels.length
    ? `<div class="cb-tt-tags">${bonusLabels.map((l) => `<span>${escapeHtml(l)}</span>`).join("")}</div>`
    : `<div class="cb-tt-empty">—</div>`;

  return `<div class="cb-tooltip">
    <div class="cb-tt-title">${escapeHtml(doc.name)}</div>
    ${table}
    <div class="cb-tt-subtitle">${escapeHtml(game.i18n.localize("GOD.Class.Competencies"))}</div>
    ${competencies}
    <div class="cb-tt-subtitle">${escapeHtml(game.i18n.localize("GOD.Class.SkillBonuses"))}</div>
    ${skillBonuses}
  </div>`;
}

// Local label maps for the equipment tooltip below — same hardcoded values used by the
// live item sheets/actor-sheet.mjs's own inventory-row labeling (these aren't i18n keys,
// see e.g. actor-sheet.mjs's ARCHETYPE_LABEL/CONTAINER_TYPE_LABEL consts).
const EQUIP_HANDS_LABEL = { main: "Основная рука", off: "Не основная", two: "Обе руки", versatile: "Основная рука или обе руки", verbal: "Вербальный" };
const EQUIP_ARCHETYPE_LABEL = { light: "Лёгкая", heavy: "Тяжёлая" };
const EQUIP_CONTAINER_TYPE_LABEL = { deep: "Deep Storage Container", quick: "Quick Slot Container" };
const EQUIP_DAMAGE_TYPE_LABEL = Object.fromEntries(GOD.DAMAGE_TYPES.map((d) => [d.key, d.name]));
const EQUIP_DAMAGE_NATURE_LABEL = Object.fromEntries(GOD.DAMAGE_NATURES.map((d) => [d.key, d.name]));
const EQUIP_SIZE_LABEL = { small: "Малое", medium: "Среднее", large: "Большое", huge: "Огромное" };
const EQUIP_ARMOR_SUBTYPE_LABEL = Object.fromEntries(GOD.ARMOR_SUBTYPES.map((s) => [s.key, s.name]));

/** Localized item-type label ("weapon" → "Оружие") — same GOD.Item.Types.* lookup as
 *  class-sheet.mjs's #typeLabel/character-builder.mjs's own #itemTypeLabel, duplicated
 *  here as a plain function since this runs outside the class (equipment docs are
 *  tooltip-cached once in #ensureCompendiaLoaded, not per-instance). */
function equipTypeLabel(type) {
  if (!type) return "";
  const key = `GOD.Item.Types.${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  const label = game.i18n.localize(key);
  return label === key ? type : label;
}

/** "Категория · Навык" for a GOD.SKILL_MAP skill key — same lookup classTooltipHtml's
 *  skillBonuses loop uses above. */
function equipSkillLabel(key) {
  for (const cat of Object.values(GOD.SKILL_MAP)) {
    const skill = cat.skills.find((s) => s.key === key);
    if (skill) return `${cat.name} · ${skill.name}`;
  }
  return key;
}

/** Which GOD.<Namespace>.Rarity* label set applies to an equipment doc's rarity — same
 *  split each item's own sheet uses (weapon-sheet.mjs/armor-sheet.mjs/etc.): Weapon/Spell
 *  get the "Weapon" (neuter-gendered) set, Armor/Container get "Armor" (feminine), and
 *  everything else (Consumable/Tools) gets the generic "Item" set. */
function equipRarityNamespace(type) {
  if (type === "weapon" || type === "spell") return "Weapon";
  if (type === "armor" || type === "container") return "Armor";
  return "Item";
}

/** Rich hover-tooltip HTML for an equipment-browser row (items step) — same
 *  data-tooltip-html rendering path as raceTooltipHtml/classTooltipHtml above, just for
 *  a compendium Weapon/Spell/Armor/Consumable/Container/Tools document. Shows the
 *  fields common to every type (rarity/price/size) plus whichever stats are specific to
 *  that item's own card format. */
function equipmentTooltipHtml(doc) {
  const sys = doc.system ?? {};
  const type = doc.type;

  const rows = [];
  rows.push(ttRow(game.i18n.localize("GOD.Item.Rarity"), `${clampRarity(sys.rarity)} — ${rarityTierName(sys.rarity, equipRarityNamespace(type))}`));
  if (sys.price != null) rows.push(ttRow(game.i18n.localize("GOD.Item.Price"), sys.price));
  if (sys.size) rows.push(ttRow(game.i18n.localize("GOD.Item.Size"), EQUIP_SIZE_LABEL[sys.size] ?? sys.size));

  if (type === "weapon" || type === "spell") {
    rows.push(ttRow("Руки", EQUIP_HANDS_LABEL[sys.hands] ?? sys.hands));
    if (sys.damageType) rows.push(ttRow("Тип воздействия", EQUIP_DAMAGE_TYPE_LABEL[sys.damageType] ?? sys.damageType));
    if (sys.damageNature) rows.push(ttRow("Природа урона", EQUIP_DAMAGE_NATURE_LABEL[sys.damageNature] ?? sys.damageNature));
    if (sys.skill) rows.push(ttRow("Навык", equipSkillLabel(sys.skill)));
  } else if (type === "armor") {
    rows.push(ttRow("Архетип", EQUIP_ARCHETYPE_LABEL[sys.archetype] ?? sys.archetype));
    rows.push(ttRow("Подтип", EQUIP_ARMOR_SUBTYPE_LABEL[sys.subtype] ?? sys.subtype));
  } else if (type === "consumable") {
    rows.push(ttRow("Запас", sys.stockMax));
  } else if (type === "container") {
    rows.push(ttRow("Тип контейнера", EQUIP_CONTAINER_TYPE_LABEL[sys.containerType] ?? sys.containerType));
    rows.push(ttRow("Вместимость", sys.capacity));
  } else if (type === "tools" && sys.competency) {
    rows.push(ttRow("Компетенция", sys.competency));
  }

  return `<div class="cb-tooltip">
    <div class="cb-tt-title">${escapeHtml(doc.name)}</div>
    <div class="cb-tt-subtitle">${escapeHtml(equipTypeLabel(type))}</div>
    ${rows.join("")}
  </div>`;
}

export class GODCharacterBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Default total XP available to spend at chargen — the GM/player can override it per
   *  character via the editable "Остаток" field on the alloc step (see #onRemainingChange;
   *  builderState.xpPool holds the actual value in use, this is just the starting point). */
  static XP_POOL = 30;
  /** Characteristics start at GOD.CHAR_MIN (schema floor) and, at chargen only, may not
   *  exceed 70. */
  static CHAR_MIN = GOD.CHAR_MIN;
  static CHAR_MAX_START = 70;
  /** Items step's equipment browser never shows anything above this rarity — starting
   *  gear is deliberately capped well below the top tiers (Priceless/Legendary/
   *  Mythical/Artifact, GOD.RARITY_TIERS), regardless of how rare a trophy the player
   *  happens to be holding. */
  static EQUIPMENT_RARITY_CAP = 4;
  // Characteristic and rank costs are the same shared formulas the post-chargen character
  // sheet uses (charRaiseXpCost() in config.mjs, skillRankRaiseCost() in data-models.mjs)
  // — no separate chargen-only rates anymore. No separate hardcoded rank cap either — rank
  // 3+ is naturally unreachable at chargen whenever its characteristic prerequisite (see
  // GOD.SKILL_RANK_CHAR_PREREQ) sits above CHAR_MAX_START, since skillRankCharPrereq()
  // blocks it in #onSkillRankClick the same way it does on the post-chargen character sheet.

  /** One live instance per actor — reopening the builder for the same actor
   *  focuses the existing window instead of stacking a duplicate. */
  static #open = new Map();

  static open(actor) {
    const existing = GODCharacterBuilder.#open.get(actor.id);
    if (existing) {
      existing.bringToFront();
      return existing;
    }
    const app = new GODCharacterBuilder(actor);
    GODCharacterBuilder.#open.set(actor.id, app);
    app.render(true);
    return app;
  }

  static DEFAULT_OPTIONS = {
    tag: "div",
    classes: ["god-character-builder-app"],
    window: {
      title: "GOD.CharBuilder.Title",
      icon: "fas fa-dna",
      resizable: true,
      minimizable: false,
    },
    position: { width: 640, height: 680 },
  };

  static PARTS = {
    body: { template: "systems/god-tactical/templates/apps/character-builder.hbs" },
  };

  #races = null;
  #classes = null;
  #equipment = null;
  /** scrollTop of .cb-scroll captured just before a re-render triggered by an in-place
   *  control (the alloc step's characteristic +/- buttons or skill rank star clicks) —
   *  restored in _onRender so clicking them doesn't yank the view back to the top of a
   *  long skill list. */
  #lastScroll = 0;
  /** Selector + caret position captured just before a re-render triggered by the items
   *  step's equipment search box — same idea as #lastScroll, but for input focus/caret
   *  instead of scroll position, since a full re-render otherwise drops focus entirely
   *  and resets the caret to the end. Consumed (cleared) the next time _onRender runs. */
  #pendingFocus = null;
  /** Monotonic counter for kit-trophy `key`s (module.builderState.kitTrophies) — a fresh
   *  set is assigned each time #ensureItemStepState re-resolves the pool for a newly
   *  selected class. */
  #kitKeySeq = 0;

  constructor(actor, options = {}) {
    super({
      id: `god-character-builder-${actor.id}`,
      window: { title: `${game.i18n.localize("GOD.CharBuilder.Title")} — ${actor.name}` },
      ...options,
    });
    this.actor = actor;
    this.step = 0;

    const chars = {};
    for (const cat of Object.values(GOD.SKILL_MAP)) chars[cat.charKey] = GODCharacterBuilder.CHAR_MIN;

    const skillRanks = {};
    for (const cat of Object.values(GOD.SKILL_MAP)) {
      for (const skill of cat.skills) skillRanks[skill.key] = 0;
    }

    this.builderState = {
      name: actor.name ?? "",
      nickname: actor.system.biography?.nickname ?? "",
      raceUuid: null,
      classUuid: null,
      // Competencies picked on the builder's two dedicated steps — classCompetencies is
      // up to GOD.CLASS_COMPETENCY_PICK_COUNT tags picked straight off the selected
      // class's own competencies list (#selectedClassCompetencies); competencies is up to
      // GOD.COMPETENCY_PICK_COUNT more picked off the general GOD.COMPETENCY_GROUPS list,
      // unrestricted by class. Together they REPLACE the class item's own `competencies`
      // array at #onFinish (config.mjs's GOD.COMPETENCY_GROUPS doc comment). Not
      // pre-filled when reopening the builder for an existing actor (unlike
      // mezzanineOrder below): once written onto the class item they're indistinguishable
      // from whatever's there, so there's nothing reliable to read back.
      classCompetencies: [],
      competencies: [],
      // Starting-items step state — see #ensureItemStepState. kitForClassUuid tracks
      // which class's startingItems kitTrophies/kitItems were last resolved from, so
      // going back and picking a different class re-initializes them instead of leaving
      // stale trophies/trades from the previous class lying around.
      kitForClassUuid: null,
      kitTrophies: [],
      // Each entry is one ITEM received (see #onFinish, which iterates this flat) but
      // several can share one groupId when they were bought off the same offer's budget
      // (see activeOffer below / #onTradeEquipment) — #onUndoTrade always undoes a whole
      // group at once, never a single item out of a multi-item one.
      trades: [],
      // Kit trophy keys currently "armed" for spending — the player must select at least
      // one here before any equipment row becomes tradeable (see
      // #onSelectTrophy/#onTradeEquipment). Two or more, as long as they're all the SAME
      // rarity, combine into one offer worth one rarity rank higher per extra trophy
      // (see #buildItemsContext's offerRarity) — e.g. two rarity-3 trophies together
      // offer at rarity 4. Cleared the moment that offer's first purchase happens (see
      // activeOffer below), not necessarily when the whole budget is spent.
      selectedTrophyKeys: [],
      // Set once an armed selection's first purchase leaves budget unspent (offer rarity
      // > that item's rarity) — { groupId, remainingRarity, spentTrophies }. Further
      // equipment clicks keep drawing from remainingRarity instead of requiring a new
      // trophy selection (see #onTradeEquipment), e.g. one rarity-3 trophy can fund three
      // rarity-1 items, or a rarity-2 + a rarity-1, one purchase at a time. Cleared back
      // to null once the budget hits 0, or forfeited (with a warning) the moment the
      // player arms a different selection instead of spending the rest (see
      // #onSelectTrophy) — there's no "change" mechanic to hand leftover value back as a
      // trophy.
      activeOffer: null,
      equipSearch: "",
      chars,
      skillRanks,
      xpPool: GODCharacterBuilder.XP_POOL,
      // Мезонин drive priority — drive keys in the order clicked, index 0 = priority 1
      // (see GOD.MEZZANINE_DRIVES/MEZZANINE_PRIORITY_RULES, config.mjs). Pre-fill from
      // the actor's existing choice if the builder is reopened for a character that
      // already has one (e.g. to redo an earlier step without losing this).
      mezzanineOrder: [...(actor.system.mezzanine?.order ?? [])],
    };
  }

  /* -------------------------------------------- */

  async #ensureCompendiaLoaded() {
    if (this.#races && this.#classes && this.#equipment) return;
    const racePack = game.packs.get("god-tactical.races");
    const classPack = game.packs.get("god-tactical.classes");
    const equipPack = game.packs.get("god-tactical.equipment");
    const raceDocs = racePack ? await racePack.getDocuments() : [];
    const classDocs = classPack ? await classPack.getDocuments() : [];
    const equipDocs = equipPack ? await equipPack.getDocuments() : [];
    this.#races = raceDocs.map((d) => ({
      uuid: d.uuid,
      name: d.name,
      img: d.img,
      charBonuses: d.system.charBonuses ?? {},
      tooltipHtml: raceTooltipHtml(d),
    }));
    this.#classes = classDocs.map((d) => ({
      uuid: d.uuid,
      name: d.name,
      img: d.img,
      skillRankBonuses: d.system.skillRankBonuses ?? [],
      competencies: d.system.competencies ?? [],
      // Raw startingItems entries (uuid/name/img/type snapshot) off the class item —
      // the items step's default kit + trophy pool (see #ensureItemStepState). Kept
      // as-is (not resolved to full documents) until the items step actually needs
      // trophy rarity, same lazy-resolve split as #selectedClassCompetencies.
      startingItems: d.system.startingItems ?? [],
      tooltipHtml: classTooltipHtml(d),
    }));
    // Equipment compendium browsed on the items step — capped at EQUIPMENT_RARITY_CAP
    // (starting gear never reaches the top rarity tiers, see that constant's doc
    // comment), and always exclusively from the "equipment" pack, never any other
    // compendium. tooltipHtml is the same rich hover-preview pattern the race/class pick
    // cards use (raceTooltipHtml/classTooltipHtml above), built once here rather than
    // per-render since the source docs never change mid-session.
    this.#equipment = equipDocs
      .filter((d) => (d.system.rarity ?? 1) <= GODCharacterBuilder.EQUIPMENT_RARITY_CAP)
      .map((d) => ({
        uuid: d.uuid,
        name: d.name,
        img: d.img,
        type: d.type,
        rarity: d.system.rarity ?? 1,
        price: d.system.price ?? null,
        tooltipHtml: equipmentTooltipHtml(d),
      }));
  }

  /** The selected class's own competency pool for the FIRST competency step
   *  (#buildClassCompetencyContext) — ClassDataModel.competencies no longer holds free
   *  competency NAMES directly; it holds a subset of GOD.COMPETENCY_GROUPS' own `key`s
   *  (which CATEGORIES this class allows picking from — see class-sheet.mjs's
   *  #onPickCompetency). Resolved here into the actual competency names within those
   *  categories, always reading GOD.COMPETENCY_GROUPS live — so a rulebook edit to a
   *  category's competency list (config.mjs's loadCompetencyGroupsFromRulebook) is
   *  reflected here too, same as the SECOND (general) competency step already is. */
  #selectedClassCompetencies() {
    const cls = this.#classes?.find((c) => c.uuid === this.builderState.classUuid);
    const categoryKeys = cls?.competencies ?? [];
    return GOD.COMPETENCY_GROUPS
      .filter((g) => categoryKeys.includes(g.key))
      .flatMap((g) => g.competencies);
  }

  /** How many of the class's own competencies the player must pick — normally
   *  GOD.CLASS_COMPETENCY_PICK_COUNT, but clamped down to however many the class
   *  actually has (e.g. a class with none, like Маг, requires zero picks rather than
   *  making it impossible to ever finish chargen with that class selected). */
  #classCompetencyPickCount() {
    return Math.min(GOD.CLASS_COMPETENCY_PICK_COUNT, this.#selectedClassCompetencies().length);
  }

  /** +1 per occurrence of a skill key in the selected class's skillRankBonuses — same
   *  "class grants effective rank, never touches the stored rank itself" rule the actor
   *  sheet applies once the class is actually embedded (see CharacterDataModel#prepareDerivedData
   *  in data-models.mjs). Read here straight off the cached compendium source since the
   *  class isn't dropped onto the actor until #onFinish. */
  #selectedClassBonuses() {
    const cls = this.#classes?.find((c) => c.uuid === this.builderState.classUuid);
    const bonuses = {};
    for (const key of cls?.skillRankBonuses ?? []) bonuses[key] = (bonuses[key] ?? 0) + 1;
    return bonuses;
  }

  /** The selected race's charBonuses — a signed value per characteristic, set directly
   *  on the race card (unlike the class's skillRankBonuses, not a tally of repeated
   *  entries). Read here straight off the cached compendium source since the race isn't
   *  dropped onto the actor until #onFinish. */
  #selectedRaceBonuses() {
    const race = this.#races?.find((r) => r.uuid === this.builderState.raceUuid);
    return race?.charBonuses ?? {};
  }

  /** Recompute spent/remaining XP and every per-row display field from current state.
   *  Shaped like actor-sheet.mjs's #prepareCombined (one `blocks` array, characteristic +
   *  its own skills together) so the alloc step can mirror the character sheet's layout —
   *  same star rank pips, same lock/cost/prereq math, no separate chargen-only formulas. */
  #buildAllocContext() {
    const classBonuses = this.#selectedClassBonuses();
    const raceBonuses = this.#selectedRaceBonuses();

    let spent = 0;
    const blocks = [];
    for (const cat of Object.values(GOD.SKILL_MAP)) {
      const value = this.builderState.chars[cat.charKey];
      // Same piecewise ladder as the post-chargen purchase (charRaiseXpCost() in
      // config.mjs) — cumulative XP spent to raise this characteristic from the chargen
      // floor up to its current value.
      const cost = charRaiseXpCost(GODCharacterBuilder.CHAR_MIN, value);
      spent += cost;
      // Race bonus is free (doesn't cost XP) and can push the effective value past the
      // chargen 70 purchase cap (up to the game's hard cap, GOD.CHAR_HARD_MAX) or below the
      // 40 purchase floor if negative — same as a class's skill bonus can push a skill to
      // rank 5 despite the rank-4 chargen purchase cap.
      const raceBonus = raceBonuses[cat.charKey] ?? 0;
      const effectiveValue = Math.max(0, Math.min(GOD.CHAR_HARD_MAX, value + raceBonus));
      const raceBonusFormatted = raceBonus > 0 ? `+${raceBonus}` : String(raceBonus);
      // Cost of the NEXT single point — null once the chargen purchase ceiling
      // (CHAR_MAX_START) is reached, since nothing more can be bought here regardless of
      // the game's overall hard cap (see charPointXpCost() in config.mjs).
      const nextPointCost = value >= GODCharacterBuilder.CHAR_MAX_START ? null : charPointXpCost(value);
      const valueTooltipParts = [`${game.i18n.localize("GOD.CharBuilder.PurchasedRank")}: ${value}`];
      if (nextPointCost !== null) valueTooltipParts.push(`Следующее очко: ${nextPointCost} XP`);
      const valueTooltip = valueTooltipParts.join(" · ");
      const char = { key: cat.charKey, name: cat.name, css: cat.css, value, cost, raceBonus, raceBonusFormatted, effectiveValue, valueTooltip };

      const skills = cat.skills.map((skill) => {
        const rank = this.builderState.skillRanks[skill.key];
        // Cumulative XP spent on this skill's raw purchased rank (from 0) — the class
        // bonus below is never part of this cost, it's a free perk layered on top.
        const cost = skillRankRaiseCost(0, rank);
        spent += cost;

        // Effective rank/value mirror the character sheet exactly — the purchased rank
        // plus the class's free bonus, clamped at 4.
        const classBonus = classBonuses[skill.key] ?? 0;
        const effectiveRank = Math.min(4, rank + classBonus);
        const value = skillValueFromRank(effectiveRank, effectiveValue);

        // Star pips 1–4, identical shape to actor-sheet.mjs#prepareCombined's rankBoxes —
        // reuses the same .skill-rank-mark CSS so locked/bonus/filled all read the same way
        // as the character sheet. The first `classBonus` stars are the fixed class-bonus
        // block, always leftmost regardless of the raw purchased rank (see the comment in
        // actor-sheet.mjs#prepareCombined for why it doesn't shift with the raw rank). No
        // more chargen-only free baseline star on top of that — every skill starts at raw=0
        // (see the constructor) and every rank past the class bonus is a real purchase,
        // exactly like the live character sheet.
        const rankBoxes = [];
        for (let i = 1; i <= 4; i++) {
          const prereq = skillRankCharPrereq(i);
          const isClassBonus = i <= classBonus;
          const locked = i > effectiveRank && effectiveValue < prereq;
          let tooltip = `Ранг ${i}`;
          if (locked) tooltip = `Требуется ${cat.name} ${prereq}`;
          else if (isClassBonus) tooltip = `Ранг ${i} (бонус класса)`;
          rankBoxes.push({ index: i, active: i <= effectiveRank, isBonus: isClassBonus, locked, tooltip });
        }

        // What it takes to buy the next rank beyond the current effective one — same
        // shape/logic as actor-sheet.mjs#prepareCombined's nextRankHint.
        let nextRankHint = null;
        if (effectiveRank < 4) {
          const nextRank = effectiveRank + 1;
          const nextPrereq = skillRankCharPrereq(nextRank);
          const nextCost = skillRankRaiseCost(effectiveRank, nextRank);
          const nextLocked = effectiveValue < nextPrereq;
          nextRankHint = {
            rank: nextRank,
            cost: nextCost,
            locked: nextLocked,
            tooltip: nextLocked
              ? `Ранг ${nextRank}: нужно ${cat.name} ${nextPrereq} (сейчас ${effectiveValue}), ${nextCost} XP`
              : `Ранг ${nextRank}: ${nextCost} XP`,
          };
        }

        return { key: skill.key, charKey: cat.charKey, name: skill.name, rank, effectiveRank, classBonus, value, rankBoxes, nextRankHint };
      });

      blocks.push({ char, skills });
    }

    const pool = this.builderState.xpPool;
    const remaining = pool - spent;

    for (const { char } of blocks) {
      char.canInc = char.value < GODCharacterBuilder.CHAR_MAX_START && remaining >= charPointXpCost(char.value);
      char.canDec = char.value > GODCharacterBuilder.CHAR_MIN;
    }

    return { pool, spent, remaining, blocks };
  }

  /* -------------------------------------------- */

  async _prepareContext(_options) {
    await this.#ensureCompendiaLoaded();

    const context = {
      step: this.step,
      stepIndex: this.step + 1,
      stepCount: 8,
      isFirst: this.step === 0,
      isLast: this.step === 7,
    };

    if (this.step === 0) {
      context.bio = { name: this.builderState.name, nickname: this.builderState.nickname };
    } else if (this.step === 1) {
      context.races = this.#races.map((r) => ({ ...r, selected: r.uuid === this.builderState.raceUuid }));
    } else if (this.step === 2) {
      context.classes = this.#classes.map((c) => ({ ...c, selected: c.uuid === this.builderState.classUuid }));
    } else if (this.step === 3) {
      context.classCompetencies = this.#buildClassCompetencyContext();
      context.classCompetencyCount = this.builderState.classCompetencies.length;
      context.classCompetencyPickCount = this.#classCompetencyPickCount();
    } else if (this.step === 4) {
      context.competencyGroups = this.#buildCompetencyContext();
      context.competencyCount = this.builderState.competencies.length;
      context.competencyPickCount = GOD.COMPETENCY_PICK_COUNT;
    } else if (this.step === 5) {
      await this.#ensureItemStepState();
      context.items = this.#buildItemsContext();
    } else if (this.step === 6) {
      context.drives = this.#buildMezzanineContext();
    } else if (this.step === 7) {
      context.alloc = this.#buildAllocContext();
    }

    return context;
  }

  /** FIRST competency step context — every one of the selected class's own competencies
   *  tagged with whether it's currently one of the (at most #classCompetencyPickCount())
   *  picks in builderState.classCompetencies, and whether it's unavailable here because
   *  that same name was already picked on the SECOND (general) competency step
   *  (builderState.competencies — see #buildCompetencyContext) — the two lists can share
   *  names (a general GOD.COMPETENCY_GROUPS entry happens to also appear in this class's
   *  own list), and picking the same one twice would just grant a redundant duplicate. */
  #buildClassCompetencyContext() {
    return this.#selectedClassCompetencies().map((name) => {
      const selected = this.builderState.classCompetencies.includes(name);
      return { name, selected, takenElsewhere: !selected && this.builderState.competencies.includes(name) };
    });
  }

  /** SECOND competency step context — every GOD.COMPETENCY_GROUPS entry tagged with
   *  whether it's currently one of the (at most GOD.COMPETENCY_PICK_COUNT) picks in
   *  builderState.competencies — unrestricted by the selected class (see the FIRST
   *  competency step, #buildClassCompetencyContext, for that) — except that a name
   *  already picked THERE (builderState.classCompetencies) is flagged unavailable here
   *  too, for the same reason: picking it again would just be a redundant duplicate. */
  #buildCompetencyContext() {
    return GOD.COMPETENCY_GROUPS.map((g) => ({
      key: g.key,
      name: g.name,
      competencies: g.competencies.map((name) => {
        const selected = this.builderState.competencies.includes(name);
        return { name, selected, takenElsewhere: !selected && this.builderState.classCompetencies.includes(name) };
      }),
    }));
  }

  /** "Категория" label for an item type key, same fallback-to-raw-key behavior as
   *  class-sheet.mjs's #typeLabel — used on the items step's equipment cards. */
  #itemTypeLabel(type) {
    if (!type) return "";
    const key = `GOD.Item.Types.${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    const label = game.i18n.localize(key);
    return label === key ? type : label;
  }

  #nextKitKey() {
    return `kt${this.#kitKeySeq++}`;
  }

  /** Resolves the selected class's `startingItems` trophy entries into the items step's
   *  mutable barter pool (builderState.kitTrophies) — only trophies need resolving here:
   *  their rarity/size aren't part of the startingItems snapshot (see
   *  grantedItemsField's doc comment, items.mjs), so each has to be fetched via fromUuid.
   *  Non-trophy entries (the free default kit) stay as their existing snapshot and are
   *  read straight off the cached class entry by #buildItemsContext — no resolve needed
   *  since name/img/type is all the display ever shows for those.
   *
   *  Guarded by kitForClassUuid so this only re-runs when the selected class actually
   *  changed since the last time the items step was built — re-entering the step after
   *  Back/Next without changing class leaves any trades the player already made alone. */
  async #ensureItemStepState() {
    if (this.builderState.kitForClassUuid === this.builderState.classUuid) return;

    const cls = this.#classes?.find((c) => c.uuid === this.builderState.classUuid);
    const entries = cls?.startingItems ?? [];

    const kitTrophies = [];
    for (const entry of entries) {
      if (entry.type !== "trophies") continue;
      const source = await fromUuid(entry.uuid);
      if (!source) continue;
      kitTrophies.push({
        key: this.#nextKitKey(),
        name: source.name,
        img: source.img,
        rarity: source.system.rarity,
        size: source.system.size,
        // Full system snapshot (description/property/category/…) so a trophy that's
        // never traded away can be recreated on the actor at #onFinish with everything
        // the compendium source had.
        sourceSystem: source.system.toObject(),
      });
    }

    this.builderState.kitForClassUuid = this.builderState.classUuid;
    this.builderState.kitTrophies = kitTrophies;
    this.builderState.trades = [];
    this.builderState.selectedTrophyKeys = [];
    this.builderState.activeOffer = null;
  }

  /** Items step context — the class's free default kit (non-trophy startingItems
   *  entries), the current trophy pool (one or more may be "armed" for spending — see
   *  #onSelectTrophy), and the equipment compendium browser. A row there is only
   *  tradeable while there's spendable budget (see `budget` below) AND the row's own
   *  rarity doesn't exceed it — see #onTradeEquipment. */
  #buildItemsContext() {
    const cls = this.#classes?.find((c) => c.uuid === this.builderState.classUuid);
    const entries = cls?.startingItems ?? [];

    const kitItems = entries
      .filter((e) => e.type !== "trophies")
      .map((e) => ({ ...e, typeLabel: this.#itemTypeLabel(e.type) }));

    const selectedTrophies = this.builderState.kitTrophies.filter((t) =>
      this.builderState.selectedTrophyKeys.includes(t.key)
    );
    // Combining trophies: #onSelectTrophy never lets this array hold mixed rarities (see
    // its doc comment), so a single base rarity always covers the whole selection — each
    // trophy past the first raises the offer by one more rank, e.g. two rarity-3 trophies
    // together offer at rarity 4, three at rarity 5. null with nothing selected.
    const freshOfferRarity = selectedTrophies.length
      ? clampRarity(selectedTrophies[0].rarity + (selectedTrophies.length - 1))
      : null;

    // The budget actually spendable right now: what's left of an offer already partway
    // through being spent on several items (builderState.activeOffer — see
    // #onTradeEquipment), or else a freshly-armed selection's own combined value. Never
    // both at once — arming a new selection while one is still open forfeits it (see
    // #onSelectTrophy).
    const activeOffer = this.builderState.activeOffer;
    const budget = activeOffer?.remainingRarity ?? freshOfferRarity;

    const kitTrophies = this.builderState.kitTrophies.map((t) => ({
      ...t,
      rarityValue: clampRarity(t.rarity),
      selected: this.builderState.selectedTrophyKeys.includes(t.key),
    }));

    const search = this.builderState.equipSearch.trim().toLowerCase();
    const equipment = (this.#equipment ?? [])
      .filter((e) => !search || e.name.toLowerCase().includes(search))
      .map((e) => {
        const traded = this.builderState.trades.some((t) => t.equipmentUuid === e.uuid);
        // A purchase no longer has to spend the WHOLE budget at once — any item costing
        // no more than what's left is tradeable (see #onTradeEquipment); a cheaper item
        // just leaves the rest to spend on something else.
        const canTrade = !traded && budget != null && e.rarity <= budget;
        let disabledReason = "";
        if (!traded && !canTrade) {
          disabledReason = budget == null
            ? game.i18n.localize("GOD.CharBuilder.WarnSelectTrophyFirst")
            : game.i18n.localize("GOD.CharBuilder.WarnRarityMismatch");
        }
        return {
          ...e,
          rarityValue: clampRarity(e.rarity),
          typeLabel: this.#itemTypeLabel(e.type),
          traded,
          canTrade,
          disabledReason,
        };
      });

    // Trades are grouped by the offer that funded them — several items can share one
    // offer's budget (see #onTradeEquipment), and undoing any one of them undoes the
    // whole group at once (see #onUndoTrade), so the UI shows/undoes them together
    // rather than as unrelated individual rows.
    const tradeGroups = [];
    const groupsById = new Map();
    for (const t of this.builderState.trades) {
      let group = groupsById.get(t.groupId);
      if (!group) {
        group = { id: t.groupId, items: [] };
        groupsById.set(t.groupId, group);
        tradeGroups.push(group);
      }
      group.items.push({ ...t, rarityValue: clampRarity(t.rarity) });
    }
    for (const group of tradeGroups) group.multi = group.items.length > 1;

    return {
      kitItems, kitTrophies, equipment, tradeGroups, search: this.builderState.equipSearch,
      offerRarity: budget, combining: selectedTrophies.length > 1, offerActive: !!activeOffer,
    };
  }

  /** Мезонин step context — the 5 drives (GOD.MEZZANINE_DRIVES) in their fixed order,
   *  each tagged with its priority rank from builderState.mezzanineOrder (or null if not
   *  yet clicked). Same shape as GODActorSheet#prepareMezzanine's `drives`, so the two
   *  can share the click-to-append/click-to-remove mental model even though one writes to
   *  in-memory builderState and the other to a live actor.update(). */
  #buildMezzanineContext() {
    const order = this.builderState.mezzanineOrder;
    const drives = GOD.MEZZANINE_DRIVES.map((d) => {
      const idx = order.indexOf(d.key);
      return { key: d.key, name: d.name, rank: idx >= 0 ? idx + 1 : null };
    });
    return { drives, complete: order.length === GOD.MEZZANINE_DRIVES.length };
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender(context, options);

    this.element.querySelectorAll("[data-action='builder-back']").forEach((b) =>
      b.addEventListener("click", (e) => { e.preventDefault(); this.step--; this.#lastScroll = 0; this.render(); })
    );
    this.element.querySelectorAll("[data-action='builder-next']").forEach((b) =>
      b.addEventListener("click", this.#onNext.bind(this))
    );
    this.element.querySelectorAll("[data-action='builder-finish']").forEach((b) =>
      b.addEventListener("click", this.#onFinish.bind(this))
    );

    this.element.querySelectorAll(".builder-race-card").forEach((el) =>
      el.addEventListener("click", () => { this.builderState.raceUuid = el.dataset.uuid; this.#rerender(); })
    );
    this.element.querySelectorAll(".builder-class-card").forEach((el) =>
      el.addEventListener("click", () => { this.builderState.classUuid = el.dataset.uuid; this.#rerender(); })
    );

    // Class competency chips (FIRST competency step) — click an unpicked one to add it
    // (up to #classCompetencyPickCount()), click an already-picked one to remove it.
    this.element.querySelectorAll(".cb-class-competency-chip").forEach((el) =>
      el.addEventListener("click", () => this.#onClassCompetencyClick(el.dataset.name))
    );
    // General competency chips (SECOND competency step) — same click-to-add/remove
    // model, capped at GOD.COMPETENCY_PICK_COUNT instead.
    this.element.querySelectorAll(".cb-competency-chip").forEach((el) =>
      el.addEventListener("click", () => this.#onCompetencyClick(el.dataset.name))
    );

    // Items step — click a trophy card to arm it for spending, click an equipment row
    // to spend the armed trophy on it (only enabled rows fire — see #buildItemsContext's
    // canTrade), undo an existing trade, and the equipment search box.
    this.element.querySelectorAll(".cb-trophy-card").forEach((el) =>
      el.addEventListener("click", () => this.#onSelectTrophy(el.dataset.key))
    );
    this.element.querySelectorAll(".cb-equip-trade").forEach((el) =>
      el.addEventListener("click", () => this.#onTradeEquipment(el.dataset.uuid))
    );
    this.element.querySelectorAll(".cb-trade-undo").forEach((el) =>
      el.addEventListener("click", () => this.#onUndoTrade(el.dataset.id))
    );
    this.element.querySelector(".cb-equip-search")?.addEventListener("input", (event) => {
      const input = event.currentTarget;
      this.builderState.equipSearch = input.value;
      this.#pendingFocus = { selector: ".cb-equip-search", start: input.selectionStart, end: input.selectionEnd };
      this.#rerender();
    });

    // Мезонин drive cards — click an unranked drive to append it as the next priority,
    // click an already-ranked one to remove it (closing the gap for the ones after it).
    this.element.querySelectorAll(".cb-drive-card").forEach((el) =>
      el.addEventListener("click", () => this.#onDriveClick(el.dataset.key))
    );

    this.element.querySelector(".cb-xp-remaining-input")?.addEventListener("change", this.#onRemainingChange.bind(this));

    this.element.querySelectorAll("[data-action='char-inc']").forEach((b) =>
      b.addEventListener("click", () => this.#adjustChar(b.dataset.key, 1))
    );
    this.element.querySelectorAll("[data-action='char-dec']").forEach((b) =>
      b.addEventListener("click", () => this.#adjustChar(b.dataset.key, -1))
    );
    // Skill rank star pips — same click-to-jump-to-this-rank interaction as
    // actor-sheet.mjs#onSkillRankClick, just operating on in-memory builderState instead
    // of a live actor document.
    this.element.querySelectorAll(".skill-rank-mark").forEach((mark) =>
      mark.addEventListener("click", () =>
        this.#onSkillRankClick(mark.dataset.skill, mark.dataset.char, parseInt(mark.dataset.index, 10))
      )
    );

    // Restore the .cb-scroll position captured by #rerender() — the part's markup is
    // fully replaced on every render, so the browser resets scrollTop to 0 on its own.
    requestAnimationFrame(() => {
      const scrollEl = this.element?.querySelector(".cb-scroll");
      if (scrollEl) scrollEl.scrollTop = this.#lastScroll;
    });

    // Restore focus/caret on the equipment search box after a re-render it itself
    // triggered — see #pendingFocus's doc comment.
    if (this.#pendingFocus) {
      const { selector, start, end } = this.#pendingFocus;
      this.#pendingFocus = null;
      requestAnimationFrame(() => {
        const el = this.element?.querySelector(selector);
        if (el) {
          el.focus();
          if (typeof el.setSelectionRange === "function") el.setSelectionRange(start, end);
        }
      });
    }
  }

  /** Like render(), but captures the current .cb-scroll position first and restores it
   *  after — for controls that update the alloc step in place (+/- buttons) without
   *  navigating to a different page, where resetting scroll to the top would be jarring. */
  #rerender() {
    const scrollEl = this.element?.querySelector(".cb-scroll");
    if (scrollEl) this.#lastScroll = scrollEl.scrollTop;
    this.render();
  }

  /* -------------------------------------------- */

  #onNext(event) {
    event.preventDefault();

    if (this.step === 0) {
      const name = this.element.querySelector("[name='builder-name']")?.value.trim() ?? "";
      const nickname = this.element.querySelector("[name='builder-nickname']")?.value.trim() ?? "";
      if (!name) {
        ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnName"));
        return;
      }
      this.builderState.name = name;
      this.builderState.nickname = nickname;
    } else if (this.step === 1 && !this.builderState.raceUuid) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnRace"));
      return;
    } else if (this.step === 2 && !this.builderState.classUuid) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnClass"));
      return;
    } else if (this.step === 3 && this.builderState.classCompetencies.length !== this.#classCompetencyPickCount()) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnClassCompetencies"));
      return;
    } else if (this.step === 4 && this.builderState.competencies.length !== GOD.COMPETENCY_PICK_COUNT) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnCompetencies"));
      return;
    } else if (this.step === 6 && this.builderState.mezzanineOrder.length < GOD.MEZZANINE_DRIVES.length) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnMezzanine"));
      return;
    }

    this.step++;
    this.#lastScroll = 0;
    this.render();
  }

  /** The "Остаток" field is editable — typing a new remaining value re-derives the total
   *  XP pool for this chargen (spent + the typed remaining), instead of the fixed
   *  GODCharacterBuilder.XP_POOL default. Lets the GM/player grant a bigger or smaller
   *  starting budget per character without touching code. Floored at 0 — the pool can
   *  never dip below what's already spent. */
  #onRemainingChange(event) {
    const input = event.currentTarget;
    let value = parseInt(input.value, 10);
    if (Number.isNaN(value) || value < 0) value = 0;

    const { spent } = this.#buildAllocContext();
    this.builderState.xpPool = spent + value;
    this.#rerender();
  }

  #adjustChar(key, delta) {
    const cur = this.builderState.chars[key];
    const next = cur + delta;
    if (next < GODCharacterBuilder.CHAR_MIN || next > GODCharacterBuilder.CHAR_MAX_START) return;
    // Piecewise 1/2/3 XP-per-point ladder (charPointXpCost() in config.mjs), same as the
    // post-chargen purchase on the character sheet — the price of THIS point depends on
    // the value before it, not a flat rate.
    if (delta > 0 && this.#buildAllocContext().remaining < charPointXpCost(cur)) return;

    this.builderState.chars[key] = next;

    // Same auto-clamp as actor-sheet.mjs#onNumberInputChange — lowering a characteristic
    // below a rank's prerequisite rolls the raw purchased rank back down, floored at 0
    // (no more chargen baseline — see #onSkillRankClick), never touching a class-granted
    // bonus rank.
    if (delta < 0) {
      const raceBonuses = this.#selectedRaceBonuses();
      const newEffective = Math.max(0, Math.min(GOD.CHAR_HARD_MAX, next + (raceBonuses[key] ?? 0)));
      const maxEffectiveRank = maxRankForChar(newEffective);
      const cat = Object.values(GOD.SKILL_MAP).find((c) => c.charKey === key);
      const classBonuses = this.#selectedClassBonuses();
      for (const skill of cat?.skills ?? []) {
        const classBonus = classBonuses[skill.key] ?? 0;
        const maxRaw = Math.max(0, maxEffectiveRank - classBonus);
        if (this.builderState.skillRanks[skill.key] > maxRaw) {
          this.builderState.skillRanks[skill.key] = maxRaw;
        }
      }
    }

    this.#rerender();
  }

  /** Skill rank star pip click — identical model to actor-sheet.mjs#onSkillRankClick:
   *  `index` is the TARGET EFFECTIVE rank (raw purchased rank + the class's free bonus).
   *  Clicking the pip at the current effective rank steps the raw rank down by one, floored
   *  at 0 — a class-granted bonus rank can never be sold back here (the raw purchased
   *  portion just can't go negative), but there's no more chargen-only free floor above
   *  that. Any other pip targets that effective rank directly. Cost/prerequisite are both
   *  priced off the current EFFECTIVE rank, so a class bonus already covering a tier is
   *  never paid for twice. */
  #onSkillRankClick(skillKey, charKey, index) {
    const current = this.builderState.skillRanks[skillKey] ?? 0;
    const classBonus = this.#selectedClassBonuses()[skillKey] ?? 0;
    const currentEffective = Math.min(4, current + classBonus);

    const newRaw = currentEffective === index ? Math.max(0, current - 1) : Math.max(0, index - classBonus);
    if (newRaw === current) return;

    const newEffective = Math.min(4, newRaw + classBonus);

    if (newEffective > currentEffective) {
      const raceBonuses = this.#selectedRaceBonuses();
      const charValue = Math.max(0, Math.min(GOD.CHAR_HARD_MAX, this.builderState.chars[charKey] + (raceBonuses[charKey] ?? 0)));
      const prereq = skillRankCharPrereq(newEffective);
      if (charValue < prereq) {
        const cat = Object.values(GOD.SKILL_MAP).find((c) => c.charKey === charKey);
        ui.notifications.warn(`Требуется ${cat?.name ?? charKey} ${prereq}`);
        return;
      }

      const cost = skillRankRaiseCost(currentEffective, newEffective);
      if (this.#buildAllocContext().remaining < cost) return;
    }

    this.builderState.skillRanks[skillKey] = newRaw;
    this.#rerender();
  }

  /** FIRST competency step's chip click — click-to-add/click-to-remove, capped at
   *  #classCompetencyPickCount() picks off the selected class's own competency list.
   *  Refuses a name already picked on the SECOND (general) step (see
   *  #buildClassCompetencyContext's takenElsewhere) — the chip is rendered disabled for
   *  that case (see the template), this just re-checks defensively. */
  #onClassCompetencyClick(name) {
    const list = this.builderState.classCompetencies;
    const idx = list.indexOf(name);
    const pickCount = this.#classCompetencyPickCount();
    if (idx >= 0) {
      list.splice(idx, 1);
    } else if (this.builderState.competencies.includes(name)) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnCompetencyTaken"));
      return;
    } else if (list.length < pickCount) {
      list.push(name);
    } else {
      ui.notifications.warn(`Можно выбрать не больше ${pickCount} компетенций класса.`);
      return;
    }
    this.#rerender();
  }

  /** SECOND competency step's chip click — click-to-add/click-to-remove, capped at
   *  GOD.COMPETENCY_PICK_COUNT picks total (across every group, not per group).
   *  Unrestricted by the selected class (see #onClassCompetencyClick for that pick),
   *  except a name already picked THERE is refused here too (see
   *  #buildCompetencyContext's takenElsewhere) — the chip is rendered disabled for that
   *  case (see the template), this just re-checks defensively. */
  #onCompetencyClick(name) {
    const list = this.builderState.competencies;
    const idx = list.indexOf(name);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else if (this.builderState.classCompetencies.includes(name)) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnCompetencyTaken"));
      return;
    } else if (list.length < GOD.COMPETENCY_PICK_COUNT) {
      list.push(name);
    } else {
      ui.notifications.warn(`Можно выбрать не больше ${GOD.COMPETENCY_PICK_COUNT} компетенций.`);
      return;
    }
    this.#rerender();
  }

  /** Мезонин drive card click — click-to-append/click-to-remove, same model as
   *  GODActorSheet#onMezzanineDriveClick's edit-mode branch (the sheet reuses this exact
   *  interaction post-chargen, just against a live actor.update() instead of in-memory
   *  builderState). An unranked drive gets appended as the next priority; an already-
   *  ranked one is spliced out, automatically closing the gap for everything ranked after
   *  it since priority is just array position, not a stored number. */
  #onDriveClick(driveKey) {
    const order = this.builderState.mezzanineOrder;
    const idx = order.indexOf(driveKey);
    if (idx >= 0) order.splice(idx, 1);
    else if (order.length < GOD.MEZZANINE_DRIVES.length) order.push(driveKey);
    this.#rerender();
  }

  /** Trophy card click — toggles that trophy into/out of the "armed" selection spent by
   *  #onTradeEquipment. Two or more armed trophies combine into one offer, but ONLY if
   *  they're all the same rarity (see #buildItemsContext's offerRarity) — clicking a
   *  trophy whose rarity doesn't match the rest of the current selection starts a fresh
   *  selection with just that trophy instead of mixing rarities. Only an untraded trophy
   *  is ever in this list to begin with (a spent one is spliced out of
   *  builderState.kitTrophies entirely, see #onTradeEquipment).
   *
   *  Arming a selection here always starts fresh, so it first forfeits whatever's left of
   *  a still-open offer (builderState.activeOffer, see #onTradeEquipment) — there's no
   *  "change" mechanic to hand unspent value back as a trophy, so once the player moves
   *  on to a new pick the old remainder is simply lost; warn them since that's a real,
   *  possibly-unintended loss. */
  #onSelectTrophy(key) {
    if (this.builderState.activeOffer) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnOfferAbandoned"));
      this.builderState.activeOffer = null;
    }
    const keys = this.builderState.selectedTrophyKeys;
    const idx = keys.indexOf(key);
    if (idx >= 0) {
      keys.splice(idx, 1);
    } else {
      const clicked = this.builderState.kitTrophies.find((t) => t.key === key);
      const first = this.builderState.kitTrophies.find((t) => t.key === keys[0]);
      if (first && clicked && first.rarity !== clicked.rarity) keys.length = 0;
      keys.push(key);
    }
    this.#rerender();
  }

  /** Equipment row click — spends against the current budget (#buildItemsContext's
   *  `budget`), which is either an offer already partway through being spent
   *  (builderState.activeOffer) or a freshly-armed trophy selection
   *  (#onSelectTrophy/#buildItemsContext's offerRarity). Only requires the item's rarity
   *  to be AT MOST the budget, not an exact match — a rarity-3 offer can fund one
   *  rarity-3 item, or a rarity-2 + a rarity-1, or three rarity-1s, one click at a time,
   *  same barter (never numeric price) each time. The row itself is only rendered as
   *  tradeable when this is already true (#buildItemsContext's canTrade), this re-checks
   *  defensively.
   *
   *  Continuing an already-open offer (activeOffer set) just draws down its
   *  remainingRarity and tags the new trade with the SAME groupId, no trophies to touch
   *  again. Starting a fresh one removes every armed trophy from the pool right away
   *  (spent for the whole offer, not per item) and stashes them on the group's FIRST
   *  trade record (spentTrophies) so #onUndoTrade can hand them all back verbatim
   *  whenever the group gets undone — whether that's before or after the rest of the
   *  budget was spent. If the purchase doesn't exhaust the offer, activeOffer stays open
   *  for more clicks instead of clearing the selection outright. */
  #onTradeEquipment(equipmentUuid) {
    const equip = this.#equipment?.find((e) => e.uuid === equipmentUuid);
    if (!equip) return;
    if (this.builderState.trades.some((t) => t.equipmentUuid === equipmentUuid)) return;

    const activeOffer = this.builderState.activeOffer;
    if (activeOffer) {
      if (equip.rarity > activeOffer.remainingRarity) {
        ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnRarityMismatch"));
        return;
      }
      activeOffer.remainingRarity -= equip.rarity;
      this.builderState.trades.push({
        id: foundry.utils.randomID(), groupId: activeOffer.groupId,
        equipmentUuid: equip.uuid, name: equip.name, img: equip.img, rarity: equip.rarity, type: equip.type,
      });
      if (activeOffer.remainingRarity <= 0) this.builderState.activeOffer = null;
      this.#rerender();
      return;
    }

    const keys = this.builderState.selectedTrophyKeys;
    if (!keys.length) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnSelectTrophyFirst"));
      return;
    }
    const spentTrophies = keys
      .map((key) => this.builderState.kitTrophies.find((t) => t.key === key))
      .filter(Boolean);
    if (spentTrophies.length !== keys.length) {
      // A selected key no longer resolves to a pool trophy (stale state) — bail rather
      // than spend a partial/mismatched set.
      this.builderState.selectedTrophyKeys = [];
      return;
    }
    const offerRarity = clampRarity(spentTrophies[0].rarity + (spentTrophies.length - 1));
    if (equip.rarity > offerRarity) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnRarityMismatch"));
      return;
    }
    this.builderState.kitTrophies = this.builderState.kitTrophies.filter((t) => !keys.includes(t.key));
    this.builderState.selectedTrophyKeys = [];

    const groupId = foundry.utils.randomID();
    this.builderState.trades.push({
      id: foundry.utils.randomID(), groupId,
      equipmentUuid: equip.uuid, name: equip.name, img: equip.img, rarity: equip.rarity, type: equip.type,
      spentTrophies,
    });
    const remainingRarity = offerRarity - equip.rarity;
    this.builderState.activeOffer = remainingRarity > 0 ? { groupId, remainingRarity } : null;
    this.#rerender();
  }

  /** Undoes an ENTIRE trade group — every item bought off one offer's budget (see
   *  #onTradeEquipment), not just the one clicked; there's no per-item partial undo since
   *  the trophies were spent for the whole offer up front, not per item. Hands every
   *  trophy the group spent back to the pool exactly as they were (spentTrophies lives on
   *  the group's first trade record — see #onTradeEquipment), and closes out the group's
   *  offer if it was still open (some of its budget unspent). */
  #onUndoTrade(groupId) {
    const groupTrades = this.builderState.trades.filter((t) => t.groupId === groupId);
    if (!groupTrades.length) return;
    this.builderState.trades = this.builderState.trades.filter((t) => t.groupId !== groupId);
    const spentTrophies = groupTrades.find((t) => t.spentTrophies)?.spentTrophies ?? [];
    this.builderState.kitTrophies.push(...spentTrophies);
    if (this.builderState.activeOffer?.groupId === groupId) this.builderState.activeOffer = null;
    this.#rerender();
  }

  /* -------------------------------------------- */

  async #onFinish(event) {
    event.preventDefault();

    if (this.builderState.classCompetencies.length !== this.#classCompetencyPickCount()) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnClassCompetencies"));
      return;
    }
    if (this.builderState.competencies.length !== GOD.COMPETENCY_PICK_COUNT) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnCompetencies"));
      return;
    }
    if (this.builderState.mezzanineOrder.length < GOD.MEZZANINE_DRIVES.length) {
      ui.notifications.warn(game.i18n.localize("GOD.CharBuilder.WarnMezzanine"));
      return;
    }

    const updates = {
      name: this.builderState.name,
      "system.biography.nickname": this.builderState.nickname,
      "system.mezzanine.order": this.builderState.mezzanineOrder,
      // Stamps every actor chargen produces as already on the current 0–4 rank scale —
      // see data-models.mjs's rankSystemVersion schema doc comment — so its skillRanks
      // (written just below) are never mistaken for old-scale values and re-shifted by
      // CharacterDataModel.migrateData's one-time rank-scale migration.
      "system.rankSystemVersion": 2,
    };
    for (const [k, v] of Object.entries(this.builderState.chars)) updates[`system.chars.${k}`] = v;
    for (const [k, v] of Object.entries(this.builderState.skillRanks)) updates[`system.skillRanks.${k}`] = v;
    await this.actor.update(updates);

    const itemsToCreate = [];
    for (const uuid of [this.builderState.raceUuid, this.builderState.classUuid]) {
      if (!uuid) continue;
      const source = await fromUuid(uuid);
      if (!source) continue;
      const data = source.toObject();
      delete data._id;
      // Replace the class's own full competencies list with just the builder's two picks
      // (classCompetencies + competencies) on the actor's OWN copy of the class item —
      // the compendium source class is never touched (see GOD.COMPETENCY_GROUPS' doc
      // comment, config.mjs). The class no longer grants its whole list wholesale.
      if (uuid === this.builderState.classUuid) {
        data.system.competencies = [...this.builderState.classCompetencies, ...this.builderState.competencies];
      }
      itemsToCreate.push(data);
    }

    // Starting-items step results — the class's free default kit (non-trophy
    // startingItems entries), whatever kit trophies never got traded away, and whatever
    // equipment was traded for. A one-time chargen snapshot, same as
    // classCompetencies/competencies above — never touches the class item's own
    // startingItems list, and isn't kept in sync with it afterward.
    await this.#ensureItemStepState();
    const selectedClass = this.#classes?.find((c) => c.uuid === this.builderState.classUuid);
    for (const entry of selectedClass?.startingItems ?? []) {
      if (entry.type === "trophies") continue;
      const source = await fromUuid(entry.uuid);
      if (!source) continue;
      const data = source.toObject();
      delete data._id;
      itemsToCreate.push(data);
    }
    for (const trophy of this.builderState.kitTrophies) {
      itemsToCreate.push({
        name: trophy.name,
        type: "trophies",
        img: trophy.img,
        system: { ...trophy.sourceSystem, rarity: trophy.rarity },
      });
    }
    for (const trade of this.builderState.trades) {
      const source = await fromUuid(trade.equipmentUuid);
      if (!source) continue;
      const data = source.toObject();
      delete data._id;
      itemsToCreate.push(data);
    }

    // grantClassItems / single-slot enforcement runs off the createItem hook
    // (module/data/class-race-rules.mjs) — nothing else to do here.
    if (itemsToCreate.length) await this.actor.createEmbeddedDocuments("Item", itemsToCreate);

    // Post the final XP budget to chat — pool here is whatever #onRemainingChange left it
    // at (defaults to GODCharacterBuilder.XP_POOL if the GM never touched the field), so
    // this is the actual grant, not just the hardcoded default.
    const { pool, spent } = this.#buildAllocContext();
    const unspent = pool - spent;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: `
        <div class="god-chargen-summary">
          <div class="cg-header">Создание персонажа завершено</div>
          <div class="cg-name">${this.builderState.name}</div>
          <div class="cg-xp-row">
            <span>Выделено: <strong>${pool}</strong> XP</span>
            <span>Потрачено: <strong>${spent}</strong> XP</span>
            <span>Осталось: <strong>${unspent}</strong> XP</span>
          </div>
        </div>
      `,
    });

    ui.notifications.info(`${game.i18n.localize("GOD.CharBuilder.Done")}: ${this.builderState.name}`);
    this.close();
  }

  /* -------------------------------------------- */

  async close(options = {}) {
    GODCharacterBuilder.#open.delete(this.actor.id);
    return super.close(options);
  }
}
