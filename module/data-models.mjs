/**
 * GOD Tactical — Actor Data Models
 * Foundry VTT v13 TypeDataModel
 */

import { GOD } from "./config.mjs";

const { SchemaField, NumberField, StringField, ArrayField } = foundry.data.fields;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** Build skill RANK fields from SKILL_MAP (0–4, 0 = no rank at all). The actual skill
 *  value used by rolls is derived from this rank and the linked characteristic — see
 *  skillValueFromRank(). */
function buildSkillRankFields() {
  const fields = {};
  for (const cat of Object.values(GOD.SKILL_MAP)) {
    for (const skill of cat.skills) {
      fields[skill.key] = new NumberField({
        required: true,
        nullable: false,
        initial: 0,
        min: 0,
        max: 4,
        integer: true,
      });
    }
  }
  return fields;
}

/** A skill's value = floor(characteristic / 2) + the rank's flat bonus (GOD.SKILL_RANK_BONUS),
 *  clamped first to (characteristic - 5) — the invariant that a characteristic always reads
 *  higher than any skill it governs — then to the overall 95 cap. Order matters: the
 *  characteristic-relative clamp must run before the flat cap. */
export function skillValueFromRank(rank, charValue) {
  const r = Math.max(0, Math.min(4, rank ?? 0));
  const c = charValue ?? 0;
  let value = Math.floor(c / 2) + GOD.SKILL_RANK_BONUS[r];
  value = Math.min(value, c - 5);
  value = Math.min(value, 95);
  return Math.max(0, value);
}

/** Minimum EFFECTIVE characteristic required to buy/hold a given rank (0–4) —
 *  see GOD.SKILL_RANK_CHAR_PREREQ. */
export function skillRankCharPrereq(rank) {
  return GOD.SKILL_RANK_CHAR_PREREQ[Math.max(0, Math.min(4, rank ?? 0))];
}

/** Total XP cost to raise a skill's rank from `from` to `to` (to > from) — sums each
 *  intermediate rank's fixed step cost (GOD.SKILL_RANK_XP_COST). */
export function skillRankRaiseCost(from, to) {
  let total = 0;
  for (let r = from + 1; r <= to; r++) total += GOD.SKILL_RANK_XP_COST[r];
  return total;
}

/** Highest EFFECTIVE rank (0–4) whose prerequisite is met by the given characteristic
 *  value — used to auto-clamp a skill's raw purchased rank back down when its governing
 *  characteristic drops (see #onNumberInputChange in actor-sheet.mjs and #adjustChar in
 *  character-builder.mjs). A class-granted bonus rank is never touched by this — only the
 *  raw purchased portion (effectiveRank - classBonus) gets floored. */
export function maxRankForChar(charValue) {
  let max = 0;
  for (let r = 1; r <= 4; r++) {
    if (skillRankCharPrereq(r) <= (charValue ?? 0)) max = r;
  }
  return max;
}

/** Repoints any keys in `obj` that match GOD.SKILL_KEY_RENAMES (config.mjs) onto their
 *  current key, in place. Used on both the ancient `skills` shape and the current
 *  `skillRanks` shape below, plus by items.mjs for the `skill` field on weapons/abilities
 *  and ClassDataModel's skillRankBonuses. */
export function renameSkillKeys(obj) {
  if (!obj) return;
  for (const [oldKey, newKey] of Object.entries(GOD.SKILL_KEY_RENAMES)) {
    if (obj[oldKey] !== undefined && obj[newKey] === undefined) {
      obj[newKey] = obj[oldKey];
      delete obj[oldKey];
    }
  }
}

/** Same as renameSkillKeys() above, but for GOD.CHAR_KEY_RENAMES (config.mjs) — used on the
 *  `chars`/`charFlaws`/`charExp` objects (CharacterDataModel/NPCDataModel here) and
 *  `charBonuses` (RaceDataModel, items.mjs). */
export function renameCharKeys(obj) {
  if (!obj) return;
  for (const [oldKey, newKey] of Object.entries(GOD.CHAR_KEY_RENAMES)) {
    if (obj[oldKey] !== undefined && obj[newKey] === undefined) {
      obj[newKey] = obj[oldKey];
      delete obj[oldKey];
    }
  }
}

