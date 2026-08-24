import { test } from "node:test";
import assert from "node:assert/strict";
import { thinLineCells } from "../module/canvas/geometry-core.mjs";

test("thin line is always exactly one cell wide (8-connected chain, no branching)", () => {
  for (const [c1, r1, c2, r2] of [[0, 0, 10, 3], [0, 0, 3, 10], [0, 0, 10, 10], [0, 0, -8, 5], [0, 0, 7, -6]]) {
    const cells = thinLineCells(c1, r1, c2, r2);
    // Consecutive cells must be 8-connected neighbors (a proper staircase, never a jump).
    for (let i = 1; i < cells.length; i++) {
      const dc = Math.abs(cells[i].col - cells[i - 1].col);
      const dr = Math.abs(cells[i].row - cells[i - 1].row);
      assert.ok(dc <= 1 && dr <= 1 && (dc + dr) > 0, `step ${i} is not a single adjacent move: ${JSON.stringify(cells[i - 1])} -> ${JSON.stringify(cells[i])}`);
    }
  }
});

test("thin line includes both endpoints", () => {
  const cells = thinLineCells(2, 3, 9, 1);
  assert.ok(cells.some((c) => c.col === 2 && c.row === 3));
  assert.ok(cells.some((c) => c.col === 9 && c.row === 1));
});

test("thin line has no duplicate cells", () => {
  const cells = thinLineCells(0, 0, 12, 5);
  const keys = cells.map((c) => `${c.col},${c.row}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("thin line on a single point returns just that cell", () => {
  const cells = thinLineCells(4, 4, 4, 4);
  assert.deepEqual(cells, [{ col: 4, row: 4 }]);
});

test("thin line step count matches the dominant axis (classic Bresenham, no supercover extras)", () => {
  const cells = thinLineCells(0, 0, 10, 4);
  // Dominant axis is horizontal (dx=10) — exactly 11 cells (one per column), never doubled.
  assert.equal(cells.length, 11);
});

test("axis-aligned and diagonal lines are perfectly straight", () => {
  const horiz = thinLineCells(0, 0, 5, 0);
  assert.equal(horiz.length, 6);
  assert.ok(horiz.every((c) => c.row === 0));

  const diag = thinLineCells(0, 0, 5, 5);
  assert.equal(diag.length, 6);
  assert.ok(diag.every((c, i) => c.col === i && c.row === i));
});
