import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeShapeConfig,
  buildShapeGeometry,
  segmentsIntersect,
  segmentIntersectsShapeGeometry,
} from "../module/canvas/geometry-core.mjs";

const GRID_SIZE = 100;
const ORIGIN = { x: 0, y: 0 };

test("segmentsIntersect: crossing segments", () => {
  assert.equal(segmentsIntersect({ x: 0, y: -10 }, { x: 0, y: 10 }, { x: -10, y: 0 }, { x: 10, y: 0 }), true);
});

test("segmentsIntersect: parallel non-touching segments", () => {
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }), false);
});

test("segmentsIntersect: collinear overlapping segments count as touching", () => {
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 }), true);
});

// ── line (polygon) shape ──────────────────────────────────────────
// origin (0,0), aim along +x, length 5 cells (500px), default width 1.2 cells
// (120px, half-width 60px) — rectangle spans x:[0,500], y:[-60,60].
const lineGeometry = buildShapeGeometry(
  normalizeShapeConfig({ type: "line", length: 5 }),
  ORIGIN,
  0,
  GRID_SIZE,
);

test("line: wall crossing the beam is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 200, y: -100 }, { x: 200, y: 100 }, lineGeometry);
  assert.equal(hit, true);
});

test("line: wall fully inside the beam (no edge crossing) is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 100, y: -10 }, { x: 100, y: 10 }, lineGeometry);
  assert.equal(hit, true);
});

test("line: wall beyond the beam's length is a miss", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 700, y: -100 }, { x: 700, y: 100 }, lineGeometry);
  assert.equal(hit, false);
});

test("line: wall exactly touching the beam's tip edge is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 500, y: -100 }, { x: 500, y: 100 }, lineGeometry);
  assert.equal(hit, true);
});

// ── cone (fan) shape ───────────────────────────────────────────────
// origin (0,0), aim along +x, radius 5 cells (500px), 60° angle (±30° half).
const coneGeometry = buildShapeGeometry(
  normalizeShapeConfig({ type: "cone", length: 5, angle: 60 }),
  ORIGIN,
  0,
  GRID_SIZE,
);

test("cone: wall fully inside the sector (no edge crossing) is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 200, y: -10 }, { x: 200, y: 10 }, coneGeometry);
  assert.equal(hit, true);
});

test("cone: wall crossing a radial edge is detected", () => {
  // at x=100 the +30° edge sits at y = 100*tan(30°) ≈ 57.7 — this segment starts
  // inside the sector and ends well outside it, crossing that edge.
  const hit = segmentIntersectsShapeGeometry({ x: 100, y: 0 }, { x: 100, y: 200 }, coneGeometry);
  assert.equal(hit, true);
});

test("cone: wall entirely outside the sector is a miss", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 200, y: 300 }, { x: 200, y: 320 }, coneGeometry);
  assert.equal(hit, false);
});

test("cone: wall beyond the radius is a miss", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 600, y: -10 }, { x: 600, y: 10 }, coneGeometry);
  assert.equal(hit, false);
});

// ── circle shape (косой/навесной) ──────────────────────────────────
// center (0,0), radius 3 cells (300px).
const circleGeometry = buildShapeGeometry(
  normalizeShapeConfig({ type: "circle", radius: 3 }),
  ORIGIN,
  ORIGIN,
  GRID_SIZE,
);

test("circle: wall crossing through the center is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: -400, y: 0 }, { x: 400, y: 0 }, circleGeometry);
  assert.equal(hit, true);
});

test("circle: wall fully inside is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: -50, y: -50 }, { x: 50, y: 50 }, circleGeometry);
  assert.equal(hit, true);
});

test("circle: wall outside the radius is a miss", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 1000, y: -50 }, { x: 1000, y: 50 }, circleGeometry);
  assert.equal(hit, false);
});

test("circle: wall exactly tangent to the boundary is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 300, y: -50 }, { x: 300, y: 50 }, circleGeometry);
  assert.equal(hit, true);
});

// ── square shape (косой/навесной) ──────────────────────────────────
// center (0,0), size 4 cells (400px) — spans x:[-200,200], y:[-200,200].
const squareGeometry = buildShapeGeometry(
  normalizeShapeConfig({ type: "square", size: 4 }),
  ORIGIN,
  ORIGIN,
  GRID_SIZE,
);

test("square: wall crossing two opposite edges is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 0, y: -300 }, { x: 0, y: 300 }, squareGeometry);
  assert.equal(hit, true);
});

test("square: wall fully inside is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: -50, y: -50 }, { x: 50, y: 50 }, squareGeometry);
  assert.equal(hit, true);
});

test("square: wall outside is a miss", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 500, y: -50 }, { x: 500, y: 50 }, squareGeometry);
  assert.equal(hit, false);
});

test("square: wall exactly touching an edge is detected", () => {
  const hit = segmentIntersectsShapeGeometry({ x: 200, y: -300 }, { x: 200, y: 300 }, squareGeometry);
  assert.equal(hit, true);
});
