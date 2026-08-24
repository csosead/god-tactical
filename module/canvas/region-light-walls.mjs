/**
 * GOD Tactical — Region Light Walls (opt-in per Region)
 * Adds three fields to the native Region config sheet (grouped next to
 * region-cover-config.mjs's own Cover field):
 *  - "Автостены (свет)" checkbox — when checked, generates real Wall
 *    documents tracing that Region's exact boundary (root polygon AND
 *    holes — see _regionWallCoords), blocking LIGHT and SIGHT — move/sound
 *    are explicitly left at NONE.
 *  - "Отступ стен внутрь" — how far (in the scene's own grid units, e.g.
 *    metres) the generated walls sit INSIDE the Region's boundary rather
 *    than exactly on it.
 *  - "Учитывать высоту (Wall Height)" checkbox — when checked (default),
 *    copies the Region's own `elevation.bottom`/`elevation.top` onto each
 *    generated wall's Wall Height module flags, so the wall only blocks
 *    light/sight for sources/tokens actually within that elevation band
 *    instead of unconditionally at every height.
 *
 * Why this exists: a Region has no physical presence for Foundry's own
 * light rendering — only Walls do — so an AmbientLight near a "tall" Region
 * (one vision-obstruction.mjs already treats as blocking Basic Sight) shone
 * straight through it, producing a lit beam where a real obstacle should
 * cast a shadow (confirmed live, GM screenshot: a window's light tunneled
 * through a Region as if it wasn't there). Real light-blocking Walls fix
 * this at the actual source, and — as a side effect — gives the Region a
 * REAL, Foundry-native lighting shadow, which is strictly better than the
 * hand-drawn polygon overlay this system used to cast per-Region (removed
 * once this landed — confirmed live it's no longer needed).
 *
 * `sight` now matches `light` (both NORMAL/blocking) on every generated
 * wall — this used to be NONE, back when every hand-placed wall in this
 * world also had `sight: None` (to avoid Foundry's own native dynamic-
 * shadow FOV rendering reappearing — see range-vision.mjs's header, which
 * now documents that convention as REVERSED: walls are back to
 * `sight: Normal` on purpose, dynamic shadows wanted back). With walls
 * blocking sight again, vision-obstruction.mjs's Basic Sight check ALSO
 * switched from testing a wall's `move` property to its `sight` property —
 * leaving these generated walls at `sight: None` would have made a
 * Region's own auto-walls invisible to that check even though hand-placed
 * walls block it, an inconsistency for no reason once both systems agree
 * on which property is the source of truth. `move` stays off: a "tall"
 * Region (blocks sight because it's above eye level) isn't necessarily
 * something a token can't walk under/through — turning on physical movement
 * blocking wasn't asked for and would be a much bigger, easy-to-miss
 * gameplay change bundled into what's supposed to be a lighting fix.
 *
 * Wall Height integration confirmed against the actual installed module
 * (Data/modules/wall-height/scripts/const.js + utils.js): it reads
 * `flags["wall-height"].top`/`.bottom`, falling back to +Infinity/-Infinity
 * via `??` when unset — the exact same "missing/null = unbounded"
 * convention this system's own `region.elevation.top`/`.bottom` already
 * uses (confirmed in the module's OWN patches.js, which reads a Region's
 * elevation the same way for its RegionMesh rendering). Copying one
 * straight onto the other needs no translation.
 *
 * Opt-in (not automatic for every Region) on purpose: plenty of Regions in
 * this system are pure gameplay triggers (Lift platforms, trap zones) with
 * no business generating walls at all, and the GM asked for a per-Region
 * toggle specifically so it's easy to switch off if a given Region doesn't
 * actually need one.
 */

import { getRegionState } from "../state.mjs";

const FLAG_SCOPE = "god-tactical";
const AUTO_WALLS_FLAG = "autoLightWalls";
const INSET_FLAG = "lightWallInset"; // grid units (metres), 0 = exactly on the boundary
const USE_ELEVATION_FLAG = "lightWallUseElevation"; // boolean, default true when unset
const WALL_OWNER_FLAG = "autoWallForRegion"; // written on each generated Wall, holds the owning Region's id

const WALL_HEIGHT_SCOPE = "wall-height";

function _useElevation(regionDoc) {
  const v = regionDoc.getFlag(FLAG_SCOPE, USE_ELEVATION_FLAG);
  return v !== false; // unset (undefined) defaults to true
}

function _insetMeters(regionDoc) {
  const v = regionDoc.getFlag(FLAG_SCOPE, INSET_FLAG);
  return (typeof v === "number" && v > 0) ? v : 0;
}

