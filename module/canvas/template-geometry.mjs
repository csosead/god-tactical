/**
 * GOD Tactical — Template Geometry
 * Foundry adapter for AOE shapes. Grid-cell math (worldToGrid/gridToWorld)
 * is the only place that talks to canvas.grid; coverage itself is delegated
 * to the pure geometry-core module — computeCoverage() is the single source
 * of truth used by preview, commit, and hit-resolution alike.
 */

import * as GC from "./geometry-core.mjs";

// ── Foundry grid helpers ─────────────────────────────────────────

/** Convert world coordinates to grid cell indices. */
export function worldToGrid(wx, wy) {
  const g = canvas.grid;
  const offset = g.getOffset({ x: wx, y: wy });
  const col = offset.i ?? offset.q ?? 0;
  const row = offset.j ?? offset.r ?? 0;
  return { col, row };
}

/** Grid cell centre in world pixels. */
export function gridToWorld(col, row) {
  const g = canvas.grid;
  const topLeft = g.getTopLeftPoint({ i: col, j: row });
  return {
    x: topLeft.x + g.sizeX / 2,
    y: topLeft.y + g.sizeY / 2,
  };
}

/** Top-left corner of a grid cell in world pixels. */
export function gridToWorldTopLeft(col, row) {
  return canvas.grid.getTopLeftPoint({ i: col, j: row });
}

// ── Coverage ─────────────────────────────────────────────────────

/** Snap a raw world point to the nearest cell center or nearest grid vertex. */
function _snapTargetPoint(rawPoint, mode) {
  const cell = worldToGrid(rawPoint.x, rawPoint.y);
  if (mode === "center") return gridToWorld(cell.col, cell.row);

  const g = canvas.grid;
  const tl = gridToWorldTopLeft(cell.col, cell.row);
  const corners = [
    { x: tl.x, y: tl.y },
    { x: tl.x + g.sizeX, y: tl.y },
    { x: tl.x, y: tl.y + g.sizeY },
    { x: tl.x + g.sizeX, y: tl.y + g.sizeY },
  ];
  return corners.reduce((best, c) =>
    Math.hypot(c.x - rawPoint.x, c.y - rawPoint.y) < Math.hypot(best.x - rawPoint.x, best.y - rawPoint.y) ? c : best
  );
}

/**
 * Resolve the exact shape geometry for a shapeConfig/origin/aim triple,
 * applying the same circle/square target-snapping that computeCoverage
 * uses internally. Exposed so preview outlines are drawn against the
 * IDENTICAL shape used to compute cell coverage (no second source of truth).
 */
export function resolveGeometry(shapeConfig, origin, aim) {
  const gridSize = canvas.grid.sizeX; // square-grid assumption, matches the rest of this codebase
  const cfg = GC.normalizeShapeConfig(shapeConfig);

  let resolvedAim = aim;
  if (cfg.type === "circle" || cfg.type === "square") {
    const sizeInCells = cfg.type === "circle" ? cfg.radius * 2 : cfg.size;
    resolvedAim = _snapTargetPoint(aim, GC.resolveSnapMode(sizeInCells, cfg.snap));
  }

  return GC.buildShapeGeometry(cfg, origin, resolvedAim, gridSize);
}

/**
 * computeCoverage(shapeConfig, origin, aim) -> Set<"col,row">
 *
 * Single source of truth for AOE coverage. `origin` is the attacker's
 * center in world/canvas pixels. `aim` is either an angle/point for
 * directional shapes (line/wide_line/cone) or a ground point for
 * targetable shapes (circle/square, snapped internally). A cell is
 * covered iff its center lies inside the shape, epsilon-inclusive.
 */
export function computeCoverage(shapeConfig, origin, aim) {
  const gridSize = canvas.grid.sizeX;
  const eps = GC.EPSILON_RATIO * gridSize;
  const cfg = GC.normalizeShapeConfig(shapeConfig);
  const geometry = resolveGeometry(shapeConfig, origin, aim);
  const bbox = GC.geometryBoundingBox(geometry);

  const c1 = worldToGrid(bbox.minX - gridSize, bbox.minY - gridSize);
  const c2 = worldToGrid(bbox.maxX + gridSize, bbox.maxY + gridSize);
  const colMin = Math.min(c1.col, c2.col), colMax = Math.max(c1.col, c2.col);
  const rowMin = Math.min(c1.row, c2.row), rowMax = Math.max(c1.row, c2.row);

  const originCell = worldToGrid(origin.x, origin.y);
  const result = new Set();

  for (let col = colMin; col <= colMax; col++) {
    for (let row = rowMin; row <= rowMax; row++) {
      if (cfg.excludeCaster && col === originCell.col && row === originCell.row) continue;
      const center = gridToWorld(col, row);
      if (GC.isPointInShapeGeometry(center, geometry, eps)) result.add(`${col},${row}`);
    }
  }
  return result;
}

/** Set<"col,row"> -> [{col,row}], for JSON-serializable stroke storage. */
export function coverageToCells(set) {
  return [...set].map((key) => {
    const [col, row] = key.split(",").map(Number);
    return { col, row };
  });
}

export const normalizeShapeType = GC.normalizeShapeType;
export const thinLineCells = GC.thinLineCells;
export const pathMovementCost = GC.pathMovementCost;
export const isWithinRange = GC.isWithinRange;

// ── Foundry-specific helpers ─────────────────────────────────────

/**
 * Compute cells covered by an existing Foundry MeasuredTemplate document.
 * Returns { shape, cells }.
 */
export function getTemplateCells(doc) {
  const shape = doc.t;
  const origin = { x: doc.x, y: doc.y };

  if (shape === "point") {
    const cell = worldToGrid(doc.x, doc.y);
    return { shape, cells: [{ col: cell.col, row: cell.row }] };
  }

  const gridSize = canvas.grid.sizeX;
  const distCells = doc.distance / (canvas.grid.distance || 1);
  const dir = doc.direction ?? 0;
  const rad = Math.toRadians(dir);

  let godShape = shape;
  if (shape === "ray") godShape = "line";
  if (shape === "rect") godShape = "square";

  const shapeConfig = _configForNativeShape(godShape, distCells);
  const aim = godShape === "circle" || godShape === "square"
    ? { x: origin.x + Math.cos(rad) * distCells * gridSize, y: origin.y + Math.sin(rad) * distCells * gridSize }
    : rad;

  const cells = coverageToCells(computeCoverage(shapeConfig, origin, aim));
  return { shape: godShape, cells };
}

function _configForNativeShape(godShape, distCells) {
  switch (godShape) {
    case "line":   return { type: "line", length: distCells, width: 1.2 };
    case "circle": return { type: "circle", radius: distCells };
    case "square": return { type: "square", size: distCells };
    case "cone":   return { type: "cone", length: distCells };
    default:       return { type: "circle", radius: 0.5 };
  }
}

/** Highlight a set of cells on the grid. */
export function highlightCells(cells, name = "god-template", color = 0xff0000, alpha = 0.25) {
  const grid = canvas.interface.grid;
  grid.clearHighlightLayer(name);
  for (const { col, row } of cells) {
    const tl = gridToWorldTopLeft(col, row);
    grid.highlightPosition(name, { x: tl.x, y: tl.y, color, alpha, border: null });
  }
}

/** Clear highlight. */
export function clearHighlight(name = "god-template") {
  canvas.interface.grid?.clearHighlightLayer(name);
}
