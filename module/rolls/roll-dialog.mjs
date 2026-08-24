/**
 * GOD Tactical — Roll Dialog (ApplicationV2)
 */

import { GODRoll, OUTCOME_LABEL } from "./d100-roll.mjs";
import { GOD, mezzaninePriorityDescription } from "../config.mjs";
import { rollBonus, damageForTier, isAttackSkill, classBaseField } from "../combat/combat-damage.mjs";
import { applyOutcomeTier } from "../combat/attack-outcome.mjs";
import { coverTargetsForShooter } from "../canvas/attack-cover-targets.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

// Выносливость (endurance) rolls a Fortitude value, Ловкость (agility) rolls a Dodge
// value — same damage-TIER formula as an attack (see combat-damage.mjs's damageForTier),
// but NOT the same bonus divisor: Fortitude uses the attack's ÷20, Dodge uses ÷10 (book:
// "Уклонение = ловкость/10" — twice as steep as Fortitude, see COMBAT-REDESIGN.md and
// combat-damage.mjs's rollBonus). See _finalizeRoll's defenseKind block below. (2026-08-19
// characteristic restructure — Плотность retired, its Fortitude role moved to
// Выносливость/endurance, formerly Ресурс; see config.mjs's GOD.SKILL_MAP.)
const DEFENSE_SKILLS = { endurance: "fortitude", agility: "dodge" };
// English, matching the character sheet's own headline labels (lang/*.json's
// GOD.Class.Dodge/Fortitude are literally left untranslated) — .roll-dmg-label
// uppercases via CSS regardless of source casing here.
const DEFENSE_LABEL = { fortitude: "Fortitude", dodge: "Dodge" };

/** "pendingMezzanine" is pure internal bookkeeping — a pointer to the actor's most recent
 *  Мезонин-eligible failure, read fresh via getFlag() by applyMezzanine() below whenever a
 *  drive button is actually clicked. No sheet template ever reads it, so there's nothing
 *  visual for a full sheet re-render to update — yet every single roll touches this flag
 *  (set on an eligible failure, cleared on everything else), and setFlag/unsetFlag always
 *  trigger the sheet's default full render. That was resetting the sheet's scroll position
 *  on virtually every roll (same class of bug as #patchWoundTrack in actor-sheet.mjs, just
 *  triggered from here instead) — {render:false} on a raw update() skips it since nothing
 *  downstream depends on this particular render. */
async function setPendingMezzanine(actor, data) {
  await actor.update({ "flags.god-tactical.pendingMezzanine": data }, { render: false });
}
async function clearPendingMezzanine(actor) {
  await actor.update({ "flags.god-tactical.-=pendingMezzanine": null }, { render: false });
}

