import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEIGHT_GAP_ZERO_M, HEIGHT_BANDS, DAMAGE_TIER, aimHeightDamageTier, heightBandForZ,
} from "../module/combat/aim-height-damage.mjs";

// Standard 2 m body on flat ground (floorZ 0..2) for most cases below.
const body = { floorZ: 0, heightM: 2 };
// A single giant band spanning everything — isolates the pure gap formula from the
// cross-band cutoff, same purpose the old flyingZoneM:Infinity override served.
const ONE_BAND = [{ id: "all", max: Infinity }];

test("aimHeightDamageTier — Target Z inside the body span is full", () => {
  assert.equal(aimHeightDamageTier({ targetZ: 0 }, body).tier, DAMAGE_TIER.FULL);
  assert.equal(aimHeightDamageTier({ targetZ: 1 }, body).tier, DAMAGE_TIER.FULL);
  assert.equal(aimHeightDamageTier({ targetZ: 2 }, body).tier, DAMAGE_TIER.FULL);
});

test("aimHeightDamageTier — symmetric: same gap above or below gives the same tier", () => {
  // topZ = 2, floorZ = 0 — a gap of 3 m either direction should read identically. Both ends
  // (targetZ 5 and -3) still fall in the "ground" band (max 6), so this stays a same-band case.
  const above = aimHeightDamageTier({ targetZ: 2 + 3 }, body);
  const below = aimHeightDamageTier({ targetZ: 0 - 3 }, body);
  assert.equal(above.tier, DAMAGE_TIER.HALF);
  assert.equal(below.tier, DAMAGE_TIER.HALF);
  assert.equal(above.multiplier, below.multiplier);
});

test("aimHeightDamageTier — gap at exactly the default HEIGHT_GAP_ZERO_M is still half, past it is zero", () => {
  // Isolated to ONE_BAND so the cross-band cutoff (ground's max is only 6) doesn't fire before
  // the gap ever reaches HEIGHT_GAP_ZERO_M (10) — this test is purely about the gap formula.
  const atThreshold = aimHeightDamageTier({ targetZ: 2 + HEIGHT_GAP_ZERO_M }, body, undefined, ONE_BAND);
  assert.equal(atThreshold.tier, DAMAGE_TIER.HALF);
  const pastThreshold = aimHeightDamageTier({ targetZ: 2 + HEIGHT_GAP_ZERO_M + 0.1 }, body, undefined, ONE_BAND);
  assert.equal(pastThreshold.tier, DAMAGE_TIER.ZERO);
  assert.equal(pastThreshold.multiplier, 0);

  const belowThreshold = aimHeightDamageTier({ targetZ: 0 - HEIGHT_GAP_ZERO_M }, body, undefined, ONE_BAND);
  assert.equal(belowThreshold.tier, DAMAGE_TIER.HALF);
  const pastBelow = aimHeightDamageTier({ targetZ: 0 - HEIGHT_GAP_ZERO_M - 0.1 }, body, undefined, ONE_BAND);
  assert.equal(pastBelow.tier, DAMAGE_TIER.ZERO);
});

test("aimHeightDamageTier — a custom (melee, weapon-length-based) gapZeroM tightens the falloff", () => {
  // A dagger's half-length (0.25m) as the zero-threshold — much tighter than ranged's 10m.
  // All targetZ values here stay under 6 (the ground band's max), so no band interference.
  const daggerGap = 0.25;
  const justInside = aimHeightDamageTier({ targetZ: 2 + 0.2 }, body, daggerGap);
  assert.equal(justInside.tier, DAMAGE_TIER.HALF);
  const justOutside = aimHeightDamageTier({ targetZ: 2 + 0.3 }, body, daggerGap);
  assert.equal(justOutside.tier, DAMAGE_TIER.ZERO);
  // Same absolute mismatch (3m) that reads HALF for ranged (10m gap) is ZERO for a dagger.
  assert.equal(aimHeightDamageTier({ targetZ: 2 + 3 }, body, daggerGap).tier, DAMAGE_TIER.ZERO);
});

