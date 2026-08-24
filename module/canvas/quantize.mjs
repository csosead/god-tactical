/**
 * GOD Tactical — Quantization primitives
 * Pure functions, no Foundry deps (testable with plain Node — see
 * geometry-core.mjs's header for the same convention). Kills the v14
 * sub-pixel/float noise on CONTINUOUS values read from live Foundry state
 * (a token's live pixel center, a token/region's elevation) by snapping them
 * to the nearest half-unit before anything downstream (state.mjs) touches
 * them.
 *
 * NOT for integer cell INDICES — template-geometry.mjs's worldToGrid/
 * gridToWorld ("which cell does this point fall in", via
 * canvas.grid.getOffset) are already discrete and need no quantization; the
 * float-drift problem this file solves only affects continuous positions/
 * elevations, never cell indices.
 */

import { cellsToMeters, metersToCells } from "../config.mjs";

/** Round-to-nearest-0.5 primitive — every other export here reduces to this. */
export function quantizeHalf(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 2) / 2 || 0; // the `|| 0` folds a -0 result back to plain 0
}

/** Elevation in metres → nearest 0.5 m, via the SAME whole-cell round-trip
 *  cellsToMeters/metersToCells already use for every other stored quantity
 *  (config.mjs's METERS_PER_CELL = 0.5) — one source of truth for the 0.5
 *  constant, not a second copy of it. */
export function quantizeElevationMeters(metersRaw) {
  const v = Number(metersRaw);
  return Number.isFinite(v) ? cellsToMeters(metersToCells(v)) : 0;
}

/** Same as quantizeElevationMeters but preserves the "null/undefined =
 *  unbounded" convention Region elevation and template-3d.mjs's
 *  resolveTargetElevation both rely on, instead of coercing a missing
 *  top/bottom to 0. */
export function quantizeElevationMetersOrNull(metersRaw) {
  if (metersRaw === null || metersRaw === undefined) return null;
  return quantizeElevationMeters(metersRaw);
}

/** A continuous world PIXEL point → quantized CONTINUOUS cell-space point
 *  (col/row as fractional cell counts, snapped to the nearest half-cell) —
 *  NOT the integer cell INDEX worldToGrid returns, a different concept (see
 *  file header). gridSizeX/Y are passed in, not read from canvas.grid, so
 *  this stays pixel-and-grid-agnostic. */
export function worldToQuantizedCellPoint(worldX, worldY, gridSizeX, gridSizeY) {
  return {
    col: quantizeHalf(worldX / (gridSizeX || 1)),
    row: quantizeHalf(worldY / (gridSizeY || 1)),
  };
}

/** Inverse of worldToQuantizedCellPoint, for callers that need pixels back. */
export function quantizedCellPointToWorld(colQ, rowQ, gridSizeX, gridSizeY) {
  return { x: colQ * (gridSizeX || 1), y: rowQ * (gridSizeY || 1) };
}