export class GODRollDialog extends HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    id: "god-roll-dialog",
    classes: ["god-tactical", "roll-dialog"],
    position: { width: 380, height: "auto" },
    window: { resizable: false },
  };

  static PARTS = {
    form: {
      template: "systems/god-tactical/templates/rolls/roll-dialog.hbs",
    },
  };

  /* -------------------------------------------- */

  constructor(actor, data) {
    super({ window: { title: game.i18n.localize("GOD.Roll.Title") } });
    this.actor = actor;
    // { name, value, isChar, charKey, skillKey, flaws, classItem, raceItem,
    //   attackType?, damageNature?, onlyTargetTokenId? } — attackType/damageNature are only
    //   present when the roll was started FROM a weapon/ability item's own Attack button
    //   (see weapon-sheet.mjs/ability-sheet.mjs's #onAttack), and feed classBaseField() in
    //   the attack-damage block below; a roll started from the actor sheet's plain skill
    //   row (actor-sheet.mjs's #onSkillRollClick) has neither, and classBaseField() falls
    //   back to deriving melee/ranged from skillKey + assumes physical. onlyTargetTokenId
    //   is set when the roll was launched from ONE specific target's own live-preview tag
    //   in the Планер (action-log.mjs's _rollAttackForTarget) — it trims attackTargets
    //   down to that single token instead of everything currently under the shooter's
    //   template (see the attack-damage block's coverTargetsForShooter call).
    this.data = data;

    // Defaults
    this._rollType = data.flaws > 0 ? "disadvantage" : "normal";
    this._diceCount = data.flaws > 0 ? Math.min(3, data.flaws + 1) : 1;
  }

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const range = this._getRange();

    ctx.name = this.data.name;
    ctx.value = this.data.value;
    ctx.isChar = this.data.isChar;
    ctx.rollType = this._rollType;
    ctx.diceCount = this._diceCount;
    ctx.autoDisadvantage = this.data.flaws > 0;
    ctx.rangeText = `${String(range.from).padStart(2, "0")} – ${String(range.to).padStart(2, "0")}`;

    return ctx;
  }

  /* -------------------------------------------- */

  _getRange() {
    return { from: 1, to: this.data.value };
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender(context, options);

    // Roll type buttons
    this.element.querySelectorAll(".roll-type-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._rollType = btn.dataset.type;
        if (this._rollType === "normal") {
          this._diceCount = 1;
        } else if (this._diceCount === 1) {
          this._diceCount = 2;
        }
        this.render();
      });
    });

    // Dice count buttons
    this.element.querySelectorAll(".dice-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._diceCount = parseInt(btn.dataset.count, 10);
        this.render();
      });
    });

    // Launch roll
    this.element.querySelector(".roll-launch")?.addEventListener("click", () => {
      this._executeRoll();
    });
  }

  /* -------------------------------------------- */

  async _executeRoll() {
    const roll = new GODRoll(
      this.data.value,
      this._rollType,
      this._diceCount,
      { actor: this.actor }
    );
    roll.actor = this.actor;
    await roll.evaluate();
    await this._finalizeRoll(roll);
  }

  /* -------------------------------------------- */

  async _finalizeRoll(roll) {
    // "Через что бросалось" tag shown at the top of the card — the skill/characteristic
    // name, plus the governing characteristic's own name in parens for a skill roll (a
    // raw characteristic roll's name already IS the characteristic, no parenthetical
    // needed). See _charCategoryName() below.
    roll.godResult.rollSource = {
      name: this.data.name,
      charName: !this.data.isChar && this.data.charKey ? _charCategoryName(this.data.charKey) : null,
    };

    // Competency mechanic (книга правил): a double landing inside a roll's own success
    // zone is a Triumph by the raw dice rule, but only counts if the character actually
    // has competency in that direction — now applies to BOTH skill and characteristic
    // rolls (per user request; originally skill-only, see RECENT-CHANGES.md — a raw
    // characteristic roll still gets the same self-declared confirmation, the system
    // never actually cross-checks a specific competency tag against anything anyway).
    // Asking before every roll would be naggy, and a persistent "I'm competent" toggle is
    // too easy to leave on by accident — so the default (nobody confirmed anything)
    // reading downgrades that double-in-success to a Fiasco instead. The posted card
    // offers a "Есть компетенция" button (see registerCompetencyButton below) the player
    // can click after the fact to confirm they have it, flipping this specific result
    // back up to Triumph. Must run BEFORE the attack-damage block below, which reads
    // outcomeKey: an unconfirmed competency-double is a Fiasco and must deal Fiasco damage
    // (1), NOT the pre-downgrade Triumph number — the confirm flow raises it later.
    roll.godResult.competencyEligible = roll.godResult.outcomeKey === "triumph";
    if (roll.godResult.competencyEligible) {
      roll.godResult.hasCompetency = false;
      roll.godResult.outcomeKey = "fiasco";
      roll.godResult.outcomeClass = "fiasco";
      roll.godResult.outcome = game.i18n.localize(OUTCOME_LABEL.fiasco);
    }

    // Attack damage (COMBAT-REDESIGN): a roll made with an attack skill (импульс/
    // восприятие) produces damage gated by the outcome tier (see
    // module/combat/combat-damage.mjs) — read AFTER the competency downgrade above, so an
    // unconfirmed competency-double deals Fiasco damage (1) here, not Triumph. Which of
    // the Class item's 4 base-damage fields to read is resolved by classBaseField() from
    // this.data's attackType/damageNature (present when the roll was started from a
    // weapon/ability item's Attack button — see the constructor's doc comment). attackBase
    // is stashed on godResult so the competency-confirm flow can raise the shown damage to
    // the class base without a re-roll (a competency-confirmed attack deals exactly the
    // class base — per user rule; attackBonus is still stashed for the success tier's
    // base+bonus).
    if (!this.data.isChar && isAttackSkill(this.data.skillKey)) {
      const baseField = classBaseField(this.data);
      const base = Number(this.data.classItem?.[baseField]) || 0;
      const bonus = rollBonus(roll.godResult.chosen);
      roll.godResult.attackBase = base;
      roll.godResult.attackBonus = bonus;
      roll.godResult.weaponDamage = damageForTier({ base, bonus, outcome: roll.godResult.outcomeKey });

      // Per-target result (b1): the tokens caught under THIS shooter's AOE template, each
      // with its cover level and cover-reduced damage (read-only — b2 applies to HP).
      const shooterToken = this.actor?.getActiveTokens?.()[0] ?? null;
      const targets = shooterToken
        ? coverTargetsForShooter(shooterToken, roll.godResult.weaponDamage, { onlyTokenId: this.data.onlyTargetTokenId })
        : [];
      if (targets.length) roll.godResult.attackTargets = targets;
    }

    // Fortitude/Dodge roll (2026-08-18, same COMBAT-REDESIGN shape as attack damage
    // above): rolling Выносливость (endurance) or Ловкость (agility) computes a tiered
    // value off the SAME number the sheet's own headline Dodge/Fortitude shows
    // (actor.system.defense — data-models.mjs's CharacterDataModel.prepareDerivedData),
    // via the identical damageForTier/rollBonus formula. NOT the Class item's raw
    // dodgeBase/fortitudeBase directly (bug found live, 2026-08-19: that skipped the
    // equipped cuirass's own passive bonus — Light → +1 Dodge, Heavy → +2 Fortitude —
    // that system.defense already folds in, so a roll came out lower than the "always
    // on" headline number it's supposed to be tiering off of). defenseBase is stashed
    // the same way attackBase is, so the competency-confirm flow below can raise it to
    // the Triumph value without a re-roll.
    const defenseKind = !this.data.isChar ? DEFENSE_SKILLS[this.data.skillKey] : null;
    if (defenseKind) {
      const base = Number(this.actor?.system?.defense?.[defenseKind]) || 0;
      const bonus = rollBonus(roll.godResult.chosen, defenseKind === "dodge" ? 10 : 20);
      roll.godResult.defenseKind = defenseKind;
      roll.godResult.defenseLabel = DEFENSE_LABEL[defenseKind];
      roll.godResult.defenseBase = base;
      roll.godResult.defenseBonus = bonus;
      roll.godResult.defenseValue = damageForTier({ base, bonus, outcome: roll.godResult.outcomeKey });
    }

    // Мезонин mechanic (книга правил): a failed SKILL check (Провал/Фиаско — after the
    // competency downgrade above has already run, so a competency-eligible double counts
    // too) can be saved by spending one of the character's Мезонин dice — a reroll against
    // the linked CHARACTERISTIC instead of the skill, framed as acting from one of 5 named
    // drives (GOD.MEZZANINE_DRIVES). Which drive applies is the player's call, made after
    // seeing the failure — this just flags the roll as eligible and lists the character's
    // drives with their current priority; the reroll itself happens later, either from the
    // button this flags on the posted card (registerMezzanineButton below) or from the
    // Мезонин panel on the character sheet — both call applyMezzanine() below. STILL
    // skill-only, unlike competency above (which now applies to both) — a reroll against
    // "the linked characteristic" is meaningless for a roll that already IS a
    // characteristic roll, and the rulebook only ever describes this as a skill mechanic
    // ("в области навыка" — direct user requirement, see RECENT-CHANGES.md).
    roll.godResult.mezzanineEligible = !this.data.isChar
      && (roll.godResult.outcomeKey === "fail" || roll.godResult.outcomeKey === "fiasco");
    if (roll.godResult.mezzanineEligible) {
      roll.godResult.mezzanineUsed = false;
      const order = this.actor.system.mezzanine?.order ?? [];
      roll.godResult.mezzanineDrives = GOD.MEZZANINE_DRIVES
        .map((d) => ({ key: d.key, name: d.name, rank: order.indexOf(d.key) + 1 }))
        .filter((d) => d.rank > 0)
        .sort((a, b) => a.rank - b.rank)
        .map((d) => ({ ...d, hint: mezzaninePriorityDescription(d.rank) }));
    }

    const flavor = `${this.data.name} — ${roll.godResult.outcome}`;
    const message = await roll.toMessage({
      flavor,
      // Enough to rebuild what this roll was (name/actor/char/skill) later without the
      // original dialog's `this.data` around — read by the competency-confirm and Мезонин
      // flows below.
      flags: {
        "god-tactical": {
          rerollData: {
            actorUuid: this.actor.uuid,
            isChar: !!this.data.isChar,
            charKey: this.data.charKey ?? null,
            skillKey: this.data.skillKey ?? null,
            rollType: this._rollType,
            diceCount: this._diceCount,
          },
          // Snapshot of the fully-computed result, kept on the message itself (not just
          // in-memory on the Roll instance) so the competency-confirm and Мезонин flows
          // can read/patch it later — including after a page reload, when nothing but the
          // ChatMessage's own data survives. See registerCompetencyButton/
          // registerMezzanineButton below.
          rollResult: roll.godResult,
        },
      },
    });

    // Track the single most recent Мезонин-eligible failure so the sheet's drive buttons
    // (which have no chat message of their own to read state from) know what to reroll —
    // any other roll (a success, a characteristic roll, or a skill roll that isn't
    // eligible) clears it, since applying Мезонин to a stale failure once play has moved
    // on doesn't make sense. See applyMezzanine() below for the read side.
    if (roll.godResult.mezzanineEligible) {
      await setPendingMezzanine(this.actor, {
        messageId: message.id,
        charKey: this.data.charKey,
        name: this.data.name,
        rollType: this._rollType,
        diceCount: this._diceCount,
      });
    } else {
      await clearPendingMezzanine(this.actor);
    }

    this.close();
  }
}

