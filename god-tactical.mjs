/**
 * GOD Tactical System — Entry Point
 * Foundry VTT v13 Game System
 */

import { GOD, loadCompetencyGroupsFromRulebook, loadSkillMapDescsFromRulebook } from "./module/config.mjs";
import { registerGodState } from "./module/state.mjs";
import { CharacterDataModel, NPCDataModel, CreatureDataModel } from "./module/data-models.mjs";
import { GODActorSheet } from "./module/sheets/actor-sheet.mjs";
import { GODNPCSheet } from "./module/sheets/npc-sheet.mjs";
import {
  WeaponDataModel,
  SpellDataModel,
  ArmorDataModel,
  ConsumableDataModel,
  ToolsDataModel,
  TrophyDataModel,
  ClassDataModel,
  RaceDataModel,
  CreatureItemDataModel,
  AbilityDataModel,
  ContainerDataModel,
} from "./module/data/items.mjs";
import { GODConsumableSheet } from "./module/sheets/consumable-sheet.mjs";
import { GODToolsSheet } from "./module/sheets/tools-sheet.mjs";
import { GODWeaponSheet } from "./module/sheets/weapon-sheet.mjs";
import { GODArmorSheet } from "./module/sheets/armor-sheet.mjs";
import { GODContainerSheet } from "./module/sheets/container-sheet.mjs";
import { GODTrophySheet } from "./module/sheets/trophy-sheet.mjs";
import { GODClassSheet } from "./module/sheets/class-sheet.mjs";
import { GODRaceSheet } from "./module/sheets/race-sheet.mjs";
import { GODCreatureSheet } from "./module/sheets/creature-sheet.mjs";
import { GODAbilitySheet } from "./module/sheets/ability-sheet.mjs";
import { seedCompendiums, registerSeedRegistrySetting } from "./module/data/seed-compendiums.mjs";
import { registerTooltipToggle, applyTooltipToggleState } from "./module/sheets/tooltip-toggle.mjs";
import { registerClassRaceRules } from "./module/data/class-race-rules.mjs";
import { registerContainerRules } from "./module/data/container-rules.mjs";
import { registerNpcNicknames } from "./module/data/npc-nicknames.mjs";
import { injectDiceTray } from "./module/apps/dice-tray.mjs";
import { GODRoll } from "./module/rolls/d100-roll.mjs";
import { registerCompetencyButton, registerMezzanineButton } from "./module/rolls/roll-dialog.mjs";
import { registerTemplateControls } from "./module/canvas/template-controls.mjs";
import { registerSurveyMode } from "./module/canvas/survey-mode.mjs";
import { registerSceneDarknessOpacity } from "./module/canvas/scene-darkness-opacity.mjs";
import { registerRegionLightWalls } from "./module/canvas/region-light-walls.mjs";
import { registerTemplateCanvas } from "./module/canvas/template-canvas.mjs";
import { registerRangeVision } from "./module/canvas/range-vision.mjs";
import { registerVisionObstruction } from "./module/canvas/vision-obstruction.mjs";
import { registerRangePreview } from "./module/canvas/range-preview.mjs";
import { registerTokenEyeHeightSync } from "./module/canvas/token-eye-height-sync.mjs";
import { registerWeaponTemplateDrop } from "./module/canvas/weapon-template-drop.mjs";
import { registerNpcHierarchyBadges } from "./module/canvas/npc-hierarchy-badge.mjs";
import { registerTokenHudTweaks } from "./module/canvas/token-hud-tweaks.mjs";
import { registerPhaseControls, loadPhaseStageHintsFromRulebook } from "./module/combat/phase-controls.mjs";
import { registerActionLog, loadBaseActionDescsFromRulebook } from "./module/combat/action-log.mjs";
import { registerPhaseTracker } from "./module/combat/phase-tracker.mjs";
import { registerPlanningVignette } from "./module/combat/planning-vignette.mjs";
import { registerPhaseActivationReminder } from "./module/combat/phase-activation-reminder.mjs";
import { registerChatPortraits } from "./module/chat/chat-portraits.mjs";
import { registerChatItemDrop } from "./module/chat/chat-item-drop.mjs";
import { registerStatusEffects } from "./module/combat/status-effects.mjs";

