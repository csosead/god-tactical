/**
 * GOD Tactical — Class/Race/Creature Actor Rules
 *
 * A character holds at most one Class item and one Race item. An NPC/Creature actor holds at
 * most one species card, which may be either a Creature item (the Bestiary equivalent of Race,
 * for monsters) or a Race item (for humanoid NPCs) — Race and Creature share one slot, so
 * dropping either replaces whichever of the two is already there. This is enforced at the
 * document level (not just in the actor sheet's drag-drop handler) so it holds no matter how the
 * item ends up on the actor — dropped onto the sheet, dropped onto the token on the canvas,
 * created via a macro, etc.
 *
 * A Class item can also list "granted items" (system.grantedItems, edited on the class sheet) —
 * abilities, or anything else that class hands out. Adding the class to an actor copies all
 * of them onto that actor; removing/replacing the class removes exactly what it granted.
 */

/* -------------------------------------------- */
/*  Class-granted items (способности/etc.)       */
/* -------------------------------------------- */

const GRANT_FLAG_SCOPE = "god-tactical";
const GRANT_FLAG_KEY   = "grantedByClassId";

/**
 * Create actor-embedded copies of everything listed in the class's `grantedItems`
 * (abilities, or any other item type dropped onto the class sheet), tagged with a
 * flag pointing at the class item's id on this actor so they can be found and removed
 * again if the class is swapped out or deleted (see revokeClassItems below).
 */
export async function grantClassItems(actor, classItem) {
  // Idempotency guard: if this exact class item already granted items on this actor
  // (tagged with its id below), don't grant a second copy. Without this, the
  // createItem hook below firing more than once for the same class-add — e.g. the
  // same GM account connected in two browser tabs at once, each independently passing
  // the hook's `userId === game.user.id` check — silently multiplies every granted
  // ability (reproduced live: a single "Воин" add left 3 copies each of its 3 granted
  // abilities, all flagged with the one class item's id).
  const alreadyGranted = actor.items.some(
    (it) => it.getFlag(GRANT_FLAG_SCOPE, GRANT_FLAG_KEY) === classItem.id
  );
  if (alreadyGranted) {
    console.log(`god-tactical | grantClassItems: "${classItem.name}" already granted items on "${actor.name}" — skipping duplicate grant`);
    return;
  }

  const entries = classItem.system?.grantedItems ?? [];
  console.log(`god-tactical | grantClassItems: "${classItem.name}" lists ${entries.length} granted item(s)`, entries);
  if (!entries.length) return;

  const toCreate = [];
  for (const entry of entries) {
    const source = await fromUuid(entry.uuid);
    if (!source) {
      console.warn(`god-tactical | grantClassItems: couldn't resolve "${entry.name}" — uuid "${entry.uuid}" did not resolve to a document`);
      continue;
    }
    const data = source.toObject();
    delete data._id;
    foundry.utils.setProperty(data, `flags.${GRANT_FLAG_SCOPE}.${GRANT_FLAG_KEY}`, classItem.id);
    toCreate.push(data);
  }
  if (toCreate.length) {
    try {
      const created = await actor.createEmbeddedDocuments("Item", toCreate);
      console.log(`god-tactical | grantClassItems: created ${created.length} item(s) on "${actor.name}"`, created);
    } catch (err) {
      console.error(`god-tactical | grantClassItems: createEmbeddedDocuments failed for "${actor.name}"`, err);
    }
  }
}

/** Remove whatever grantClassItems created for this class item. */
export async function revokeClassItems(actor, classItem) {
  const granted = actor.items.filter(
    (it) => it.getFlag(GRANT_FLAG_SCOPE, GRANT_FLAG_KEY) === classItem.id
  );
  console.log(`god-tactical | revokeClassItems: "${classItem.name}" — found ${granted.length} granted item(s) to remove from "${actor.name}"`, granted);
  if (granted.length) await actor.deleteEmbeddedDocuments("Item", granted.map((it) => it.id));
}

/* -------------------------------------------- */
/*  Single class / single race enforcement      */
/* -------------------------------------------- */

export function registerClassRaceRules() {
  Hooks.on("createItem", async (item, options, userId) => {
    if (userId !== game.user.id) return; // only the client performing the create should act
    const actor = item.parent;
    if (!(actor instanceof Actor)) return;
    if (item.type !== "class" && item.type !== "race" && item.type !== "creature") return;

    // Race and Creature share one species slot per actor — dropping either kind replaces
    // whichever species card (of either type) is already there.
    const SPECIES_TYPES = ["race", "creature"];
    const isSpeciesItem = SPECIES_TYPES.includes(item.type);
    const duplicates = actor.items.filter((it) =>
      it.id !== item.id && (isSpeciesItem ? SPECIES_TYPES.includes(it.type) : it.type === item.type)
    );

    if (duplicates.length) {
      await actor.deleteEmbeddedDocuments("Item", duplicates.map((it) => it.id));
    }
    if (item.type === "class") {
      await grantClassItems(actor, item);
    }
  });

  Hooks.on("deleteItem", async (item, options, userId) => {
    if (userId !== game.user.id) return;
    const actor = item.parent;
    if (!(actor instanceof Actor)) return;
    if (item.type !== "class") return;
    await revokeClassItems(actor, item);
  });
}