/* -------------------------------------------- */
/*  Shared helpers                               */
/* -------------------------------------------- */

/** Resolve a roll's display name from the same {isChar, charKey, skillKey} shape stored
 *  in rerollData — shared by the competency-confirm and Мезонин flows below, both of
 *  which rebuild a flavor string from just the message's flags, without the original
 *  dialog's `this.data` around. */
function _resolveRollName({ isChar, charKey, skillKey }) {
  if (isChar) {
    const catEntry = Object.values(GOD.SKILL_MAP).find((c) => c.charKey === charKey);
    return catEntry?.name || charKey;
  }
  const catEntry = Object.values(GOD.SKILL_MAP).find((c) => c.skills.some((s) => s.key === skillKey));
  return catEntry?.skills.find((s) => s.key === skillKey)?.name || skillKey;
}

/** Display name of the characteristic a charKey belongs to (GOD.SKILL_MAP) — used to
 *  build the "через что бросалось" tag on the chat card (godResult.rollSource, see
 *  _finalizeRoll above and applyMezzanine below). */
function _charCategoryName(charKey) {
  return Object.values(GOD.SKILL_MAP).find((c) => c.charKey === charKey)?.name ?? charKey;
}

/* -------------------------------------------- */
/*  Competency button on the chat card           */
/* -------------------------------------------- */

