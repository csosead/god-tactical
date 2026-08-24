/**
 * GOD Tactical — Weapon/Spell/Ability → Canvas Template Drop
 * Drag a Weapon, Spell, or Ability inventory card onto the canvas during the shared
 * tracker's "Планирование" stage (see module/combat/phase-tracker.mjs's isPlanningStage)
 * to draw one of its configured natisk/brosok range-template entries, constrained to the
 * item's own range — see module/canvas/template-canvas.mjs's startWeaponTemplateDraw.
 * Spell shares Weapon's exact card shape (weaponCardSchema); Ability carries the same
 * natisk/brosok/attackType fields as its own "weapon-shared combat parameters" (see
 * items.mjs's AbilityDataModel) so a tactical/simple maneuver can draw a template the
 * same way, without needing a separate Weapon item just to hold the range/shape.
 *
 * The exported `armTemplateForToken` below is the SAME arming logic reused a third way:
 * module/combat/action-log.mjs's Планер lets a player drag an already-logged base-action
 * tag (Натиск/Залп/Толчок/Захват/Опрокидывание) straight onto the canvas too, off a
 * synthetic "item" built from that action's own natiskM/brosokM (see its
 * _buildPseudoItem) — no real Item document involved, and no actor→token ambiguity to
 * resolve either (the log entry already says which token).
 */

import { normalizeShapeType, worldToGrid } from "./template-geometry.mjs";
import { startWeaponTemplateDraw, getTokenCells } from "./template-canvas.mjs";
import { setPhaseTokenLabel } from "../combat/phase-controls.mjs";
import { isPlanningStage } from "../combat/phase-tracker.mjs";
import { showPopupMenu } from "../sheets/item-context-menu.mjs";
import { formatMeters } from "../config.mjs";
import { BASE_ACTIONS, setLogEntryTarget } from "../combat/action-log.mjs";

const MODE_LABEL = { natisk: "GOD.Weapon.VerbNatisk", brosok: "GOD.Weapon.VerbBrosok" };

// Which base action (see BASE_ACTIONS.execution in action-log.mjs) a weapon's attack
// counts as — read from the weapon's own attackType field (items.mjs's WeaponDataModel),
// NOT from which list (Настильный/Навесной) the dropped entry came from. Those two are
// independent: Настильный/Навесной describe a template's TRAJECTORY (a horizontal
// line-of-sight shot blocked by walls, vs a lobbed arc that clears walls but can hit
// floor/ceiling) — a bow's shot is still Залп (ranged) even when drawn as a
// Настильный (Direct) line. Read off BASE_ACTIONS itself rather than restating
// "Натиск"/"Залп" as literal strings here, so the action log's own name is the single
// source of truth.
const ACTION_FOR_ATTACK_TYPE = {
  melee:  BASE_ACTIONS.execution.find((a) => a.id === "melee"),
  ranged: BASE_ACTIONS.execution.find((a) => a.id === "ranged"),
};

// Circle/square are the only shapes with TWO independent numbers. Настильный (natisk)
// still handles them as a COMPOUND, two-click draw: phase 1 is a real LINE, fixed
// exactly at rangeModifier, that stays on the canvas as its own template; phase 2 is
// the circle/square itself, fixed exactly at templateSize, anchored automatically at
// phase 1's tip (see startWeaponTemplateDraw's compoundShape option). Its start point
// is wherever the player clicks — never forced to the token.
//
// Навесной (brosok) instead places in a SINGLE stage: the fixed-size circle/square
// previews live under the cursor together with a dashed range ruler back to the bound
// token (see template-canvas.mjs's _renderWeaponThrowPreview/startWeaponTemplateDraw's
// instantPlace) — one click, anywhere within rangeModifier of the token, both aims the
// throw and places the template in the same motion.
//
// Every other shape (line/wide_line/cone) has only ONE meaningful number —
// rangeModifier IS the shape's own reach (the FIXED length it's drawn at, not a max),
// aimed from wherever it's clicked; templateSize doesn't apply to them at all.
const THROWN_SHAPES = new Set(["circle", "square"]);

