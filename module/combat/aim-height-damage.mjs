/**
 * GOD Tactical — Aim-height damage tier (COMBAT-REDESIGN follow-up)
 * Line/wide_line/cone, BOTH Натиск (melee) and Залп (ranged): попадание — чистое членство
 * клетки (hitTokenIdsForShooter), БЕЗ какого-либо высотного расчёта на уровне шаблона (см.
 * directionalWallClip в template-3d.mjs — обе модели, "разгон-и-полка" у Залпа и реч-обрезание
 * у Натиска, ретирнуты). Несоответствие по высоте — чистый МОДИФИКАТОР УРОНА, применяется
 * ОТДЕЛЬНО и ПОСЛЕ обычного попадания: зная Target Z атаки (высота, на которую боец навёл
 * шаблон — template-canvas.mjs's _aimElevation/_aimElevationOverride, колесо мыши) и
 * собственные floor/heightM уже поражённой цели, определяет full/half/zero.
 *
 * Cover НЕ встроено сюда специальным случаем — этот модуль отдаёт только КЛАССИФИКАЦИЮ
 * (full/half/zero), а фактическое перемножение с cover (и "слышу-не-вижу") живёт в
 * module/combat/attack-outcome.mjs's combineAttackOutcome — единая точка композиции всех
 * факторов урона, а не попарные apply-функции здесь.
 *
 * ВЫСОТНЫЕ ГРУППЫ (HEIGHT_BANDS, 2026-08-17 — заменили старую ассиметричную "лётную зону"):
 * мир делится на несколько именованных вертикальных слоёв (по умолчанию Земля/Низкий полёт/
 * Высокий полёт). Target Z (куда навёлся боец) и собственная высота цели (floorZ) каждые
 * попадают в свою группу — если группы РАЗНЫЕ, это безусловный ZERO, независимо от того,
 * насколько МАЛ зазор в метрах (заменяет старый плоский HEIGHT_GAP_ZERO_M допуск как
 * межгрупповую границу). Внутри ОДНОЙ группы старая симметричная формула зазора (ниже)
 * по-прежнему решает full/half/zero — группы только заменили МЕЖгрупповую отсечку, тонкая
 * настройка внутри группы не тронута. onTarget (прицел физически накрывает тело цели) всегда
 * побеждает первым, даже если бы группы формально не совпали (тело — не точка).
 *
 * СИММЕТРИЧНО (внутри одной группы): тело цели может лежать НИЖЕ Target Z (обычный случай)
 * ИЛИ ВЫШЕ него (шаблон опущен ниже роста бойца) — одна и та же формула зазора работает в обе
 * стороны. Зазор = расстояние от Target Z до БЛИЖАЙШЕГО края тела цели, неважно выше оно или
 * ниже; чем больше зазор — тем хуже тир, по ОДНОЙ и той же шкале в обоих направлениях.
 *
 * Дальний бой и ближний РАЗЛИЧАЮТСЯ только тем, КАКОЙ зазор считается "чистым промахом"
 * (`gapZeroM`, теперь параметр функции, а не модульная константа):
 *  - Залп: HEIGHT_GAP_ZERO_M — фиксированные 10 м (снаряд летит, есть допуск). Шире, чем любая
 *    отдельная группа, так что внутри ОДНОЙ группы этот допуск практически никогда не режет —
 *    он остаётся значимым только для верхней (безграничной сверху) группы.
 *  - Натиск: половина длины оружия/шаблона (см. template-canvas.mjs's _onCanvasWheel и
 *    _meleeAimRange) — рука/оружие никуда не летит, допуска на промах почти нет, короткий
 *    кинжал прощает сантиметры, копьё — больше, но не 10 метров ни при каких раскладах.
 *
 * ФЛАГ "БЬЁТ ПО ЛЕТАЮЩИМ" (canHitLowFlight/canHitHighFlight, только Залп): по умолчанию
 * дальний бой работает ТОЛЬКО в группе "Земля" — чтобы задеть цель в Низком или Высоком
 * полёте, у оружия/способности (items.mjs's weaponCardSchema) должен быть явно включён
 * соответствующий флаг. Без него — безусловный ZERO даже при прямом попадании (onTarget не
 * спасает: способности бить по воздуху физически нет, а не "чуть-чуть не долетел"). Ближний
 * бой этим флагом не ограничен — если оба тела уже оказались в одной нестандартной группе
 * (два летающих существа рядом), обычная формула зазора работает как обычно.
 */

/** Дальнобойный (Залп) зазор-до-нуля по умолчанию, метры — снаряд летит, есть допуск. */
export const HEIGHT_GAP_ZERO_M = 10;

/** Именованные вертикальные слои мира — GM-настраиваемые границы (метры, включительно
 *  сверху). `max: Infinity` на последней группе означал бы "и выше" — здесь она КОНЕЧНА (18 м)
 *  по прямому решению GM: выше явно определённых групп ничего не бывает, а не "всё высокое
 *  автоматически летает". heightBandForZ возвращает null для такой высоты, что уже
 *  корректно читается как ZERO (см. aimHeightDamageTier). Порядок важен — первая группа, чей
 *  `max` не меньше проверяемой высоты, побеждает. */