/** Build characteristic fields (initial/range GOD.CHAR_MIN–GOD.CHAR_HARD_MAX). CHAR_MIN is
 *  the weakest a chargen spread can produce under the current skill formula — an unranked
 *  (rank 0) skill at char=40 rolls 20% (floor(40/2)+SKILL_RANK_BONUS[0]), still a viable
 *  minimum. */
function buildCharFields() {
  const fields = {};
  for (const cat of Object.values(GOD.SKILL_MAP)) {
    fields[cat.charKey] = new NumberField({
      required: true,
      nullable: false,
      initial: GOD.CHAR_MIN,
      min: GOD.CHAR_MIN,
      max: GOD.CHAR_HARD_MAX,
      integer: true,
    });
  }
  return fields;
}

/** Build char-flaw fields (0–3). */
function buildCharFlawFields() {
  const fields = {};
  for (const cat of Object.values(GOD.SKILL_MAP)) {
    fields[cat.charKey] = new NumberField({
      required: true,
      nullable: false,
      initial: 0,
      min: 0,
      max: 3,
      integer: true,
    });
  }
  return fields;
}

/** Build char-experience marker fields (0–3 per characteristic) — checked off by the
 *  player, e.g. once XP has been spent raising it. Same 0–3 pip shape as
 *  buildCharFlawFields() above. */
function buildCharExpFields() {
  const fields = {};
  for (const cat of Object.values(GOD.SKILL_MAP)) {
    fields[cat.charKey] = new NumberField({
      required: true,
      nullable: false,
      initial: 0,
      min: 0,
      max: 3,
      integer: true,
    });
  }
  return fields;
}

/* -------------------------------------------- */
/*  Character Data Model                        */
/* -------------------------------------------- */

