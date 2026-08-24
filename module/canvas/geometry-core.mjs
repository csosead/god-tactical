/**
 * GOD Tactical — Geometry Core
 * Pure shape math for attack-template coverage. No Foundry globals
 * (canvas/game/Hooks/PIXI) — everything takes gridSize/points explicitly,
 * so this module is testable with plain Node.
 *
 * Coverage rule: a cell is covered iff its center lies inside the shape,
 * with the boundary included via an epsilon = EPSILON_RATIO * gridSize.
 */

export const EPSILON_RATIO = 0.01;
export const DEFAULT_ARC_STEP_DEG = 5;

export const SHAPE_DEFAULTS = {
  line:      { width: 1.2, excludeCaster: true },
  wide_line: { width: 2.0, excludeCaster: true },
  cone:      { angle: 60, excludeCaster: true, arcStepDeg: DEFAULT_ARC_STEP_DEG },
  circle:    { excludeCaster: false, snap: "auto" },
  square:    { excludeCaster: false, snap: "auto" },
};

/** Merge a shapeConfig with its type's defaults. */
export function normalizeShapeConfig(shapeConfig) {
  const defaults = SHAPE_DEFAULTS[shapeConfig?.type];
  if (!defaults) throw new Error(`geometry-core: unknown shape type "${shapeConfig?.type}"`);
  return { ...defaults, ...shapeConfig };
}

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Resolve a continuous aim direction. `aim` may be:
 *  - a plain number (radians),
 *  - an object `{ angle }` (radians),
 *  - a ground point `{ x, y }` (angle derived via atan2 from origin).
 * No discretization to compass directions.
 */
export function resolveAimAngle(origin, aim) {
  if (typeof aim === "number") return aim;
  if (typeof aim?.angle === "number") return aim.angle;
  return Math.atan2(aim.y - origin.y, aim.x - origin.x);
}

/**
 * Convex polygon point test, epsilon-inclusive, winding-order agnostic.
 *
 * Strict containment (epsilon = 0) is a standard half-plane test per edge,
 * with the "inside" side calibrated against the polygon's centroid (a
 * known-interior reference) so the caller's vertex order (CW vs CCW) never
 * matters. A point that fails strict containment is still counted as
 * covered if it lies within `epsilon` of the polygon's boundary — measured
 * as distance to the nearest EDGE SEGMENT (clamped to each edge's endpoints),
 * not the infinite line through it. Using the infinite line here would let
 * the epsilon tolerance "leak" through a sharp vertex: near a thin sliver
 * (e.g. a cone fan triangle's apex at the origin), a point on the *opposite*
 * side of the vertex can be numerically close to an edge's infinite line
 * even though it is nowhere near the actual boundary — clamping to the
 * segment rejects that case correctly.
 */
export function isPointInConvexPolygon(point, vertices, epsilon = 0) {
  const n = vertices.length;
  if (n < 3) return false;

  let cx = 0, cy = 0;
  for (const v of vertices) { cx += v.x; cy += v.y; }
  cx /= n; cy /= n;

  let strictlyInside = true;
  let minBoundaryDist = Infinity;

  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y;
    const edgeLenSq = ex * ex + ey * ey || 1e-18;
    const edgeLen = Math.sqrt(edgeLenSq);

    const crossPoint    = ex * (point.y - a.y) - ey * (point.x - a.x);
    const crossCentroid = ex * (cy - a.y)      - ey * (cx - a.x);
    const sign = crossCentroid >= 0 ? 1 : -1;
    const signedDist = (crossPoint * sign) / edgeLen;
    if (signedDist < 0) strictlyInside = false;

    const t = Math.max(0, Math.min(1, ((point.x - a.x) * ex + (point.y - a.y) * ey) / edgeLenSq));
    const projX = a.x + t * ex, projY = a.y + t * ey;
    const segDist = Math.hypot(point.x - projX, point.y - projY);
    if (segDist < minBoundaryDist) minBoundaryDist = segDist;
  }

  if (strictlyInside) return true;
  return minBoundaryDist <= epsilon;
}

