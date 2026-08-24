/**
 * GOD Tactical — Stock (Запас) Wear Check
 *
 * A wear Consumable (ammo, patched shields, etc. — see "Расходники" → "Заряды и запас")
 * doesn't track an exact charge count. `stockMax` is the GM-set max length of the "stock
 * dice chain"; `stockDice` is how many d10 currently sit in that chain — it starts at 1
 * and never resets between scenes. Checking rolls that many d10: if at least one shows 2
 * or less, the chain grows by one die (persisted). Growing past `stockMax` exhausts the
 * item outright (pack empty / shield broken — deleted, same as the item being fully
 * spent). A clean roll (every die > 2) changes nothing.
 *
 * Triggered manually by the player, typically right after a Fail/Fiasco roll made with
 * the item — the system has no distinct weapon-attack/Guard-reaction roll flow to hook
 * this to automatically, so the player judges when a check is warranted, same as before.
 * Triggered from two places: the actor sheet's quick-consumable icon strip (Quick Slot
 * Container contents only — see actor-sheet.mjs's #prepareQuickConsumables) and the
 * "Проверить" inventory right-click entry (any Consumable, regardless of container —
 * actor-sheet.mjs's context menu builder). Both call checkConsumable() below with the
 * same {actor, item} pair. NPCs never check stock — their gear doesn't wear down, so
 * npc-sheet.mjs doesn't offer the "Проверить" entry for consumables at all.
 */

/** Confirm → roll → apply — the whole flow for one stock check. `actor` owns `item`
 *  (needed as the roll's speaker and to update/delete the embedded item afterward).
 *  No-ops silently if `item` isn't actually a Consumable (defensive — callers should
 *  already only ever reach this for consumable items). */
export async function checkConsumable(actor, item) {
  if (!item || item.type !== "consumable") return;

  const stockDice = item.system.stockDice;
  const stockMax = item.system.stockMax;
  const willExhaust = stockDice >= stockMax;

  const action = await foundry.applications.api.DialogV2.wait({
    window: { title: `Проверка запаса: ${item.name}` },
    content: `
      <div class="god-stock-check-dialog">
        <p><strong>${item.name}</strong></p>
        <p>Запас: ${stockDice}/${stockMax}</p>
        <p class="hint">
          Бросок ${stockDice}к10 — если хотя бы один кубик покажет 2 или меньше, цепочка
          вырастет на кубик.
          ${willExhaust
            ? "Цепочка уже на максимуме — рост означает, что предмет будет исчерпан и удалён."
            : `Рост поднимет запас до ${stockDice + 1}/${stockMax}.`}
        </p>
      </div>
    `,
    buttons: [
      { action: "roll", label: "Бросить", icon: "fas fa-dice" },
      { action: "cancel", label: "Отмена" },
    ],
    rejectClose: false,
  }).catch(() => null);
  if (action !== "roll") return;

  const roll = new Roll(`${stockDice}d10`);
  await roll.evaluate();
  const results = roll.dice[0]?.results?.map((r) => r.result) ?? [];
  const grows = results.some((r) => r <= 2);

  const speaker = ChatMessage.getSpeaker({ actor });

  if (!grows) {
    await roll.toMessage({ speaker, flavor: `${item.name} — запас без изменений (${stockDice}/${stockMax})` });
    return;
  }

  if (willExhaust) {
    await roll.toMessage({ speaker, flavor: `${item.name} — цепочка выросла — предмет исчерпан` });
    const name = item.name;
    await item.delete();
    ui.notifications?.info(`«${name}» исчерпан и удалён из инвентаря.`);
    return;
  }

  await roll.toMessage({ speaker, flavor: `${item.name} — цепочка выросла (${stockDice} → ${stockDice + 1}/${stockMax})` });
  await item.update({ "system.stockDice": stockDice + 1 });
}
