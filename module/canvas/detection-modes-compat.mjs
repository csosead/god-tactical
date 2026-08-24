/**
 * GOD Tactical — Detection Modes compat shim
 *
 * Foundry v13 stored `TokenDocument#detectionModes` as an ARRAY of
 * `{id, enabled, range}` objects. v14 restructured it into a plain OBJECT keyed by
 * mode id instead — `{senseAll:{enabled,range}, basicSight:{enabled,range}, ...}`,
 * no `.id` field on the entries (the key IS the id). `Array.prototype.find/filter`
 * calls that used to walk it now throw ("...find is not a function") on v14.
 *
 * Both range-vision.mjs (the real sightRange/testRange libWrapper overrides — actual
 * gameplay, not just display) and range-preview.mjs (the GM-only range-circle
 * overlay) need to iterate "every configured detection mode" without caring which
 * shape core handed back. This is the one normalizer both import, so a future core
 * rename only needs fixing in one place.
 */

/** @returns {{id: string, enabled: boolean, range: number}[]} regardless of whether
 *  `doc.detectionModes` is v13's array or v14's id-keyed object. */
export function detectionModeList(doc) {
  const dm = doc?.detectionModes;
  if (!dm) return [];
  if (Array.isArray(dm)) return dm; // v13 shape: already [{id, enabled, range}, ...]
  return Object.entries(dm).map(([id, mode]) => ({ id, ...mode })); // v14+ shape
}
