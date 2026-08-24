/**
 * GOD Tactical — Range Vision (base)
 * Two tiers of token-to-token detection, both native Foundry Detection
 * Modes so they render with Foundry's own built-in distinction (a
 * SIGHT-type hit draws the token normally; a non-SIGHT-only hit draws the
 * "sensed, not seen" outline effect):
 *
 *  - "Basic Sight" (SIGHT type) — true vision, pure range, with its own
 *    Range field (Token Config → Vision → Detection Modes). Native
 *    behavior, unmodified in THIS file — no wall-blocking code lives here.
 *    REVERSED from an earlier convention: walls in this world used to be
 *    hand-set to `sight: None` specifically to suppress Foundry's own
 *    native dynamic-shadow FOV rendering (the *rendered* vision-source
 *    polygon reshaping around walls); that's now wanted back, so walls are
 *    back to `sight: Normal`. Native DetectionMode behavior means Basic
 *    Sight's own `walls: true` default already blocks through them with
 *    zero code — vision-obstruction.mjs's optional wall/region/elevation
 *    layer (see that file) now checks the SAME `sight` property for its own
 *    Region/elevation-aware blocking, so the two stay in agreement instead
 *    of one honoring walls and the other silently not.
 *    Wall/region/elevation-aware blocking used to live in THIS file and
 *    crashed the whole render pipeline more than once (a Region without the
 *    expected shape, then a null target token — see git history) — moved to
 *    vision-obstruction.mjs, off by default, so a bug in that logic can't
 *    take this base layer down with it again.
 *  - "Feel Tremor" (MOVE type, `walls: false` natively) — Tremorsense
 *    stand-in: ignores walls entirely, pure distance. Its own Range field is
 *    independent of Basic Sight's — set it further out so it covers the gap
 *    Basic Sight can't reach. Turn it off per token for a deaf unit — just
 *    the Enabled checkbox, no code.
 *
 * Hiding identity under Tremor: Foundry's native "sensed, not seen" render
 * (DetectionMode.getDetectionFilter()) is just a colored OUTLINE drawn AROUND
 * the token's real artwork — the actual creature art (and its nameplate)
 * still show, so a player can already tell exactly what/who it is. Instead,
 * whenever `token.detectionFilter` is set (Foundry sets this itself, in
 * CanvasVisibility#testVisibility, precisely when a token was matched by a
 * non-Basic-Sight/non-Light-Perception mode only — i.e. exactly the
 * Tremor-only case) AND the token is otherwise visible, the `refreshToken`
 * hook below hides the real mesh + nameplate entirely and draws a white
 * "unknown" icon (a plain rounded-rect backing + icon sprite, GROUPED
 * together under the same shared Feel-Tremor filter) in its place — square
 * magenta border, washed-out interior; confirmed live as the specific look
 * wanted. This only covers the canvas token image + nameplate; things like
 * the Combat Tracker portrait/name or chat mentions still show the real
 * identity — out of scope here.
 *
 * Every OTHER core Detection Mode (`lightPerception`, `seeAll`,
 * `seeInvisibility`) is permanently neutered: we can't remove/disable them
 * from a token's `detectionModes` — Foundry silently re-adds
 * `basicSight`/`lightPerception` (reverting any edit server-side on the very
 * next read, confirmed live) whenever `sight.enabled` is true — so instead
 * of fighting that, this wraps the shared `DetectionMode#testVisibility` and
 * makes those specific modes permanent no-ops. `lightPerception` in
 * particular has an uncapped range and would otherwise reveal anything lit
 * anywhere on the map, regardless of distance — this is the one part of the
 * whole system that ISN'T optional, since without it every token everywhere
 * is always visible, full stop.
 *
 * `sight.enabled` still needs to stay ON for the observer token — Foundry
 * only restricts visibility at all (fog of war, hidden tokens) when at least
 * one controlled token has an active vision source; with it off, every
 * client sees the whole scene unrestricted (confirmed live).
 *
 * A token's `detectionModes` array only survives a round-trip to the server
 * for ids the SERVER's own `CONFIG.Canvas.detectionModes` already knows
 * about (it runs common/schema code but never this system's browser-side
 * init hook) — and even for known ids, a raw script `TokenDocument#update()`
 * call gets silently reverted (confirmed live, repeatedly); only submitting
 * the real Token Config *form* persists a change. Not this module's
 * business logic, just a trap to remember when configuring tokens.
 */