/** 4 vertices of the rotated rectangle used by "line"/"wide_line": origin is a corner-anchor. */
export function buildLineRectVertices(origin, angleRad, length, width) {
  const hw = width / 2;
  const ux = Math.cos(angleRad), uy = Math.sin(angleRad);
  const nx = -uy, ny = ux;
  return [
    { x: origin.x + nx * hw,             y: origin.y + ny * hw },
    { x: origin.x + ux * length + nx * hw, y: origin.y + uy * length + ny * hw },
    { x: origin.x + ux * length - nx * hw, y: origin.y + uy * length - ny * hw },
    { x: origin.x - nx * hw,             y: origin.y - ny * hw },
  ];
}

/** Arc vertices (vertex at origin excluded) for a cone sector, step <= arcStepDeg. */
export function buildConeArc(origin, angleRad, radius, halfAngleRad, arcStepDeg = DEFAULT_ARC_STEP_DEG) {
  const maxStep = toRad(arcStepDeg);
  const steps = Math.max(1, Math.ceil((2 * halfAngleRad) / maxStep));
  const verts = [];
  for (let i = 0; i <= steps; i++) {
    const a = angleRad - halfAngleRad + (2 * halfAngleRad) * (i / steps);
    verts.push({ x: origin.x + Math.cos(a) * radius, y: origin.y + Math.sin(a) * radius });
  }
  return verts;
}

/** Point-in-cone test via a fan of triangles (origin, arc[i], arc[i+1]), each tested through the generic convex-polygon primitive. */
export function isPointInConeFan(point, origin, arcVertices, epsilon, radius) {
  if (Math.hypot(point.x - origin.x, point.y - origin.y) > radius + epsilon) return false;
  for (let i = 0; i < arcVertices.length - 1; i++) {
    if (isPointInConvexPolygon(point, [origin, arcVertices[i], arcVertices[i + 1]], epsilon)) return true;
  }
  return false;
}

export function isPointInCircle(point, center, radius, epsilon = 0) {
  return Math.hypot(point.x - center.x, point.y - center.y) <= radius + epsilon;
}

export function isPointInAxisSquare(point, center, halfSize, epsilon = 0) {
  return Math.abs(point.x - center.x) <= halfSize + epsilon
      && Math.abs(point.y - center.y) <= halfSize + epsilon;
}

/**
 * Decide whether a targetable shape's center should snap to a cell CENTER
 * or a grid VERTEX, based on the parity of its covered size in cells
 * (diameter for circle, side length for square). Odd -> center, even -> vertex.
 * Fractional sizes are rounded before the parity check. An explicit
 * "center"/"vertex" mode always wins over the parity rule.
 */
export function resolveSnapMode(sizeInCells, explicitMode = "auto") {
  if (explicitMode === "center" || explicitMode === "vertex") return explicitMode;
  const rounded = Math.round(sizeInCells);
  return Math.abs(rounded) % 2 === 0 ? "vertex" : "center";
}

/** Build a testable geometry descriptor for a normalized shapeConfig. `aimOrTarget` is an angle/point for directional shapes, or the (already snapped) target point for circle/square. */
export function buildShapeGeometry(shapeConfig, origin, aimOrTarget, gridSize) {
  switch (shapeConfig.type) {
    case "line":
    case "wide_line": {
      const angle = resolveAimAngle(origin, aimOrTarget);
      const vertices = buildLineRectVertices(origin, angle, shapeConfig.length * gridSize, shapeConfig.width * gridSize);
      return { kind: "polygon", vertices };
    }
    case "cone": {
      const angle = resolveAimAngle(origin, aimOrTarget);
      const radius = shapeConfig.length * gridSize;
      const halfAngle = toRad(shapeConfig.angle / 2);
      const arc = buildConeArc(origin, angle, radius, halfAngle, shapeConfig.arcStepDeg);
      return { kind: "fan", origin, arc, radius };
    }
    case "circle":
      return { kind: "circle", center: aimOrTarget, radius: shapeConfig.radius * gridSize };
    case "square":
      return { kind: "square", center: aimOrTarget, halfSize: (shapeConfig.size * gridSize) / 2 };
    default:
      throw new Error(`geometry-core: unknown shape type "${shapeConfig.type}"`);
  }
}