test("heightBandForZ — default three bands (2026-08-17 GM redesign)", () => {
  assert.equal(heightBandForZ(0).id, "ground");
  assert.equal(heightBandForZ(6).id, "ground");       // boundary is inclusive on the low side
  assert.equal(heightBandForZ(6.1).id, "lowFlight");
  assert.equal(heightBandForZ(12).id, "lowFlight");
  assert.equal(heightBandForZ(12.1).id, "highFlight");
  assert.equal(heightBandForZ(18).id, "highFlight");
  assert.equal(heightBandForZ(18.1), null);           // above every defined band
  assert.equal(heightBandForZ(-50).id, "ground");      // ground's max-based lookup catches negatives too
});

test("aimHeightDamageTier — crossing a band boundary is a hard zero, even with a tiny raw gap", () => {
  // Разбойник repro (2026-08-17): aim at 1m (ground), target standing at floorZ 10 (lowFlight).
  // Raw gap would be 9m — under HEIGHT_GAP_ZERO_M (10) — so without band-gating this read HALF.
  const highTarget = aimHeightDamageTier({ targetZ: 1, attackType: "ranged", canHitLowFlight: true }, { floorZ: 10, heightM: 2 });
  assert.equal(highTarget.tier, DAMAGE_TIER.ZERO);

  // Just below the ground/lowFlight boundary on both sides — same band, gap formula applies.
  const sameBand = aimHeightDamageTier({ targetZ: 5 }, { floorZ: 6, heightM: 2 }); // gap 1
  assert.equal(sameBand.tier, DAMAGE_TIER.HALF);

  // onTarget still wins first — aiming directly at a target's own body is a full hit
  // regardless of which band either edge nominally rounds to.
  const bothHigh = aimHeightDamageTier({ targetZ: 11, attackType: "ranged", canHitLowFlight: true }, { floorZ: 10, heightM: 2 });
  assert.equal(bothHigh.tier, DAMAGE_TIER.FULL);
});

test("aimHeightDamageTier — ranged needs an explicit per-weapon flag to touch a non-ground band at all", () => {
  const flyer = { floorZ: 8, heightM: 2 }; // lowFlight
  // No flag at all — hard zero even aimed dead-on (onTarget doesn't rescue it: the weapon has
  // no way to reach a flying target in the first place, not "aimed slightly wrong").
  assert.equal(aimHeightDamageTier({ targetZ: 9, attackType: "ranged" }, flyer).tier, DAMAGE_TIER.ZERO);
  assert.equal(aimHeightDamageTier({ targetZ: 9, attackType: "ranged", canHitHighFlight: true }, flyer).tier, DAMAGE_TIER.ZERO); // wrong flag
  // Right flag — normal onTarget/gap rules resume.
  assert.equal(aimHeightDamageTier({ targetZ: 9, attackType: "ranged", canHitLowFlight: true }, flyer).tier, DAMAGE_TIER.FULL);

  // Melee is never gated by these flags — two things already sharing a non-ground band fight
  // normally (e.g. two flyers grappling at the same altitude).
  assert.equal(aimHeightDamageTier({ targetZ: 9, attackType: "melee" }, flyer).tier, DAMAGE_TIER.FULL);

  // The ground band never needs a flag.
  assert.equal(aimHeightDamageTier({ targetZ: 1, attackType: "ranged" }, body).tier, DAMAGE_TIER.FULL);
});

test("aimHeightDamageTier — a target above every defined band is unreachable regardless of flags", () => {
  const skyHigh = { floorZ: 25, heightM: 2 }; // past HEIGHT_BANDS' highest max (18)
  assert.equal(
    aimHeightDamageTier({ targetZ: 15, attackType: "ranged", canHitHighFlight: true }, skyHigh).tier,
    DAMAGE_TIER.ZERO,
  );
});
