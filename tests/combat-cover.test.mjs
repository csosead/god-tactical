import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COVER, coverLevelFromExposure, coverBlocksShot, applyCover, exposureFromPoints, BODY_HEIGHT_BY_SIZE,
} from "../module/combat/combat-cover.mjs";

test("coverLevelFromExposure — cover needs ≥ half the body blocked (4 of 8)", () => {
  assert.equal(coverLevelFromExposure(1),     COVER.NONE); // nothing blocked
  assert.equal(coverLevelFromExposure(0.875), COVER.NONE); // 1 of 8 blocked — tip graze, open shot
  assert.equal(coverLevelFromExposure(0.625), COVER.NONE); // 3 of 8 blocked — still open
  assert.equal(coverLevelFromExposure(0.5),   COVER.HALF); // 4 of 8 blocked — cover begins
  assert.equal(coverLevelFromExposure(0.375), COVER.HALF); // 5 of 8 blocked
  assert.equal(coverLevelFromExposure(0.25),  COVER.FULL); // 6 of 8 blocked — no shot
  assert.equal(coverLevelFromExposure(0),     COVER.FULL); // fully blocked
});

test("coverLevelFromExposure — swarm: no cover under half, else straight to full", () => {
  assert.equal(coverLevelFromExposure(1,    { isSwarm: true }), COVER.NONE);
  assert.equal(coverLevelFromExposure(0.75, { isSwarm: true }), COVER.NONE); // < half blocked → open shot
  assert.equal(coverLevelFromExposure(0.5,  { isSwarm: true }), COVER.FULL); // ≥ half blocked → full
  assert.equal(coverLevelFromExposure(0.25, { isSwarm: true }), COVER.FULL);
});

test("coverLevelFromExposure — clamps garbage input to full (0)", () => {
  assert.equal(coverLevelFromExposure(NaN),       COVER.FULL);
  assert.equal(coverLevelFromExposure(undefined), COVER.FULL);
  assert.equal(coverLevelFromExposure(2),         COVER.NONE); // >1 clamps to 1
  assert.equal(coverLevelFromExposure(-1),        COVER.FULL);
});

test("coverBlocksShot — only full blocks", () => {
  assert.equal(coverBlocksShot(COVER.FULL), true);
  assert.equal(coverBlocksShot(COVER.HALF), false);
  assert.equal(coverBlocksShot(COVER.NONE), false);
});

test("applyCover — none unchanged, half ÷2 down (min 1), full = 0 (no shot)", () => {
  assert.equal(applyCover(7, COVER.NONE), 7);
  assert.equal(applyCover(7, COVER.HALF), 3);  // 3.5 → 3, favours target
  assert.equal(applyCover(4, COVER.HALF), 2);
  assert.equal(applyCover(1, COVER.HALF), 1);  // floor of a landed hit is 1
  assert.equal(applyCover(9, COVER.FULL), 0);  // no shot
});

test("exposureFromPoints — fraction of clear sample points", () => {
  assert.equal(exposureFromPoints([true, true, true, true]), 1);
  assert.equal(exposureFromPoints([true, false, true, false]), 0.5);
  assert.equal(exposureFromPoints([false, false, false, false]), 0);
  assert.equal(exposureFromPoints([]), 0);
  assert.equal(exposureFromPoints(null), 0);
});

test("BODY_HEIGHT_BY_SIZE mirrors the size table (small = 1.5)", () => {
  assert.equal(BODY_HEIGHT_BY_SIZE.swarm, 1);
  assert.equal(BODY_HEIGHT_BY_SIZE.small, 1.5);
  assert.equal(BODY_HEIGHT_BY_SIZE.medium, 2);
  assert.equal(BODY_HEIGHT_BY_SIZE.incrediblyLarge, 6);
});