/* -------------------------------------------- */
/*  System Initialization                       */
/* -------------------------------------------- */

Hooks.once("init", function () {
  console.log("god-tactical | Initializing GOD Tactical System");

  // The quantized Pure Data layer (module/state.mjs) — registered FIRST, so
  // its own cache-invalidation hooks always run before any consumer below
  // that reads from GodState in response to the same Foundry event.
  registerGodState();

  // Pre-load and register Handlebars partials (v13 API)
  const _loadTpl = foundry.applications?.handlebars?.loadTemplates
    ?? globalThis.loadTemplates;
  _loadTpl([
    "systems/god-tactical/templates/item/parts/weapon-inventory-row.hbs",
    "systems/god-tactical/templates/actor/parts/inventory-search-bar.hbs",
    "systems/god-tactical/templates/actor/parts/ability-search-bar.hbs",
    "systems/god-tactical/templates/actor/parts/armor-loadout.hbs",
    "systems/god-tactical/templates/actor/parts/grit-track.hbs",
    "systems/god-tactical/templates/actor/parts/wound-track.hbs",
    "systems/god-tactical/templates/actor/parts/header-effects.hbs",
  ]);

  registerSeedRegistrySetting();
  registerGritBaseV9Setting();
  registerTooltipToggle();

  // Register Handlebars helpers
  Handlebars.registerHelper("padStart", function (value, length, char) {
    return String(value).padStart(length, char);
  });
  Handlebars.registerHelper("gte", function (a, b) {
    return a >= b;
  });
  Handlebars.registerHelper("lte", function (a, b) {
    return a <= b;
  });
  Handlebars.registerHelper("eq", function (a, b) {
    return a === b;
  });
  Handlebars.registerHelper("includes", function (arr, value) {
    return Array.isArray(arr) && arr.includes(value);
  });
  Handlebars.registerHelper("times", function (n, block) {
    let result = "";
    for (let i = 0; i < n; i++) result += block.fn(i);
    return result;
  });

  // Expose configuration
  CONFIG.GOD = GOD;

  // Replace CONFIG.statusEffects with our own set (HUD-clickable token statuses)
  registerStatusEffects();

  // Register custom roll class so Foundry can recreate it from chat message data
  CONFIG.Dice.rolls.push(GODRoll);

  // Register custom GOD template canvas layer (PIXI overlay + pointer handlers)
  registerTemplateCanvas();

  // Live "who this shooter currently hits" hint used to be its own Alt-hold canvas
  // overlay here (region-cover-overlay.mjs) — folded into Survey Mode's existing
  // press-to-toggle Alt overlay instead (see registerSurveyMode above), per GM request
  // 2026-08-16 evening: a second, competing Alt binding was confusing, and the hint
  // belongs with the other tactical-visor info (walls/heights/sizes), not gated
  // separately. region-cover-overlay.mjs is left on disk, unregistered — superseded,
  // not deleted (no VCS in this repo to recover it from if that turns out to be wrong).

  // Token-to-token visibility: Basic Sight (pure range) vs Feel Tremor
  // (pure range, disguised as an unknown token) — see that module's header
  // comment for why native Detection Modes alone can't do the disguise
  // part without bringing back the dynamic-shadow rendering.
  registerRangeVision();

  // OPTIONAL wall/region/elevation blocking for Basic Sight, off by default
  // — see that module's header for why it's split out from the base layer.
  registerVisionObstruction();

  // GM-only reference circles (Basic Sight / Feel Tremor range) around the
  // currently controlled token.
  registerRangePreview();

  // Keeps Wall Height's per-token `flags['wall-height'].tokenHeight` synced
  // to THIS system's own size-tiered eye-height table (blind-spot.mjs), so
  // Wall Height's own "Auto LOS Height" setting (footprint-based) or its flat
  // world default never disagrees with vision-obstruction.mjs's/blind-spot.
  // mjs's idea of the same creature's eye height — see that module's header.
  registerTokenEyeHeightSync();

  // Register Actor Data Models
  CONFIG.Actor.dataModels = {
    character: CharacterDataModel,
    npc: NPCDataModel,
    creature: CreatureDataModel,
  };

  // Trackable attributes for Token HUD / Bars
  CONFIG.Actor.trackableAttributes = {
    character: {
      bar: [],
      value: ["nf.value", "damage.value"],
    },
    npc: {
      bar: [],
      value: ["damage.melee"],
    },
  };

  /* --- Register Character Sheet --- */
  const ActorsCollection = foundry.documents.collections.Actors;
  ActorsCollection.unregisterSheet("core", foundry.applications.sheets.ActorSheetV2);
  ActorsCollection.registerSheet("god-tactical", GODActorSheet, {
    types: ["character"],
    makeDefault: true,
    label: "GOD.Sheet.Character",
  });

  /* --- Register NPC Sheet --- */
  ActorsCollection.registerSheet("god-tactical", GODNPCSheet, {
    types: ["npc"],
    makeDefault: true,
    label: "GOD.Sheet.NPC",
  });

  /* --- Register Creature Sheet --- */
  ActorsCollection.registerSheet("god-tactical", GODNPCSheet, {
    types: ["creature"],
    makeDefault: true,
    label: "GOD.Sheet.Creature",
  });

  /* --- Register Item Data Models --- */
  CONFIG.Item.dataModels = {
    weapon: WeaponDataModel,
    spell: SpellDataModel,
    armor: ArmorDataModel,
    consumable: ConsumableDataModel,
    tools: ToolsDataModel,
    trophies: TrophyDataModel,
    class: ClassDataModel,
    race: RaceDataModel,
    creature: CreatureItemDataModel,
    ability: AbilityDataModel,
    container: ContainerDataModel,
  };

  /* --- Register Weapon Sheet --- */
  const ItemsCollection = foundry.documents.collections.Items;
  ItemsCollection.unregisterSheet("core", foundry.applications.sheets.ItemSheetV2);
  ItemsCollection.registerSheet("god-tactical", GODWeaponSheet, {
    types: ["weapon"],
    makeDefault: true,
    label: "GOD.Sheet.Weapon",
  });

  /* --- Register Spell Sheet (same card as Weapon — see items.mjs's weaponCardSchema) --- */
  ItemsCollection.registerSheet("god-tactical", GODWeaponSheet, {
    types: ["spell"],
    makeDefault: true,
    label: "GOD.Sheet.Spell",
  });

  /* --- Register Armor Sheet --- */
  ItemsCollection.registerSheet("god-tactical", GODArmorSheet, {
    types: ["armor"],
    makeDefault: true,
    label: "GOD.Sheet.Armor",
  });

  /* --- Register Class Sheet --- */
  ItemsCollection.registerSheet("god-tactical", GODClassSheet, {
    types: ["class"],
    makeDefault: true,
    label: "GOD.Sheet.Class",
  });

  /* --- Register Race Sheet --- */
  ItemsCollection.registerSheet("god-tactical", GODRaceSheet, {
    types: ["race"],
    makeDefault: true,
    label: "GOD.Sheet.Race",
  });

  /* --- Register Creature Sheet (Bestiary) --- */
  ItemsCollection.registerSheet("god-tactical", GODCreatureSheet, {
    types: ["creature"],
    makeDefault: true,
    label: "GOD.Sheet.Creature",
  });

  /* --- Register Ability Sheet --- */
  ItemsCollection.registerSheet("god-tactical", GODAbilitySheet, {
    types: ["ability"],
    makeDefault: true,
    label: "GOD.Sheet.Ability",
  });

  /* --- Register Container Sheet --- */
  ItemsCollection.registerSheet("god-tactical", GODContainerSheet, {
    types: ["container"],
    makeDefault: true,
    label: "GOD.Sheet.Container",
  });

  ItemsCollection.registerSheet("god-tactical", GODTrophySheet, {
    types: ["trophies"],
    makeDefault: true,
    label: "GOD.Sheet.Trophy",
  });

  /* --- Register Consumable Sheet --- */
  ItemsCollection.registerSheet("god-tactical", GODConsumableSheet, {
    types: ["consumable"],
    makeDefault: true,
    label: "GOD.Sheet.Consumable",
  });

  /* --- Register Tools Sheet --- */
  ItemsCollection.registerSheet("god-tactical", GODToolsSheet, {
    types: ["tools"],
    makeDefault: true,
    label: "GOD.Sheet.Tools",
  });

  console.log("god-tactical | System initialized successfully");
});