import { detectionModeList } from "./detection-modes-compat.mjs";

const NEUTERED_MODE_IDS = new Set(["lightPerception", "seeAll", "seeInvisibility"]);
const UNKNOWN_TOKEN_IMAGE = "icons/svg/mystery-man.svg";

/** White-backed "unknown" icon, grouped with its own backing under the
 *  shared Feel-Tremor filter — square magenta border, washed-out interior,
 *  this is the specific look wanted (confirmed live with a reference
 *  screenshot). Needs `knockout: false` OFF (i.e. Foundry's default `true`)
 *  — turning it off to fix an earlier "too pale" complaint instead blew the
 *  whole backing out to solid opaque white (confirmed live). Position this
 *  yourself afterward (world-space center). */
function _createDisguiseGroup(w, h) {
  const tex = foundry.canvas.getTexture(UNKNOWN_TOKEN_IMAGE);
  const filter = CONFIG.Canvas.detectionModes.feelTremor.constructor.getDetectionFilter();

  const group = new PIXI.Container();
  const bg = new PIXI.Graphics();
  bg.beginFill(0xFFFFFF, 1);
  bg.drawRoundedRect(-w / 2, -h / 2, w, h, w / 8);
  bg.endFill();
  const icon = new PIXI.Sprite(tex);
  icon.width = w;
  icon.height = h;
  icon.anchor.set(0.5);

  group.addChild(bg, icon);
  group.filters = [filter];
  return group;
}