/** Rough centroid (plain vertex average, not area-weighted) across EVERY
 *  point in the Region's polygonTree — root boundary and holes combined.
 *  Only used as a "which way is inward" reference for the inset below, so
 *  it doesn't need to be exact: for a hole, the overall Region centroid
 *  sits in the surrounding solid material (not inside the hole itself),
 *  which conveniently is also the semantically correct "into the Region"
 *  direction for a hole's own boundary. */
function _regionCentroid(regionDoc) {
  let sx = 0, sy = 0, n = 0;
  for (const node of regionDoc.polygonTree ?? []) {
    const pts = node.points;
    if (!pts) continue;
    for (let i = 0; i < pts.length; i += 2) {
      sx += pts[i];
      sy += pts[i + 1];
      n++;
    }
  }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}

/** Every boundary edge of a Region's own footprint (root polygon and holes
 *  alike), each translated `insetPixels` toward the Region's own centroid
 *  along ITS OWN perpendicular — not a proper mitred polygon offset (no
 *  vertex-bisector join), just each edge sliding inward independently. That
 *  can leave a small gap or overlap at sharp corners, which is a non-issue
 *  for straight light-blocking Wall segments (each still blocks light along
 *  its own length regardless of whether its neighbor's endpoint lines up
 *  exactly) — an acceptable simplification for what's a rough placement
 *  helper, not a rendered fill. Returns Wall `c: [x1,y1,x2,y2]` arrays. */
function _regionWallCoords(regionDoc, insetPixels) {
  const centroid = _regionCentroid(regionDoc);
  const coords = [];
  for (const node of regionDoc.polygonTree ?? []) {
    const pts = node.points;
    if (!pts || pts.length < 4) continue;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[i * 2], ay = pts[i * 2 + 1];
      const bx = pts[j * 2], by = pts[j * 2 + 1];

      if (!insetPixels) {
        coords.push([ax, ay, bx, by]);
        continue;
      }

      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      // Two perpendicular candidates; pick whichever points toward the
      // Region's own centroid — convention-agnostic, works regardless of
      // whether this node's own winding is CW or CCW.
      const nx = dy / len, ny = -dx / len;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const towardX = centroid.x - mx, towardY = centroid.y - my;
      const sign = (nx * towardX + ny * towardY) >= 0 ? 1 : -1;
      const ix = nx * sign * insetPixels, iy = ny * sign * insetPixels;

      coords.push([ax + ix, ay + iy, bx + ix, by + iy]);
    }
  }
  return coords;
}

function _autoWallsFor(regionDoc) {
  return regionDoc.parent?.walls?.filter((w) => w.getFlag(FLAG_SCOPE, WALL_OWNER_FLAG) === regionDoc.id) ?? [];
}

async function _clearAutoWalls(regionDoc) {
  const scene = regionDoc.parent;
  const ids = _autoWallsFor(regionDoc).map((w) => w.id);
  if (scene && ids.length) await scene.deleteEmbeddedDocuments("Wall", ids);
}

async function _buildAutoWalls(regionDoc) {
  const scene = regionDoc.parent;
  if (!scene) return;
  await _clearAutoWalls(regionDoc); // always rebuild from scratch — simplest way to stay in sync with shape/setting edits

  const grid = scene.grid;
  const pixelsPerUnit = grid?.distance ? (grid.size ?? 100) / grid.distance : 100;
  const insetPixels = _insetMeters(regionDoc) * pixelsPerUnit;

  const coordsList = _regionWallCoords(regionDoc, insetPixels);
  if (!coordsList.length) return;

  // Reads through GodState (module/state.mjs) rather than regionDoc.elevation directly, so this
  // and template-3d.mjs's resolveTargetElevation always agree on the exact same quantized number
  // for a given Region (both round to the nearest 0.5 m — config.mjs's METERS_PER_CELL), instead
  // of each accumulating its own independent float noise from the same raw value.
  //
  // Reentrancy safety (this file's own historical bug was exactly this class — see the
  // `activeGM` comment on the updateRegion hook below, and foundry-v14-upgrade-fixes project
  // notes): GodState's own updateRegion hook (state.mjs) does nothing but `Map.delete()` — no
  // Document write — so it cannot itself trigger a new updateRegion/tokenEnter/tokenExit event.
  // getRegionState() here is a pure, synchronous, read-only cache lookup; it cannot cause a new
  // Region or Wall event either. The actual writes below (_clearAutoWalls / createEmbeddedDocuments)
  // are completely UNCHANGED by this — same calls, same activeGM gate, same order — and this
  // module's own hooks only listen for Region events, which the generated Walls (Wall documents,
  // not Regions) never fire. Only WHERE the top/bottom numbers are read from changed here, not
  // what gets written, when, or in response to what — so the "no self-trigger" property this file
  // already relied on is exactly as true after this change as before it.
  const regionState = getRegionState(regionDoc);
  const wallHeightFlags = _useElevation(regionDoc)
    ? { [WALL_HEIGHT_SCOPE]: { top: regionState?.topM ?? null, bottom: regionState?.bottomM ?? null } }
    : {};

  // v14 renamed CONST.WALL_SENSE_TYPES → CONST.EDGE_SENSE_TYPES (same values, old name
  // deprecated, removed in v16); prefer the new one when present.
  const SENSE_TYPES = CONST.EDGE_SENSE_TYPES ?? CONST.WALL_SENSE_TYPES;
  const data = coordsList.map((c) => ({
    c,
    light: SENSE_TYPES.NORMAL,
    sight: SENSE_TYPES.NORMAL,
    move: SENSE_TYPES.NONE,
    sound: SENSE_TYPES.NONE,
    flags: { [FLAG_SCOPE]: { [WALL_OWNER_FLAG]: regionDoc.id }, ...wallHeightFlags },
  }));
  await scene.createEmbeddedDocuments("Wall", data);
}