/** Wires up the "Есть компетенция" button — shown only on cards flagged
 *  competencyEligible (a double inside a roll's own success zone — skill OR
 *  characteristic — downgraded to Fiasco by default in _finalizeRoll above). One-shot:
 *  flips the message's stored result to Triumph, rebuilds the class table's highlighted
 *  column off the actor's CURRENT class (not a stale snapshot — same live-read pattern as
 *  the sheet), re-renders the card, and persists the flip in the message's own flags so a
 *  page reload doesn't bring the button back or let it be clicked twice. Call once at
 *  module init, not per message. */
export function registerCompetencyButton() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    html.querySelector('[data-action="god-competency"]')?.addEventListener("click", () => _applyCompetency(message));
  });
}

async function _applyCompetency(message) {
  const result = message.getFlag("god-tactical", "rollResult");
  const rerollData = message.getFlag("god-tactical", "rerollData");
  if (!result || !result.competencyEligible || result.hasCompetency) return;

  result.hasCompetency = true;
  result.outcomeKey = "triumph";
  result.outcomeClass = "triumph";
  result.outcome = game.i18n.localize(OUTCOME_LABEL.triumph);
  // A competency-confirmed Triumph is no longer a failure — drop any Мезонин-reroll offer
  // this card was showing (see applyMezzanine() below).
  result.mezzanineEligible = false;

  const actor = rerollData?.actorUuid ? await fromUuid(rerollData.actorUuid) : null;

  // Confirming competency raises the shown damage to the full Triumph value (model B): class
  // base + the MAX bonus the skill allows (ceil(skill/20), NOT the rolled bonus) + base again
  // — "performed at the peak of the skill", so it depends on skill investment, not on what
  // the die happened to show. Uses the base + skill stashed at roll time — no class re-fetch,
  // no re-roll. Per-target numbers re-apply each target's STORED outcomeTier (cover + ranged
  // height-tier + "hears not sees", already combined by attack-cover-targets.mjs) to the new
  // damage — the template may be gone by now, so we reuse the stored tier rather than
  // re-querying the canvas.
  if (result.attackBase !== undefined) {
    const maxBonus = rollBonus(result.skill);
    result.weaponDamage = damageForTier({ base: result.attackBase, bonus: maxBonus, outcome: "triumph" });
    if (Array.isArray(result.attackTargets)) {
      result.attackTargets = result.attackTargets.map((t) => ({
        ...t,
        damage: applyOutcomeTier(result.weaponDamage, t.outcomeTier),
      }));
    }
  }

  // Same Triumph-recompute as attack damage above, for a Fortitude/Dodge roll
  // (defenseKind block in _finalizeRoll) — peak-of-skill bonus, not the rolled one.
  if (result.defenseBase !== undefined) {
    const maxBonus = rollBonus(result.skill, result.defenseKind === "dodge" ? 10 : 20);
    result.defenseValue = damageForTier({ base: result.defenseBase, bonus: maxBonus, outcome: "triumph" });
  }

  // If the sheet's Мезонин panel was still pointing at this exact roll as its pending
  // failure, that pointer is now stale too — clear it so the sheet doesn't offer a
  // reroll for a check that just turned into a Triumph.
  if (actor?.getFlag("god-tactical", "pendingMezzanine")?.messageId === message.id) {
    await clearPendingMezzanine(actor);
  }

  const content = await foundry.applications.handlebars.renderTemplate(GODRoll.CHAT_TEMPLATE, { result });
  const updateData = { content, flags: { "god-tactical": { rollResult: result } } };
  if (rerollData) updateData.flavor = `${_resolveRollName(rerollData)} — ${result.outcome}`;
  await message.update(updateData);
}

