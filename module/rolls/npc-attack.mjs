/**
 * GOD Tactical — NPC Damage (COMBAT-REDESIGN: "Бросают только игроки. НПС не бросают никогда.")
 * An NPC's damage is a flat GM-set number (system.damage.{melee,ranged,metaphysicalMelee,
 * metaphysicalRanged} — see data-models.mjs's NPCDataModel) — no d100 roll, no tier ladder
 * (module/combat/combat-damage.mjs's damageForTier is a PLAYER-only concept, keyed off a kept
 * roll result that doesn't exist here). Clicking the Damage stat on the NPC sheet, or the
 * Attack button on one of the NPC's own weapon/ability item cards (see weapon-sheet.mjs/
 * ability-sheet.mjs's #onAttack), opens a confirm dialog (same DialogV2.wait shape as
 * module/rolls/consumable-check.mjs's checkConsumable) showing the base number and, per target
 * under the NPC's own currently-armed AOE template, the same cover/height/hearNotSee-adjusted
 * result a player's attack roll would get (coverTargetsForShooter — same function, same math,
 * just fed a flat base instead of a rolled one). Confirming posts a chat card reusing
 * d100-chat-card.hbs's `result.attackTargets` block via its `result.noRoll` flag (skips the
 * outcome/dice/range sections that only make sense for an actual roll).
 *
 * Forward-looking: the dialog is deliberately built as a list of modifier ROWS (currently just
 * "База") rather than a single number, so a later pass can add more rows (armor, terrain,
 * whatever ends up modifying an NPC's own attack) without changing the confirm flow's shape.
 */

import { GODRoll } from "./d100-roll.mjs";
import { GOD } from "../config.mjs";
import { coverTargetsForShooter } from "../canvas/attack-cover-targets.mjs";
import { npcDamageField } from "../combat/combat-damage.mjs";

/** @param {Actor} actor — an NPC-type actor with system.damage.{melee,ranged,...}
 *  @param {object} [opts] — {attackType, damageNature} from the triggering weapon/ability
 *  item (see npcDamageField's doc comment); omitted when triggered from the sheet's own
 *  quick "deal-damage" icon, which has no item context and defaults to melee/physical.
 *  `onlyTargetTokenId` (set when launched from ONE target's own live-preview tag in the
 *  Планер — see action-log.mjs's _rollAttackForTarget) trims the confirm dialog and the
 *  posted card down to that single token instead of everything under the NPC's template. */
export async function dealNpcDamage(actor, { attackType, damageNature, onlyTargetTokenId } = {}) {
  const field = npcDamageField({ attackType, damageNature });
  const base = Math.max(0, Math.trunc(Number(actor.system.damage?.[field]) || 0));
  const natureAbbr = GOD.DAMAGE_NATURES.find((d) => d.key === (damageNature === "metaphysical" ? "metaphysical" : "physical"))?.abbr;
  const rangeLabel = attackType === "ranged" ? game.i18n.localize("GOD.Weapon.AttackTypeRanged") : game.i18n.localize("GOD.Weapon.AttackTypeMelee");
  const shooterToken = actor.getActiveTokens?.()[0] ?? null;
  const targets = shooterToken ? coverTargetsForShooter(shooterToken, base, { onlyTokenId: onlyTargetTokenId }) : [];

  const targetRows = targets.length
    ? targets.map((t) => `
        <div class="god-npc-damage-target">
          <span>${t.name}</span>
          <span class="god-npc-damage-target-val">${t.outcomeTier === "zero" ? "✕" : t.damage}</span>
        </div>`).join("")
    : `<p class="hint">Нет целей под текущим шаблоном атаки этого юнита — на сцене должен быть размещён/наведён шаблон, привязанный к этому токену.</p>`;

  const action = await foundry.applications.api.DialogV2.wait({
    window: { title: `Урон: ${actor.name}` },
    content: `
      <div class="god-npc-damage-dialog">
        <div class="god-npc-damage-row">
          <span>База (${natureAbbr} · ${rangeLabel})</span>
          <span class="god-npc-damage-val">${base}</span>
        </div>
        <p class="hint">Бросков нет — берётся фиксированное базовое число (правило: НПС не бросают). Список модификаторов атаки и базового урона появится здесь позже.</p>
        ${targets.length ? `<hr>${targetRows}` : targetRows}
      </div>
    `,
    buttons: [
      { action: "deal", label: "Нанести урон", icon: "fas fa-khanda" },
      { action: "cancel", label: "Отмена" },
    ],
    rejectClose: false,
  }).catch(() => null);
  if (action !== "deal") return;

  const content = await foundry.applications.handlebars.renderTemplate(GODRoll.CHAT_TEMPLATE, {
    result: {
      noRoll: true,
      rollSource: { name: `${actor.name} — урон` },
      weaponDamage: base,
      attackTargets: targets,
    },
  });

  await ChatMessage.create({
    user: game.user.id,
    content,
    flavor: `${actor.name} — урон`,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}
