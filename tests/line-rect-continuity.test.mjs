import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeShapeConfig,
  buildShapeGeometry,
  isPointInShapeGeometry,
  EPSILON_RATIO,
  toRad,
} from "../module/canvas/geometry-core.mjs";

const GRID_SIZE = 100;
const ORIGIN = { x: GRID_SIZE / 2, y: GRID_SIZE / 2 }; // center of cell (0,0), like a 1x1 token
const LENGTH_CELLS = 10;
const ANGLES_DEG = [0, 15, 30, 45, 60, 90];

function cellCenter(col, row) {
  return { x: (col + 0.5) * GRID_SIZE, y: (row + 0.5) * GRID_SIZE };
}

function scanCoveredCells(geometry, eps, colRange, rowRange) {
  const covered = new Set();
  for (let col = colRange[0]; col <= colRange[1]; col++) {
    for (let row = rowRange[0]; row <= rowRange[1]; row++) {
      if (isPointInShapeGeometry(cellCenter(col, row), geometry, eps)) {
        covered.add(`${col},${row}`);
      }
    }
  }
  return covered;
}

function buildLineGeometry(type, angleDeg) {
  const cfg = normalizeShapeConfig({ type, length: LENGTH_CELLS });
  const angleRad = toRad(angleDeg);
  const geometry = buildShapeGeometry(cfg, ORIGIN, angleRad, GRID_SIZE);
  return { cfg, geometry };
}

/**
 * Group covered cells by their rounded longitudinal projection along the
 * beam axis ("station") — used to measure the corridor's cross-section
 * width at each point along its length.
 */
function stationCounts(covered, origin, angleRad, lengthCells) {
  const ux = Math.cos(angleRad), uy = Math.sin(angleRad);
  const counts = new Map();
  for (const key of covered) {
    const [col, row] = key.split(",").map(Number);
    const c = cellCenter(col, row);
    const proj = ((c.x - origin.x) * ux + (c.y - origin.y) * uy) / GRID_SIZE;
    const station = Math.round(proj);
    if (station < 1 || station > lengthCells - 1) continue; // skip end caps
    counts.set(station, (counts.get(station) ?? 0) + 1);
  }
  return counts;
}

/**
 * "No gaps along the length" means the corridor of covered cells forms a
 * single 8-connected blob (Chebyshev distance 1 — including diagonal,
 * corner-touching neighbors). This is NOT "every unit-length station has a
 * covered cell" — a purely diagonal 1-cell-wide corridor (e.g. at 45°)
 * legitimately advances ~1.41 cells per step while still being visually
 * continuous, since consecutive cells touch at a corner. It's also not a
 * simple "sort by projection and check neighbors" chain — a 2-wide corridor
 * has two parallel columns that must be checked for overall connectivity,
 * not a single linear order (axis-aligned cases can tie in projection).
 */
function assertNoGaps(covered, message) {
  const cells = [...covered].map((key) => key.split(",").map(Number));
  if (cells.length === 0) return;
  const key = (c, r) => `${c},${r}`;
  const remaining = new Set(covered);
  const start = cells[0];
  const queue = [start];
  remaining.delete(key(start[0], start[1]));
  let visited = 1;

  while (queue.length) {
    const [col, row] = queue.pop();
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const k = key(col + dc, row + dr);
        if (remaining.has(k)) {
          remaining.delete(k);
          visited++;
          queue.push([col + dc, row + dr]);
        }
      }
    }
  }

  assert.equal(visited, cells.length, `${message}: covered cells are not a single connected corridor (${cells.length - visited} unreachable)`);
}

for (const type of ["line", "wide_line"]) {
  for (const angleDeg of ANGLES_DEG) {
    test(`${type} at ${angleDeg}° has no gaps along its length`, () => {
      const { cfg, geometry } = buildLineGeometry(type, angleDeg);
      const eps = EPSILON_RATIO * GRID_SIZE;
      const margin = Math.ceil(cfg.width) + 2;
      const covered = scanCoveredCells(
        geometry, eps,
        [-margin, LENGTH_CELLS + margin],
        [-margin, LENGTH_CELLS + margin],
      );
      assertNoGaps(covered, `${type} at ${angleDeg}°`);
    });
  }
}

test("wide_line (width 2.0) reads as a stable 2-cell-wide corridor", () => {
  const { geometry } = buildLineGeometry("wide_line", 30);
  const eps = EPSILON_RATIO * GRID_SIZE;
  const covered = scanCoveredCells(geometry, eps, [-3, LENGTH_CELLS + 3], [-3, LENGTH_CELLS + 3]);
  const counts = [...stationCounts(covered, ORIGIN, toRad(30), LENGTH_CELLS).values()];

  assert.ok(counts.length > 0, "expected interior stations to exist");
  for (const count of counts) {
    assert.ok(count >= 2, `wide_line should cover at least 2 cells per station, got ${count}`);
  }
});

test("line (width 1.2) is single-wide at axis-aligned/diagonal angles, double-wide only occasionally at others", () => {
  // At 0°/45°/90° the corridor lines up perfectly with the grid — always single-wide.
  for (const angleDeg of [0, 45, 90]) {
    const { geometry } = buildLineGeometry("line", angleDeg);
    const eps = EPSILON_RATIO * GRID_SIZE;
    const covered = scanCoveredCells(geometry, eps, [-3, LENGTH_CELLS + 3], [-3, LENGTH_CELLS + 3]);
    const counts = [...stationCounts(covered, ORIGIN, toRad(angleDeg), LENGTH_CELLS).values()];
    assert.ok(counts.length > 0, "expected interior stations to exist");
    assert.ok(counts.every((c) => c === 1), `expected every station single-wide at ${angleDeg}°, got ${counts}`);
  }

  // At in-between angles, double-wide transitions occur but are never constant —
  // there must be at least one single-wide station too.
  for (const angleDeg of [15, 30, 60]) {
    const { geometry } = buildLineGeometry("line", angleDeg);
    const eps = EPSILON_RATIO * GRID_SIZE;
    const covered = scanCoveredCells(geometry, eps, [-3, LENGTH_CELLS + 3], [-3, LENGTH_CELLS + 3]);
    const counts = [...stationCounts(covered, ORIGIN, toRad(angleDeg), LENGTH_CELLS).values()];
    assert.ok(counts.length > 0, "expected interior stations to exist");
    assert.ok(counts.some((c) => c === 1), `expected at least one single-wide station at ${angleDeg}°, got ${counts}`);
  }
});
