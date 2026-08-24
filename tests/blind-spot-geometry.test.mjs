import { test } from "node:test";
import assert from "node:assert/strict";
import {
  intersectSegments,
  rayHeightAt,
  testWallAgainstRay,
  findBlockingWall,
  crossesAnyWall,
} from "../module/canvas/blind-spot-geometry.mjs";

test("intersectSegments: crossing segments report the correct point and parameters", () => {
  const hit = intersectSegments({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 });
  assert.ok(hit);
  assert.equal(hit.x, 5);
  assert.equal(hit.y, 0);
  assert.equal(hit.t, 0.5);
  assert.equal(hit.u, 0.5);
});

test("intersectSegments: parallel segments never intersect", () => {
  assert.equal(intersectSegments({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }), null);
});

test("intersectSegments: crossing point outside either segment's own range is a miss", () => {
  // Lines would cross at x=20 if extended, but neither segment reaches that far.
  assert.equal(intersectSegments({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: -5 }, { x: 20, y: 5 }), null);
});

test("rayHeightAt: linear interpolation between the two ends", () => {
  assert.equal(rayHeightAt(10, 0, 0), 10);
  assert.equal(rayHeightAt(10, 0, 1), 0);
  assert.equal(rayHeightAt(10, 0, 0.5), 5);
  assert.equal(rayHeightAt(2, 8, 0.25), 3.5);
});

// ── Sniper-on-a-roof scenario ────────────────────────────────────────────
// Roof surface at z=5, a 1.2 m parapet along its edge (x=0) — top = 6.2 m,
// bottom = 5 m (the roof surface itself). Target stands at ground level
// (z=0.9, its own center-of-mass height) 20 m out from the parapet.
// Shooter's eye sits at roof height + 1.7 m standing eye height = 6.7 m,
// somewhere BEHIND the parapet (x < 0, deeper into the roof the further
// back they stand).
const EYE_Z = 5 + 1.7;
const TARGET_GROUND = { x: 20, y: 0, z: 0.9 };
const PARAPET = { a: { x: 0, y: -5 }, b: { x: 0, y: 5 }, top: 6.2, bottom: 5 };

test("sniper at the roof's edge fires at a steep angle and clears the parapet", () => {
  // Standing right up against the parapet (x=-0.5) — the ray has barely
  // started descending by the time it reaches x=0, still well above 6.2 m.
  const eye = { x: -0.5, y: 0, z: EYE_Z };
  const hit = findBlockingWall(eye, TARGET_GROUND, [PARAPET]);
  assert.equal(hit, null);
});

test("sniper steps back from the edge and the same parapet now blocks the shot", () => {
  // Stepping back to x=-4 flattens the angle enough that by x=0 the ray has
  // already dropped below the parapet's 6.2 m top.
  const eye = { x: -4, y: 0, z: EYE_Z };
  const hit = findBlockingWall(eye, TARGET_GROUND, [PARAPET]);
  assert.ok(hit);
  assert.equal(hit.wall, PARAPET);
  assert.equal(hit.blocked, true);
  assert.ok(hit.rayZ < PARAPET.top);
});

test("testWallAgainstRay: ray passing exactly along the parapet's top edge is NOT blocked (grazing, not through)", () => {
  const eye = { x: -4, y: 0, z: 6.2 };
  const target = { x: 20, y: 0, z: 6.2 }; // flat ray, exactly at parapet top height
  const result = testWallAgainstRay(eye, target, PARAPET);
  assert.ok(result);
  assert.equal(result.blocked, false);
});

test("testWallAgainstRay: ray passing exactly along the parapet's bottom edge IS blocked (bottom is inclusive)", () => {
  const eye = { x: -4, y: 0, z: 5 };
  const target = { x: 20, y: 0, z: 5 };
  const result = testWallAgainstRay(eye, target, PARAPET);
  assert.ok(result);
  assert.equal(result.blocked, true);
});

test("testWallAgainstRay: untagged wall (no top/bottom) blocks at every height", () => {
  const wall = { a: { x: 0, y: -5 }, b: { x: 0, y: 5 } };
  const eye = { x: -4, y: 0, z: 100 };
  const target = { x: 20, y: 0, z: -100 };
  const result = testWallAgainstRay(eye, target, wall);
  assert.ok(result);
  assert.equal(result.blocked, true);
});

test("findBlockingWall: a wall the ray never crosses in 2D is ignored entirely", () => {
  const farWall = { a: { x: 200, y: -5 }, b: { x: 200, y: 5 }, top: 100, bottom: -100 };
  const eye = { x: -0.5, y: 0, z: EYE_Z };
  const hit = findBlockingWall(eye, TARGET_GROUND, [farWall]);
  assert.equal(hit, null);
});

test("findBlockingWall: skips a low wall the ray clears and blocks on a taller one further along", () => {
  const lowWall = PARAPET; // ray clears this one at eye x=-0.5 (see the steep-angle test above)
  const tallWall = { a: { x: 10, y: -5 }, b: { x: 10, y: 5 }, top: 10, bottom: 0 }; // full wall further along
  const eye = { x: -0.5, y: 0, z: EYE_Z };
  const hit = findBlockingWall(eye, TARGET_GROUND, [lowWall, tallWall]);
  assert.ok(hit);
  assert.equal(hit.wall, tallWall);
});

test("findBlockingWall: nearest-first order doesn't matter — result is the same regardless of input array order", () => {
  const lowWall = PARAPET;
  const tallWall = { a: { x: 10, y: -5 }, b: { x: 10, y: 5 }, top: 10, bottom: 0 };
  const eye = { x: -0.5, y: 0, z: EYE_Z };
  const hitA = findBlockingWall(eye, TARGET_GROUND, [lowWall, tallWall]);
  const hitB = findBlockingWall(eye, TARGET_GROUND, [tallWall, lowWall]);
  assert.equal(hitA.wall, hitB.wall);
});

// ── crossesAnyWall (ordinary full-height walls, 2D only) ─────────────────

test("crossesAnyWall: a crossing wall is detected regardless of the ray's elevation", () => {
  const wall = { a: { x: 10, y: -5 }, b: { x: 10, y: 5 } };
  const hit = crossesAnyWall({ x: 0, y: 0 }, { x: 20, y: 0 }, [wall]);
  assert.equal(hit, true);
});

test("crossesAnyWall: no crossing walls in the list is a clean miss", () => {
  const wall = { a: { x: 100, y: -5 }, b: { x: 100, y: 5 } };
  const hit = crossesAnyWall({ x: 0, y: 0 }, { x: 20, y: 0 }, [wall]);
  assert.equal(hit, false);
});

test("crossesAnyWall: empty wall list never blocks", () => {
  const hit = crossesAnyWall({ x: 0, y: 0 }, { x: 20, y: 0 }, []);
  assert.equal(hit, false);
});

test("crossesAnyWall: only one wall in the list needs to cross for a block", () => {
  const missWall = { a: { x: 100, y: -5 }, b: { x: 100, y: 5 } };
  const hitWall = { a: { x: 10, y: -5 }, b: { x: 10, y: 5 } };
  const hit = crossesAnyWall({ x: 0, y: 0 }, { x: 20, y: 0 }, [missWall, hitWall]);
  assert.equal(hit, true);
});
