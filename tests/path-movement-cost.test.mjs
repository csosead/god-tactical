import { test } from "node:test";
import assert from "node:assert/strict";
import { thinLineCells, pathMovementCost } from "../module/canvas/geometry-core.mjs";

test("pure orthogonal path costs 1 per step", () => {
  const cells = thinLineCells(0, 0, 5, 0); // 5 orthogonal steps
  assert.equal(pathMovementCost(cells), 5);
});

test("alternating diagonal rule: diagonal steps cost 1,2,1,2,...", () => {
  const cells = [
    { col: 0, row: 0 },
    { col: 1, row: 1 }, // 1st diagonal -> 1
    { col: 2, row: 2 }, // 2nd diagonal -> 2
    { col: 3, row: 3 }, // 3rd diagonal -> 1
    { col: 4, row: 4 }, // 4th diagonal -> 2
  ];
  // 1 + 2 + 1 + 2 = 6
  assert.equal(pathMovementCost(cells), 6);
});

test("mixing orthogonal and diagonal steps only advances the diagonal counter on diagonal moves", () => {
  const cells = [
    { col: 0, row: 0 },
    { col: 1, row: 1 }, // 1st diagonal -> 1
    { col: 2, row: 1 }, // orthogonal -> 1
    { col: 3, row: 2 }, // 2nd diagonal -> 2
    { col: 4, row: 2 }, // orthogonal -> 1
    { col: 5, row: 3 }, // 3rd diagonal -> 1
  ];
  // 1 + 1 + 2 + 1 + 1 = 6
  assert.equal(pathMovementCost(cells), 6);
});

test("single-cell path (no movement) costs 0", () => {
  assert.equal(pathMovementCost([{ col: 4, row: 4 }]), 0);
  assert.equal(pathMovementCost([]), 0);
});

test("a long pure-diagonal line matches the 1-2-1-2 sum, not a flat 1 or 2 per step", () => {
  const cells = thinLineCells(0, 0, 8, 8); // 8 diagonal steps
  // steps 1..8 costs: 1,2,1,2,1,2,1,2 = 12
  assert.equal(pathMovementCost(cells), 12);
  assert.notEqual(pathMovementCost(cells), 8);  // not "1 per diagonal step"
  assert.notEqual(pathMovementCost(cells), 16); // not "2 per diagonal step"
});