async function _syncAutoWalls(regionDoc) {
  if (regionDoc.getFlag(FLAG_SCOPE, AUTO_WALLS_FLAG)) await _buildAutoWalls(regionDoc);
  else await _clearAutoWalls(regionDoc);
}

function _injectAutoWallsField(app, html) {
  try {
    const root = (html instanceof HTMLElement) ? html : (html?.[0] ?? app.element);
    if (!root) return;
    if (root.querySelector("[data-god-auto-light-walls-field]")) return; // already injected (re-render)

    const doc = app.document ?? app.object;
    if (!doc) return;

    const form = root.querySelector("form") ?? root;
    const enabled = !!doc.getFlag(FLAG_SCOPE, AUTO_WALLS_FLAG);
    const inset = _insetMeters(doc);
    const useElevation = _useElevation(doc);
    const distanceUnit = doc.parent?.grid?.units || "";

    const group = document.createElement("div");
    group.classList.add("form-group");
    group.dataset.godAutoLightWallsField = "true";
    group.innerHTML = `
      <label>${game.i18n.localize("GOD.RegionLightWalls.FieldLabel")}</label>
      <div class="form-fields">
        <input type="checkbox" data-god-auto-light-walls-checkbox ${enabled ? "checked" : ""}>
      </div>
      <p class="hint">${game.i18n.localize("GOD.RegionLightWalls.FieldHint")}</p>

      <label>${game.i18n.localize("GOD.RegionLightWalls.InsetLabel")}${distanceUnit ? ` (${distanceUnit})` : ""}</label>
      <div class="form-fields">
        <input type="number" min="0" step="0.1" value="${inset}" data-god-light-wall-inset>
      </div>
      <p class="hint">${game.i18n.localize("GOD.RegionLightWalls.InsetHint")}</p>

      <label>${game.i18n.localize("GOD.RegionLightWalls.ElevationLabel")}</label>
      <div class="form-fields">
        <input type="checkbox" data-god-light-wall-elevation ${useElevation ? "checked" : ""}>
      </div>
      <p class="hint">${game.i18n.localize("GOD.RegionLightWalls.ElevationHint")}</p>
    `;

    // Anchor right after the native Elevation fields — this is a GOD-Tactical
    // Region property that pairs naturally with the elevation band it copies
    // onto its generated walls. Falls back to the footer, then the form itself.
    const elevationInput = form.querySelector('[name="elevation.top"]') ?? form.querySelector('[name="elevation.bottom"]');
    const anchor = elevationInput?.closest(".form-group");
    if (anchor) anchor.after(group);
    else {
      const footer = form.querySelector("footer");
      if (footer) footer.before(group);
      else form.appendChild(group);
    }

    // All three handlers write with `{render: false}` — these controls are
    // injected into the native Region form but persist immediately on change,
    // and a re-render would reset every OTHER native field (notably the
    // Elevation top/bottom the user may have just typed but not yet submitted)
    // back to its last-saved value. Confirmed live: typing Elevation 5, then
    // ticking "Автостены" here, silently reverted the field to 1 — looked
    // exactly like "can't set a nested Region's height above the one below
    // it", but it's just this re-render eating the unsaved edit. Suppressing
    // the re-render keeps the flag write (and its updateRegion sync) while
    // leaving the rest of the form's pending edits intact.
    const setFlagNoRender = (key, value) => doc.update({ [`flags.${FLAG_SCOPE}.${key}`]: value }, { render: false });
    const unsetFlagNoRender = (key) => doc.update({ [`flags.${FLAG_SCOPE}.-=${key}`]: null }, { render: false });

    group.querySelector("[data-god-auto-light-walls-checkbox]").addEventListener("change", async (ev) => {
      ev.stopPropagation();
      if (ev.currentTarget.checked) await setFlagNoRender(AUTO_WALLS_FLAG, true);
      else await unsetFlagNoRender(AUTO_WALLS_FLAG);
    });

    group.querySelector("[data-god-light-wall-inset]").addEventListener("change", async (ev) => {
      ev.stopPropagation();
      const val = Number(ev.currentTarget.value);
      if (!val || val <= 0) await unsetFlagNoRender(INSET_FLAG);
      else await setFlagNoRender(INSET_FLAG, val);
    });

    group.querySelector("[data-god-light-wall-elevation]").addEventListener("change", async (ev) => {
      ev.stopPropagation();
      if (ev.currentTarget.checked) await unsetFlagNoRender(USE_ELEVATION_FLAG); // true is the default — no need to store it
      else await setFlagNoRender(USE_ELEVATION_FLAG, false);
    });

    // This sheet's tab section (.tab.region-identity) renders at a FIXED
    // pixel height with `overflow-y: hidden` — adding these fields grows the
    // tab's real content past that frozen box, with nothing to reveal what's
    // cut off. Confirmed
    // live: the native "Visibility" dropdown (ordinarily the LAST field,
    // right above the footer) ends up entirely below the clipped edge —
    // easy to mistake for "the setting got deleted", since there's no
    // scrollbar to hint anything's missing.
    // Tried `app.setPosition({height:"auto"})` first (Foundry's documented
    // resize API, and the same fix Wall Height's own `renderTokenConfig`
    // handler uses after ITS injected field) — confirmed live it does NOT
    // help here: `position.height` updates to `"auto"` but the rendered
    // element stays pinned at its original height regardless (tab-switching
    // and forcing an inline `style.height` override both get silently
    // reverted too). Whatever holds this particular sheet's height fixed
    // sits deeper than the public resize API reaches. Overriding the
    // overflow instead (see god-tactical.css's `.region-config` rule) sidesteps
    // that entirely — the window itself stays whatever size Foundry wants,
    // the tab's own content scrolls inside it.
  } catch (e) {
    console.error("god-tactical | Failed to inject auto light-walls fields into Region config:", e);
  }
}