// Modes that use the single-stage "thrown" flow for a circle/square entry (see
// THROWN_SHAPES above) rather than natisk's two-click "compound" line-then-shape flow.
const THROWN_MODES = new Set(["brosok"]);

/** Eligible natisk/brosok entries on a weapon (templateShape !== "none"),
 *  translated to the canvas tool's shape vocabulary and labeled the same way
 *  weapon-sheet.mjs/ability-sheet.mjs already label them ("Настильный 1", or just
 *  "Настильный" alone). */
function _collectEntries(item) {
  const out = [];
  for (const mode of ["natisk", "brosok"]) {
    const list = (item.system[mode] ?? []).filter((e) => e.templateShape && e.templateShape !== "none");
    const modeLabel = game.i18n.localize(MODE_LABEL[mode]);
    list.forEach((entry, idx) => {
      const shapeType = normalizeShapeType(entry.templateShape);
      const namePrefix = list.length > 1 ? `${modeLabel} ${idx + 1}` : modeLabel;

      if (THROWN_SHAPES.has(shapeType)) {
        // circle/square delivery depends on trajectory + range:
        //  - Навесной (brosok): a lobbed throw to a point within rangeModifier.
        //  - Настильный (natisk), rangeModifier 0: AOE centered on the caster — a self
        //    burst, no aim step (see template-canvas.mjs's selfCentered path).
        //  - Настильный (natisk), rangeModifier > 0: a reach LINE from the caster out to
        //    rangeModifier (anchored on the token), then the AOE at its tip (compound).
        if (THROWN_MODES.has(mode)) {
          out.push({
            mode, shapeType, kind: "thrown", hitLogic: entry.hitLogic,
            reachCells: entry.rangeModifier, maxLengthCells: entry.templateSize,
            label: `${namePrefix} — бросок на ${formatMeters(entry.rangeModifier)}, радиус ${formatMeters(entry.templateSize)}`,
          });
        } else if (entry.rangeModifier === 0) {
          out.push({
            mode, shapeType, kind: "self", hitLogic: entry.hitLogic, maxLengthCells: entry.templateSize,
            label: `${namePrefix} — область вокруг себя, радиус ${formatMeters(entry.templateSize)}`,
          });
        } else {
          out.push({
            mode, shapeType, kind: "directed", hitLogic: entry.hitLogic,
            reachCells: entry.rangeModifier, maxLengthCells: entry.templateSize,
            label: `${namePrefix} — область на ${formatMeters(entry.rangeModifier)} от юнита, радиус ${formatMeters(entry.templateSize)}`,
          });
        }
      } else {
        out.push({
          mode, shapeType, kind: "direct", hitLogic: entry.hitLogic,
          maxLengthCells: entry.rangeModifier,
          label: `${namePrefix} — дальность ${formatMeters(entry.rangeModifier)}`,
        });
      }
    });
  }
  return out;
}

