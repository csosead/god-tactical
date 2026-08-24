import { test } from "node:test";
import assert from "node:assert/strict";
import { isPointInConvexPolygon } from "../module/canvas/geometry-core.mjs";

const SQUARE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];
const SQUARE_REVERSED = [...SQUARE].reverse();

test("point well inside is covered", () => {
  assert.equal(isPointInConvexPolygon({ x: 5, y: 5 }, SQUARE, 0.1), true);
});

test("point well outside is not covered", () => {
  assert.equal(isPointInConvexPolygon({ x: 50, y: 50 }, SQUARE, 0.1), false);
});

test("point exactly on the epsilon boundary is included", () => {
  const eps = 0.1;
  assert.equal(isPointInConvexPolygon({ x: -eps, y: 5 }, SQUARE, eps), true);
});

test("point just past the epsilon boundary is excluded", () => {
  const eps = 0.1;
  assert.equal(isPointInConvexPolygon({ x: -eps - 1e-6, y: 5 }, SQUARE, eps), false);
});

test("point exactly on the edge (epsilon = 0) is included", () => {
  assert.equal(isPointInConvexPolygon({ x: 0, y: 5 }, SQUARE, 0), true);
});

test("degenerate polygon (fewer than 3 vertices) is never covered", () => {
  assert.equal(isPointInConvexPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 1), false);
  assert.equal(isPointInConvexPolygon({ x: 0, y: 0 }, [], 1), false);
});

test("winding order does not affect the result", () => {
  const p = { x: 5, y: 5 };
  assert.equal(
    isPointInConvexPolygon(p, SQUARE, 0.1),
    isPointInConvexPolygon(p, SQUARE_REVERSED, 0.1),
  );
  const outside = { x: 50, y: 50 };
  assert.equal(
    isPointInConvexPolygon(outside, SQUARE, 0.1),
    isPointInConvexPolygon(outside, SQUARE_REVERSED, 0.1),
  );
});
