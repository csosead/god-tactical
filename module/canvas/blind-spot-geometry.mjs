/**
 * GOD Tactical — Blind Spot Geometry (height-based line of sight)
 * Pure 3D ray-vs-wall math for the "Слепая зона по высоте" check: a
 * parapet/low wall of LIMITED height can block the sightline from a
 * shooter's eye down to a target even though both stand in the open in
 * plan view — the ray clears it or doesn't depending on the shooter's own
 * angle of fire. No Foundry globals (canvas/game/PIXI) — everything takes
 * plain points/segments, so this module is testable with plain Node.
 *
 * Model: the shooter's eye and the target's aim point are two 3D points
 * (x, y, z). The line between them is a single straight ray — its height
 * at any point along the way is a plain linear interpolation between the
 * two ends. A candidate wall is a 2D segment (a, b) tagged with a height
 * band [bottom, top) (the "Wall Height" module's own convention: top
 * defaults to +Infinity, bottom to -Infinity when unset — an untagged
 * Wall Height wall blocks at every height, same as that module treats it).
 * The wall blocks the ray iff its own 2D segment crosses the ray's 2D
 * projection AND the ray's height at that exact crossing point falls
 * inside the wall's band — i.e. the ray passes THROUGH the parapet's
 * silhouette, not over its top edge or under its bottom edge.
 */

/**
 * Parametric intersection of segment A→B with segment C→D, in 2D.
 * Returns `{ t, u, x, y }` — `t` is A→B's own parameter (0 at A, 1 at B),
 * `u` is C→D's — or `null` if the segments are parallel/collinear, or
 * cross outside either segment's own [0,1] range. Touching endpoints
 * (t or u exactly 0 or 1) count as a crossing.
 */
export function intersectSegments(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null; // parallel, or a zero-length segment

  const qpx = c.x - a.x, qpy = c.y - a.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return { t, u, x: a.x + t * rx, y: a.y + t * ry };
}

/** Height of the straight eye→target ray at parameter `t` (0 = eye, 1 =
 *  target) — plain linear interpolation, since a straight 3D line's height
 *  varies linearly with the same `t` its own 2D projection uses. */
export function rayHeightAt(eyeZ, targetZ, t) {
  return eyeZ + (targetZ - eyeZ) * t;
}

/**
 * Does a single wall block the eye→target ray? `wall` = `{ a, b, top,
 * bottom }` (2D endpoints + height band; `top`/`bottom` default to
 * +Infinity/-Infinity, matching an untagged Wall Height wall). Returns
 * `null` if the wall's own segment never crosses the ray's 2D projection at
 * all (irrelevant to this ray); otherwise `{ t, x, y, rayZ, top, bottom,
 * blocked }` — `blocked` is true iff the ray's height at the crossing point
 * falls strictly inside [bottom, top), i.e. the ray threads through the
 * parapet's own silhouette rather than skimming exactly over its top edge
 * or under its bottom edge.
 */
export function testWallAgainstRay(eye, target, wall) {
  const hit = intersectSegments(eye, target, wall.a, wall.b);
  if (!hit) return null;

  const rayZ = rayHeightAt(eye.z, target.z, hit.t);
  const top = wall.top ?? Infinity;
  const bottom = wall.bottom ?? -Infinity;
  const blocked = rayZ < top && rayZ >= bottom;

  return { t: hit.t, x: hit.x, y: hit.y, rayZ, top, bottom, blocked };
}

/**
 * Does segment A→B cross ANY of the given 2D wall segments (`{ a, b }`
 * each)? For ordinary full-height walls, which block regardless of
 * elevation — no height band, just a plain 2D crossing test. Used as the
 * cheap short-circuit ahead of findBlockingWall's 3D walk (see
 * blind-spot.mjs's computeBlindSpot): if any wall here crosses the ray, the
 * sightline is broken outright and the height math never needs to run.
 */
export function crossesAnyWall(a, b, walls) {
  for (const wall of walls) {
    if (intersectSegments(a, b, wall.a, wall.b)) return true;
  }
  return false;
}

/**
 * Walk every candidate wall the ray's 2D projection crosses, NEAREST TO THE
 * SHOOTER first, and return the first one that actually blocks (ray height
 * inside its [bottom, top) band at the crossing point). A wall the ray
 * passes cleanly over — or under — doesn't stop the walk; the next
 * candidate along the ray is still checked, so a low parapet close by that
 * the shooter is firing steeply over doesn't falsely shadow a taller one
 * further along. Returns `null` if no candidate blocks.
 *
 * `walls` — array of `{ a, b, top, bottom, ...anything }`; any extra fields
 * pass through on the returned `wall` untouched, for the caller's own use
 * (e.g. a Foundry wall id).
 */
export function findBlockingWall(eye, target, walls) {
  const hits = [];
  for (const wall of walls) {
    const result = testWallAgainstRay(eye, target, wall);
    if (result) hits.push({ wall, ...result });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits.find((h) => h.blocked) ?? null;
}

/**
 * Even-odd point-in-polygon test across ALL rings of a `polygonTree` (root boundary AND
 * holes together, each a flat `[x0,y0,x1,y1,…]` array under a node's `.points`) — the
 * even-odd rule makes a point inside a hole correctly count as OUTSIDE, no separate hole
 * bookkeeping needed. Pure geometry — `polygonTree` just needs to be an array of `{points}`
 * nodes (a Foundry Region document's own `.polygonTree` satisfies this with no other
 * dependency here, but nothing here reaches for `canvas`/`game` to get it).
 */
export function pointInPolygonTree(polygonTree, x, y) {
  let inside = false;
  for (const node of polygonTree ?? []) {
    const pts = node.points;
    if (!pts || pts.length < 6) continue; // need at least a triangle
    const n = pts.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[i * 2], yi = pts[i * 2 + 1];
      const xj = pts[j * 2], yj = pts[j * 2 + 1];
      const intersects = (yi > y) !== (yj > y)
        && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
  }
  return inside;
}
