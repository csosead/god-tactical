/**
 * GOD Tactical — Scene Darkness Opacity
 * Adds a "Darkness Opacity" slider to the native Scene Config sheet, right
 * next to Foundry's own Darkness Level field — writes/reads
 * flags['god-tactical'].darknessOpacity (0..1, default 1 = vanilla behavior).
 *
 * IMPORTANT — this does NOT paint a black overlay on top of the scene (that
 * was tried first and rejected: it darkens the whole screen, which is the
 * opposite of what's needed). What this actually controls is the alpha
 * Foundry's own vision/fog shader (VisibilityFilter, see
 * foundry.canvas.rendering.filters.VisibilityFilter — core client bundle,
 * class ~line 159939 in scripts/foundry.mjs for this build) uses for the
 * "unexplored" region: the black wedges cast by walls/fences blocking a
 * token's line of sight within its vision RANGE circle (exactly what was
 * flagged on the reference screenshot). Core hardcodes that alpha to 1.0
 * (`vec4(unexploredColor, 1.0)`) — the ALREADY-explored-but-not-currently-
 * visible fog is rendered at a soft 0.5 alpha by the same shader, so the
 * "hard black cutout" for never-explored/blocked areas is a deliberate core
 * choice, not a technical limit. We subclass VisibilityFilter (an official
 * CONFIG.Canvas.visibilityFilter extension point — see the core bundle's
 * defaultUniforms/fragmentShader statics) to add a real `unexploredAlpha`
 * uniform and wire it to the flag above.
 *
 * This ONLY changes how already-computed visibility is painted to the
 * screen. It never touches Detection Modes, walls, Regions, or this
 * system's own range-vision.mjs / vision-obstruction.mjs / blind-spot.mjs —
 * none of which read this filter or its uniforms. Purely atmospheric, per
 * the GM's request: "хочу регулировать тени и тьмы, чтобы сквозь неё было
 * видно, но при этом она работала просто для атмосферы."
 *
 * Also adds a second, independent slider on the same field group —
 * "Искусственная подсветка тьмы" (darknessFloor) — because Darkness Opacity
 * above has a hard ceiling on how much it can help: at its own minimum (0),
 * it's already showing the scene's real, un-modified content, and if THAT
 * is still too dark to make out, that's genuine scene lighting (Darkness
 * Level, or real light-blocking geometry — e.g. region-light-walls.mjs's
 * auto-generated walls correctly casting a real shadow), not fog/vision
 * alpha at all — no amount of "more transparent" changes what's actually
 * being revealed underneath. darknessFloor is a flat post-process filter on
 * the WHOLE canvas.stage that raises any pixel darker than its value up to
 * it (`max(color, floor)`) and leaves brighter pixels alone — a GM-only
 * "night vision assist" that works regardless of WHICH mechanism made an
 * area dark (fog, Darkness Level, or a real light-blocking wall), since it
 * operates on the final rendered pixels rather than any specific shader's
 * inputs.
 */

const FLAG_SCOPE = "god-tactical";
const OPACITY_FLAG = "darknessOpacity";
const FLOOR_FLAG = "darknessFloor";

let _floorFilter = null;

function _sceneAlpha(scene) {
  const v = scene?.getFlag(FLAG_SCOPE, OPACITY_FLAG);
  return (typeof v === "number" && v >= 0 && v <= 1) ? v : 1; // 1 = Foundry's own default (fully opaque)
}

function _sceneFloor(scene) {
  const v = scene?.getFlag(FLAG_SCOPE, FLOOR_FLAG);
  return (typeof v === "number" && v >= 0 && v <= 1) ? v : 0; // 0 = off, matches vanilla rendering
}

/** Flat "raise the black point" post-process: any pixel darker than
 *  `floorLevel` gets lifted to it, anything already brighter is untouched.
 *  `* color.a` scales the target for PIXI's premultiplied-alpha convention
 *  — at the fully-opaque alpha (1.0) this whole filter normally runs at
 *  (a full canvas.stage pass), that's just `floorLevel` itself. */
