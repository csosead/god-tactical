import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTCOME_TIER, combineAttackOutcome, applyOutcomeTier } from "../module/combat/attack-outcome.mjs";

test("combineAttackOutcome — no factors active is full", () => {
  assert.equal(combineAttackOutcome({ coverLevel: "none", heightTier: null, hearNotSee: false }), OUTCOME_TIER.FULL);
  assert.equal(combineAttackOutcome({ coverLevel: "none", heightTier: "full", hearNotSee: false }), OUTCOME_TIER.FULL);
});

test("combineAttackOutcome — hard zero overrides: full cover, or a zero height tier", () => {
  assert.equal(combineAttackOutcome({ coverLevel: "full", heightTier: null, hearNotSee: false }), OUTCOME_TIER.ZERO);
  assert.equal(combineAttackOutcome({ coverLevel: "none", heightTier: "zero", hearNotSee: false }), OUTCOME_TIER.ZERO);
  // Full cover wins even if nothing else applies.
  assert.equal(combineAttackOutcome({ coverLevel: "full", heightTier: "full", hearNotSee: false }), OUTCOME_TIER.ZERO);
});

test("combineAttackOutcome — exactly one half-factor is half, any two is quarter", () => {
  assert.equal(combineAttackOutcome({ coverLevel: "half", heightTier: null, hearNotSee: false }), OUTCOME_TIER.HALF);
  assert.equal(combineAttackOutcome({ coverLevel: "none", heightTier: "half", hearNotSee: false }), OUTCOME_TIER.HALF);
  assert.equal(combineAttackOutcome({ coverLevel: "none", heightTier: null, hearNotSee: true }), OUTCOME_TIER.HALF);

  assert.equal(combineAttackOutcome({ coverLevel: "half", heightTier: "half", hearNotSee: false }), OUTCOME_TIER.QUARTER);
  assert.equal(combineAttackOutcome({ coverLevel: "half", heightTier: null, hearNotSee: true }), OUTCOME_TIER.QUARTER);
  assert.equal(combineAttackOutcome({ coverLevel: "none", heightTier: "half", hearNotSee: true }), OUTCOME_TIER.QUARTER);
});

test("combineAttackOutcome — all three half-factors together is a clean zero, not an eighth", () => {
  assert.equal(combineAttackOutcome({ coverLevel: "half", heightTier: "half", hearNotSee: true }), OUTCOME_TIER.ZERO);
});

test("applyOutcomeTier — multipliers and flooring", () => {
  assert.equal(applyOutcomeTier(10, OUTCOME_TIER.FULL), 10);
  assert.equal(applyOutcomeTier(5, OUTCOME_TIER.HALF), 2); // floor(2.5)
  assert.equal(applyOutcomeTier(1, OUTCOME_TIER.HALF), 1); // floored up to min 1
  assert.equal(applyOutcomeTier(10, OUTCOME_TIER.QUARTER), 2); // floor(2.5)
  assert.equal(applyOutcomeTier(10, OUTCOME_TIER.ZERO), 0);
});
