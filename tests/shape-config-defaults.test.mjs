import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeShapeConfig, SHAPE_DEFAULTS } from "../module/canvas/geometry-core.mjs";

test("line defaults to width 1.2 and excludeCaster true", () => {
  const cfg = normalizeShapeConfig({ type: "line", length: 8 });
  assert.equal(cfg.width, 1.2);
  assert.equal(cfg.excludeCaster, true);
});

test("wide_line defaults to width 2.0 and excludeCaster true", () => {
  const cfg = normalizeShapeConfig({ type: "wide_line", length: 8 });
  assert.equal(cfg.width, 2.0);
  assert.equal(cfg.excludeCaster, true);
});

test("line and wide_line remain distinct shape types, never collapsing into one", () => {
  assert.notEqual(SHAPE_DEFAULTS.line.width, SHAPE_DEFAULTS.wide_line.width);
  const line = normalizeShapeConfig({ type: "line", length: 8 });
  const wideLine = normalizeShapeConfig({ type: "wide_line", length: 8 });
  assert.equal(line.type, "line");
  assert.equal(wideLine.type, "wide_line");
});

test("cone defaults to angle 60 and excludeCaster true", () => {
  const cfg = normalizeShapeConfig({ type: "cone", length: 4 });
  assert.equal(cfg.angle, 60);
  assert.equal(cfg.excludeCaster, true);
});

test("circle and square default excludeCaster to false and snap to auto", () => {
  const circle = normalizeShapeConfig({ type: "circle", radius: 1.5 });
  const square = normalizeShapeConfig({ type: "square", size: 3 });
  assert.equal(circle.excludeCaster, false);
  assert.equal(circle.snap, "auto");
  assert.equal(square.excludeCaster, false);
  assert.equal(square.snap, "auto");
});

test("explicit fields override defaults", () => {
  const cfg = normalizeShapeConfig({ type: "line", length: 8, width: 3, excludeCaster: false });
  assert.equal(cfg.width, 3);
  assert.equal(cfg.excludeCaster, false);
});

test("unknown shape type throws", () => {
  assert.throws(() => normalizeShapeConfig({ type: "hexagon" }));
});
