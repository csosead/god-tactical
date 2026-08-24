import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSnapMode } from "../module/canvas/geometry-core.mjs";

test("even integer size snaps to vertex", () => {
  assert.equal(resolveSnapMode(2), "vertex");
  assert.equal(resolveSnapMode(4), "vertex");
  assert.equal(resolveSnapMode(-2), "vertex");
});

test("odd integer size snaps to center", () => {
  assert.equal(resolveSnapMode(1), "center");
  assert.equal(resolveSnapMode(3), "center");
  assert.equal(resolveSnapMode(5), "center");
});

test("fractional size rounds before the parity check", () => {
  assert.equal(resolveSnapMode(3.4), "center"); // rounds to 3 (odd)
  assert.equal(resolveSnapMode(2.6), "center"); // rounds to 3 (odd)
  assert.equal(resolveSnapMode(4.4), "vertex"); // rounds to 4 (even)
  assert.equal(resolveSnapMode(3.6), "vertex"); // rounds to 4 (even)
});

test("an explicit mode always wins over parity", () => {
  assert.equal(resolveSnapMode(2, "center"), "center");
  assert.equal(resolveSnapMode(1, "vertex"), "vertex");
  assert.equal(resolveSnapMode(4.4, "center"), "center");
});

test("default explicit mode is \"auto\" and defers to parity", () => {
  assert.equal(resolveSnapMode(2, "auto"), "vertex");
  assert.equal(resolveSnapMode(1, "auto"), "center");
});