function _armDraw(entry, item, token) {
  const action = ACTION_FOR_ATTACK_TYPE[item.system.attackType];
  const base = {
    tokenId: token.id,
    tokenName: token.name,
    itemId: item.id,
    itemName: item.name,
    itemType: item.type,
    actionId: action?.id ?? null,
    actionName: action?.name ?? null,
    // Настильный/Навесной — read straight off which list (_collectEntries)
    // this entry came from, so cover-overlay.mjs's height/HC-FC rules know how to
    // treat the finished stroke (see template-canvas.mjs's _finalizeDraw).
    mode: entry.mode,
    // Height-aware 3D-Direct hit/clip logic (template-canvas.mjs's _recomputeDraw) is now
    // ALWAYS on for Настильный (natisk) attacks — the old per-weapon `direct3D` toggle was
    // retired (every weapon respects elevation; a flat 2D shot that ignored height hit units on
    // any elevation, e.g. a 5→3 arrow "hitting" a swarm on the ground). Stamped `true` so the
    // downstream stroke-render/dead-zone logic that reads this flag stays consistent.
    direct3D: true,
    // melee | ranged | self — a ranged 3D-Direct resolves as a single projectile BEAM
    // (one trajectory, 3D body hits) rather than the per-cell footprint a melee reach
    // uses (see template-canvas.mjs's _recomputeDraw / template-3d.mjs's beamHitTokenIds).
    attackType: item.system.attackType,
    // Ranged-only "can this weapon even touch a non-ground height band" flags (items.mjs's
    // weaponCardSchema, 2026-08-17) — carried onto the constraint so template-canvas.mjs's
    // preview/committed-stroke objects can stamp them for aim-height-damage.mjs's gate.
    canHitLowFlight: item.system.canHitLowFlight ?? false,
    canHitHighFlight: item.system.canHitHighFlight ?? false,
    // Which hit-resolution logic THIS template entry uses (items.mjs's per-entry `hitLogic`
    // field, 2026-08-16) — forward-looking infrastructure, no alternate implementation exists
    // yet, this just carries the entry's choice onto the stroke constraint so a future
    // implementation has somewhere to read it from (see template-canvas.mjs's TODO).
    hitLogic: entry.hitLogic ?? "base",
  };

  if (entry.kind === "self") {
    // Centered on the caster: the shape pins to the bound token's own cell (rangeCells
    // 0, selfCentered flag), instantPlace commits on the single confirm click. A cone
    // rotates to face that click; circle/square ignore direction entirely.
    startWeaponTemplateDraw({
      ...base,
      shape: entry.shapeType,
      maxLengthCells: entry.maxLengthCells,
      rangeOrigin: { x: token.center.x, y: token.center.y },
      rangeCells: 0,
      instantPlace: true,
      selfCentered: true,
    });
    ui.notifications?.info("Область вокруг юнита размещена. Убрать — из планера.");
  } else if (entry.kind === "directed") {
    // One gesture: the AOE previews immediately at `reachCells` from the caster in the
    // hover direction, with a delivery line drawn from the unit; the player just aims the
    // direction and clicks once (see template-canvas.mjs's directedFromToken path).
    startWeaponTemplateDraw({
      ...base,
      shape: entry.shapeType,
      maxLengthCells: entry.maxLengthCells,   // AOE radius
      rangeOrigin: { x: token.center.x, y: token.center.y },
      rangeCells: entry.reachCells,           // fixed delivery distance from the caster
      instantPlace: true,
      directedFromToken: true,
    });
    ui.notifications?.info("Наведите направление от юнита — область встанет на дистанции; клик, чтобы поставить (Esc — отмена).");
  } else if (entry.kind === "thrown") {
    // Single stage: a live fixed-size shape preview + a range ruler to the token track
    // the cursor together (see template-canvas.mjs's _renderWeaponThrowPreview) — one
    // click both aims and places the template.
    startWeaponTemplateDraw({
      ...base,
      shape: entry.shapeType,
      maxLengthCells: entry.maxLengthCells,
      rangeOrigin: { x: token.center.x, y: token.center.y },
      rangeCells: entry.reachCells,
      instantPlace: true,
    });
    ui.notifications?.info("Наведите курсор на цель и кликните, чтобы бросить — Esc для отмены.");
  } else if (entry.kind === "compound") {
    // Phase 1 (the reach line) starts AT the caster (anchorToken) — drag only aims its
    // direction, its length stays pinned to rangeModifier. Once released, template-canvas.mjs
    // automatically arms phase 2 (the circle/square, fixed exactly at templateSize) anchored
    // at the line's tip.
    startWeaponTemplateDraw({
      ...base,
      shape: entry.phase1Shape,
      maxLengthCells: entry.reachCells,
      rangeOrigin: null,
      rangeCells: null,
      anchorToken: true,
      compoundShape: { shape: entry.shapeType, maxLengthCells: entry.maxLengthCells },
    });
    ui.notifications?.info("Потяните в сторону цели, чтобы навести линию от юнита, отпустите — затем разместите область в её конце (Esc — отмена).");
  } else {
    startWeaponTemplateDraw({
      ...base,
      shape: entry.shapeType,
      maxLengthCells: entry.maxLengthCells,
      rangeOrigin: null,
      rangeCells: null,
    });
    // Movement path (Рывок/Перемещение) is a click-click-…-double-click path, not a
    // press-drag-release shape — see template-canvas.mjs's _onPointerDown/
    // _onCanvasDblClick — so it gets its own instructions instead of the drag-based ones.
    ui.notifications?.info(
      entry.shapeType === "thin_line"
        ? `Кликайте по клеткам, чтобы проложить путь (запас ${formatMeters(entry.maxLengthCells)}) — двойной клик завершает, Esc отменяет.`
        : "Кликните и потяните на сетке, чтобы разместить шаблон — Esc для отмены.",
    );
  }
}