export const HEIGHT_BANDS = Object.freeze([
  { id: "ground",     label: "Земля",         max: 6 },
  { id: "lowFlight",  label: "Низкий полёт",  max: 12 },
  { id: "highFlight", label: "Высокий полёт", max: 18 },
]);

/** Практический потолок колеса прицела (template-canvas.mjs's _onCanvasWheel) — верх самой
 *  высокой определённой группы. Крутить выше бессмысленно: там нет группы, значит нет и
 *  возможной цели (heightBandForZ вернёт null → безусловный ZERO). */
export const HEIGHT_BAND_CEILING_M = HEIGHT_BANDS[HEIGHT_BANDS.length - 1].max;

/** Which height band a Z coordinate falls into, or null when it's above every defined band
 *  (see HEIGHT_BANDS' doc comment — deliberately NOT an unbounded top group). `bands` is a
 *  parameter (not just read off the module constant) so tests/tools can isolate behaviour
 *  with a custom band layout without touching world state. */
export function heightBandForZ(z, bands = HEIGHT_BANDS) {
  const v = Number(z) || 0;
  return bands.find((b) => v <= b.max) ?? null;
}

export const DAMAGE_TIER = Object.freeze({ FULL: "full", HALF: "half", ZERO: "zero" });
const TIER_MULTIPLIER = { full: 1, half: 0.5, zero: 0 };

/**
 * @param {object} attackerData
 * @param {number} attackerData.targetZ — высота шаблона, выбранная бойцом (м)
 * @param {string} [attackerData.attackType] — "ranged" гейтит canHitLowFlight/canHitHighFlight
 *   ниже; любое другое значение (melee/self/null) этим флагом не ограничивается.
 * @param {boolean} [attackerData.canHitLowFlight] — Залп может задевать группу "lowFlight".
 * @param {boolean} [attackerData.canHitHighFlight] — Залп может задевать группу "highFlight".
 * @param {object} targetData
 * @param {number} targetData.floorZ — собственная высота пола цели (м)
 * @param {number} targetData.heightM — рост/высота тела цели (м)
 * @param {number} [gapZeroM] — зазор ВНУТРИ одной группы, выше которого — чистый промах; по
 *   умолчанию HEIGHT_GAP_ZERO_M (Залп). Ближний бой передаёт половину длины оружия вместо этого.
 * @param {Array} [bands] — высотные группы; по умолчанию HEIGHT_BANDS.
 * @returns {{tier: "full"|"half"|"zero", multiplier: number}}
 */
export function aimHeightDamageTier(attackerData, targetData, gapZeroM = HEIGHT_GAP_ZERO_M, bands = HEIGHT_BANDS) {
  const targetZ = Number(attackerData?.targetZ) || 0;
  const floorZ = Number(targetData?.floorZ) || 0;
  const heightM = Number(targetData?.heightM) || 0;
  const topZ = floorZ + heightM;
  const zeroGap = Number.isFinite(gapZeroM) ? Math.max(0, gapZeroM) : HEIGHT_GAP_ZERO_M;

  const targetBand = heightBandForZ(floorZ, bands);

  // Залп без явного флага на эту группу физически не может её задеть — ни в упор, ни рядом.
  // Проверяется ПЕРВЫМ, до onTarget: отсутствие способности важнее точности наводки.
  if (attackerData?.attackType === "ranged" && targetBand && targetBand.id !== "ground") {
    const flagKey = targetBand.id === "lowFlight" ? "canHitLowFlight" : "canHitHighFlight";
    if (!attackerData?.[flagKey]) return { tier: DAMAGE_TIER.ZERO, multiplier: 0 };
  }

  const onTarget = targetZ >= floorZ - 1e-6 && targetZ <= topZ + 1e-6;
  if (onTarget) return { tier: DAMAGE_TIER.FULL, multiplier: TIER_MULTIPLIER.full };

  // Разные группы — безусловный ZERO, каким бы малым ни казался зазор в метрах (включая
  // targetBand === null, высота вне всех определённых групп).
  const aimBand = heightBandForZ(targetZ, bands);
  if (!targetBand || !aimBand || aimBand.id !== targetBand.id) {
    return { tier: DAMAGE_TIER.ZERO, multiplier: 0 };
  }

  // Одна группа: зазор до ближайшего края — ВЫШЕ тела (targetZ > topZ) или НИЖЕ него
  // (targetZ < floorZ), одна и та же величина, одна и та же шкала обеих направлений.
  const gap = targetZ > topZ ? targetZ - topZ : floorZ - targetZ;
  return gap <= zeroGap
    ? { tier: DAMAGE_TIER.HALF, multiplier: TIER_MULTIPLIER.half }
    : { tier: DAMAGE_TIER.ZERO, multiplier: 0 };
}