/* -------------------------------------------- */
/*  Canvas tools — init on setup                */
/* -------------------------------------------- */

Hooks.once("setup", function () {
  game.godTactical = { activeShape: null, activeToolName: null, bindTokenActive: false, _lastStrokeId: null };
  registerTemplateControls();
  registerSurveyMode();
  registerRegionLightWalls();
  registerSceneDarknessOpacity();
  registerWeaponTemplateDrop();
  registerNpcHierarchyBadges();
  registerTokenHudTweaks();
  registerPhaseControls();
  registerActionLog();
  registerPhaseTracker();
  registerPlanningVignette();
  registerPhaseActivationReminder();
  registerClassRaceRules();
  registerContainerRules();
  registerNpcNicknames();
});

/* -------------------------------------------- */
/*  Scene Controls — hide native ruler tool     */
/* -------------------------------------------- */

Hooks.on("getSceneControlButtons", (controls) => {
  // Hide Foundry's native "Measure Distance" ruler tool — GOD Tactical has its own
  // ruler under the Templates control group instead (see template-controls.mjs'
  // "god-ruler" tool), so the core one is redundant. Group name/shape varies across
  // Foundry versions, so scan every control group's tools rather than assume one key.
  try {
    const groups = Array.isArray(controls)
      ? controls
      : (controls instanceof Map || typeof controls?.get === "function")
        ? Array.from(controls.values())
        : (controls?.controls instanceof Map || typeof controls?.controls?.get === "function")
          ? Array.from(controls.controls.values())
          : (typeof controls === "object" && controls !== null)
            ? Object.values(controls)
            : [];

    for (const group of groups) {
      const t = group?.tools;
      if (!t) continue;
      if (Array.isArray(t)) {
        const idx = t.findIndex((tool) => tool?.name === "ruler");
        if (idx !== -1) t.splice(idx, 1);
      } else if (t instanceof Map || typeof t?.delete === "function") {
        t.delete("ruler");
      } else if (typeof t === "object") {
        delete t.ruler;
      }
    }
  } catch (e) {
    console.error("god-tactical | Failed to hide native ruler tool:", e);
  }
});