export function registerRegionLightWalls() {
  Hooks.on("renderRegionConfig", _injectAutoWallsField);

  // Only the single ACTIVE GM mutates Wall documents here, not every
  // GM-permission user — this world runs with three simultaneously-
  // connected GM-role accounts (confirmed live), and `game.user.isGM` alone
  // let all three race the exact same updateRegion broadcast, each running
  // its own clear-then-create pass concurrently. Each one's "clear" ran
  // before the OTHERS' "create" had landed, so nothing ever actually got
  // cleared between them — result: 16 walls for a 4-edge Region instead of
  // 4 (confirmed live). `game.users.activeGM` is core's own mechanism for
  // exactly this — a single, deterministically-chosen GM among however many
  // are currently connected — so only that one client's hook body runs.
  Hooks.on("updateRegion", (region, changes) => {
    if (game.user !== game.users.activeGM) return;
    try {
      const flagsTouched = changes.flags?.[FLAG_SCOPE] ?? {};
      const touched = (key) => key in flagsTouched || `-=${key}` in flagsTouched;
      const settingsTouched = touched(AUTO_WALLS_FLAG) || touched(INSET_FLAG) || touched(USE_ELEVATION_FLAG);
      const geometryTouched = "shapes" in changes || (_useElevation(region) && "elevation" in changes);

      if (settingsTouched || (geometryTouched && region.getFlag(FLAG_SCOPE, AUTO_WALLS_FLAG))) {
        _syncAutoWalls(region);
      }
    } catch (e) {
      console.error("god-tactical | Region Light Walls: failed to sync on updateRegion —", e);
    }
  });

  Hooks.on("preDeleteRegion", (region) => {
    if (game.user !== game.users.activeGM) return;
    _clearAutoWalls(region).catch((e) =>
      console.error("god-tactical | Region Light Walls: failed to clean up on Region delete —", e));
  });
}