class GodDarknessFloorFilter extends PIXI.Filter {
  constructor() {
    const frag = `
      varying vec2 vTextureCoord;
      uniform sampler2D uSampler;
      uniform float floorLevel;
      void main(void) {
        vec4 color = texture2D(uSampler, vTextureCoord);
        color.rgb = max(color.rgb, vec3(floorLevel) * color.a);
        gl_FragColor = color;
      }
    `;
    super(undefined, frag, { floorLevel: 0 });
  }
}

function _ensureFloorFilter() {
  if (!canvas?.stage) return null;
  if (!_floorFilter) _floorFilter = new GodDarknessFloorFilter();
  if (!canvas.stage.filters?.includes(_floorFilter)) {
    canvas.stage.filters = [...(canvas.stage.filters ?? []), _floorFilter];
  }
  return _floorFilter;
}

function _applyFloorFromScene() {
  const filter = _ensureFloorFilter();
  if (filter) filter.uniforms.floorLevel = _sceneFloor(canvas.scene);
}

/** Static method that builds the fragment shader SOURCE STRING on `CONFIG.Canvas.visibilityFilter`.
 *  Foundry v13 exposed it as `fragmentShader`; v14 renamed the whole family of shader-source
 *  builders to `_create*Shader` (`_createFragmentShader`/`_createVertexShader`) — same source,
 *  same anchors to patch, just a different static name. Support both so a core update doesn't
 *  silently kill the Darkness Opacity slider again; null if core renames it to something else
 *  entirely (registerSceneDarknessOpacity then logs and moves on, atmosphere-only feature). */
function _shaderMethodName(Base) {
  if (typeof Base?._createFragmentShader === "function") return "_createFragmentShader";
  if (typeof Base?.fragmentShader === "function") return "fragmentShader";
  return null;
}

function _buildVisibilityFilterClass() {
  const Base = CONFIG.Canvas.visibilityFilter;
  const shaderMethod = _shaderMethodName(Base);
  if (!shaderMethod || !Base?.defaultUniforms) return null;

  class GodVisibilityFilter extends Base {
    /** @override — inject unexploredAlpha, read fresh from the active scene on every filter (re)creation. */
    static get defaultUniforms() {
      return { ...super.defaultUniforms, unexploredAlpha: _sceneAlpha(canvas?.scene) };
    }
  }

  // Assigned dynamically (rather than declared in the class body under a fixed name) so this
  // keeps working whichever of the two names `_shaderMethodName` found. `.call(this, options)`
  // — `this` is whatever the ACTUAL runtime class is (GodVisibilityFilter, or a further
  // subclass) — mirrors what `super.method()` would give inside the class body.
  GodVisibilityFilter[shaderMethod] = function (options) {
    let src = Base[shaderMethod].call(this, options);
    const declAnchor = "uniform vec3 unexploredColor;";
    const alphaExpr = "vec4(unexploredColor, 1.0)";
    if (src.includes(declAnchor) && src.includes(alphaExpr)) {
      src = src.replace(declAnchor, `${declAnchor}\n    uniform float unexploredAlpha;`);
      src = src.split(alphaExpr).join("vec4(unexploredColor, unexploredAlpha)");
    } else {
      console.warn("god-tactical | VisibilityFilter shader shape changed — Darkness Opacity slider will have no effect this session.");
    }
    return src;
  };

  return GodVisibilityFilter;
}