/* -------------------------------------------- */
/*  Pre-Create Actor — defaults                 */
/* -------------------------------------------- */

Hooks.on("preCreateActor", (document, data, options, userId) => {
  if (document.type !== "character") return;
  if (!data.img) data.img = "icons/svg/mystery-man.svg";
});

/* -------------------------------------------- */
/*  Migrations                                  */
/* -------------------------------------------- */

/**
 * One-time (idempotent) migration: the "perk" Item type was renamed to "ability"
 * (GOD.Item.Types.Perk / GOD.Sheet.Perk no longer exist — see module/data/items.mjs).
 * Existing documents don't retype themselves on their own, so walk every place one
 * could still be sitting: world items, every actor's embedded items, compendium
 * packs, and the `grantedItems` type-string snapshot on Class items (a Class item
 * can grant an ability, and keeps a display-only {uuid, name, img, type} copy of it).
 * Safe to run every load — each branch only fires while a "perk" is still found.
 */
async function migratePerkToAbility() {
  const fixGrantedItems = (list) =>
    list.some((g) => g.type === "perk")
      ? list.map((g) => (g.type === "perk" ? { ...g, type: "ability" } : g))
      : null;

  // Changing a Document's `type` needs its `system` blob force-replaced (the "=="
  // prefix) rather than merged — Foundry can't diff the old type's system data
  // against the new type's schema. {recursive: false} on the update call is the
  // documented alternative, but it doesn't reliably propagate through
  // updateEmbeddedDocuments/updateDocuments batches, so force-replace explicitly
  // instead: same content, just flagged as an atomic replacement, not a merge.
  // PerkDataModel and AbilityDataModel are schema-identical, so nothing is lost.
  const retypeToAbility = (doc) => ({
    _id: doc.id,
    type: "ability",
    "==system": doc.toObject().system,
  });

  // World items (standalone + Class items' grantedItems)
  for (const item of game.items) {
    if (item.type === "perk") {
      await item.update({ type: "ability", "==system": item.toObject().system });
    } else if (item.type === "class") {
      const fixed = fixGrantedItems(item.system.grantedItems ?? []);
      if (fixed) await item.update({ "system.grantedItems": fixed });
    }
  }

  // Every actor's embedded items
  for (const actor of game.actors) {
    const typeUpdates = [];
    const grantUpdates = [];
    for (const it of actor.items) {
      if (it.type === "perk") {
        typeUpdates.push(retypeToAbility(it));
      } else if (it.type === "class") {
        const fixed = fixGrantedItems(it.system.grantedItems ?? []);
        if (fixed) grantUpdates.push({ _id: it.id, "system.grantedItems": fixed });
      }
    }
    if (typeUpdates.length) await actor.updateEmbeddedDocuments("Item", typeUpdates);
    if (grantUpdates.length) await actor.updateEmbeddedDocuments("Item", grantUpdates);
  }

  // Unlinked tokens keep their own item overrides in the token's ActorDelta, invisible to
  // game.actors — only a linked token shares the actor iterated above. A single leftover
  // "perk" item there fails Actor document validation on ANY update to that token's actor
  // (not just item updates), which is what was silently blocking grantClassItems entirely.
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      const tokenActor = token.actor;
      if (!tokenActor) continue;
      const typeUpdates = [];
      const grantUpdates = [];
      for (const it of tokenActor.items) {
        if (it.type === "perk") {
          typeUpdates.push(retypeToAbility(it));
        } else if (it.type === "class") {
          const fixed = fixGrantedItems(it.system.grantedItems ?? []);
          if (fixed) grantUpdates.push({ _id: it.id, "system.grantedItems": fixed });
        }
      }
      if (typeUpdates.length) {
        await tokenActor.updateEmbeddedDocuments("Item", typeUpdates);
        console.log(`god-tactical | Migrated ${typeUpdates.length} item(s) perk→ability on token "${token.name}" (${scene.name})`);
      }
      if (grantUpdates.length) await tokenActor.updateEmbeddedDocuments("Item", grantUpdates);
    }
  }

  // Compendium Item packs
  for (const pack of game.packs) {
    if (pack.documentName !== "Item") continue;
    const wasLocked = pack.locked;
    if (wasLocked) await pack.configure({ locked: false });

    const docs = await pack.getDocuments();
    const typeUpdates = [];
    const grantUpdates = [];
    for (const d of docs) {
      if (d.type === "perk") {
        typeUpdates.push(retypeToAbility(d));
      } else if (d.type === "class") {
        const fixed = fixGrantedItems(d.system.grantedItems ?? []);
        if (fixed) grantUpdates.push({ _id: d.id, "system.grantedItems": fixed });
      }
    }
    if (typeUpdates.length) {
      await pack.documentClass.updateDocuments(typeUpdates, { pack: pack.collection });
      console.log(`god-tactical | Migrated ${typeUpdates.length} document(s) perk→ability in ${pack.collection}`);
    }
    if (grantUpdates.length) {
      await pack.documentClass.updateDocuments(grantUpdates, { pack: pack.collection });
      console.log(`god-tactical | Fixed grantedItems type on ${grantUpdates.length} class(es) in ${pack.collection}`);
    }

    if (wasLocked) await pack.configure({ locked: true });
  }
}