function _pickEntryThenArm(item, token, x, y) {
  const entries = _collectEntries(item);
  if (!entries.length) {
    ui.notifications?.warn("У этого предмета не настроен шаблон дальности.");
    return;
  }
  if (entries.length === 1) {
    _armDraw(entries[0], item, token);
    return;
  }
  showPopupMenu(
    entries.map((entry) => ({ label: entry.label, icon: "fa-crosshairs", onClick: () => _armDraw(entry, item, token) })),
    x, y,
  );
}

/** Arm a template draw against an ALREADY-KNOWN token, skipping the actor→token(s)
 *  ambiguity picker `_bindTokenThenPick` exists for — used by action-log.mjs's Планер,
 *  where dragging a logged base-action tag onto the canvas already says exactly which
 *  token the action was logged against (see _wireLog's pointer-drag `onUp`). `item` need
 *  not be a real Foundry Item document — only `.id`/`.name`/`.type`/`.system.{attackType,
 *  canHitLowFlight,canHitHighFlight,natisk,brosok}` are ever read (see
 *  action-log.mjs's _buildPseudoItem, which builds exactly this shape from a
 *  BASE_ACTIONS entry's own natiskM/brosokM). */
export function armTemplateForToken(item, token, x, y) {
  _pickEntryThenArm(item, token, x, y);
}

/** Tokens THIS client has pinned as a Преследование (pursue) target — tracked so the
 *  round-start auto-clear below (see registerWeaponTemplateDrop) only releases targets
 *  Преследование itself set, never anything the player independently targeted by hand.
 *  Foundry's own target reticle (token.setTarget), not a separate custom marker — "чтобы
 *  понимать кого преследуешь" just needs the crosshair everyone already reads, visible
 *  per Foundry's normal target-visibility rules, not a new UI element. */
const _pursuitTargetIds = new Set();

/** Преследование's drag-to-canvas: unlike every other draggable Планер action, this one
 *  never arms a template draw — dropping the tag directly ONTO an enemy token (a plain
 *  Foundry drop-on-target gesture, no separate "pick mode" to arm/cancel) sets THIS
 *  user's Foundry target to that token, so the room can see who's being chased. Silently
 *  does nothing if the drop misses every token, same as a shape-drop landing off-grid.
 *  `strokeId` (the dragged tag's own log entry, see action-log.mjs's _armLoggedAction) is
 *  optional — when given, the pursued token's name is ALSO stamped onto that entry (see
 *  setLogEntryTarget) so it reads right off the Планер tag, not only the map's reticle. */
export function setPursuitTarget(clientX, clientY, strokeId) {
  const point = canvas.canvasCoordinatesFromClient({ x: clientX, y: clientY });
  if (point.x == null) return;
  const cell = worldToGrid(point.x, point.y);
  const token = canvas.tokens?.placeables.find((t) =>
    getTokenCells(t).some((c) => c.col === cell.col && c.row === cell.row),
  );
  if (!token) {
    ui.notifications?.warn("Отпустите «Преследование» прямо на токене цели.");
    return;
  }
  token.setTarget(true, { user: game.user, releaseOthers: true });
  _pursuitTargetIds.add(token.id);
  ui.notifications?.info(`Цель преследования: ${token.name}. Снимется в начале следующего раунда.`);
  if (strokeId) setLogEntryTarget(strokeId, token.name);
}

/** Releases every target Преследование itself set for this user — called on
 *  godTactical.combatRoundChanged (see registerWeaponTemplateDrop), so a pursuit target
 *  never survives past the round it was called out in. */
