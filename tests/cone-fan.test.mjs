import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeShapeConfig,
  buildShapeGeometry,
  isPointInShapeGeometry,
  EPSILON_RATIO,
  toRad,
  DEFAULT_ARC_STEP_DEG,
} from "../module/canvas/geometry-core.mjs";

const GRID_SIZE = 100;
const ORIGIN = { x: 0, y: 0 };
const AIM_ANGLE = toRad(20); // arbitrary, non-axis-aligned aim direction

function analyticConeTest(point, origin, angleRad, radius, halfAngleRad, eps) {
  const dx = point.x - origin.x, dy = point.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist > radius + eps) return false;
  const pointAngle = Math.atan2(dy, dx);
  let diff = Math.abs(pointAngle - angleRad);
  while (diff > Math.PI) diff = 2 * Math.PI - diff;
  return diff <= halfAngleRad;
}

function sagitta(radius, arcStepDeg) {
  return radius * (1 - Math.cos(toRad(arcStepDeg) / 2));
}

for (const angleDeg of [30, 60, 90]) {
  for (const radiusCells of [2, 8, 15, 30]) {
    test(`cone angle=${angleDeg}° radius=${radiusCells} cells matches analytic sector within sagitta tolerance`, () => {
      const cfg = normalizeShapeConfig({ type: "cone", length: radiusCells, angle: angleDeg });
      const geometry = buildShapeGeometry(cfg, ORIGIN, AIM_ANGLE, GRID_SIZE);
      const eps = EPSILON_RATIO * GRID_SIZE;
      const radiusPx = radiusCells * GRID_SIZE;
      const halfAngleRad = toRad(angleDeg / 2);
      const tolerance = sagitta(radiusPx, cfg.arcStepDeg ?? DEFAULT_ARC_STEP_DEG) + eps;

      let mismatches = 0;
      let total = 0;
      const steps = 60;
      for (let ri = 1; ri <= steps; ri++) {
        const r = (ri / steps) * (radiusPx + GRID_SIZE);
        for (let ai = 0; ai < steps; ai++) {
          const a = AIM_ANGLE - Math.PI + (2 * Math.PI) * (ai / steps);
          const point = { x: ORIGIN.x + Math.cos(a) * r, y: ORIGIN.y + Math.sin(a) * r };
          const analytic = analyticConeTest(point, ORIGIN, AIM_ANGLE, radiusPx, halfAngleRad, eps);
          const fan = isPointInShapeGeometry(point, geometry, eps);
          total++;
          if (analytic !== fan) {
            // Mismatches are only acceptable within `tolerance` of either boundary (radius or the two edges).
            const distFromArc = Math.abs(r - radiusPx);
            const pointAngle = Math.atan2(point.y - ORIGIN.y, point.x - ORIGIN.x);
            let angDiff = Math.abs(pointAngle - AIM_ANGLE);
            while (angDiff > Math.PI) angDiff = 2 * Math.PI - angDiff;
            // Perpendicular distance from a radial edge scales with the point's OWN
            // radius (arc length ~= r * angle), not the shape's outer radius.
            const distFromEdge = Math.abs(angDiff - halfAngleRad) * r;
            const nearBoundary = distFromArc <= tolerance || distFromEdge <= tolerance;
            if (!nearBoundary) mismatches++;
          }
        }
      }
      assert.equal(mismatches, 0, `found ${mismatches}/${total} mismatches outside the expected sagitta tolerance band`);
    });
  }
}