export function registerRangeVision() {
  const DetectionMode = foundry.canvas?.perception?.DetectionMode;
  if (!DetectionMode) {
    console.warn("god-tactical | Range Vision: foundry.canvas.perception.DetectionMode not found — skipping (Foundry API changed?).");
    return;
  }
  if (typeof libWrapper === "undefined") {
    console.warn("god-tactical | Range Vision requires the 'lib-wrapper' module to be active — without it, light perception will reveal anything at unlimited range.");
    return;
  }

  // The token's NATIVE rendered vision circle (the shape fog-of-war/darkness
  // actually draws — separate from anything detection-mode related above)
  // reads `document.sight.range`, a totally different field from Basic
  // Sight's own Range in the Detection Modes table. Rather than keep two
  // numbers in sync by hand (and hit the same "raw script update gets
  // silently reverted" trap this file's header already warns about), this
  // redirects the getter the render pipeline actually calls straight to the
  // FURTHEST-reaching enabled detection mode (normally Feel Tremor, since
  // it's meant to cover ground past Basic Sight). Single source of truth,
  // no document write.
  //
  // Previously this only looked at basicSight's range, which caps the
  // underlying PointVisionSource's own radius at that shorter distance —
  // CanvasVisibility never even generates test points past that radius, so
  // no detection mode (Tremor included) can ever fire beyond it regardless
  // of its own configured Range field. Confirmed live: a target sitting
  // between Basic Sight's and Feel Tremor's range (in Tremor's own range)
  // was silently never tested at all — `DetectionMode#testVisibility`
  // returns `true` for it in isolation, but `canvas.visibility.testVisibility`
  // still said invisible, because the vision source's radius (1875px, from
  // Basic Sight's 6m) fell short of the target's actual distance (2121px,
  // within Tremor's 8m/2475px). Taking the max across enabled modes fixes
  // this without needing to touch either mode's own Range field.
  //
  // Must exclude NEUTERED_MODE_IDS here too: `lightPerception`'s `range` is
  // `Infinity` by design (its uncapped-range native behavior is what makes
  // it dangerous in the first place, see this file's header) — `testVisibility`
  // neuters it to a permanent no-op, but it's still present and `enabled` in
  // `detectionModes`, so an unfiltered `Math.max` picked it up and blew the
  // vision source's radius out to `Infinity` (confirmed live: every token on
  // the map became visible, not just ones in Tremor range). Only modes that
  // can actually contribute a detection result should count toward reach.
  libWrapper.register(
    "god-tactical",
    "foundry.canvas.placeables.Token.prototype.sightRange",
    function (wrapped) {
      const ranges = detectionModeList(this.document)
        .filter((m) => m.enabled && m.range && !NEUTERED_MODE_IDS.has(m.id))
        .map((m) => this.getLightRadius(m.range));
      if (!ranges.length) return 0;
      return Math.max(...ranges);
    },
    "OVERRIDE",
  );

  // Feel Tremor is felt through the ground/air (vibration/sound), not sighted
  // — a height difference shouldn't shrink or block its reach the way it
  // does for Basic Sight. But the "Levels" module installs its own OVERRIDE
  // of this exact method, globally, for every detection mode with no id
  // check: it swaps core's plain 2D range test (dx, dy only — confirmed by
  // reading core's source) for a 3D one that adds the observer/target
  // elevation difference (`dz`) into the distance, using the SAME formula for
  // Tremor as for Sight. Confirmed live: two tokens 7.07m apart horizontally
  // (within Tremor's 8m range, outside Basic Sight's 6m) tested as
  // undetected by Tremor while their elevations differed by 5m (3D distance
  // ~8.66m), and became detected the instant their elevations were set
  // equal — i.e. Tremor was silently inheriting Sight's height sensitivity
  // from Levels, not because anything in THIS module's Tremor code cared
  // about elevation.
  //
  // Basic Sight ALSO gets 2D here now, for a different reason: this same
  // Levels 3D penalty turns out to be the ONLY thing in the whole vision
  // stack that ever penalizes looking DOWN by distance — vision-obstruction.
  // mjs's `_elevationBlocksSight` already fully blocks the opposite case
  // (target above the observer's own eye level) regardless of distance, per
  // this project's own documented rule "high ground can always see down,
  // only looking up is capped" (see that file's header). Since "looking up"
  // is already all-or-nothing before any range math runs, the 3D distance
  // was only ever adding an unintended range PENALTY to the "looking down"
  // case that's supposed to be unrestricted — confirmed live: a target 4.5m
  // away horizontally, 5.4m below the observer's eye level, tested as out of
  // Basic Sight's 6m range (~7m real 3D distance) despite nothing blocking
  // the view and despite being straight downhill from the observer. 2D
  // removes that unintended penalty without touching wall/region/eye-level
  // blocking at all — those all live in vision-obstruction.mjs's `_testLOS`
  // wrapper, a fully separate gate (`_testPoint` requires both `_testRange`
  // AND `_testLOS` to pass), untouched by this change.
  //
  // Registered after range-vision's other wrappers so it layers OUTSIDE
  // Levels' OVERRIDE (libWrapper calls the most-recently registered wrapper
  // first); only intercepts `feelTremor`/`basicSight` specifically and falls
  // through to `wrapped` (Levels' 3D math) for every other mode.
  libWrapper.register(
    "god-tactical",
    "foundry.canvas.perception.DetectionMode.prototype._testRange",
    function (wrapped, visionSource, mode, target, test) {
      if (this.id !== "feelTremor" && this.id !== "basicSight") return wrapped(visionSource, mode, target, test);
      const range = mode.range;
      if (range <= 0) return false;
      if (range === Infinity) return true;
      const { x, y } = visionSource.data;
      const radius = visionSource.object.getLightRadius(range);
      const dx = test.point.x - x;
      const dy = test.point.y - y;
      return (dx * dx) + (dy * dy) <= (radius * radius);
    },
    "MIXED",
  );

  libWrapper.register(
    "god-tactical",
    "foundry.canvas.perception.DetectionMode.prototype.testVisibility",
    function (wrapped, visionSource, mode, config) {
      if (NEUTERED_MODE_IDS.has(this.id)) return false;
      return wrapped(visionSource, mode, config);
    },
    "MIXED",
  );

  // Foundry's own native per-mesh filtered render is fully replaced below
  // by the grouped disguise render — a no-op here, not something to
  // special-case per token, since we always want the grouped look now.
  // "MIXED" rather than "OVERRIDE": functionally identical (never calls
  // `wrapped`), but plays nicer with any OTHER module that might wrap this
  // same method later — OVERRIDE sits on top and silently blocks anything
  // registered below it in the chain.
  libWrapper.register(
    "god-tactical",
    "foundry.canvas.placeables.Token.prototype._renderDetectionFilter",
    function (wrapped) {},
    "MIXED",
  );

  // Thicken the shared Feel-Tremor filter's outline AND boost its interior
  // "wave" ripple — both read fine against a bright floor but nearly vanish
  // over a dark/shadowed tile (confirmed live, GM screenshot). Deferred to
  // canvasReady: OutlineOverlayFilter needs a live WebGL/renderer context
  // (registerRangeVision runs on "init", well before canvas exists).
  //
  // The PREVIOUS version of this block wrote directly to
  // `tremorFilter.uniforms.thickness` — a no-op bug. OutlineOverlayFilter's
  // own `apply()` recomputes that exact array from a PRIVATE `#thickness`
  // field (default 3) on every single frame, so a direct uniforms write
  // gets silently clobbered the very next frame and never had any visible
  // effect (confirmed by reading core's apply() — this is why the frame
  // still looked thin despite this code already existing). The public
  // `.thickness` SETTER is the real lever: it also grows `.padding` to
  // match, so the fatter ring doesn't get clipped at the filter's bounding
  // box.
  //
  // The wave ripple's low opacity was ALSO not just the 0.33 amplitude cap
  // (already bumped to 0.9 below) — the real culprit found after a second
  // look: core's `wcos(0.0, 1.0, dist * 75.0, ...)` oscillates the ring
  // pattern's brightness all the way down to 0.0 between rings (see
  // AbstractBaseShader.WAVE()'s `(v1-v2)*((cos+a)*0.5)+v2` formula — v1=0.0
  // IS the floor). 0 times any amplitude is still 0, so however high the
  // peak gets, most of the square is fully transparent at any single
  // instant — against near-black shadow that reads as "barely visible",
  // exactly the follow-up complaint (a still screenshot just catches the
  // pattern at a dim point in its cycle). Raising the floor to 0.4 turns it
  // into a constant soft glow that the rings pulse brighter on TOP of,
  // rather than a thin bright line surrounded by literal gaps — visible at
  // every point in the animation, not just at ring peaks. Frequency
  // (dist * 75.0 → * 50.0) is also lowered a bit for chunkier, easier-to-
  // read bands instead of thin hairlines.
  //
  // Both constants are hardcoded in core's fragment shader (not uniforms),
  // so there's no field to tweak: replace the whole detection filter with a
  // subclass that patches them via a string-replace of the *compiled*
  // shader source (matches whatever core actually returns at runtime, so it
  // can't drift out of sync with a minor version's exact formatting).
  // DetectionModeTremor is the only core mode that turns `wave` on, so this
  // subclass — and the higher opacity — is invisible to every other outline
  // effect in the game (targeting, DetectionModeAll's blue "see all"
  // outline, etc).
  Hooks.once("canvasReady", () => {
    const TremorMode = CONFIG.Canvas.detectionModes?.feelTremor?.constructor;
    const OutlineOverlayFilter = foundry.canvas?.rendering?.filters?.OutlineOverlayFilter;
    if (!TremorMode || !OutlineOverlayFilter) return;

    class GodTremorOutlineFilter extends OutlineOverlayFilter {}

    // NOT a `static createFragmentShader()` declared in the class body — two reasons stack
    // here. (1) `super.createFragmentShader()` keeps `this` bound to GodTremorOutlineFilter
    // (whatever this method was actually called on), but the inherited method internally
    // reads a PRIVATE static field (`this.#quality`) that only exists on the literal
    // OutlineOverlayFilter class object — private fields aren't inherited through the
    // prototype chain the way normal properties are, "an instance of a subclass" isn't
    // enough — so that throws "Receiver must be class OutlineOverlayFilter" (confirmed live:
    // this crashed EVERY canvasReady since this feature shipped, silently no-op'ing the whole
    // thickness/wave-floor boost below every single time). Explicitly re-binding `this` back
    // to the real OutlineOverlayFilter for the call sidesteps the private-field restriction.
    // (2) v14 renamed the static method itself, `createFragmentShader` → `_createFragmentShader`
    // (paired with `_createVertexShader`) — a fixed-name override under the OLD name is simply
    // never reached by the render pipeline anymore, which falls through to the INHERITED
    // `_createFragmentShader` and hits the exact private-field crash above via the new name
    // instead (reproduced live after the v14 upgrade). Detecting the live name and assigning
    // the override dynamically, post-declaration, survives either core version.
    const shaderMethod = typeof OutlineOverlayFilter._createFragmentShader === "function" ? "_createFragmentShader"
      : typeof OutlineOverlayFilter.createFragmentShader === "function" ? "createFragmentShader"
      : null;
    if (shaderMethod) {
      GodTremorOutlineFilter[shaderMethod] = function () {
        let src = OutlineOverlayFilter[shaderMethod].call(OutlineOverlayFilter);
        const floorAnchor = "wcos(0.0, 1.0, dist * 75.0,";
        const ampAnchor = "0.33 * (1.0 - dist) * w;";
        if (src.includes(floorAnchor) && src.includes(ampAnchor)) {
          src = src.replace(floorAnchor, "wcos(0.4, 1.0, dist * 50.0,");
          src = src.replace(ampAnchor, "1.0 * (1.0 - dist) * w;");
        } else {
          console.warn("god-tactical | Feel-Tremor outline shader shape changed — wave boost skipped this session.");
        }
        return src;
      };
    } else {
      console.warn("god-tactical | OutlineOverlayFilter shader-builder renamed again — Feel-Tremor wave boost skipped this session.");
    }

    // Same uniforms core's own DetectionModeTremor.getDetectionFilter() uses
    // (magenta, knockout, wave on) — only the shader class differs.
    const tremorFilter = GodTremorOutlineFilter.create({
      outlineColor: [1, 0, 1, 1],
      knockout: true,
      wave: true,
    });
    tremorFilter.thickness = 6; // Foundry's own default is 3
    TremorMode._detectionFilter = tremorFilter;
  });

  Hooks.on("refreshToken", (token) => {
    if (!token.mesh) return;
    const sensedOnly = token.visible && !!token.detectionFilter;

    if (sensedOnly && token.nameplate) token.nameplate.visible = false;
    // Foundry's own Token#_refreshVisibility sets `mesh.visible = token.visible
    // && token.renderable` — mesh lives outside the Token itself (added
    // straight to canvas.primary, not as a child of the Token placeable), so
    // nothing else keeps it in sync. Must stay gated on `token.visible` too,
    // not just the disguise condition, or a token entirely out of range
    // (token.visible === false, sensedOnly === false too) gets its mesh
    // forced back visible regardless of distance (confirmed live).
    token.mesh.visible = token.visible && !sensedOnly;

    if (sensedOnly) {
      if (!token._godDisguiseGroup) {
        token._godDisguiseGroup = _createDisguiseGroup(token.w, token.h);
        // Deliberately NOT parented next to token.mesh (canvas.primary, inside
        // the "environment" group) like an earlier version of this code did.
        // Core's own group tree (CONFIG.Canvas.groups) nests things as
        // rendered -> [environment (primary/effects, i.e. token.mesh's home),
        // visibility, interface] — visibility is drawn AFTER environment and
        // paints an opaque black "unexplored/blocked" mask straight over
        // whatever's there (see scene-darkness-opacity.mjs's header for the
        // full shader breakdown). No amount of tuning the glow's OWN
        // brightness could ever show through that later, opaque paint pass
        // (confirmed live — the thickness/wave-floor fixes had zero visible
        // effect in the dark). `canvas.interface` is visibility's next
        // sibling, drawn after it, so anything parented there renders on TOP
        // of the fog/darkness mask instead of underneath it — which also
        // just matches what tremorsense (a "feel", not a "see") should mean:
        // unaffected by darkness or by what's currently in line of sight.
        canvas.interface.addChild(token._godDisguiseGroup);
      }
      token._godDisguiseGroup.position.set(token.mesh.position.x, token.mesh.position.y);
      token._godDisguiseGroup.visible = true;
    } else if (token._godDisguiseGroup) {
      token._godDisguiseGroup.visible = false;
    }
  });

  // _godDisguiseGroup lives outside the Token itself (a child of
  // canvas.interface, not of the Token — see above), so deleting the token
  // mid-session wouldn't otherwise clean it up: an orphaned white square with
  // no owner left rendering on the canvas forever (unlike range-preview.mjs's
  // equivalent _godRangeCircles, which already had this).
  Hooks.on("destroyToken", (token) => {
    token._godDisguiseGroup?.destroy();
  });
}