const GRIT_BASE_V9_SETTING = "gritBaseV9Applied";

/** Registered in the init hook, alongside registerSeedRegistrySetting — a one-shot
 *  gate for migrateGritBaseTo9 below. */
function registerGritBaseV9Setting() {
  game.settings.register("god-tactical", GRIT_BASE_V9_SETTING, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });
}

/**
 * One-time bump of existing Character actors' baseGrit from the old default (5) to the
 * new one (9) — GOD.BASE_GRIT itself (config.mjs) only sets the initial value for
 * NEWLY created actors; anyone made before this change already has 5 persisted in their
 * own data and needs an explicit update. Deliberately NOT done as an in-place value
 * transform inside CharacterDataModel.migrateData (see the "RETIRED" comment on
 * data-models.mjs's old rankSystemVersion shift for why): migrateData also runs on
 * SPARSE update payloads (e.g. a single click on the GRIT "+"/"-" stepper), so a
 * `baseGrit === 5` check there would keep re-firing forever and silently overwrite a
 * GM's own deliberate choice to set some character's baseGrit back to 5 later. Gated
 * instead by a real one-shot world setting (same idiom as seed-compendiums.mjs's
 * seedRegistry) so it runs exactly once, ever, regardless of how many times any
 * individual actor's baseGrit changes after today. Only touches game.actors (linked
 * characters) — an unlinked token's own ActorDelta override, if any GM has one, isn't
 * covered and would need a manual fix; low-risk enough to skip the extra scan
 * migratePerkToAbility does for that case.
 */