function _clearPursuitTargets() {
  if (!_pursuitTargetIds.size) return;
  for (const id of _pursuitTargetIds) {
    canvas.tokens?.get(id)?.setTarget(false, { user: game.user, releaseOthers: false });
  }
  _pursuitTargetIds.clear();
}

/** Token(s) on the current scene belonging to the same actor the dragged weapon lives
 *  on — the sheet you dragged from and the token on the map are the same character, so
 *  the binding step doesn't need a separate manual gesture for this flow.
 *
 *  A synthetic (unlinked) token-actor — e.g. two placed copies of the same NPC, each its
 *  own "Разбойник" token — already knows exactly which token it belongs to (Foundry's
 *  own Actor#token), even though that synthetic actor keeps the SOURCE actor's own id
 *  (Actor#id) rather than getting one of its own. Checking Actor#isToken/#token first
 *  resolves straight to that one token, no picker needed, even with several identically-
 *  named copies on the scene — only a genuinely LINKED actor (the one shared world
 *  Actor, not a per-token instance) is actually ambiguous across multiple placed tokens,
 *  since nothing on a linked actor's sheet can say which placed token you have in mind;
 *  that's the one case the picker below still needs to ask about. */
function _tokensForActor(actor) {
  if (!actor) return [];
  if (actor.isToken && actor.token) {
    const token = canvas.tokens?.placeables.find((t) => t.id === actor.token.id) ?? null;
    return token ? [token] : [];
  }
  return canvas.tokens?.placeables.filter((t) => t.actor?.id === actor.id) ?? [];
}

function _bindTokenThenPick(item, tokens, x, y) {
  if (tokens.length === 1) {
    const token = tokens[0];
    setPhaseTokenLabel(token.name, token.id);
    _pickEntryThenArm(item, token, x, y);
    return;
  }
  showPopupMenu(
    tokens.map((token) => ({
      label: token.name,
      icon: "fa-user",
      onClick: () => {
        setPhaseTokenLabel(token.name, token.id);
        _pickEntryThenArm(item, token, x, y);
      },
    })),
    x, y,
  );
}

async function _onDrop(event) {
  if (event.target !== canvas.app?.view) return;

  let data;
  try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
  catch { return; }
  if (data?.type !== "Item") return;

  const item = await fromUuid(data.uuid);
  // Spell shares Weapon's exact card (natisk/brosok/attackType — see items.mjs's
  // weaponCardSchema); Ability carries the same fields on its own schema (see this
  // file's top doc comment) — all three go through this same canvas-drop flow.
  if (!item || !["weapon", "spell", "ability"].includes(item.type)) return; // not this feature's concern — stay inert

  event.preventDefault();
  event.stopPropagation();

  // Gated on the shared, GM-controlled tracker's stage (module/combat/phase-tracker.mjs),
  // not any per-user state — every connected client sees the same "are we planning right
  // now" answer, unlike the old per-user activePhase flag (phase-controls.mjs), which
  // required each player/GM to have separately pressed a base-action button first.
  if (!game.combat || !isPlanningStage()) {
    ui.notifications?.warn("Перетаскивание на сетку доступно только на этапе «Планирование» (проверьте общий трекер боя).");
    return;
  }

  const tokens = _tokensForActor(item.parent);
  if (!tokens.length) {
    ui.notifications?.warn("На сцене нет токена этого персонажа.");
    return;
  }

  _bindTokenThenPick(item, tokens, event.clientX, event.clientY);
}

export function registerWeaponTemplateDrop() {
  // Foundry requires dragover to call preventDefault() for a drop to be allowed.
  document.addEventListener("dragover", (event) => {
    if (event.target !== canvas.app?.view) return;
    event.preventDefault();
  });

  document.addEventListener("drop", _onDrop);

  // Fired by action-log.mjs's own updateCombat round-change hook (see its
  // Hooks.callAll("godTactical.combatRoundChanged")) — same event template-canvas.mjs
  // listens to for clearing this round's templates.
  Hooks.on("godTactical.combatRoundChanged", () => _clearPursuitTargets());
}