export class CharacterDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      /* --- Skill ranks (16 total, 0–4, 0 = no rank at all) — the actual skill value used
       *  by rolls is derived from rank + characteristic in prepareDerivedData(), see
       *  skillValueFromRank(). --- */
      skillRanks: new SchemaField(buildSkillRankFields()),

      /* --- Rank-system schema marker, NOT player-facing — distinguishes an actor whose
       *  skillRanks are already stored on the CURRENT 0–4 scale (this field present) from
       *  one still on the older 0–5 scale (field absent in the raw stored data, since it
       *  didn't exist as a field back then — see migrateData below, and #onFinish in
       *  character-builder.mjs which stamps it on every actor chargen ever produces from
       *  now on). A value-remapping migration like this one can't tell old-3 from new-3
       *  by shape alone the way a renamed/dropped field can, hence the explicit marker
       *  instead of the usual structural check. Bump only if the rank scale changes
       *  again. */
      rankSystemVersion: new NumberField({ required: true, nullable: false, initial: 2, integer: true }),

      /* --- Characteristics (set directly, per-character) --- */
      chars: new SchemaField(buildCharFields()),

      /* --- Character flaws (0–3 per characteristic) --- */
      charFlaws: new SchemaField(buildCharFlawFields()),

      /* --- Characteristic experience marker — one toggle per characteristic, checked
       *  off by the player --- */
      charExp: new SchemaField(buildCharExpFields()),

      /* --- Wound steps (ступени ранений) — damage type per mark, bottom→top --- */
      wounds: new ArrayField(new StringField(), { required: true, initial: [] }),

      /* --- GRIT cells (Фокус, renamed to "GRIT" — see migrateData below) — every character
       *  has a flat pool of GOD.BASE_GRIT (currently 9); armor grants no bonus on top of
       *  it (see module/combat/wounds.mjs's getGritCells). Lit by default, two independent
       *  counts over the same row of boxes: gritFilled (dim, click on a box to mark/undo —
       *  same fill/undo semantics as the wound track) anchored to the right edge, and
       *  gritCracked (red, right-click to break/repair) anchored to the left edge. A box
       *  in both ranges reads as cracked. --- */
      baseGrit: new NumberField({ required: true, nullable: false, initial: GOD.BASE_GRIT, min: 0, integer: true }),
      gritFilled: new NumberField({ required: true, initial: 0, min: 0, integer: true }),
      gritCracked: new NumberField({ required: true, initial: 0, min: 0, integer: true }),

      /* --- Experience --- */
      xp: new SchemaField({
        value: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
        max: new NumberField({ required: true, nullable: false, initial: 1000, min: 0, integer: true }),
      }),

      /* --- Damage --- */
      damage: new SchemaField({
        value: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      }),

      /* --- Perks --- */
      perks: new ArrayField(new StringField(), { required: true, initial: [] }),

      /* --- Мезонин: 5 named drives (GOD.MEZZANINE_DRIVES, config.mjs), ranked 1–5 by
       *  priority, plus a shared pool of up to GOD.MEZZANINE_MAX_DICE dice spent to reroll
       *  a failed skill check against its linked characteristic (see applyMezzanine() in
       *  module/rolls/roll-dialog.mjs). `order` holds drive keys in priority order — index
       *  0 is priority 1 — rather than a rank-per-drive map, so "no duplicate ranks" is
       *  structural instead of something every writer has to validate. Set during the
       *  character builder's drive-priority step; also editable later on the sheet while
       *  in edit mode (same click-to-append/click-to-remove interaction as the builder). */
      mezzanine: new SchemaField({
        dice: new NumberField({ required: true, nullable: false, initial: GOD.MEZZANINE_MAX_DICE, min: 0, max: GOD.MEZZANINE_MAX_DICE, integer: true }),
        order: new ArrayField(new StringField(), { required: true, initial: [] }),
      }),

      /* --- Status & Control effects --- */
      statusEffects: new ArrayField(new StringField(), { required: true, initial: [] }),
      controlEffects: new ArrayField(new StringField(), { required: true, initial: [] }),

      /* --- Biography --- */
      biography: new SchemaField({
        name: new StringField({ required: true, initial: "" }),
        nickname: new StringField({ required: true, initial: "" }),
        age: new StringField({ required: true, initial: "" }),
        build: new StringField({ required: true, initial: "" }),
        weight: new StringField({ required: true, initial: "" }),
        physique: new StringField({ required: true, initial: "" }),
        gaze: new StringField({ required: true, initial: "" }),
        mark: new StringField({ required: true, initial: "" }),
        taboo: new StringField({ required: true, initial: "" }),
        vice: new StringField({ required: true, initial: "" }),
        need: new StringField({ required: true, initial: "" }),
        shame: new StringField({ required: true, initial: "" }),
      }),

      /* --- Inventory --- */
      inventory: new ArrayField(new StringField(), { required: true, initial: [] }),

      /* --- Notes --- */
      notes: new StringField({ required: true, initial: "" }),
    };
  }

  /* ------------------------------------------ */

  /** One-time data shape fixes for existing actors: repoints any skill under a retired key
   *  (GOD.SKILL_KEY_RENAMES, config.mjs) onto its current key, clamps characteristics into
   *  the current GOD.CHAR_MIN–GOD.CHAR_HARD_MAX scale, and converts skills from their old
   *  stored value (10–80) into a rank against skillRanks. */
  static migrateData(source) {
    // "Броня" was renamed to "Фокус" (same fill/crack track, now with a base pool even
    // unarmored — see baseGrit above) — repoint any actor still storing progress under
    // the old armorFilled/armorCracked keys.
    if (source.armorFilled !== undefined && source.focusFilled === undefined) {
      source.focusFilled = source.armorFilled;
      delete source.armorFilled;
    }
    if (source.armorCracked !== undefined && source.focusCracked === undefined) {
      source.focusCracked = source.armorCracked;
      delete source.armorCracked;
    }

    // "Фокус" was renamed to "GRIT" (same fill/crack track and base pool, just the
    // field/label changed) — repoint any actor still storing progress under the old
    // baseFocus/focusFilled/focusCracked keys. Chained right after the armor→focus step
    // above so a very old actor (still on armorFilled/armorCracked) lands on the current
    // gritFilled/gritCracked keys in a single migrateData pass.
    if (source.baseFocus !== undefined && source.baseGrit === undefined) {
      source.baseGrit = source.baseFocus;
      delete source.baseFocus;
    }
    if (source.focusFilled !== undefined && source.gritFilled === undefined) {
      source.gritFilled = source.focusFilled;
      delete source.focusFilled;
    }
    if (source.focusCracked !== undefined && source.gritCracked === undefined) {
      source.gritCracked = source.focusCracked;
      delete source.focusCracked;
    }

    // The characteristic scale used to run 47–99, then 40–81, then 50–91, then 50–100;
    // it's now GOD.CHAR_MIN–GOD.CHAR_HARD_MAX. Clamp any existing actor's values into the
    // new range so they don't get silently rejected/reset. Do this first — the skill-rank
    // conversion below needs the final characteristic value.
    for (const cat of Object.values(GOD.SKILL_MAP)) {
      const val = source.chars?.[cat.charKey];
      if (typeof val === "number") {
        source.chars[cat.charKey] = Math.max(GOD.CHAR_MIN, Math.min(GOD.CHAR_HARD_MAX, val));
      }
    }

    // Repoint retired skill keys onto their current name — in both the pre-rank `skills`
    // shape (ancient actors) and the current `skillRanks` shape (actors that already went
    // through the conversion below in an earlier session, under the old key names).
    renameSkillKeys(source.skills);
    renameSkillKeys(source.skillRanks);

    // "biodynamics"/ПЛОТЬ was renamed to "corpus"/КОРПУС 2026-08-21 (GOD.CHAR_KEY_RENAMES,
    // config.mjs) — repoint any retired charKey still sitting in chars/charFlaws/charExp.
    renameCharKeys(source.chars);
    renameCharKeys(source.charFlaws);
    renameCharKeys(source.charExp);

    // charExp used to be a single BooleanField per characteristic; it's now a 0–3
    // NumberField (three separate marks, same pip shape as charFlaws) — repoint any
    // existing true/false left over from before that change (true → fully marked, 3).
    if (source.charExp) {
      for (const [key, val] of Object.entries(source.charExp)) {
        if (typeof val === "boolean") source.charExp[key] = val ? 3 : 0;
      }
    }

    // Мезонин drives were renamed 2026-08-21 (GOD.MEZZANINE_KEY_RENAMES, config.mjs) —
    // repoint any retired key still sitting in mezzanine.order so it doesn't silently drop
    // out of GOD.MEZZANINE_DRIVES.find() lookups (actor-sheet.mjs, roll-dialog.mjs).
    if (Array.isArray(source.mezzanine?.order)) {
      source.mezzanine.order = source.mezzanine.order.map((key) => GOD.MEZZANINE_KEY_RENAMES[key] ?? key);
    }

    // RETIRED: this used to shift an old-scale (0–5) actor's skillRanks down by one, once,
    // guarded by `!source.rankSystemVersion` being absent from the raw stored data. That
    // guard doesn't survive an unlinked token's ActorDelta update path: Foundry runs
    // migrateData on the SPARSE update payload for a synthetic token-actor write (not the
    // full persisted source), and a sparse payload — e.g. just { skillRanks: { impulse: 2 } }
    // from a single rank-up click — never itself carries `rankSystemVersion`, even though the
    // real actor has long since been migrated. That made `!source.rankSystemVersion` true on
    // EVERY such write and silently re-applied the -1 shift to whatever skillRanks key was
    // being set, eating one rank off every single purchase on an unlinked token (XP still
    // spent — this ran after the sheet's own cost/prereq check — just the rank never actually
    // moved). Every actor in active use has long since carried rankSystemVersion: 2 on its
    // real persisted source, so the shift itself has no remaining legitimate targets; removed
    // rather than re-guarded to close this off for good. The field stays in the schema
    // (harmless, still defaults to 2) in case a future rank-scale change needs the same
    // marker — just don't reintroduce an in-place value transform gated on its absence.

    // Skill values used to be stored directly (10–80, system.skills.<key>); they're now
    // derived from a 0–4 rank times the linked characteristic (skillValueFromRank). Convert
    // each existing stored value into the closest matching rank so characters keep their
    // progress instead of resetting to rank 0.
    if (source.skills && !source.skillRanks) {
      source.skillRanks = {};
      for (const cat of Object.values(GOD.SKILL_MAP)) {
        const charValue = source.chars?.[cat.charKey] ?? GOD.CHAR_MIN;
        for (const skill of cat.skills) {
          const oldValue = source.skills[skill.key];
          if (typeof oldValue !== "number") continue;

          let bestRank = 0, bestDiff = Infinity;
          for (let r = 0; r <= 4; r++) {
            const diff = Math.abs(skillValueFromRank(r, charValue) - oldValue);
            if (diff < bestDiff) { bestDiff = diff; bestRank = r; }
          }
          source.skillRanks[skill.key] = bestRank;
        }
      }
      delete source.skills;
    }

    return super.migrateData(source);
  }

  /* ------------------------------------------ */

  prepareDerivedData() {
    // The attached Class item's skillRankBonuses (see items.mjs's ClassDataModel) grant
    // +1 EFFECTIVE rank per occurrence of a skill key — read live off the item, never
    // copied onto skillRanks itself (same pattern as its damage/guard/push/
    // competencies fields). `this.parent` is the Actor; by the time an actor's own
    // prepareDerivedData runs, its embedded items are already fully prepared.
    const classItem = this.parent?.items?.find((it) => it.type === "class");
    const classBonuses = classItem?.system?.skillRankBonuses ?? [];
    this.skillClassBonus = {};
    for (const key of classBonuses) this.skillClassBonus[key] = (this.skillClassBonus[key] ?? 0) + 1;

    // The attached Race item's charBonuses (see items.mjs's RaceDataModel) is a signed
    // value per characteristic, set directly on the race card — read live off the item,
    // never copied onto system.chars itself (the number input on the sheet stays bound
    // to the raw, race-bonus-free base value).
    const raceItem = this.parent?.items?.find((it) => it.type === "race");
    this.charRaceBonus = raceItem?.system?.charBonuses ?? {};

    // Effective characteristic values (base + race bonus, clamped to 0–GOD.CHAR_HARD_MAX) —
    // this is what skill values and rolls should use, never the raw system.chars.
    this.charsEffective = {};
    for (const cat of Object.values(GOD.SKILL_MAP)) {
      const base = this.chars[cat.charKey] ?? GOD.CHAR_MIN;
      this.charsEffective[cat.charKey] = Math.max(0, Math.min(GOD.CHAR_HARD_MAX, base + (this.charRaceBonus[cat.charKey] ?? 0)));
    }

    // Derive each skill's rolled value from its (bonus-adjusted) rank and the linked
    // EFFECTIVE characteristic. `skills` isn't a schema field — it's computed fresh every
    // time so it's always in sync.
    this.skills = {};
    for (const cat of Object.values(GOD.SKILL_MAP)) {
      const charValue = this.charsEffective[cat.charKey];
      for (const skill of cat.skills) {
        const baseRank = this.skillRanks[skill.key] ?? 0;
        const effectiveRank = Math.min(5, baseRank + (this.skillClassBonus[skill.key] ?? 0));
        this.skills[skill.key] = skillValueFromRank(effectiveRank, charValue);
      }
    }

    // Flat defence values (COMBAT-REDESIGN step 3, reworked 2026-08-18) — shown on the
    // sheet as headline numbers above Компетенции (see character-sheet.hbs). No longer
    // skill-derived: each is the attached Class item's own flat dodgeBase/fortitudeBase
    // (items.mjs's ClassDataModel — same role `base` plays for weapon damage) plus
    // whatever the equipped cuirass passively adds (Light armor → +1 Dodge, Heavy → +2
    // Fortitude — see actor-sheet.mjs's #prepareArmorLoadout; only one cuirass can be
    // equipped at a time, so at most one of the two bonuses ever applies). Read live off
    // the class/armor items, never stored on the actor itself, same live-read pattern as
    // skillClassBonus/charRaceBonus above. A Выносливость/Ловкость skill ROLL separately
    // computes its own tiered value off this same base (roll-dialog.mjs's
    // DEFENSE_SKILLS) — this headline number is the flat "always on" one, not that roll.
    const cuirass = this.parent?.items?.find((it) =>
      it.type === "armor" && it.system.equipped && it.system.subtype === "cuirass");
    const dodgeBonus = cuirass?.system.archetype === "light" ? 1 : 0;
    const fortitudeBonus = cuirass?.system.archetype === "heavy" ? 2 : 0;
    this.defense = {
      dodge: Math.max(0, (classItem?.system.dodgeBase ?? 0) + dodgeBonus),
      fortitude: Math.max(0, (classItem?.system.fortitudeBase ?? 0) + fortitudeBonus),
    };
  }
}