/** Test a point against a geometry descriptor produced by buildShapeGeometry. */
export function isPointInShapeGeometry(point, geometry, epsilon) {
  switch (geometry.kind) {
    case "polygon": return isPointInConvexPolygon(point, geometry.vertices, epsilon);
    case "fan":     return isPointInConeFan(point, geometry.origin, geometry.arc, epsilon, geometry.radius);
    case "circle":  return isPointInCircle(point, geometry.center, geometry.radius, epsilon);
    case "square":  return isPointInAxisSquare(point, geometry.center, geometry.halfSize, epsilon);
    default:        return false;
  }
}

/** Signed area*2 of triangle (a,b,c) — cross product of (b-a) and (c-a). */
function _cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** True iff c lies within the axis-aligned bounding box of segment a-b. Only meaningful
 *  when a, b, c are already known collinear (the caller of this helper always checks that). */
function _onSegment(a, b, c) {
  return Math.min(a.x, b.x) <= c.x && c.x <= Math.max(a.x, b.x)
      && Math.min(a.y, b.y) <= c.y && c.y <= Math.max(a.y, b.y);
}

/**
 * Standard orientation-based segment/segment intersection test (touching endpoints
 * count as an intersection). Used to test a cover-wall segment against a настильный
 * template's own boundary edges — see segmentIntersectsShapeGeometry.
 */
export function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = _cross(p3, p4, p1);
  const d2 = _cross(p3, p4, p2);
  const d3 = _cross(p1, p2, p3);
  const d4 = _cross(p1, p2, p4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }

  if (d1 === 0 && _onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && _onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && _onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && _onSegment(p1, p2, p4)) return true;

  return false;
}

/** Shared by "polygon" (line/wide_line) and "square" (just 4 corner points) below:
 *  does segA-segB cross any edge of this vertex loop, or lie (partly) inside it? */
function _segmentIntersectsPolygonVertices(segA, segB, vertices) {
  for (let i = 0; i < vertices.length; i++) {
    if (segmentsIntersect(segA, segB, vertices[i], vertices[(i + 1) % vertices.length])) return true;
  }
  // Neither endpoint crossed an edge — still counts if the wall sits fully inside.
  return isPointInConvexPolygon(segA, vertices, 0) || isPointInConvexPolygon(segB, vertices, 0);
}

/** Closest-point-on-segment-to-center distance test, clamped to the segment (not the
 *  infinite line through it) — standard projection-then-clamp formula. */
function _segmentIntersectsCircle(segA, segB, center, radius) {
  const dx = segB.x - segA.x, dy = segB.y - segA.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((center.x - segA.x) * dx + (center.y - segA.y) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const closestX = segA.x + t * dx, closestY = segA.y + t * dy;
  return Math.hypot(closestX - center.x, closestY - center.y) <= radius;
}

/**
 * Does segment segA-segB (e.g. a cover-wall's endpoints) cross a template shape's
 * boundary, or lie (partly) inside it? All four geometry kinds are handled —
 * "polygon"/"fan" for настильный (line/wide_line/cone), "circle"/"square" for
 * косой/навесной (see items.mjs's Настильный/Навесной doc comment).
 */
export function segmentIntersectsShapeGeometry(segA, segB, geometry) {
  switch (geometry.kind) {
    case "polygon":
      return _segmentIntersectsPolygonVertices(segA, segB, geometry.vertices);
    case "fan": {
      const { origin, arc, radius } = geometry;
      if (segmentsIntersect(segA, segB, origin, arc[0])) return true;
      if (segmentsIntersect(segA, segB, origin, arc[arc.length - 1])) return true;
      for (let i = 0; i < arc.length - 1; i++) {
        if (segmentsIntersect(segA, segB, arc[i], arc[i + 1])) return true;
      }
      return isPointInConeFan(segA, origin, arc, 0, radius) || isPointInConeFan(segB, origin, arc, 0, radius);
    }
    case "circle":
      return _segmentIntersectsCircle(segA, segB, geometry.center, geometry.radius);
    case "square": {
      const { center, halfSize } = geometry;
      const corners = [
        { x: center.x - halfSize, y: center.y - halfSize },
        { x: center.x + halfSize, y: center.y - halfSize },
        { x: center.x + halfSize, y: center.y + halfSize },
        { x: center.x - halfSize, y: center.y + halfSize },
      ];
      return _segmentIntersectsPolygonVertices(segA, segB, corners);
    }
    default:
      return false;
  }
}

/** World-space bounding box of a geometry descriptor, used to limit the candidate-cell scan. */
export function geometryBoundingBox(geometry) {
  if (geometry.kind === "circle") {
    return {
      minX: geometry.center.x - geometry.radius, maxX: geometry.center.x + geometry.radius,
      minY: geometry.center.y - geometry.radius, maxY: geometry.center.y + geometry.radius,
    };
  }
  if (geometry.kind === "square") {
    return {
      minX: geometry.center.x - geometry.halfSize, maxX: geometry.center.x + geometry.halfSize,
      minY: geometry.center.y - geometry.halfSize, maxY: geometry.center.y + geometry.halfSize,
    };
  }
  const points = geometry.kind === "fan" ? [geometry.origin, ...geometry.arc] : geometry.vertices;
  return {
    minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)),
  };
}

