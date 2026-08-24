import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quantizeHalf,
  quantizeElevationMeters,
  quantizeElevationMetersOrNull,
  worldToQuantizedCellPoint,
  quantizedCellPointToWorld,
} from "../module/canvas/quantize.mjs";

test("quantizeHalf: rounds to the nearest 0.5", () => {
  assert.equal(quantizeHalf(2.26), 2.5);
  assert.equal(quantizeHalf(2.24), 2);
  assert.equal(quantizeHalf(-0.24), 0);
  assert.equal(quantizeHalf(-0.26), -0.5);
});

test("quantizeHalf: absorbs v14-style float noise around whole/half values", () => {
  assert.equal(quantizeHalf(2.9999999997), 3);
  assert.equal(quantizeHalf(3.0000000003), 3);
  assert.equal(quantizeHalf(2.5000000001), 2.5);
});

test("quantizeHalf: non-finite input is treated as 0", () => {
  assert.equal(quantizeHalf(NaN), 0);
  assert.equal(quantizeHalf(undefined), 0);
  assert.equal(quantizeHalf(null), 0);
});

test("quantizeElevationMeters: matches the cellsToMeters(metersToCells(x)) round-trip", () => {
  assert.equal(quantizeElevationMeters(2.3), 2.5);
  assert.equal(quantizeElevationMeters(2.2), 2);
  assert.equal(quantizeElevationMeters(0), 0);
  assert.equal(quantizeElevationMeters(7.9999999998), 8);
});

test("quantizeElevationMetersOrNull: preserves null/undefined as unbounded", () => {
  assert.equal(quantizeElevationMetersOrNull(null), null);
  assert.equal(quantizeElevationMetersOrNull(undefined), null);
  assert.equal(quantizeElevationMetersOrNull(3.26), 3.5);
});

test("worldToQuantizedCellPoint / quantizedCellPointToWorld round-trip on a grid-aligned point", () => {
  const pt = worldToQuantizedCellPoint(250.0000001, 149.9999998, 100, 100);
  assert.equal(pt.col, 2.5);
  assert.equal(pt.row, 1.5);
  const back = quantizedCellPointToWorld(pt.col, pt.row, 100, 100);
  assert.equal(back.x, 250);
  assert.equal(back.y, 150);
});

test("worldToQuantizedCellPoint: degenerate zero grid size falls back to 1px cells instead of dividing by zero", () => {
  const pt = worldToQuantizedCellPoint(3, 4, 0, 0);
  assert.equal(pt.col, 3);
  assert.equal(pt.row, 4);
});