function _injectDarknessOpacityField(app, html) {
  try {
    const root = (html instanceof HTMLElement) ? html : (html?.[0] ?? app.element);
    if (!root) return;
    if (root.querySelector("[data-god-darkness-opacity-field]")) return; // already injected (re-render)

    const doc = app.document ?? app.object;
    if (!doc) return;

    const form = root.querySelector("form") ?? root;
    const current = _sceneAlpha(doc);
    const currentFloor = _sceneFloor(doc);

    const group = document.createElement("div");
    group.classList.add("form-group");
    group.dataset.godDarknessOpacityField = "true";
    group.innerHTML = `
      <label>${game.i18n.localize("GOD.SceneDarkness.FieldLabel")}</label>
      <div class="form-fields">
        <input type="range" min="0" max="1" step="0.05" value="${current}" data-god-darkness-opacity-range>
        <output>${Math.round(current * 100)}%</output>
      </div>
      <p class="hint">${game.i18n.localize("GOD.SceneDarkness.FieldHint")}</p>

      <label>${game.i18n.localize("GOD.SceneDarkness.FloorLabel")}</label>
      <div class="form-fields">
        <input type="range" min="0" max="1" step="0.05" value="${currentFloor}" data-god-darkness-floor-range>
        <output>${Math.round(currentFloor * 100)}%</output>
      </div>
      <p class="hint">${game.i18n.localize("GOD.SceneDarkness.FloorHint")}</p>
    `;

    // Anchor next to Foundry's own Darkness Level field (Lighting tab, name
    // confirmed against this build's core bundle: "environment.darknessLevel")
    // — falls back to just before the footer if that name differs on another
    // core version, same defensive anchor pattern as region-light-walls.mjs.
    const darknessInput = form.querySelector('[name="environment.darknessLevel"]') ?? form.querySelector('[name="darkness"]');
    const anchor = darknessInput?.closest(".form-group");
    if (anchor) anchor.after(group);
    else {
      const footer = form.querySelector("footer");
      if (footer) footer.before(group);
      else form.appendChild(group);
    }

    const range = group.querySelector("[data-god-darkness-opacity-range]");
    const output = group.querySelector("output");

    // Live preview while dragging — mutates the already-running shader's uniform
    // directly (cheap: no texture/geometry rebuild), only when this Scene Config
    // is editing the scene currently on screen.
    range.addEventListener("input", (ev) => {
      const val = Number(ev.currentTarget.value);
      output.textContent = `${Math.round(val * 100)}%`;
      if (canvas.scene?.id === doc.id && canvas.visibility?.filter) {
        canvas.visibility.filter.uniforms.unexploredAlpha = val;
      }
    });

    // Persist on release. >=1 (the default) unsets the flag entirely rather than
    // storing a redundant literal 1 — an untouched scene and an explicitly-reset
    // one should look identical in the data.
    range.addEventListener("change", async (ev) => {
      ev.stopPropagation();
      const val = Number(ev.currentTarget.value);
      if (val >= 1) await doc.unsetFlag(FLAG_SCOPE, OPACITY_FLAG);
      else await doc.setFlag(FLAG_SCOPE, OPACITY_FLAG, val);
    });

    const floorRange = group.querySelector("[data-god-darkness-floor-range]");
    const floorOutput = floorRange.nextElementSibling;

    floorRange.addEventListener("input", (ev) => {
      const val = Number(ev.currentTarget.value);
      floorOutput.textContent = `${Math.round(val * 100)}%`;
      if (canvas.scene?.id === doc.id) {
        const filter = _ensureFloorFilter();
        if (filter) filter.uniforms.floorLevel = val;
      }
    });

    floorRange.addEventListener("change", async (ev) => {
      ev.stopPropagation();
      const val = Number(ev.currentTarget.value);
      if (val <= 0) await doc.unsetFlag(FLAG_SCOPE, FLOOR_FLAG);
      else await doc.setFlag(FLAG_SCOPE, FLOOR_FLAG, val);
    });
  } catch (e) {
    console.error("god-tactical | Failed to inject darkness opacity field into Scene config:", e);
  }
}

export function registerSceneDarknessOpacity() {
  const GodVisibilityFilter = _buildVisibilityFilterClass();
  if (GodVisibilityFilter) CONFIG.Canvas.visibilityFilter = GodVisibilityFilter;
  else console.error("god-tactical | Could not extend CONFIG.Canvas.visibilityFilter — Darkness Opacity slider will have no effect this session.");

  Hooks.on("renderSceneConfig", _injectDarknessOpacityField);

  Hooks.on("canvasReady", _applyFloorFromScene);

  Hooks.on("updateScene", (scene, changes) => {
    if (scene.id !== canvas.scene?.id) return;
    // Covers both the setFlag path (flags.god-tactical.darknessOpacity) and the
    // unsetFlag deletion path (flags.god-tactical.-=darknessOpacity) — either
    // way `flags["god-tactical"]` shows up as a touched key on `changes`.
    if (changes.flags && FLAG_SCOPE in changes.flags) {
      if (canvas.visibility?.filter) canvas.visibility.filter.uniforms.unexploredAlpha = _sceneAlpha(scene);
      _applyFloorFromScene();
    }
  });
}
