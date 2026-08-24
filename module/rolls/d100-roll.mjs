/**
 * GOD Tactical — d100 Roll Class
 * Extends Foundry Roll with custom evaluation logic
 */

/** A "double" is a d100 result whose tens and ones digits match (11, 22, … 99, 00/100). */
export function isDouble(value) {
  const ones = value % 10;
  const tens = Math.floor(value / 10) % 10;
  return ones === tens;
}

// Exported so roll-dialog.mjs's competency-confirm flow (a double in a skill's success
// zone reads as Fiasco by default, flipped to Triumph after the fact — see
// registerCompetencyButton) can relocalize an outcome without duplicating this map.
export const OUTCOME_LABEL = {
  fiasco: "GOD.Roll.Fiasco",
  fail: "GOD.Roll.CleanFail",
  success: "GOD.Roll.CleanSuccess",
  triumph: "GOD.Roll.Triumph",
};

/** A double inside the success zone is a Triumph, a double inside the fail zone is a
 *  Fiasco; otherwise it's a plain success/fail. Shared by GODRoll and the roll dialog's
 *  re-pick flow (module/rolls/roll-dialog.mjs) so both agree on the outcome for a given
 *  chosen value. */
export function computeOutcome(chosen, range) {
  const isSuccess = chosen >= range.from && chosen <= range.to;
  const doubled = chosen != null && isDouble(chosen);

  let outcomeKey;
  if (isSuccess) outcomeKey = doubled ? "triumph" : "success";
  else outcomeKey = doubled ? "fiasco" : "fail";

  return {
    isSuccess,
    outcomeKey,
    outcomeClass: outcomeKey,
    outcome: game.i18n.localize(OUTCOME_LABEL[outcomeKey]),
  };
}

export class GODRoll extends Roll {
  static CHAT_TEMPLATE = "systems/god-tactical/templates/rolls/d100-chat-card.hbs";

  /**
   * @param {number} skillValue — skill or characteristic value
   * @param {string} rollType — 'normal' | 'advantage' | 'disadvantage'
   * @param {number} diceCount — 1 | 2 | 3
   * @param {object} options
   */
  constructor(skillValue, rollType, diceCount, options = {}) {
    // Support Roll.fromData signature: new GODRoll(formula, data, options)
    if (typeof skillValue === "string" && (typeof rollType === "object" || rollType === undefined)) {
      super(skillValue, rollType, diceCount);
      const data = rollType || {};
      this.skill = data.skill ?? 0;
      this.rollType = data.rollType ?? "normal";
      this.diceCount = data.diceCount ?? 1;
    } else {
      super(`${diceCount}d100`, {}, options);
      this.skill = skillValue;
      this.rollType = rollType;
      this.diceCount = diceCount;
    }
  }

  /* -------------------------------------------- */

  toJSON() {
    const data = super.toJSON();
    data.skill = this.skill;
    data.rollType = this.rollType;
    data.diceCount = this.diceCount;
    return data;
  }

  /* -------------------------------------------- */

  getRange() {
    return { from: 1, to: this.skill };
  }

  /* -------------------------------------------- */

  async evaluate(options = {}) {
    await super.evaluate(options);
    this._processResult();
    return this;
  }

  /* -------------------------------------------- */

  _processResult() {
    const rolls = this.dice[0].results.map((r) => r.result);
    const range = this.getRange();

    // The success range always starts at 1 (getRange), so a lower raw roll is
    // uniformly better — closer to a Triumph within a success, and a smaller
    // overshoot within a fail. No need to weigh success/fail separately:
    // advantage always wants the single lowest die, disadvantage the highest.
    let chosen;
    if (this.rollType === "advantage") {
      chosen = Math.min(...rolls);
    } else if (this.rollType === "disadvantage") {
      chosen = Math.max(...rolls);
    } else {
      chosen = rolls[0];
    }

    const { isSuccess, outcomeKey, outcomeClass, outcome } = computeOutcome(chosen, range);

    this.godResult = {
      rolls,
      chosen,
      range,
      isSuccess,
      outcome,
      outcomeKey,
      outcomeClass,
      onesDigit: chosen != null ? chosen % 10 : null,
      rollType: this.rollType,
      diceCount: this.diceCount,
      skill: this.skill,
    };
  }

  /* -------------------------------------------- */

  async toMessage(messageData = {}, options = {}) {
    const content = await foundry.applications.handlebars.renderTemplate(GODRoll.CHAT_TEMPLATE, {
      result: this.godResult,
    });

    const msgData = foundry.utils.mergeObject(
      {
        user: game.user.id,
        rolls: [this],
        content,
        flavor: messageData.flavor || this.godResult.outcome,
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      },
      messageData
    );

    return ChatMessage.create(msgData);
  }
}