async function migrateGritBaseTo9() {
  if (game.settings.get("god-tactical", GRIT_BASE_V9_SETTING)) return;

  const updates = game.actors
    .filter((a) => a.type === "character" && a.system.baseGrit === 5)
    .map((a) => ({ _id: a.id, "system.baseGrit": 9 }));
  if (updates.length) {
    await Actor.updateDocuments(updates);
    console.log(`god-tactical | Bumped baseGrit 5→9 on ${updates.length} character(s)`);
  }
  await game.settings.set("god-tactical", GRIT_BASE_V9_SETTING, true);
}

/* -------------------------------------------- */
/*  Ready Hook                                  */
/* -------------------------------------------- */

Hooks.once("ready", async function () {
  console.log("god-tactical | Ready");

  // Apply this client's tooltip on/off preference (see module/sheets/tooltip-toggle.mjs)
  applyTooltipToggleState();

  // Unlock system compendiums so the GM can drag items into them
  if (game.user.isGM) {
    const packNames = ["weapons", "armor", "classes", "races", "creatures", "consumables", "treasures", "bestiary", "abilities", "equipment", "journal"];
    const config = game.settings.get("core", "compendiumConfiguration");
    let updated = false;
    for (const name of packNames) {
      const key = `god-tactical.${name}`;
      if (!config[key]) config[key] = {};
      if (config[key].locked !== false) {
        config[key].locked = false;
        updated = true;
      }
    }
    if (updated) {
      await game.settings.set("core", "compendiumConfiguration", config);
      console.log("god-tactical | Unlocked compendiums via core settings");
    }

    // Seed system compendiums with the rulebook's default cards (idempotent)
    await seedCompendiums();

    // Retype any leftover "perk" documents to "ability" (idempotent)
    await migratePerkToAbility();

    // One-shot: existing characters' baseGrit 5→9 (see migrateGritBaseTo9's doc comment)
    await migrateGritBaseTo9();

    // Migrate scenes to the system's grid rules (idempotent — safe to run every
    // load, only writes when a value actually differs):
    // - units/distance: current rule is 0.5 m/cell — everything is measured/displayed
    //   in real-world metres (see config.mjs's formatMeters). A scene still on
    //   Foundry's own stock default
    //   (units other than "m", e.g. "ft") never had the system's convention applied
    //   at all — reset both together. A scene already on "m" but from a PREVIOUS
    //   system default (1.5 or 1 m/cell) just needs the distance number rescaled.
    //   Never touches a scene already on 0.5/"m".
    // - diagonals: the alternating 1-2-1-2 rule (CONST.GRID_DIAGONALS.ALTERNATING_1)
    //   wasn't used by this system before, so every scene gets it applied.
    for (const scene of game.scenes) {
      const update = {};
      if (scene.grid.units !== "m") {
        update["grid.units"] = "m";
        update["grid.distance"] = 0.5;
      } else if (scene.grid.distance === 1.5 || scene.grid.distance === 1) {
        update["grid.distance"] = 0.5;
      }
      if (scene.grid.diagonals !== CONST.GRID_DIAGONALS.ALTERNATING_1) {
        update["grid.diagonals"] = CONST.GRID_DIAGONALS.ALTERNATING_1;
      }
      if (Object.keys(update).length) {
        await scene.update(update);
        console.log(`god-tactical | Migrated scene "${scene.name}" grid settings`, update);
      }
    }
  }

  // Live stage-hint tooltips for the combat tracker — read from the "Фазы и этапы"
  // rulebook journal entry (seedPhasesJournal, seed-compendiums.mjs) instead of the
  // hardcoded default, wherever a GM has written one (see phase-controls.mjs's
  // PHASES/loadPhaseStageHintsFromRulebook doc comments). Same convention for the base
  // actions picker's own tooltips, read from the "Действия" entry (see action-log.mjs's
  // BASE_ACTIONS/loadBaseActionDescsFromRulebook doc comments) — the actions flyout is
  // rebuilt from BASE_ACTIONS on every combat-tracker render (see action-log.mjs's
  // _syncActionsFlyout), so the same re-render below refreshes both at once. Runs for
  // every client, not just the GM — both only read already-seeded, world-shared
  // compendium data. Re-renders the combat tracker in case it's already on screen with
  // the hardcoded text still showing.
  await loadPhaseStageHintsFromRulebook();
  await loadBaseActionDescsFromRulebook();
  if (ui.combat?.rendered) ui.combat.render();

  // Live competency lists for the character builder's competency step — read from the
  // "Компетенции" rulebook journal entry (seedCompetenciesJournal, seed-compendiums.mjs)
  // instead of the hardcoded default per group, wherever a GM has edited one (see
  // config.mjs's GOD.COMPETENCY_GROUPS/loadCompetencyGroupsFromRulebook doc comments). No
  // re-render needed here — the builder isn't open yet at this point in the load, and
  // reads GOD.COMPETENCY_GROUPS live whenever a player later opens it.
  await loadCompetencyGroupsFromRulebook();

  // Live characteristic/skill tooltips (character + NPC sheets) — read from the
  // "Характеристики и навыки" rulebook journal entry's "Характеристики"/"Навыки" pages
  // (seedRulesJournal, seed-compendiums.mjs) instead of the hardcoded default per entry,
  // wherever a GM has written one (see config.mjs's GOD.SKILL_MAP/
  // loadSkillMapDescsFromRulebook doc comment). No re-render needed here for the same
  // reason as the competency lists above — actor sheets read char.desc/skill.desc live
  // off GOD.SKILL_MAP on every render.
  await loadSkillMapDescsFromRulebook();

  // Inject dice tray into chat log whenever it renders
  Hooks.on("renderChatLog", injectDiceTray);

  // Messenger-style portraits in chat
  registerChatPortraits();

  // "Есть компетенция" button on roll chat cards (fiasco→triumph confirm, see roll-dialog.mjs)
  registerCompetencyButton();

  // "Мезонин" drive-pick buttons on failed-roll chat cards (see roll-dialog.mjs)
  registerMezzanineButton();

  // Drag any item/ability onto the chat log to post a linked card
  registerChatItemDrop();

  // Fallback for v13: inject immediately if chat element already exists in DOM
  const chatEl = document.querySelector("#chat.sidebar-tab")
              || document.querySelector("#chat")
              || document.querySelector(".chat-sidebar");
  if (chatEl) {
    console.log("god-tactical | Chat found in DOM, injecting dice tray now");
    injectDiceTray(ui.chat, chatEl);
  }
});