/* -------------------------------------------- */
/*  Мезонин (drive priorities) — reroll engine   */
/* -------------------------------------------- */

/** Spend one of the actor's Мезонин dice to reroll its most recent eligible failed skill
 *  check (module.pendingMezzanine flag, set in _finalizeRoll above) against the linked
 *  CHARACTERISTIC instead of the skill — framed as acting from `driveKey` (one of
 *  GOD.MEZZANINE_DRIVES), at whatever priority rank the actor currently has it ranked
 *  (CharacterDataModel.mezzanine.order, data-models.mjs). Shared by the button on the
 *  failed roll's own chat card (registerMezzanineButton below) and the drive rows on the
 *  character sheet's Мезонин panel (actor-sheet.mjs) — both just need an actor + a drive
 *  key; this is the only place GOD.MEZZANINE_PRIORITY_RULES is actually read. */
export async function applyMezzanine(actor, driveKey) {
  const pending = actor.getFlag("god-tactical", "pendingMezzanine");
  if (!pending) {
    ui.notifications?.warn("Нет проваленной проверки навыка, к которой можно применить Мезонин.");
    return;
  }

  const dice = actor.system.mezzanine?.dice ?? 0;
  if (dice <= 0) {
    ui.notifications?.warn("Нет доступных кубиков Мезонин.");
    return;
  }

  const order = actor.system.mezzanine?.order ?? [];
  const rank = order.indexOf(driveKey) + 1;
  if (rank < 1) {
    ui.notifications?.warn("Этому драйву не назначен приоритет — задайте его в режиме редактирования листа.");
    return;
  }

  const drive = GOD.MEZZANINE_DRIVES.find((d) => d.key === driveKey);
  const rule = GOD.MEZZANINE_PRIORITY_RULES[rank];

  const charValue = actor.system.charsEffective?.[pending.charKey] ?? 0;
  const roll = new GODRoll(charValue, pending.rollType, pending.diceCount, { actor });
  roll.actor = actor;
  await roll.evaluate();
  // Unlike a plain roll (_finalizeRoll above), the die here is actually cast against the
  // CHARACTERISTIC, not the skill — so that has to be the headline name (`name`), with
  // the original skill demoted to a "instead of what" footnote (`viaSkill`). Getting this
  // backwards (skill headline, characteristic as the quiet part) is exactly what a Мезонин
  // reroll must NOT look like on the card — it reads as "still a skill roll" when the
  // whole point of spending the die was to roll on the characteristic instead.
  roll.godResult.rollSource = { name: _charCategoryName(pending.charKey), viaSkill: pending.name };

  const isSuccessTier = roll.godResult.outcomeKey === "success" || roll.godResult.outcomeKey === "triumph";
  let consequence = null;
  if (rule.capSuccess && isSuccessTier) {
    // Ranks 4/5 can never produce a clean success or triumph off a Мезонин reroll — only
    // a success carrying a light/heavy narrative consequence (the GM calls the actual
    // effect, this is just the tag).
    roll.godResult.outcomeKey = "success";
    roll.godResult.outcomeClass = "success";
    roll.godResult.outcome = game.i18n.localize(OUTCOME_LABEL.success);
    consequence = rule.capSuccess;
  }
  roll.godResult.mezzanineDrive = drive?.name ?? driveKey;
  roll.godResult.mezzanineRank = rank;
  roll.godResult.mezzanineConsequence = consequence;

  // Attack damage is intentionally NOT carried onto a Мезонин reroll — it re-rolls on the
  // CHARACTERISTIC, not the attack skill, so it's no longer a clean weapon attack (a
  // deliberate tail; revisit if attacks should benefit from Мезонин, see COMBAT-REDESIGN).

  // Rank 1: the die is only spent if the reroll actually turned the check around — a
  // reroll that still fails costs nothing. Every other rank always spends it, win or lose
  // (GOD.MEZZANINE_PRIORITY_RULES.alwaysSpend). "Success" here is the FINAL (possibly
  // capped) outcome, so a rank-4/5 consequence success still counts as a win for this.
  const finalIsSuccess = roll.godResult.outcomeKey === "success" || roll.godResult.outcomeKey === "triumph";
  const spendDie = rule.alwaysSpend || finalIsSuccess;
  if (spendDie) await actor.update({ "system.mezzanine.dice": dice - 1 });

  await clearPendingMezzanine(actor);

  // Grey out the button on the original failed card so it can't be spent twice, whichever
  // entry point (the card's own button or the sheet panel) was actually used.
  const originalMessage = game.messages.get(pending.messageId);
  if (originalMessage) {
    const origResult = originalMessage.getFlag("god-tactical", "rollResult");
    if (origResult) {
      origResult.mezzanineUsed = true;
      const origContent = await foundry.applications.handlebars.renderTemplate(GODRoll.CHAT_TEMPLATE, { result: origResult });
      await originalMessage.update({ content: origContent, flags: { "god-tactical": { rollResult: origResult } } });
    }
  }

  const flavor = `Мезонин — ${drive?.name ?? driveKey} (приоритет ${rank}) — ${pending.name} — ${roll.godResult.outcome}`;
  await roll.toMessage({ flavor });
}

/** Wires up the drive-pick buttons on a Мезонин-eligible failed roll's own chat card —
 *  see applyMezzanine() above for what actually happens. Call once at module init, not
 *  per message. */
export function registerMezzanineButton() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    html.querySelectorAll('[data-action="god-mezzanine"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rerollData = message.getFlag("god-tactical", "rerollData");
        const actor = rerollData?.actorUuid ? await fromUuid(rerollData.actorUuid) : null;
        if (!actor) {
          ui.notifications?.warn("Не удалось найти персонажа.");
          return;
        }
        applyMezzanine(actor, btn.dataset.drive);
      });
    });
  });
}