/* -------------------------------------------- */
/*  NPC Data Model                              */
/* -------------------------------------------- */

export class NPCDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      /* --- Characteristics (manual for NPC). Unlike PCs, no 47 floor — that number comes from
       *  chargen (the weakest a raised skill spread can produce), which doesn't apply to
       *  monsters/NPCs; a weak creature can be well below it. --- */
      chars: new SchemaField({
        char_cognition: new NumberField({ required: true, nullable: false, initial: 47, min: 1, max: 99, integer: true }),
        char_neurodynamics: new NumberField({ required: true, nullable: false, initial: 47, min: 1, max: 99, integer: true }),
        char_corpus: new NumberField({ required: true, nullable: false, initial: 47, min: 1, max: 99, integer: true }),
      }),

      /* --- Character flaws (0–3 per characteristic) --- */
      charFlaws: new SchemaField(buildCharFlawFields()),

      /* --- Damage / Dodge / Fortitude — single flat values, set directly by the GM. Same
       *  numbers a Character reads off their Class item's own base-damage fields
       *  (Damage/Dodge/Fortitude — see items.mjs's ClassDataModel), just static here
       *  instead of base+roll-bonus — an NPC has no class and never rolls, so the GM just
       *  sets what each number IS. `absorption` was renamed to `dodge` and `fortitude`
       *  added alongside it — see migrateData below.
       *
       *  2026-08-19: `damage` split FOUR ways — physical/metaphysical × melee/ranged,
       *  same split as ClassDataModel's baseMelee/baseRanged/baseMetaphysicalMelee/
       *  baseMetaphysicalRanged — since an NPC's own weapon/ability items now declare a
       *  damageNature + attackType too (items.mjs's weaponCardSchema), and dealing damage
       *  (module/rolls/npc-attack.mjs's dealNpcDamage, via combat-damage.mjs's
       *  npcDamageField) must read the ONE field matching what the triggering card is.
       *  migrateData below folds the old flat `value` into BOTH melee and ranged (the old
       *  model never distinguished them either); the two metaphysical fields start at 0. --- */
      damage: new SchemaField({
        melee: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
        ranged: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
        metaphysicalMelee: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
        metaphysicalRanged: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      }),
      dodge: new SchemaField({
        value: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      }),
      fortitude: new SchemaField({
        value: new NumberField({ required: true, nullable: false, initial: 0, min: 0, integer: true }),
      }),

      /* --- Wound steps (ступени ранений) — damage type per mark, bottom→top; ceiling comes
       *  from the attached Creature item's woundSteps, same as Character/Race. --- */
      wounds: new ArrayField(new StringField(), { required: true, initial: [] }),

      /* --- GRIT cells (Фокус, renamed to "GRIT" — see migrateData below) — NPCs have no
       *  armor anymore (that's a player-only concept now), so unlike a Character's
       *  baseGrit+equipped-armor sum, an NPC's total is just this flat number, set
       *  directly by the GM while editing the sheet (see module/combat/wounds.mjs's
       *  getGritCells). Lit by default, two independent counts over the same row of
       *  boxes: gritFilled (dim, click on a box to mark/undo — same fill/undo semantics
       *  as the wound track) anchored to the right edge, and gritCracked (red, right-click
       *  to break/repair) anchored to the left edge. A box in both ranges reads as
       *  cracked. --- */
      gritMax: new NumberField({ required: true, initial: 0, min: 0, integer: true }),
      gritFilled: new NumberField({ required: true, initial: 0, min: 0, integer: true }),
      gritCracked: new NumberField({ required: true, initial: 0, min: 0, integer: true }),

      /* --- Perks (abilities) --- */
      perks: new ArrayField(new StringField(), { required: true, initial: [] }),

      /* --- Nickname (кличка) — auto-assigned on creation (see module/data/npc-nicknames.mjs)
       *  so two copies of the same NPC/creature stay distinguishable in the Actors list. --- */
      nickname: new StringField({ required: true, initial: "" }),

      /* --- Hierarchy (Иерархия) — pawn | equal | boss, see GOD.NPC_HIERARCHY_TIERS
       *  (config.mjs). GM-set combat-role tag, no mechanical behavior wired to it. --- */
      hierarchy: new StringField({ required: true, initial: "equal" }),

      /* --- Size (Размер) — swarm | small | medium | large | veryLarge | incrediblyLarge,
       *  same tier names as the bestiary's CreatureItemDataModel.size (items.mjs). Drives
       *  this token's assumed eye/body height for the height-based blind-spot check (see
       *  blind-spot.mjs's HEIGHT_BY_SIZE) — width alone can't stand in for it, since
       *  several tiers (swarm/small/medium) share the same 1x1 token footprint. --- */
      size: new StringField({ required: true, initial: "medium" }),

      /* --- Biography (long text) --- */
      biography: new StringField({ required: true, initial: "" }),

      /* --- Notes --- */
      notes: new StringField({ required: true, initial: "" }),

    };
  }

  /** "Броня" was renamed to "Фокус", then "Фокус" was renamed to "GRIT" (same fill/crack
   *  track — see the schema fields above) — repoint any actor still storing progress
   *  under the old armorFilled/armorCracked or focusFilled/focusCracked keys, same
   *  migration CharacterDataModel's own migrateData does. */
  static migrateData(source) {
    if (source.armorFilled !== undefined && source.focusFilled === undefined) {
      source.focusFilled = source.armorFilled;
      delete source.armorFilled;
    }
    if (source.armorCracked !== undefined && source.focusCracked === undefined) {
      source.focusCracked = source.armorCracked;
      delete source.armorCracked;
    }
    if (source.focusFilled !== undefined && source.gritFilled === undefined) {
      source.gritFilled = source.focusFilled;
      delete source.focusFilled;
    }
    if (source.focusCracked !== undefined && source.gritCracked === undefined) {
      source.gritCracked = source.focusCracked;
      delete source.focusCracked;
    }
    // "absorption" was renamed to "dodge" (same static single-value field, matching the
    // Class item's own Absorption→Guard→Dodge rename — see items.mjs's ClassDataModel
    // migrateData) — repoint any NPC still storing its value under the old key.
    // "fortitude" has no predecessor to migrate from; it just starts at 0.
    if (source.absorption !== undefined && source.dodge === undefined) {
      source.dodge = source.absorption;
      delete source.absorption;
    }
    // Flat `damage.value` → melee/ranged/metaphysicalMelee/metaphysicalRanged
    // (2026-08-19) — see the schema's doc comment above. Whole-object reassignment
    // (rather than delete-in-place) drops the old `value` key in the same step.
    if (source.damage?.value !== undefined && source.damage.melee === undefined && source.damage.ranged === undefined) {
      const v = Number(source.damage.value) || 0;
      source.damage = { melee: v, ranged: v, metaphysicalMelee: 0, metaphysicalRanged: 0 };
    }
    // "biodynamics"/ПЛОТЬ was renamed to "corpus"/КОРПУС 2026-08-21 (GOD.CHAR_KEY_RENAMES,
    // config.mjs) — repoint any NPC still storing its value under the old char_biodynamics
    // key (this schema's `chars` is hardcoded, not built off GOD.SKILL_MAP, so it needs the
    // same rename CharacterDataModel gets via renameCharKeys).
    renameCharKeys(source.chars);
    return super.migrateData(source);
  }

  prepareDerivedData() {
    // NPC has no automatic derived values on this stage
  }
}

/* -------------------------------------------- */
/*  Creature Data Model (Bestiary)              */
/* -------------------------------------------- */

export class CreatureDataModel extends NPCDataModel {
  static defineSchema() {
    return super.defineSchema();
  }

  prepareDerivedData() {
    super.prepareDerivedData();
  }
}