/**
 * Movement-path line: a classic Bresenham/DDA staircase, always exactly one
 * cell wide at every step. This intentionally does NOT follow the
 * center-in-shape+epsilon coverage rule used by the AOE shapes above — that
 * rule guarantees no gaps by allowing occasional double-width cells at
 * transitions (fine for an attack beam's hitbox, wrong for a movement path,
 * where "which single cell does the token step through" must be unambiguous).
 * `thin_line` is a distinct tool for a distinct purpose (visualizing a move
 * path), not an AOE shape — it never goes through computeCoverage/
 * buildShapeGeometry, and has no width/excludeCaster/snap concept.
 */
export function thinLineCells(c1, r1, c2, r2) {
  c1 = Math.round(c1); r1 = Math.round(r1);
  c2 = Math.round(c2); r2 = Math.round(r2);
  const cells = [], seen = new Set();
  const add = (c, r) => {
    const k = c + "," + r;
    if (!seen.has(k)) { seen.add(k); cells.push({ col: c, row: r }); }
  };
  let x = c1, y = r1;
  const dx = Math.abs(c2 - c1), dy = Math.abs(r2 - r1);
  const sx = c2 >= c1 ? 1 : -1, sy = r2 >= r1 ? 1 : -1;
  let err = dx - dy;
  add(x, y);
  while (x !== c2 || y !== r2) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    add(x, y);
  }
  return cells;
}

/** Alias map for shape identifiers used by the drawing tool before this rewrite. */
const LEGACY_SHAPE_ALIAS = { thin: "thin_line", wideline: "wide_line", triangle: "cone" };

/** Normalize a possibly-legacy shape type string to its current name. */
export function normalizeShapeType(type) {
  return LEGACY_SHAPE_ALIAS[type] ?? type;
}

/** Straight-line distance check for targetable shapes' declared `range` (in cells). Not yet wired into any UI — available for future weapon-driven presets. */
export function isWithinRange(origin, target, range, gridSize) {
  return Math.hypot(target.x - origin.x, target.y - origin.y) <= range * gridSize;
}

/**
 * Movement cost of a thin-line path, using the alternating diagonal rule:
 * orthogonal steps cost 1, diagonal steps cost 1/2/1/2/... (every SECOND
 * diagonal step in the path costs 2 instead of 1). `cells` must be an
 * ordered, single-step-per-move path (as produced by thinLineCells) —
 * each consecutive pair is expected to be an adjacent cell (dc,dr in [0,1]).
 */
export function pathMovementCost(cells) {
  let cost = 0;
  let diagonalCount = 0;
  for (let i = 1; i < cells.length; i++) {
    const dc = Math.abs(cells[i].col - cells[i - 1].col);
    const dr = Math.abs(cells[i].row - cells[i - 1].row);
    const isDiagonal = dc === 1 && dr === 1;
    if (isDiagonal) {
      diagonalCount++;
      cost += diagonalCount % 2 === 0 ? 2 : 1;
    } else {
      cost += 1;
    }
  }
  return cost;
}
