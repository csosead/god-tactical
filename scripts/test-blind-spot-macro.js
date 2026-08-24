// GOD Tactical — визуальная проверка computeBlindSpot (стены/парапеты/укрытие через Region)
// Рисует цветную линию стрелок→цель прямо на карте: красная = заблокировано
// (стена/парапет), оранжевая = чисто, но есть укрытие, зелёная = полностью чисто.
// Использование: выделить токен-Стрелка (controlled), навести Target на токен-Цель, запустить макрос.

(async () => {
  const shooter = canvas.tokens.controlled[0];
  const target = game.user.targets.first();

  if (!shooter || !target) {
    ui.notifications.warn("Выдели Стрелка и наведи Target на Цель.");
    return;
  }

  const { drawBlindSpotDebug } = await import("/systems/god-tactical/module/canvas/blind-spot-debug.mjs");
  // duration: 0 — линия остаётся на карте, пока не запустишь макрос заново
  // (или не вызовешь clearBlindSpotDebug() из той же импортированной точки).
  // По умолчанию (без duration) линия сама пропадает через 6 секунд.
  const result = drawBlindSpotDebug(shooter, target, { duration: 0 });

  console.log("god-tactical | computeBlindSpot:", result);

  const lines = [
    `<b>Стрелок:</b> ${shooter.name} → <b>Цель:</b> ${target.name}`,
    `<b>blocked:</b> ${result.blocked}`,
    `<b>reason:</b> ${result.reason ?? "—"}`,
  ];
  if (result.wall) lines.push(`<b>wall:</b> ${result.wall.wallId}`);
  if (result.crossing) lines.push(`<b>crossing:</b> x=${result.crossing.x.toFixed(1)}, y=${result.crossing.y.toFixed(1)}, z=${result.crossing.z.toFixed(2)}`);

  ChatMessage.create({ content: lines.join("<br>") });
})();
