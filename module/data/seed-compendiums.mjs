/**
 * GOD Tactical — Compendium Seeding
 *
 * Compendiums are binary LevelDB packs and can't be edited outside a running
 * world. This creates the rulebook's weapon/armor/class cards through the
 * Foundry API on world startup — only ever adding entries that don't already
 * exist, so it never overwrites a GM's edits.
 *
 * Matching by name alone isn't enough: if a GM renames or deletes one of
 * these rulebook entries, a name-only check would see it as "missing" on the
 * next world load and silently recreate it — the exact "my compendium edits
 * keep getting reset" bug this file used to have. So every entry this
 * rulebook defines gets recorded (by name, at the time it's first seen) in
 * the `seedRegistry` world setting once it exists in the pack. From then on,
 * a name missing from the pack but present in that registry is treated as
 * "a GM deliberately removed/renamed it", not "never created" — it's left
 * alone forever, even across renames or deletions.
 */

import { CLASSES } from "./class-seed.mjs";
import { RACES } from "./race-seed.mjs";
import { CREATURES } from "./creature-seed.mjs";
import { NPCS } from "./bestiary-seed.mjs";
import { ABILITIES } from "./ability-seed.mjs";
import { GOD, charPointXpCost, charRaiseXpCost, mezzaninePriorityRuleText } from "../config.mjs";
import { skillValueFromRank, skillRankRaiseCost } from "../data-models.mjs";
import { PHASES } from "../combat/phase-controls.mjs";
import { BASE_ACTIONS, ACTION_CATEGORY_LABEL } from "../combat/action-log.mjs";

// Foundry's built-in placeholder set — icons still on one of these are
// considered "unset" and safe to overwrite when real art is added later.
const PLACEHOLDER_PREFIX = "icons/svg/";

const SEED_REGISTRY_SETTING = "seedRegistry";

export function registerSeedRegistrySetting() {
  game.settings.register("god-tactical", SEED_REGISTRY_SETTING, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
}

function _getSeededSet(packName) {
  const registry = game.settings.get("god-tactical", SEED_REGISTRY_SETTING) ?? {};
  return new Set(registry[packName] ?? []);
}

/** Record entry names as seeded for `packName` — idempotent, only writes when something's new. */
async function _markSeeded(packName, names) {
  const registry = foundry.utils.deepClone(game.settings.get("god-tactical", SEED_REGISTRY_SETTING) ?? {});
  const set = new Set(registry[packName] ?? []);
  let changed = false;
  for (const name of names) {
    if (!set.has(name)) { set.add(name); changed = true; }
  }
  if (!changed) return;
  registry[packName] = [...set];
  await game.settings.set("god-tactical", SEED_REGISTRY_SETTING, registry);
}

async function seedPack(packName, type, entries) {
  const pack = game.packs.get(`god-tactical.${packName}`);
  if (!pack) return;

  const index = await pack.getIndex({ fields: ["img", "folder"] });
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet(packName);

  // Ensure a Folder exists per distinct folder name used by the entries (entries
  // without a `folder` land at the pack root, as before).
  const folderIdByName = new Map();
  for (const name of new Set(entries.map((e) => e.folder).filter(Boolean))) {
    let folder = pack.folders?.find((f) => f.name === name);
    if (!folder) {
      folder = await Folder.create({ name, type: "Item" }, { pack: pack.collection });
    }
    if (folder) folderIdByName.set(name, folder.id);
  }

  const missing = entries
    .filter((entry) => !existingByName.has(entry.name) && !alreadySeeded.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      type: entry.type ?? type,
      img: entry.img,
      system: entry.system,
      folder: entry.folder ? folderIdByName.get(entry.folder) ?? null : null,
    }));

  if (missing.length > 0) {
    await pack.documentClass.createDocuments(missing, { pack: pack.collection });
    console.log(`god-tactical | Seeded ${missing.length} item(s) into ${packName} compendium`);
  }

  // Every rulebook entry seen this run — just created, or already present from
  // before — is now permanently protected from being recreated later.
  await _markSeeded(packName, entries.map((e) => e.name));

  // Sync icons for entries that already exist but still use a placeholder —
  // never touches items where a GM has already assigned real art.
  const iconUpdates = entries
    .map((entry) => ({ entry, existing: existingByName.get(entry.name) }))
    .filter(
      ({ entry, existing }) =>
        existing && existing.img?.startsWith(PLACEHOLDER_PREFIX) && existing.img !== entry.img,
    )
    .map(({ entry, existing }) => ({ _id: existing._id, img: entry.img }));

  if (iconUpdates.length > 0) {
    await pack.documentClass.updateDocuments(iconUpdates, { pack: pack.collection });
    console.log(`god-tactical | Synced ${iconUpdates.length} icon(s) in ${packName} compendium`);
  }

  // File existing entries that predate this rulebook's folder into it — only when
  // they're still sitting at the pack root, never touches one a GM has already
  // filed somewhere themself.
  const folderUpdates = entries
    .map((entry) => ({ entry, existing: existingByName.get(entry.name) }))
    .filter(({ entry, existing }) => existing && entry.folder && !existing.folder)
    .map(({ entry, existing }) => ({ _id: existing._id, folder: folderIdByName.get(entry.folder) ?? null }));

  if (folderUpdates.length > 0) {
    await pack.documentClass.updateDocuments(folderUpdates, { pack: pack.collection });
    console.log(`god-tactical | Filed ${folderUpdates.length} item(s) into folders in ${packName} compendium`);
  }
}

/** Seed the abilities pack. Unlike seedPack, entries carry a `folder` name (one
 *  folder per class) — the matching in-compendium Folder is created if missing,
 *  and each new ability is filed into it. Idempotent by ability name. */
async function seedAbilities(entries) {
  const pack = game.packs.get("god-tactical.abilities");
  if (!pack) return;

  const index = await pack.getIndex();
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet("abilities");

  // Ensure a Folder exists per distinct folder name used by the entries.
  const folderIdByName = new Map();
  for (const name of new Set(entries.map((e) => e.folder).filter(Boolean))) {
    let folder = pack.folders?.find((f) => f.name === name);
    if (!folder) {
      folder = await Folder.create({ name, type: "Item" }, { pack: pack.collection });
    }
    if (folder) folderIdByName.set(name, folder.id);
  }

  const missing = entries
    .filter((entry) => !existingByName.has(entry.name) && !alreadySeeded.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      type: "ability",
      img: entry.img,
      system: entry.system,
      folder: entry.folder ? folderIdByName.get(entry.folder) ?? null : null,
    }));

  if (missing.length > 0) {
    await pack.documentClass.createDocuments(missing, { pack: pack.collection });
    console.log(`god-tactical | Seeded ${missing.length} ability(ies) into abilities compendium`);
  }

  await _markSeeded("abilities", entries.map((e) => e.name));
}

/**
 * Auto-fill each class's `system.grantedItems` (the list a class hands out when added to an
 * actor — see module/data/class-race-rules.mjs) with every ability compendium entry seeded
 * into a same-named Folder (see seedAbilities()'s own `folder` handling above — e.g. every
 * ability in the "Воин" folder links onto the "Воин" class). Dropping the "Воин" class onto
 * an actor is otherwise a no-op for abilities: `grantedItems` starts out empty and nothing
 * links it to the abilities seeded alongside it. (Used to match on the abilities' own
 * `system.className` field instead of their folder — that field, and the "class"-prefixed
 * ability subtypes it was exclusive to, were retired; see AbilityDataModel.migrateData in
 * items.mjs.)
 *
 * Only touches a class while its `grantedItems` is still empty — once a GM adds/removes/reorders
 * anything on the class sheet themself, this never runs again for that class, same "don't stomp
 * a GM's own edits" rule as the rest of this file.
 */
async function linkClassGrantedAbilities() {
  const classPack = game.packs.get("god-tactical.classes");
  const abilityPack = game.packs.get("god-tactical.abilities");
  if (!classPack || !abilityPack) return;

  const wasLocked = classPack.locked;
  if (wasLocked) await classPack.configure({ locked: false });

  const classDocs = await classPack.getDocuments();
  const abilityDocs = await abilityPack.getDocuments();

  const updates = classDocs
    .filter((cls) => !(cls.system.grantedItems ?? []).length)
    .map((cls) => ({
      cls,
      matches: abilityDocs.filter((a) => a.folder?.name === cls.name),
    }))
    .filter(({ matches }) => matches.length)
    .map(({ cls, matches }) => ({
      _id: cls.id,
      "system.grantedItems": matches.map((a) => ({ uuid: a.uuid, name: a.name, img: a.img, type: a.type })),
    }));

  if (updates.length > 0) {
    await classPack.documentClass.updateDocuments(updates, { pack: classPack.collection });
    console.log(`god-tactical | Linked granted abilities on ${updates.length} class(es)`);
  }

  if (wasLocked) await classPack.configure({ locked: true });
}

/**
 * Seed one empty JournalEntry per GOD.STATUS_EFFECTS entry (config.mjs) into the
 * "Статус эффекты" folder of the journal compendium — each is a single-page document
 * ready for the GM to write the actual rules text into themselves; this only ever
 * creates the container, never any placeholder prose. Same idempotent-by-name +
 * seed-registry protection as seedPack() above, so a GM's own edits (including
 * deleting/renaming an entry, or leaving its page blank) are never touched or redone.
 */
async function seedStatusJournal() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;

  const packName = "journal";
  const folderName = "Статус эффекты";

  const index = await pack.getIndex({ fields: ["folder"] });
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet(packName);

  let folder = pack.folders?.find((f) => f.name === folderName);
  if (!folder) {
    folder = await Folder.create({ name: folderName, type: "JournalEntry" }, { pack: pack.collection });
  }

  const missing = GOD.STATUS_EFFECTS
    .filter((s) => !existingByName.has(s.name) && !alreadySeeded.has(s.name))
    .map((s) => ({
      name: s.name,
      folder: folder?.id ?? null,
      pages: [{
        name: s.name,
        type: "text",
        text: { content: "", format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
      }],
    }));

  if (missing.length > 0) {
    await pack.documentClass.createDocuments(missing, { pack: pack.collection });
    console.log(`god-tactical | Seeded ${missing.length} status effect journal entr${missing.length === 1 ? "y" : "ies"}`);
  }

  await _markSeeded(packName, GOD.STATUS_EFFECTS.map((s) => s.name));
}

/* -------------------------------------------- */
/*  Rules journal: Characteristics & Skills      */
/* -------------------------------------------- */

/** Which characteristic governs which 4 skills — built from GOD.SKILL_MAP so it can never
 *  drift out of sync with the actual skill list. */
function _charSkillBlocksHtml() {
  const rows = Object.values(GOD.SKILL_MAP)
    .map((cat) => `<tr><td><strong>${cat.name}</strong></td><td>${cat.skills.map((s) => s.name).join(", ")}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>Характеристика</th><th>Навыки блока</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** One heading + bracket-desc block per characteristic — the exact convention
 *  loadSkillMapDescsFromRulebook() (config.mjs) reads back out at runtime: a heading
 *  whose text matches the characteristic's own `name` (e.g. "КОГНИЦИЯ"), immediately
 *  followed by a paragraph with its tooltip text inside [square brackets]. Seeded once,
 *  verbatim from GOD.SKILL_MAP[...].desc — after that a GM is free to reword/translate
 *  the bracketed sentence, as long as the brackets and heading text survive (same
 *  caveat as _actionsHtml above: never put a literal example bracket pair in the
 *  free-form prose, or the extractor will treat it as the real tooltip). */
function _charDescsHtml() {
  return Object.values(GOD.SKILL_MAP).map((cat) => `
    <h3>${cat.name}</h3>
    <p>[${cat.desc}]</p>
  `).join("");
}

/** Same convention as _charDescsHtml above, one <h4> + bracket-desc block per skill —
 *  loadSkillMapDescsFromRulebook() (config.mjs) reads these back by POSITION (see
 *  rulebook-hints.mjs's extractHeadingSequence), not by matching text, since the heading
 *  text itself is the editable display name here. Grouped under a plain <h3> per
 *  characteristic purely for readability — h3 is never matched on this page (only h4
 *  is), so that grouping is free to reorganize, relabel, or drop without affecting
 *  extraction; the <h4>s themselves must stay exactly 16, in this same order, though. */
function _skillsPageHtml() {
  return Object.values(GOD.SKILL_MAP).map((cat) => `
    <h3>${cat.name}</h3>
    ${cat.skills.map((s) => `<h4>${s.name}</h4><p>[${s.desc}]</p>`).join("")}
  `).join("");
}

function _skillsPage() {
  return `
    <p>Все 12 навыков, сгруппированные по управляющей ими характеристике.</p>
    <p>Наведите курсор на навык на листе персонажа, чтобы увидеть подсказку о том, что он покрывает — текст подсказки берётся прямо с этой страницы, из фразы в [квадратных скобках] под заголовком навыка, а САМ заголовок — это его отображаемое имя. Оба можно свободно переписывать (в том числе переименовать навык) — правки в игре применятся сами после перезагрузки. На странице должно остаться ровно 12 заголовков четвёртого уровня (<code>&lt;h4&gt;</code>), по одному на навык, в этом порядке (сгруппированы по характеристике заголовками третьего уровня — те не считаются и их можно свободно менять) — не добавляйте, не убирайте и не переставляйте местами сами навыковые заголовки, иначе следующие за пропавшим/новым съедут не на тот навык. Удаление скобок или всего блока для конкретного навыка возвращает ЕГО ОДНОГО к встроенным имени/подсказке по умолчанию.</p>
    ${_skillsPageHtml()}
  `;
}

/** Rank 0–4 table (bonus / prerequisite / step cost) — built from the live GOD.* tables in
 *  config.mjs, so this page can never quote a stale number after a balance pass. */
function _rankTableHtml() {
  const rows = [0, 1, 2, 3, 4]
    .map((r) => `<tr><td>${r}</td><td>+${GOD.SKILL_RANK_BONUS[r]}</td><td>${r === 0 ? "—" : `≥ ${GOD.SKILL_RANK_CHAR_PREREQ[r]}`}</td><td>${r === 0 ? "—" : `${GOD.SKILL_RANK_XP_COST[r]} XP`}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>Ранг</th><th>Бонус к значению</th><th>Порог характеристики</th><th>Цена шага</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function _charPage() {
  return `
    <p>Три характеристики — <strong>Когниция</strong>, <strong>Пневма</strong> и <strong>Корпус</strong>. Каждая управляет своим блоком из 4 навыков и определяет потолок их роста.</p>
    ${_charSkillBlocksHtml()}
    <h2>Характеристики</h2>
    <p>Наведите курсор на характеристику на листе персонажа, чтобы увидеть подсказку о том, что она означает — текст подсказки берётся прямо из фразы в [квадратных скобках] под заголовком характеристики ниже, а САМ заголовок — это её отображаемое имя. Оба можно свободно переписывать (в том числе на другом языке, включая переименование самой характеристики) — правки в игре применятся сами после перезагрузки. Ниже должно остаться ровно 3 заголовка третьего уровня (<code>&lt;h3&gt;</code>), по одному на характеристику, в этом порядке — не добавляйте, не убирайте и не переставляйте их местами (для собственных заметок используйте другой уровень заголовка, например <code>&lt;h2&gt;</code> или <code>&lt;h4&gt;</code>), иначе следующие за пропавшим/новым заголовком характеристики съедут не на ту характеристику. Удаление скобок или всего блока для конкретной характеристики просто возвращает ЕЁ ОДНУ к встроенным имени/подсказке по умолчанию — остальные две и вся прочая страница не пострадают.</p>
    ${_charDescsHtml()}
    <h2>Диапазон</h2>
    <p>Характеристика хранится в пределах <strong>${GOD.CHAR_MIN}–${GOD.CHAR_HARD_MAX}</strong>. ${GOD.CHAR_MIN} — минимум, ниже которого персонаж не может опуститься; ${GOD.CHAR_HARD_MAX} — жёсткий потолок игры.</p>
    <h2>Стоимость очка</h2>
    <p>Цена следующего очка характеристики зависит от текущего значения — чем выше характеристика, тем дороже её растить:</p>
    <table>
      <thead><tr><th>Текущее значение</th><th>Цена очка</th></tr></thead>
      <tbody>
        <tr><td>&lt; 50</td><td>${charPointXpCost(0)} XP</td></tr>
        <tr><td>50–69</td><td>${charPointXpCost(50)} XP</td></tr>
        <tr><td>≥ 70</td><td>${charPointXpCost(70)} XP</td></tr>
      </tbody>
    </table>
    <p><em>Пример: поднять характеристику с 40 до 70 стоит ${charRaiseXpCost(40, 70)} XP суммарно (по каждому очку отдельно, ставка растёт по мере роста характеристики). Если покупка идёт сразу на несколько очков, итоговая цена — просто сумма цен по каждому из них.</em></p>
    <p>Значение характеристики правится прямо в поле на листе персонажа — стоимость проверяется и снимается с накопленного опыта (XP) автоматически при попытке его поднять. Если опыта не хватает, правка откатывается с предупреждением.</p>
  `;
}

function _ranksPage() {
  const ex1 = skillValueFromRank(3, 75);
  const ex2 = skillValueFromRank(4, 60);
  return `
    <p>У каждого навыка есть <strong>ранг от 0 до 4</strong>. Ранг 0 означает «нет ранга вообще» — никакого бонуса, только базовая половина характеристики. Бесплатного стартового ранга больше нет: каждый ранг 1–4 покупается за опыт (кроме того, что даёт бонус класса).</p>
    ${_rankTableHtml()}
    <h3>Формула значения навыка</h3>
    <p>Итоговое значение проверки (% на d100, бросок ≤ значения — успех) считается так:</p>
    <ol>
      <li><code>floor(характеристика / 2) + бонус_ранга</code></li>
      <li>кламп сверху: не больше <code>характеристика − 5</code> — навык никогда не бывает ближе 5 пунктов к своей характеристике</li>
      <li>кламп сверху: не больше 95 — общий потолок значения навыка</li>
    </ol>
    <p><em>Пример обычной покупки: характеристика 75, ранг 3 (порог ранга 3 — 75, значит характеристика его как раз позволяет) → floor(37) + 30 = 67, оба потолка выше — итог <strong>${ex1}%</strong>.</em></p>
    <h3>Пререквизит характеристики</h3>
    <p>Ранг нельзя купить, если управляющая им характеристика ниже порога из таблицы выше (используется её эффективное значение — с учётом бонуса расы). Попытка купить недоступный ранг выдаёт предупреждение с указанием нужного значения.</p>
    <p>Понижая характеристику прямо на листе (или в мастере создания персонажа), вы автоматически откатываете купленный ранг у каждого навыка блока, который она больше не поддерживает — вплоть до максимума, который ещё разрешает новое значение. Класс-бонусную звезду это не трогает — откатывается только то, что было куплено за опыт, а XP за это не возвращается. Уведомление на листе подскажет, у каких навыков ранг понизился.</p>
    <p>Единственный случай, где рассинхрон всё же может временно повиснуть, — импорт старого листа персонажа с данными, где ранг и характеристика изначально не сходятся: до тех пор, пока характеристику того блока хоть раз не тронут на листе, откат не сработает. Тогда в дело вступает кламп «характеристика − 5» из формулы выше — он не даёт навыку «висеть» с завышенным значением, пока рассинхрон не будет замечен:</p>
    <p><em>Пример такого случая: у навыка уже куплен ранг 4 (например, персонаж импортирован со старого листа), но характеристика сейчас всего 60 (ниже порога ранга 4 — 90). floor(30) + 40 = 70 — но кламп «характеристика − 5» = 55 ниже, итог всего <strong>${ex2}%</strong>. Новый ранг 4 с нуля так купить нельзя — характеристику пришлось бы поднять до 90 заранее.</em></p>
    <h3>Бонус класса к рангу</h3>
    <p>Если выбранный класс даёт бесплатный ранг к навыку, эта звезда всегда встаёт крайней слева и её нельзя ни купить, ни продать — это подарок класса, а не покупка. Дальнейшие ранги считаются от неё: если класс уже даёт эффективный ранг 2, доплата за ранг 3 — это ровно цена шага ранга 3 из таблицы выше, а не сумма рангов 2 и 3.</p>
  `;
}

function _xpPage() {
  return `
    <p>Накопленный опыт (XP) хранится в отдельном поле в шапке листа персонажа. Число можно вписать вручную (например, когда мастер начисляет опыт за сессию) — расходуется оно автоматически при попытке поднять ранг навыка или очко характеристики.</p>
    <h3>Покупка ранга навыка</h3>
    <p>Клик по звезде ранга на листе персонажа — это попытка купить эффективный ранг, соответствующий этой звезде. Если характеристика ниже порога или не хватает XP — покупка отменяется, звезда остаётся как была, и выводится предупреждение с точной причиной (сколько XP нужно или какое значение характеристики требуется). Понижение ранга (клик по уже купленной звезде) всегда бесплатно и не возвращает XP.</p>
    <h3>Создание персонажа</h3>
    <p>Мастер создания персонажа — отдельная, более простая песочница на стартовый пул опыта (по умолчанию 30, но поле «Остаток» на шаге распределения можно вписать вручную под конкретного персонажа) и не связана с полем XP на готовом листе. В ней характеристики ограничены диапазоном 40–70, а каждый навык начинается с ранга 0 — свободного стартового ранга больше нет, единственная бесплатная звезда — та, что даёт бонус класса (если он есть), и её нельзя ни купить, ни продать. Ранги 3–4 в чаргене обычно недостижимы: их порог характеристики (${GOD.SKILL_RANK_CHAR_PREREQ[3]}+) выше стартового потолка 70 — такие ранги открываются позже, через игру. По завершении мастер публикует в чат, сколько опыта было выделено и сколько потрачено.</p>
  `;
}

/* -------------------------------------------- */
/*  Rules journal: Мезонин                       */
/* -------------------------------------------- */

/** Priority 1–5 table (result cap / dice cost) — built from mezzaninePriorityRuleText()
 *  (config.mjs), which itself reads the live GOD.MEZZANINE_PRIORITY_RULES table, so
 *  neither the numbers nor the wording can drift out of sync with the sheet/chat-card
 *  tooltips that describe the same rules (same "never hardcode a balance number in
 *  prose" rule as _rankTableHtml() above — here it's the wording too, not just numbers). */
function _mezzaninePriorityTableHtml() {
  const rows = [1, 2, 3, 4, 5].map((rank) => {
    const { cap, spend } = mezzaninePriorityRuleText(rank);
    return `<tr><td>${rank}</td><td>${cap}</td><td>${spend}</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>Приоритет</th><th>Результат переброса</th><th>Кубик Мезонин</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function _mezzanineDrivesPage() {
  const driveNames = GOD.MEZZANINE_DRIVES.map((d) => `<strong>${d.name}</strong>`).join(", ");
  return `
    <p>Пять драйвов Мезонин — устойчивые мотивации персонажа: ${driveNames}. При создании персонажа (и позже — на листе, в режиме редактирования) игрок расставляет им приоритет от 1 (высший) до 5 (низший): каждому драйву достаётся ровно один приоритет.</p>
    <p>Когда персонаж проваливает проверку навыка (Провал или Фиаско), а действие было мотивировано одним из драйвов, игрок может — но не обязан — потратить кубик Мезонин и перебросить эту проверку. Важно: бросок идёт не по навыку, а по <strong>характеристике</strong>, к которой навык относится, — персонаж действует не мастерством, а голым порывом.</p>
    <p>Какой драйв применить, решает игрок задним числом, уже увидев провал — никто не спрашивает про мотивацию перед каждым броском. На карточке проваленного броска (и на листе персонажа, в панели «Мезонин») появляется список драйвов с их текущим приоритетом; клик по драйву запускает переброс.</p>
    <h3>Что делает приоритет</h3>
    ${_mezzaninePriorityTableHtml()}
    <p><em>Приоритеты 2 и 3 равны по весу намеренно — это не два разных правила, а просто два места в списке с одинаковой механикой.</em></p>
  `;
}

function _mezzanineDicePage() {
  return `
    <p>У персонажа всегда есть общий пул из <strong>${GOD.MEZZANINE_MAX_DICE}</strong> кубиков Мезонин — не по одному на каждый драйв, один пул на все пять. Текущее количество показано на листе персонажа прямо под портретом.</p>
    <h3>Восполнение</h3>
    <p>Отдельной нарративной механики восполнения кубиков пока не описано в правилах — на листе есть кнопка «+» рядом со значками кубиков, ей мастер или игрок восполняет кубик вручную, когда решит, что для этого есть повод по игре.</p>
    <h3>Порядок применения</h3>
    <ol>
      <li>Проверка навыка проваливается (Провал или Фиаско).</li>
      <li>Игрок решает, что действие было мотивировано одним из пяти драйвов, и (если есть хотя бы один кубик Мезонин) нажимает на этот драйв — на карточке броска или на листе персонажа.</li>
      <li>Персонаж перебрасывает d100 против своей ЭФФЕКТИВНОЙ характеристики (не навыка).</li>
      <li>Итог читается по приоритету этого драйва (см. страницу «Драйвы и приоритеты») — тратится кубик или нет, и не капается ли успех до «с последствием».</li>
    </ol>
  `;
}

async function seedMezzanineJournal() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;

  const packName = "journal";
  const folderName = "Правила";
  const entryName = "Мезонин";

  const index = await pack.getIndex({ fields: ["folder"] });
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet(packName);

  if (existingByName.has(entryName) || alreadySeeded.has(entryName)) {
    await _markSeeded(packName, [entryName]);
    return;
  }

  let folder = pack.folders?.find((f) => f.name === folderName);
  if (!folder) {
    folder = await Folder.create({ name: folderName, type: "JournalEntry" }, { pack: pack.collection });
  }

  await pack.documentClass.createDocuments([{
    name: entryName,
    folder: folder?.id ?? null,
    pages: [
      { name: "Драйвы и приоритеты", type: "text", text: { content: _mezzanineDrivesPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Кубики и переброс", type: "text", text: { content: _mezzanineDicePage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
    ],
  }], { pack: pack.collection });
  console.log("god-tactical | Seeded rules journal entry (Мезонин)");

  await _markSeeded(packName, [entryName]);
}

/* -------------------------------------------- */
/*  Rules journal: Phases & Stages                */
/* -------------------------------------------- */

/** One `<h4>` + bracket-hint block per stage of `phase` — the exact convention
 *  loadPhaseStageHintsFromRulebook() (phase-controls.mjs) reads back out at runtime: a
 *  heading whose text matches the stage's own label, immediately followed by a paragraph
 *  with the tooltip sentence inside [square brackets]. Seeded once, verbatim from this
 *  phase's own PHASES.stages[].hint — after that a GM is free to expand the surrounding
 *  prose, or reword/translate the bracketed sentence itself, without breaking anything,
 *  AS LONG AS the brackets and the heading text survive. Delete either and that one
 *  stage's tooltip just falls back to the hardcoded default in phase-controls.mjs —
 *  nothing else on the page or in the tracker breaks. A stage with no hint at all (e.g.
 *  "Движения" itself has none) gets a bracket-free placeholder instead — deliberately
 *  spelling out "квадратные скобки" in words rather than literal `[`/`]` characters, since
 *  the extractor greedily grabs the FIRST bracketed span after a heading: a literal
 *  example pair here would itself get picked up as if it were real hint content. */
function _phaseStagesHtml(phase) {
  return phase.stages.map((s, i) => `
    <h4>${s.label}</h4>
    <p>${s.hint ? `[${s.hint}]` : `<em>Этап ${i + 1} — впишите здесь описание. Если хотите, чтобы часть текста стала подсказкой при наведении в трекере, выделите её квадратными скобками.</em>`}</p>
  `).join("");
}

function _phaseOverviewPage() {
  return `
    <p>Раунд боя делится на две <strong>фазы</strong> — ${PHASES.map((p) => `«${p.label}»`).join(" и ")} — каждая раскрывается по очереди в свой фиксированный набор <strong>этапов</strong> (страницы «${PHASES.map((p) => p.label).join("» и «")}» этого раздела). Общий трекер (виден в шапке вкладки «Столкновения») показывает, какая фаза и какой этап сейчас активны — одно состояние на весь стол, а не персональное для каждого игрока.</p>
    <p>Только <strong>Мастер</strong> переключает фазу и листает этапы (стрелками рядом с трекером или кликом на нужный этап в списке). Игроки видят трекер, но не управляют им.</p>
    <p>Единственный этап без всяких ограничений — «Планирование», первый этап фазы «Атака»: именно здесь игроки объявляют всё на раунд — атаки, шаблоны, оружие, способности, а заодно и движения, которые формально относятся к фазе «Движения». Остальные этапы существуют, чтобы по порядку разыграть уже объявленное. Новый раунд всегда начинается заново с «Планирования».</p>
    <p>Наведите курсор на этап в трекере, чтобы увидеть подсказку о том, что на нём происходит — текст подсказки берётся прямо с соответствующей страницы этого раздела рулбука, из фразы в [квадратных скобках] под заголовком этапа. Фразу можно свободно переписывать (в том числе на другом языке) — подсказка в игре обновится сама после перезагрузки. Сами скобки и заголовок этапа удалять нельзя: без них подсказка для этого этапа просто вернётся к встроенному тексту по умолчанию, но остальные этапы и вся остальная страница на это никак не повлияют.</p>
  `;
}

/** Seed the "Фазы и этапы" rules journal entry — one page per phase (page name === the
 *  phase's own label), pre-filled from the live PHASES table (phase-controls.mjs) so the
 *  initial text can never drift from what the tracker actually shows before a GM edits
 *  anything. Same idempotent-by-name + seed-registry protection as the other rules
 *  journal entries above. */
async function seedPhasesJournal() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;

  const packName = "journal";
  const folderName = "Правила";
  const entryName = "Фазы и этапы";

  const index = await pack.getIndex({ fields: ["folder"] });
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet(packName);

  if (existingByName.has(entryName) || alreadySeeded.has(entryName)) {
    await _markSeeded(packName, [entryName]);
    return;
  }

  let folder = pack.folders?.find((f) => f.name === folderName);
  if (!folder) {
    folder = await Folder.create({ name: folderName, type: "JournalEntry" }, { pack: pack.collection });
  }

  await pack.documentClass.createDocuments([{
    name: entryName,
    folder: folder?.id ?? null,
    pages: [
      { name: "Обзор", type: "text", text: { content: _phaseOverviewPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      ...PHASES.map((phase) => ({
        name: phase.label,
        type: "text",
        text: {
          content: `<p>Фаза «${phase.label}», ${phase.stages.length} этап${phase.stages.length === 1 ? "" : phase.stages.length < 5 ? "а" : "ов"} по порядку:</p>${_phaseStagesHtml(phase)}`,
          format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
        },
      })),
    ],
  }], { pack: pack.collection });
  console.log("god-tactical | Seeded rules journal entry (Фазы и этапы)");

  await _markSeeded(packName, [entryName]);
}

/* -------------------------------------------- */
/*  Rules journal: Actions (Действия)            */
/* -------------------------------------------- */

/** One `<h4>` + bracket-desc block per action of `actions` — the exact convention
 *  loadBaseActionDescsFromRulebook() (action-log.mjs) reads back out at runtime: a
 *  heading whose text matches the action's own name, immediately followed by a paragraph
 *  with the tooltip text inside [square brackets]. Seeded once, verbatim from
 *  BASE_ACTIONS[...].desc — after that a GM is free to expand the surrounding prose, or
 *  reword/translate the bracketed sentence itself, without breaking anything, AS LONG AS
 *  the brackets and the heading text survive (same caveat as _phaseStagesHtml above: never
 *  put a literal example bracket pair in the free-form prose, or the extractor will treat
 *  it as the real tooltip). */
function _actionsHtml(actions) {
  return actions.map((a) => {
    const catLabel = (a.categories ?? []).map((c) => ACTION_CATEGORY_LABEL[c] ?? c).join(", ");
    return `
    <h4>${a.name}</h4>
    <p>[${a.desc}]</p>
    ${catLabel ? `<p><em>Категория экономии действий: ${catLabel}</em></p>` : ""}
  `;
  }).join("");
}

function _actionsOverviewPage() {
  return `
    <p>Каждое базовое действие относится к одной из двух фаз — ${PHASES.map((p) => `«${p.label}»`).join(" или ")} (страницы «${PHASES.map((p) => p.label).join("» и «")}» этого раздела) — и объявляется на этапе «Планирование» (см. раздел «Фазы и этапы»), независимо от того, на каком этапе оно фактически разрешится.</p>
    <p>Категория экономии действий у каждого действия ([Атака]/[Контроль]/[Подготовка]/[Движения]) лишь помечает, на каком ЭТАПЕ разрешения оно сработает — она не ограничивает, когда его можно объявить: объявление всегда происходит в «Планировании».</p>
    <p>Наведите курсор на действие в списке базовых действий, чтобы увидеть подсказку о том, что оно делает — текст подсказки берётся прямо с соответствующей страницы этого раздела рулбука, из фразы в [квадратных скобках] под заголовком действия. Фразу можно свободно переписывать (в том числе на другом языке) — подсказка в игре обновится сама после перезагрузки. Сами скобки и заголовок действия удалять нельзя: без них подсказка для этого действия просто вернётся к встроенному тексту по умолчанию, а остальные действия и вся остальная страница на это никак не повлияют.</p>
  `;
}

/** Seed the "Действия" rules journal entry — one page per BASE_ACTIONS group (page name
 *  === the matching phase's own label, e.g. "Атака"/"Движения" — see PHASES), pre-filled
 *  from the live BASE_ACTIONS table (action-log.mjs) so the initial text can never drift
 *  from what the actions picker actually shows before a GM edits anything. Same
 *  idempotent-by-name + seed-registry protection as the other rules journal entries. */
async function seedActionsJournal() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;

  const packName = "journal";
  const folderName = "Правила";
  const entryName = "Действия";

  const index = await pack.getIndex({ fields: ["folder"] });
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet(packName);

  if (existingByName.has(entryName) || alreadySeeded.has(entryName)) {
    await _markSeeded(packName, [entryName]);
    return;
  }

  let folder = pack.folders?.find((f) => f.name === folderName);
  if (!folder) {
    folder = await Folder.create({ name: folderName, type: "JournalEntry" }, { pack: pack.collection });
  }

  await pack.documentClass.createDocuments([{
    name: entryName,
    folder: folder?.id ?? null,
    pages: [
      { name: "Обзор", type: "text", text: { content: _actionsOverviewPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      ...PHASES.map((phase) => ({
        name: phase.label,
        type: "text",
        text: {
          content: `<p>Действия фазы «${phase.label}»:</p>${_actionsHtml(BASE_ACTIONS[phase.key] ?? [])}`,
          format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
        },
      })),
    ],
  }], { pack: pack.collection });
  console.log("god-tactical | Seeded rules journal entry (Действия)");

  await _markSeeded(packName, [entryName]);
}

/* -------------------------------------------- */
/*  Rules journal: Competencies (Компетенции)    */
/* -------------------------------------------- */

/** One bullet list of a group's own competency names — the exact convention
 *  loadCompetencyGroupsFromRulebook() (config.mjs) reads back out at runtime: the FIRST
 *  <ul>/<ol> on the page, read item by item (see rulebook-hints.mjs's extractListItems).
 *  Seeded once, verbatim from GOD.COMPETENCY_GROUPS[...].competencies — after that a GM
 *  is free to rename an item (edit its text), add a brand-new competency (add a list
 *  item), remove one (delete its list item), or reorder them (drag the item), and the
 *  character builder's competency picker picks it up on next reload. The GROUP itself
 *  (this whole page) is just as editable — see loadCompetencyGroupsFromRulebook's own
 *  doc comment for adding/removing/renaming a category by adding/removing/renaming its
 *  page. */
function _competencyListHtml(group) {
  return `<ul>${group.competencies.map((c) => `<li>${c}</li>`).join("")}</ul>`;
}

function _competenciesOverviewPage() {
  return `
    <p>Каждая страница этого раздела (кроме этой, «Обзор») — одна категория компетенций из шага их выбора в Мастере создания персонажа, со списком её тегов в виде маркированного списка.</p>
    <p>Список внутри страницы можно свободно редактировать: переименовать существующий тег (изменить текст пункта списка), добавить новый (добавить пункт списка), убрать (удалить пункт списка) или поменять порядок (перетащить пункт) — Мастер создания персонажа подхватит изменения сам после перезагрузки. Текст до и после списка не разбирается — важен только сам список; удалить его целиком значит вернуть эту категорию к пустому списку (сама категория останется).</p>
    <p>Сами категории — тоже не фиксированы: можно добавить новую страницу — это будет новая категория; удалить страницу — категория исчезнет; переименовать страницу — категория переименуется, но карточки классов, у которых эта категория была отмечена под старым именем (см. лист класса, кнопка «Добавить категорию»), эту отметку потеряют и потребуют выбрать заново под новым именем. Страница «Обзор» в счёт категорий не идёт — это просто вступительный текст, её содержимое никогда не разбирается.</p>
  `;
}

/** Seed the "Компетенции" rules journal entry — one page per GOD.COMPETENCY_GROUPS entry
 *  (page name === the group's own `name`, e.g. "Боевые (ближний бой)"), pre-filled from
 *  the live table (config.mjs) so the initial text can never drift from what the
 *  character builder actually offers before a GM edits anything. Same idempotent-by-name
 *  + seed-registry protection as the other rules journal entries above. */
async function seedCompetenciesJournal() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;

  const packName = "journal";
  const folderName = "Правила";
  const entryName = "Компетенции";

  const index = await pack.getIndex({ fields: ["folder"] });
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet(packName);

  if (existingByName.has(entryName) || alreadySeeded.has(entryName)) {
    await _markSeeded(packName, [entryName]);
    return;
  }

  let folder = pack.folders?.find((f) => f.name === folderName);
  if (!folder) {
    folder = await Folder.create({ name: folderName, type: "JournalEntry" }, { pack: pack.collection });
  }

  await pack.documentClass.createDocuments([{
    name: entryName,
    folder: folder?.id ?? null,
    pages: [
      { name: "Обзор", type: "text", text: { content: _competenciesOverviewPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      ...GOD.COMPETENCY_GROUPS.map((group) => ({
        name: group.name,
        type: "text",
        text: { content: _competencyListHtml(group), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
      })),
    ],
  }], { pack: pack.collection });
  console.log("god-tactical | Seeded rules journal entry (Компетенции)");

  await _markSeeded(packName, [entryName]);
}

async function seedRulesJournal() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;

  const packName = "journal";
  const folderName = "Правила";
  const entryName = "Характеристики и навыки";

  const index = await pack.getIndex({ fields: ["folder"] });
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet(packName);

  if (existingByName.has(entryName) || alreadySeeded.has(entryName)) {
    await _markSeeded(packName, [entryName]);
    return;
  }

  let folder = pack.folders?.find((f) => f.name === folderName);
  if (!folder) {
    folder = await Folder.create({ name: folderName, type: "JournalEntry" }, { pack: pack.collection });
  }

  await pack.documentClass.createDocuments([{
    name: entryName,
    folder: folder?.id ?? null,
    pages: [
      { name: "Характеристики", type: "text", text: { content: _charPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Навыки", type: "text", text: { content: _skillsPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Ранги навыков", type: "text", text: { content: _ranksPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Опыт и покупка", type: "text", text: { content: _xpPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
    ],
  }], { pack: pack.collection });
  console.log("god-tactical | Seeded rules journal entry (характеристики и навыки)");

  await _markSeeded(packName, [entryName]);
}

/**
 * One-time upgrade for a "Характеристики и навыки" entry that was already seeded BEFORE
 * this system started reading per-characteristic/skill [bracket] hints from it (see
 * config.mjs's loadSkillMapDescsFromRulebook) — seedRulesJournal's own idempotent-by-
 * entry-name gate skips an entry that already exists, so an older world's copy never
 * picks up the new "Навыки" page or the new per-characteristic block on "Характеристики"
 * just from a reload; without this, loadSkillMapDescsFromRulebook silently finds nothing
 * to read on either page and a GM editing what LOOKS like the right spot (the plain
 * summary table, or a page that isn't there yet) sees no effect at all. Safe to call on
 * every load — each piece is added/fixed only if it's actually still missing:
 *  - "Навыки" page: created from scratch if it doesn't exist yet (pure addition, never
 *    touches an existing one — a GM's own edits to it, once it exists, are never
 *    touched again by this).
 *  - "Характеристики" page: the per-characteristic heading+[bracket] block is APPENDED
 *    to whatever's already there if none of the four characteristic names shows up as
 *    an <h3> yet (detected by name, so it's a one-shot addition, not overwritten again
 *    once present); its own pre-existing "Диапазон"/"Стоимость очка" (and this system's
 *    own even-older "Описания характеристик") section headings get downgraded from <h3>
 *    to <h2> if they're still <h3> — on an old page they'd otherwise collide with the
 *    new positional <h3> matching (see rulebook-hints.mjs's extractHeadingSequence) and
 *    throw every characteristic's name/hint onto the wrong one.
 */
async function migrateCharSkillsJournalPages() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;
  const index = await pack.getIndex();
  const entryIndex = index.find((e) => e.name === "Характеристики и навыки");
  if (!entryIndex) return;
  const entry = await pack.getDocument(entryIndex._id);
  if (!entry) return;

  if (!entry.pages.find((p) => p.name === "Навыки")) {
    await entry.createEmbeddedDocuments("JournalEntryPage", [{
      name: "Навыки",
      type: "text",
      text: { content: _skillsPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
    }]);
    console.log("god-tactical | Migrated rules journal (Характеристики и навыки): added «Навыки» page");
  }

  const charPage = entry.pages.find((p) => p.name === "Характеристики");
  if (!charPage) return;

  let content = charPage.text?.content ?? "";
  let changed  = false;

  const hasCharBlocks = Object.values(GOD.SKILL_MAP).every((cat) => content.includes(`<h3>${cat.name}</h3>`));
  if (!hasCharBlocks) {
    content +=
      `<h2>Характеристики</h2>` +
      `<p>Наведите курсор на характеристику на листе персонажа, чтобы увидеть подсказку о том, что она означает — текст подсказки берётся прямо из фразы в [квадратных скобках] под заголовком характеристики ниже, а САМ заголовок — это её отображаемое имя. Оба можно свободно переписывать (в том числе на другом языке, включая переименование самой характеристики) — правки в игре применятся сами после перезагрузки. Ниже должно остаться ровно 3 заголовка третьего уровня (<code>&lt;h3&gt;</code>), по одному на характеристику, в этом порядке — не добавляйте, не убирайте и не переставляйте их местами (для собственных заметок используйте другой уровень заголовка, например <code>&lt;h2&gt;</code> или <code>&lt;h4&gt;</code>), иначе следующие за пропавшим/новым заголовком характеристики съедут не на ту характеристику. Удаление скобок или всего блока для конкретной характеристики просто возвращает ЕЁ ОДНУ к встроенным имени/подсказке по умолчанию — остальные две и вся прочая страница не пострадают.</p>` +
      _charDescsHtml();
    changed = true;
  }
  for (const legacyHeading of ["Диапазон", "Стоимость очка", "Описания характеристик"]) {
    const h3 = `<h3>${legacyHeading}</h3>`;
    if (content.includes(h3)) {
      content = content.replaceAll(h3, `<h2>${legacyHeading}</h2>`);
      changed = true;
    }
  }
  if (changed) {
    await charPage.update({ "text.content": content });
    console.log("god-tactical | Migrated rules journal (Характеристики и навыки): updated «Характеристики» page");
  }

  // "Ранги навыков"/"Опыт и покупка" carry no GM-editable convention at all (unlike
  // Характеристики/Навыки above, which preserve a GM's own heading/bracket edits) — every
  // word on them is generated straight from the live GOD.* tables. So instead of trying to
  // detect "is this page stale" (fragile — depends on exact old wording matching, which is
  // exactly what silently failed to fire after the 0–5 → 0–4 rank rework), just keep them
  // unconditionally in sync with the current tables on every load. Cheap (a string
  // compare + a no-op write when already current) and can never go stale again regardless
  // of what future balance pass changes these numbers.
  const ranksPage = entry.pages.find((p) => p.name === "Ранги навыков");
  const freshRanksPage = _ranksPage();
  if (ranksPage && ranksPage.text?.content !== freshRanksPage) {
    await ranksPage.update({ "text.content": freshRanksPage });
    console.log("god-tactical | Migrated rules journal (Характеристики и навыки): refreshed «Ранги навыков» page");
  }
  const xpPage = entry.pages.find((p) => p.name === "Опыт и покупка");
  const freshXpPage = _xpPage();
  if (xpPage && xpPage.text?.content !== freshXpPage) {
    await xpPage.update({ "text.content": freshXpPage });
    console.log("god-tactical | Migrated rules journal (Характеристики и навыки): refreshed «Опыт и покупка» page");
  }
}

// Bumped 2026-08-19 for the Рефлексы-retirement restructure below — stamped as a flag on
// the journal entry once migrateSkillMapStructureV2 has run, so it only ever fires once
// even though everything else in this file re-runs on every load. v2→v3 the same day: the
// original v2 pass used a single indexOf/slice splice that (confirmed live, two GM
// clients apparently racing the very first run) could leave a duplicated "Характеристики"
// block with the old Рефлексы heading still in it instead of cleanly replacing it — v3's
// rewrite strips ALL matching blocks via a global regex first, so it self-heals a world
// that already limped through the broken v2 pass, not just a pristine one.
// v3→v4, same day: v3 itself left one cosmetic empty <h2></h2> dangling where the old
// block used to sit (confirmed live right after the v3 fix ran) — v4 sweeps that up too.
// v4→v5, 2026-08-21: biodynamics/ПЛОТЬ renamed to corpus/КОРПУС (config.mjs). Same reasoning
// as v1→v2 below — an already-seeded world's "Характеристики" page still has the old
// "ПЛОТЬ" <h3> text, which breaks migrateCharSkillsJournalPages' name-based hasCharBlocks
// check (its every() over GOD.SKILL_MAP's CURRENT names fails on the one renamed entry,
// so it appends a whole second duplicate block instead of just fixing the one heading) —
// this version-gated destructive regen is what actually fixes it, self-healing that
// duplicate in the same pass since it strips every matching block first.
const SKILL_MAP_STRUCTURE_VERSION = 5;

/**
 * One-shot, DESTRUCTIVE regen of the "Характеристики"/"Навыки" pages' auto-generated
 * sections, for when the skill/characteristic ROSTER itself changes shape (a
 * characteristic or skill added/removed/merged) — not just wording. migrateChar-
 * SkillsJournalPages above is deliberately additive-only (it preserves a GM's own
 * heading/bracket rewrites, so it only ever ADDS a block that's missing, never removes or
 * reorders one) — that can't repair a heading whose underlying skill no longer exists at
 * all: an already-seeded world's "Навыки" page still carries 16 <h4>s and "Характеристики"
 * still carries the retired characteristic's own <h3> block, so loadSkillMapDescsFromRulebook's
 * POSITIONAL matching (config.mjs) would silently throw every Плоть skill's name/hint onto
 * the WRONG skill (its new 4-skill block no longer lines up with the old headings' order).
 * Only the two auto-generated pieces are touched — "Навыки" is fully regenerated (there's
 * no way to know which of its old headings' GM edits, if any, still apply to a
 * restructured roster), "Характеристики"'s per-char <h3> block section is cut back to just
 * the CURRENT roster's own descs — everything else on that page (intro table, Диапазон/
 * Стоимость очка sections, a GM's own free-form additions elsewhere) is left alone.
 */
async function migrateSkillMapStructureV2() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;
  const index = await pack.getIndex();
  const entryIndex = index.find((e) => e.name === "Характеристики и навыки");
  if (!entryIndex) return;
  const entry = await pack.getDocument(entryIndex._id);
  if (!entry) return;
  if ((entry.getFlag("god-tactical", "skillMapStructureVersion") ?? 1) >= SKILL_MAP_STRUCTURE_VERSION) return;

  const skillsPage = entry.pages.find((p) => p.name === "Навыки");
  if (skillsPage) {
    await skillsPage.update({ "text.content": _skillsPage() });
  }

  const charPage = entry.pages.find((p) => p.name === "Характеристики");
  if (charPage) {
    const content = charPage.text?.content ?? "";
    // Strip EVERY existing "<h2>Характеристики</h2> ... (up to the next <h2> or end)"
    // span — global, not just the first — so this is safe to re-run even against an
    // already-duplicated page (e.g. two GM clients racing this same one-shot migration
    // the first time it ran, both reading the pre-migration content before either write
    // landed, each appending their own copy). Whatever's left (intro table, Диапазон/
    // Стоимость очка, any GM free-form addition) is untouched; a single freshly
    // generated block for the CURRENT roster is appended once at the end.
    const stripped = content
      .replace(/<h2>Характеристики<\/h2>[\s\S]*?(?=<h2>|$)/g, "")
      // A stray empty <h2></h2> can be left dangling right where a removed block used to
      // sit (confirmed live after the v2→v3 fix above) — harmless to loadSkillMapDescs-
      // FromRulebook (only <h3>/<h4> are ever counted) but worth sweeping up too.
      .replace(/<h2>\s*<\/h2>/g, "");
    const introP = `<p>Наведите курсор на характеристику на листе персонажа, чтобы увидеть подсказку о том, что она означает — текст подсказки берётся прямо из фразы в [квадратных скобках] под заголовком характеристики ниже, а САМ заголовок — это её отображаемое имя. Оба можно свободно переписывать (в том числе на другом языке, включая переименование самой характеристики) — правки в игре применятся сами после перезагрузки. Ниже должно остаться ровно 3 заголовка третьего уровня (<code>&lt;h3&gt;</code>), по одному на характеристику, в этом порядке — не добавляйте, не убирайте и не переставляйте их местами (для собственных заметок используйте другой уровень заголовка, например <code>&lt;h2&gt;</code> или <code>&lt;h4&gt;</code>), иначе следующие за пропавшим/новым заголовком характеристики съедут не на ту характеристику. Удаление скобок или всего блока для конкретной характеристики просто возвращает ЕЁ ОДНУ к встроенным имени/подсказке по умолчанию — остальные две и вся прочая страница не пострадают.</p>`;
    const rebuilt = `${stripped}<h2>Характеристики</h2>${introP}${_charDescsHtml()}`;
    if (rebuilt !== content) await charPage.update({ "text.content": rebuilt });
  }

  await entry.setFlag("god-tactical", "skillMapStructureVersion", SKILL_MAP_STRUCTURE_VERSION);
  console.log(`god-tactical | Migrated rules journal (Характеристики и навыки): rebuilt for structure v${SKILL_MAP_STRUCTURE_VERSION}`);
}

/* -------------------------------------------- */
/*  Rules journal: Intro Rules (Вводные правила) */
/* -------------------------------------------- */

function _introDicePage() {
  return `
    <p>В игре используется один тип кубов — <strong>d100</strong> (процентник). Другие кубы для проверок не применяются.</p>
  `;
}

function _introChecksPage() {
  return `
    <p>Все проверки в игре выполняются кубом <strong>d100</strong>, который собирается из двух десятигранных кубиков: один определяет десятки, другой — единицы.</p>
    <h3>Система проверки</h3>
    <p>Все проверки выполняются по принципу «<strong>d100 roll under</strong>»:</p>
    <ol>
      <li>Игрок бросает d100.</li>
      <li>Если результат броска <strong>меньше или равен</strong> значению навыка — проверка успешна. Если результат <strong>больше</strong> значения навыка — проверка провалена.</li>
    </ol>
    <p>Результат, равный значению навыка, всегда считается успехом.</p>
    <p><strong>Потолки значений:</strong> навык не может превышать <strong>75</strong>, характеристика не может превышать <strong>90</strong>. Это жёсткие верхние границы: никакие бонусы, эффекты, экипировка или развитие не могут поднять значение выше. Если эффект должен поднять значение сверх потолка, избыток игнорируется.</p>
    <blockquote><p><strong>Принцип односторонних бросков:</strong> проверки совершают только игроки. Персонажи мастера и игровой мир не совершают бросков. Сложность ситуации выражается не встречным броском, а наложением негативных эффектов, модификаторов или иных условий, определяемых правилами и мастером.</p></blockquote>
    <h3>Градации результата</h3>
    <p>Каждая проверка имеет один из четырёх результатов. Градация определяется <strong>строго по выпавшему результату броска</strong>, до применения любых эффектов.</p>
    <p><strong>Дубль</strong> — результат, у которого обе цифры совпадают: 11, 22, 33, 44, 55, 66, 77, 88, 99 и 00 (100). Триумф и фиаско наступают <strong>только на дублях</strong>.</p>
    <ul>
      <li><strong>Триумф</strong> — дубль, выпавший <strong>в зоне успеха</strong> (меньше или равен значению навыка или характеристики), при условии, что персонаж <strong>обладает компетенцией</strong> в данной проверке (см. «Компетенция»). Без компетенции дубль в зоне успеха считается обычным успехом и никаких дополнительных эффектов не даёт.</li>
      <li><strong>Успех</strong> — результат меньше или равен значению навыка, не являющийся триумфом.</li>
      <li><strong>Провал</strong> — результат больше значения навыка, не являющийся фиаско.</li>
      <li><strong>Фиаско</strong> — дубль, выпавший <strong>в зоне провала</strong> (больше значения навыка или характеристики). Фиаско наступает <strong>всегда</strong>, независимо от наличия компетенции.</li>
    </ul>
    <p>Каждый бросок имеет ровно одну градацию; градации не накладываются друг на друга. Триумф является разновидностью успеха, фиаско — разновидностью провала: все эффекты, срабатывающие «на успех», срабатывают и на триумф, если прямо не указано иное; то же справедливо для провала и фиаско.</p>
    <p>То, что даёт каждая градация, зависит от типа действия (Strife или Drama) и определяется соответствующими таблицами результатов.</p>
    <h3>Что считать сценой</h3>
    <p><strong>Сцена</strong> — это непрерывный отрезок игрового времени, в котором неизменны три элемента: место действия, состав значимых участников и драматический фокус (то, о чём эта сцена). Сцена заканчивается, как только изменился хотя бы один из трёх элементов. Иных условий окончания сцены не существует.</p>
    <p>Конкретные триггеры окончания сцены (список не исчерпывающий, а иллюстративный):</p>
    <ul>
      <li>бой завершён (все противники повержены, произошло бегство или начались переговоры);</li>
      <li>партия покинула локацию;</li>
      <li>произошёл значимый временной скачок («через час», «на следующее утро»);</li>
      <li>социальная сцена логически завершилась (собеседник ушёл, тема исчерпана);</li>
      <li>мастер объявил переход к новой сцене.</li>
    </ul>
    <p>Длительность сцены — рычаг темпа в руках мастера. Затянутая сцена даёт игроку больше времени прожить срыв и сделать выбор; короткая — давит.</p>
  `;
}

function _introAdvantagePage() {
  return `
    <p>Внешние обстоятельства могут облегчить или усложнить проверку. Преимущество и недостаток определяет мастер до броска.</p>
    <ul>
      <li><strong>Механика:</strong> при преимуществе или недостатке игрок бросает базовый d100 <strong>плюс</strong> дополнительные d100. Количество дополнительных кубов — не более двух. Таким образом, суммарный бросок никогда не превышает <strong>3d100</strong>.</li>
      <li><strong>Выбор результата:</strong> из всех выпавших результатов игрок выбирает <strong>один</strong>. При преимуществе — наиболее выгодный для себя, при недостатке — наименее выгодный. Выбранный результат и является результатом проверки; остальные кубы отбрасываются и никак не учитываются.</li>
      <li><strong>Транзитивность:</strong> если противник получает недостаток, то все, кто выступает против него в этой проверке, получают преимущество, и наоборот. Одна и та же ситуация не может дать одному участнику одновременно преимущество и недостаток.</li>
      <li>Преимущество и недостаток не суммируются сами с собой: сколько бы обстоятельств ни складывалось в одну сторону, максимум — два дополнительных куба.</li>
    </ul>
  `;
}

function _introHelpPage() {
  return `
    <p>Несколько персонажей могут совместно выполнить одну проверку. Правила помощи:</p>
    <ol>
      <li>Участие в помощи объявляется <strong>до</strong> любых бросков. После первого броска присоединиться к проверке нельзя.</li>
      <li>Помогать может только персонаж, который в рамках фикции способен содействовать выполнению задачи. Допустимость помощи определяет мастер.</li>
      <li>Каждый участник совершает <strong>свою собственную проверку</strong> по применяемому навыку.</li>
      <li>Если <strong>хотя бы один</strong> участник добился успеха — совместная проверка успешна.</li>
      <li>Если <strong>хотя бы один</strong> участник выбросил фиаско — совместная проверка провалена, <strong>независимо от успехов остальных</strong>. Фиаско имеет приоритет над любым количеством успехов.</li>
    </ol>
  `;
}

function _introCompetencyPage() {
  return `
    <p>Компетенция описывает, что персонаж умеет на профессиональном уровне, и действует двумя способами:</p>
    <ul>
      <li><strong>Автоматический успех.</strong> Задача, тривиальная для специалиста данной профессии, не требует проверки и считается автоматически успешной. Опытный взломщик не бросает на обычный замок; хирург не бросает на перевязку. Тривиальность задачи не вычисляется по формуле — её определяет мастер в контексте сцены, исходя из профессиональной логики.</li>
      <li><strong>Доступ к триумфу.</strong> При проверке в рамках своей компетенции персонаж получает возможность выбросить триумф.</li>
    </ul>
    <h3>Соответствие навыка задаче</h3>
    <p>Для проверки применяется навык, соответствующий характеру задачи в фикции, а не навык, привычный по названию. Если обстоятельства меняют суть задачи, мастер вправе заменить применяемый навык до броска, объявив замену и её причину игрокам.</p>
    <blockquote><p><strong>Пример:</strong> ближний бой под водой. Вместо навыка «Контакт» применяется «Ловкость»: в плотной среде важнее умение контролировать собственное тело, чем мастерство владения клинком.</p></blockquote>
  `;
}

function _introResourcesPage() {
  return `
    <p>У игры две валюты последствий. <strong>Grit — то, что тратит персонаж. Doom — то, что мир предъявляет персонажу.</strong></p>
    <h3>Grit</h3>
    <p><strong>Grit</strong> — решимость персонажа настоять вопреки чужому выбору: запас воли, которой он ломает, давит и доминирует.</p>
    <p>Grit — это одновременно:</p>
    <ul>
      <li><strong>топливо</strong> манёвров и заклинаний;</li>
      <li><strong>цена определённости</strong> — откуп провала в действиях типа Strife: персонаж перевешивает чужую волю своей и покупает результат;</li>
      <li><strong>буфер, принимающий урон на себя</strong> — пока у персонажа есть решимость доминировать, он ещё стоит; урон не затрагивает здоровье вообще, пока Grit не исчерпан полностью. Очки здоровья уменьшаются только при нулевом Grit: решимость кончилась — теперь гнут тебя.</li>
    </ul>
    <p>Базовое значение Grit одинаково для всех персонажей и равно <strong>5</strong>. Броня добавляет к запасу Grit: надетая защита — это готовность давить, не боясь ответки. Значение Grit текущее: оно тратится и восстанавливается по правилам ниже.</p>
    <p><strong>Восстановление Grit.</strong> Внутри сцены потраченный Grit восстанавливается только тактическим манёвром, один раз за сцену. При переходе к новой сцене в условиях безопасности Grit восстанавливается полностью, до значения базы и брони. <strong>Сгоревший</strong> Grit (см. правила уязвимостей брони) не восстанавливается ни манёвром, ни сменой сцены — только по окончании боя.</p>
    <h3>Doom</h3>
    <p><strong>Doom</strong> — мера натяжения между партией и миром: накопленный долг последствий. Doom — это то, как мир отвечает на то, что делают персонажи: чем выше Doom, тем тяжелее и быстрее наступают последствия <strong>любых</strong> действий — независимо от их типа. Низкий Doom — мир терпелив, ошибки прощаются, обстоятельства мягки. Высокий Doom — мир бьёт в ответ жёстко: стража приходит быстрее, цены растут, случайности оборачиваются против партии.</p>
    <p>Счётчик Doom ведётся от 0 до <strong>100</strong>. Doom изменяется результатами проверок типа Drama (фиаско поднимает, триумф снижает), повторными попытками действий, отложенными последствиями решений и объявлениями мастера, а уменьшается применением утяжелений (см. ниже). Doom — <strong>индивидуальный ресурс</strong>: у каждого персонажа свой счётчик, общего Doom у партии нет.</p>
    <h3>Как работает Doom</h3>
    <p>Doom — это <strong>обречённость</strong>: мера того, насколько сильно мир гнёт именно этого персонажа. Это не репутация и не известность: мир может вовсе не знать персонажа, но реагирует на него жёстче — как на человека, по которому видно, что удача его оставила.</p>
    <p><strong>Doom не действует пассивно.</strong> Высокий Doom не даёт штрафов к броскам, не меняет значений навыков и не отравляет каждую сцену сам по себе. Doom включается ровно в один момент: <strong>когда мир или мастер выставляет персонажу условие</strong> — цену, требование, последствие. Тогда Doom определяет, какое утяжеление мастер вправе добавить <strong>сверх</strong> задуманного, — надбавку за обречённость, а не саму цену.</p>
    <p><strong>Полосы Doom.</strong> Базовая тяжесть условия всегда определяется замыслом мастера и логикой сцены: если решения игроков привели их к суровой цене, она будет суровой при любом Doom. Полосы не ограничивают мастера в этом — они определяют, какое <strong>дополнительное</strong> утяжеление мастер вправе наложить сверх уже задуманной цены, ссылаясь именно на обречённость персонажа:</p>
    <ul>
      <li><strong>0–9 — Штиль.</strong> Doom не участвует: условия идут как задумано, без надбавок.</li>
      <li><strong>10–19 — Шторм.</strong> Мастер вправе добавить <strong>одно малое</strong> утяжеление.</li>
      <li><strong>20–30 — Слом.</strong> Мастер вправе добавить <strong>одно значимое</strong> утяжеление.</li>
    </ul>
    <p><strong>Меню утяжелений.</strong> Мастер выбирает утяжеление из закрытого списка и не изобретает наказаний вне его:</p>
    <ul>
      <li><strong>Малые</strong> (Шторм): повышенная цена; дополнительное требование в моменте (залог, предоплата, сдача оружия на входе).</li>
      <li><strong>Значимые</strong> (Слом): всё малые, а также сокращённый срок; отказ в доверии (условие действует дальше этой сцены); свидетель, который всё запомнит; требование поручителя.</li>
    </ul>
    <p><strong>Утяжеление стоит Doom.</strong> Применённое утяжеление списывается со счётчика персонажа: малое — <strong>10 Doom</strong>, значимое — <strong>20 Doom</strong>. Списание происходит <strong>в момент объявления</strong> и не зависит от того, принял персонаж условие или отказался: мир свой счёт предъявил, часть долга погашена. Мастер не назначает цену произвольно: тариф определяется выбранным пунктом меню. Если Doom после списания опустился ниже границы полосы, персонаж переходит в более мягкую полосу — мир высказался и отпустил.</p>
    <p>Всё, что вне меню, — это уже не Doom, а фикция сцены, и она играется по обычным правилам.</p>
    <p><strong>Утяжеление гасит Doom.</strong> Применение утяжеления — это мир, предъявивший счёт обречённому: малое утяжеление снижает Doom персонажа на <strong>10</strong>, значимое — на <strong>20</strong>. Списание происходит <strong>при объявлении утяжеления</strong> и не зависит от того, принял игрок условие или отказался: мир свой счёт предъявил, и долг частично погашен. Мастер не назначает цену списания сам — она определяется выбранным пунктом меню.</p>
    <p><strong>Предохранители от произвола:</strong></p>
    <ol>
      <li>На одно условие — не более одного утяжеления, независимо от Doom.</li>
      <li>Утяжеление объявляется <strong>до проверки и открыто</strong>, с указанием на Doom как причину.</li>
      <li>Условие — предложение, а не приговор: персонаж вправе отказаться и принять последствия отказа. Отказ сам по себе Doom не повышает.</li>
      <li>Doom никогда не превращает успех в провал и не отменяет результат броска: он работает с ценой и последствиями, а не с исходом проверки.</li>
    </ol>
    <h3>Примеры работы Doom</h3>
    <p>Во всех примерах базовое условие — замысел мастера, одинаковый при любом Doom; меняется только надбавка.</p>
    <p><strong>Найм проводника.</strong> Базовая цена — 10 монет, так задумано.</p>
    <ul>
      <li><em>Штиль:</em> 10 монет, и всё.</li>
      <li><em>Шторм:</em> «15 и предоплата. Половину вперёд, а то сбежите» — повышенная цена плюс требование в моменте.</li>
      <li><em>Слом:</em> «20, предоплата, и мой племянник пойдёт с вами — присмотрит» — значимое: свидетель при условии.</li>
    </ul>
    <p><strong>Просьба о ночлеге у придорожного трактирщика.</strong> Базовое условие — место в общем зале.</p>
    <ul>
      <li><em>Штиль:</em> «Располагайтесь».</li>
      <li><em>Шторм:</em> «Зал полон, но за лишнюю монету найдётся угол» — повышенная цена.</li>
      <li><em>Слом:</em> «Ночуйте, но оружие сдадите мне, а уходите — не возвращайтесь» — отказ в доверии: условие живёт дальше сцены.</li>
    </ul>
    <p><strong>Последствие провала: персонажа поймала стража на взломе.</strong> Базовое последствие по замыслу мастера — ночь в участке и штраф.</p>
    <ul>
      <li><em>Штиль:</em> ночь и штраф, как задумано.</li>
      <li><em>Шторм:</em> сверху — штраф вырос вдвое, «рецидивист, небось».</li>
      <li><em>Слом:</em> сверху — имя персонажа занесено в журнал стражи: свидетель, который всё запомнит.</li>
    </ul>
    <p><strong>Стихия: буря застала отряд в горах.</strong> Проверка выносливости идёт для всех; базовая цена провала по замыслу мастера — потерянные припасы.</p>
    <ul>
      <li><em>Штиль:</em> припасы, и всё.</li>
      <li><em>Шторм:</em> сверху — персонаж с Doom теряет ещё и тёплый плащ: обречённому буря срывает больше.</li>
      <li><em>Слом:</em> сверху — он же отстаёт, и отряд вынужден выбирать: ждать его или идти дальше.</li>
    </ul>
    <p><strong>Удачная сделка.</strong> Даже успех не отменяет надбавку: контракт подписан (бросок успешен, результат не трогаем), но при Сломе контрагент сверху потребовал поручителя — «дело ваше, а душа у вас неспокойная».</p>
    <p>Обратите внимание: во всех случаях мастер объявил надбавку до разрешения, назвал Doom причиной, выбрал утяжеление из меню и ограничился одним. Игрок в каждом примере мог отказаться от условия и пойти искать другого проводника, трактирщика или обходную тропу — с последствиями отказа, но без роста Doom.</p>
  `;
}

function _introStrifeDramaPage() {
  return `
    <p>Каждое действие, требующее проверки, относится ровно к одному из двух типов: <strong>Strife</strong> или <strong>Drama</strong>. Третьего типа не существует; действие не может быть обоими типами одновременно.</p>
    <p>Тип определяется <strong>не тем, что делает персонаж, не тем, идёт ли бой, и не тем, наносится ли урон, — а тем, чем задаётся сложность действия</strong>.</p>
    <ul>
      <li><strong>Strife</strong> — действие, чья сложность определяется <strong>существом</strong>: его характеристиками, телом, волей или разумом. Осознание и враждебность цели роли не играют: Strife остаётся Strife как при открытом сопротивлении (враг паррирует удар), так и при полном неведении цели (удар в спину, чары, ломающие волю без её ведома).</li>
      <li><strong>Drama</strong> — действие, чья сложность определяется <strong>обстоятельствами</strong>. У Drama нет существа, чьи свойства персонажу противостоят. Обстоятельства — это, например:
        <ul>
          <li><strong>среда</strong> — скользкая стена, которую нужно преодолеть; темнота, в которой ищешь дверь;</li>
          <li><strong>время</strong> — успеть разминировать заряд до взрыва, закончить ритуал до рассвета;</li>
          <li><strong>расстояние</strong> — достать броском до уходящей лодки, допрыгнуть до дальнего края пропасти;</li>
          <li><strong>техника</strong> — вскрыть замок, сплести заклинание, выковать клинок: сложность задаётся мастерством исполнителя и сложностью самой задачи;</li>
          <li><strong>отношения</strong> — убедить союзника, который тебе доверяет, проще, чем того, кто тебя терпеть не может;</li>
          <li><strong>настроение</strong> — толпа после поражения податлива к подстрекательству, толпа на празднике — нет;</li>
          <li><strong>репутация</strong> — просить о милости проще, когда о тебе ходят добрые слухи;</li>
          <li><strong>состояние дел</strong> — выторговать хлеб в голодный год, найти проводника в городе, где идут облавы.</li>
        </ul>
      </li>
    </ul>
    <h3>Порядок определения типа</h3>
    <p>Мастер определяет тип действия двумя вопросами, строго в этом порядке:</p>
    <ol>
      <li><strong>Затронуты ли тело, воля или разум конкретного существа так, что его свойства задают сложность действия?</strong> Нет — действие <strong>Drama</strong>. Вопросы закончились.</li>
      <li><strong>Сохраняется ли у этого существа выбор?</strong> Может ли оно, оставаясь в здравом уме, отказаться и принять последствия? Да — действие <strong>Drama</strong>. Нет, выбор минуется, отключается или ломается — действие <strong>Strife</strong>.</li>
    </ol>
    <p>Решение мастера о типе действия является окончательным и объявляется <strong>до броска</strong>.</p>
    <h3>Граница воли</h3>
    <p>Второй вопрос — самое тонкое место системы, поэтому он зафиксирован отдельно.</p>
    <ul>
      <li><strong>Эффект проходит через решение существа</strong> — оно взвешивает, боится, сомневается, ошибается и в итоге само выбирает, пусть под давлением: это <strong>Drama</strong>. Убеждение, обман, запугивание, угроза, шантаж, соблазнение, торг — цена отказа может быть чудовищной, но точка отказа существует.</li>
      <li><strong>Эффект достигается вопреки решению существа</strong> — его выбор минуется, отключается или перезаписывается: это <strong>Strife</strong>. Удар, захват, заклинания подчинения, очарования, паралича, чтения мыслей, проклятия — точки отказа нет, как бы мягко действие ни выглядело.</li>
    </ul>
    <p>Жестокость или мягкость действия на тип не влияет. Пытка — Drama: цель выбирает заговорить. Невидимое лёгкое заклинание доверия — Strife: цель не выбирает доверять.</p>
    <h3>Тип действия и бой</h3>
    <p>Проверка типа Strife <strong>не начинает бой</strong> сама по себе. Бой начинается с открытого насилия, осознанного участниками, и объявляется мастером. Провал или фиаско Strife-проверки вне боя может привести к немедленному бою или к отложенным последствиям — по решению мастера, исходя из характера цели и ситуации.</p>
    <p>Одно и то же действие может быть Strife в одной ситуации и Drama в другой: тип определяется заново при каждом действии, а не закрепляется за навыком, заклинанием или приёмом.</p>
    <h3>Повторные попытки воздействия</h3>
    <p>После провала или фиаско проверки повторная попытка <strong>того же действия тем же способом в тех же обстоятельствах</strong> имеет цену: каждая такая попытка <strong>поднимает Doom на 5</strong> независимо от её результата. Цель насторожена, время уходит, мир замечает давление — и это фиксируется в Doom.</p>
    <p><strong>Другой способ — новая попытка без цены.</strong> Если персонаж меняет подход (не уговаривал — пригрозил; не угрожал — предложил взятку; не взятку — нашёл компромат), это новое воздействие, и повторная проверка идёт без штрафа к Doom. Способ считается другим, если в фикции изменился рычаг воздействия, а не только формулировка; оценивает мастер.</p>
    <p>Это правило распространяется на <strong>любые</strong> проверки, а не только на воздействие на существ: каждая повторная попытка того же действия в неизменных обстоятельствах поднимает Doom, будь то уговоры, взлом замка или прыжок через пропасть. Мир не стоит на месте, пока персонаж долбится в одну точку: время уходит, стража приближается, удача истощается. Это защищает темп игры: нельзя остановить повествование бесконечными перебросами одной проверки.</p>
    <p><strong>Существенное изменение обстоятельств</strong> прерывает цепочку повторов: персонаж достал отмычки, подоспела подмога, исполнил угрозу на глазах у цели, началась новая сцена. Последующая попытка снова считается первой и штрафа к Doom не несёт. Сам накопленный Doom при этом не уменьшается — он гасится только способами, предусмотренными своими правилами (триумф Drama и т. п.); прерывание цепочки лишь прекращает его рост от повторов. Переброс в тех же условиях с тем же подходом — это не новая попытка, а повтор, и он оплачивается Doom'ом.</p>
    <p>Действия типа Strife оплачивают повторы через Grit по своим таблицам и дополнительного штрафа к Doom за повтор не получают.</p>
    <h3>Примеры: боевые действия</h3>
    <p><strong>Strife:</strong></p>
    <ul>
      <li>Удар любым оружием по противнику; выстрел; метание.</li>
      <li>Удар по застигнутому врасплох, спящему или связанному врагу — цель не сопротивляется, но сложность задают её тело и защита.</li>
      <li>Захват и удержание; толчок; опрокидывание; выбивание оружия.</li>
      <li>Высвобождение из чужого захвата — противодействуют сила и воля держащего.</li>
      <li>Перехват убегающего; срыв врага с лестницы; оттеснение от двери.</li>
    </ul>
    <p><strong>Drama:</strong></p>
    <ul>
      <li>Перепрыгнуть пропасть, перебраться через стену, перейти по узкой балке — вне боя.</li>
      <li>То же самое посреди боя, если никто конкретный не мешает перемещению.</li>
      <li>Удержаться на ногах в шторм; переплыть реку; пробежать по обрушающемуся мосту.</li>
      <li>Срезать падающую люстру, чтобы она упала на врага, — сложность задают верёвка и расчёт, а не воля врага (его уклонение под люстрой — уже его защита по правилам боя).</li>
    </ul>
    <h3>Примеры: социальные взаимодействия</h3>
    <p><strong>Drama (выбор у цели сохраняется):</strong></p>
    <ul>
      <li>Убедить совет, доказать свою правоту в споре, вдохновить войско речью.</li>
      <li>Выторговать цену, заключить сделку, добиться аудиенции.</li>
      <li>Солгать стражнику, выдать себя за чиновника, поддержать легенду прикрытия.</li>
      <li>Запугать рассказом о последствиях, пригрозить расправой, шантажировать компроматом.</li>
      <li>Соблазнить, расположить к себе, снискать доверие со временем.</li>
      <li>Угадать настроение собеседника, заметить ложь, прочитать зал — цель ничего не теряет от того, что её читают.</li>
    </ul>
    <p><strong>Strife (выбор цели минуется):</strong></p>
    <ul>
      <li>Очарование, подчинение, внушение, наложенные магией: цель не выбирает быть сговорчивой.</li>
      <li>Принудительное чтение мыслей или вырывание воспоминаний.</li>
      <li>Магическое снятие страха с союзника <strong>против его желания</strong> — дружелюбность намерения типа не меняет.</li>
    </ul>
    <h3>Примеры: социально-физические действия</h3>
    <p><strong>Strife:</strong></p>
    <ul>
      <li>Сорвать с собеседника капюшон, выхватить письмо из его рук, задержать уходящего за плечо.</li>
      <li>Затолкать цель в карету; вынести упирающегося из зала; удержать от шага с крыши.</li>
      <li>Тихо усыпить часового удушающим приёмом — насилие есть, боя ещё нет, но тип определяет тело цели.</li>
    </ul>
    <p><strong>Drama:</strong></p>
    <ul>
      <li>Незаметно обыскать карман спящего пьяницы — сложность задают глубина сна и ловкость рук, а не сопротивление.</li>
      <li>Подменить письмо на столе, пока секретарь отвернулся.</li>
      <li>Проскользнуть за спиной стражи в дверь, потеряться в толпе, замести следы.</li>
      <li>Снять ценности с трупа: тела нет как носителя воли.</li>
    </ul>
    <h3>Примеры: магия</h3>
    <p><strong>Strife:</strong></p>
    <ul>
      <li>Любое заклинание, направленное против цели: сон, паралич, проклятие, страх, болезнь — независимо от наличия урона.</li>
      <li>Рассеивание чужого заклинания, взлом чужого магического щита — противодействует работа и воля другого мага.</li>
      <li>Изгнание нежити или духа, который цепляется за мир.</li>
    </ul>
    <p><strong>Drama:</strong></p>
    <ul>
      <li>Заклинание на себя: усиление, свет, защита — чужая воля не затронута, сложность задаётся техникой и обстоятельствами, как в ремесле.</li>
      <li>Создание предмета или эффекта в мире: магическая стена, мост через пропасть, огонь в очаге.</li>
      <li>Диагностика, поиск следов магии, опознание чар.</li>
      <li>Лечение добровольного пациента; лечение пациента в бреду, чьё тело сопротивляется, — уже Strife.</li>
    </ul>
    <h3>Примеры: знание и восприятие</h3>
    <p><strong>Drama (всегда):</strong> вспомнить редкое знание, опознать яд, прочитать древнюю надпись, заметить скрытую дверь, услышать шаги. Знание и мир не сопротивляются наблюдателю — сложность задают редкость, тайна и обстоятельства. Исключение: если источник знания — чужой разум, в который персонаж вторгается, это Strife (см. магию выше).</p>
    <h3>Чем оплачиваются исходы</h3>
    <p>Тип действия определяет, <strong>как разрешаются результаты проверки</strong> и <strong>какой валютой оплачиваются её исходы</strong>: Strife связан с <strong>Grit</strong>, Drama — с <strong>Doom</strong>.</p>
  `;
}

/** Seed the "Вводные правила" rules journal entry — one page per top-level (##) section
 *  of the source rules doc (Кубики / Броски и проверки / Преимущество и недостаток /
 *  Помощь / Компетенция / Ресурсы: Grit и Doom / Два типа действий: Strife и Drama),
 *  transcribed verbatim from the GM-supplied "Вводные правила.md". Pure prose — unlike
 *  the other rules journal entries above, nothing in code reads this back (no
 *  bracket-hint convention), so a GM can freely rewrite, reorder, or split/merge these
 *  pages with no functional side effect. Same idempotent-by-name + seed-registry
 *  protection as the other rules journal entries. */
async function seedIntroRulesJournal() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;

  const packName = "journal";
  const folderName = "Правила";
  const entryName = "Вводные правила";

  const index = await pack.getIndex({ fields: ["folder"] });
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet(packName);

  if (existingByName.has(entryName) || alreadySeeded.has(entryName)) {
    await _markSeeded(packName, [entryName]);
    return;
  }

  let folder = pack.folders?.find((f) => f.name === folderName);
  if (!folder) {
    folder = await Folder.create({ name: folderName, type: "JournalEntry" }, { pack: pack.collection });
  }

  await pack.documentClass.createDocuments([{
    name: entryName,
    folder: folder?.id ?? null,
    pages: [
      { name: "Кубики", type: "text", text: { content: _introDicePage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Броски и проверки", type: "text", text: { content: _introChecksPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Преимущество и недостаток", type: "text", text: { content: _introAdvantagePage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Помощь", type: "text", text: { content: _introHelpPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Компетенция", type: "text", text: { content: _introCompetencyPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Ресурсы: Grit и Doom", type: "text", text: { content: _introResourcesPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      { name: "Два типа действий: Strife и Drama", type: "text", text: { content: _introStrifeDramaPage(), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
    ],
  }], { pack: pack.collection });
  console.log("god-tactical | Seeded rules journal entry (Вводные правила)");

  await _markSeeded(packName, [entryName]);
}

/* -------------------------------------------- */
/*  Dev notes journal: "Для правок"              */
/* -------------------------------------------- */

/** Attack-template targeting/height logic, written down for whoever edits it next (not
 *  player-facing rules — a maintenance reference). Nothing in code reads this back, so it's
 *  free prose; keep it in sync by hand when the template code changes. Key files:
 *  module/canvas/template-canvas.mjs (draw/hit/danger-zone orchestration, _recomputeDraw,
 *  _aimElevation, wheel/snap, _meleeAimRange) and module/canvas/template-3d.mjs (3D geometry:
 *  beam plane, wouldHitIfAimed, wall cuts, directionalWallClip). Damage-tier math lives
 *  separately in module/combat/aim-height-damage.mjs (aimHeightDamageTier) and
 *  module/combat/attack-outcome.mjs (combineAttackOutcome — folds in cover + "hears not
 *  sees" too). Constants: BEAM_PLANE_TOL_M, BEAM_LINE_SHAPES, ASSUMED_TARGET_HEIGHT_M,
 *  ELEV_WHEEL_STEP, HEIGHT_GAP_ZERO_M, HEIGHT_BANDS, HEIGHT_BAND_CEILING_M. */
function _tplOverviewPage() {
  return `
    <p><em>Служебная заметка для разработки, не игровые правила.</em> Как шаблоны атак наводятся по высоте и как считается попадание. Держать в синхроне с кодом вручную.</p>
    <h3>Высота прицела (<code>_aimElevation</code>, template-canvas.mjs)</h3>
    <p>Высота, на которой «работает» шаблон (Target Z), берётся по приоритету:</p>
    <ol>
      <li><strong>Колесо мыши</strong> — ручной override (<code>_aimElevationOverride</code>), шаг <code>ELEV_WHEEL_STEP</code> = 1 м, КЛЭМПИТСЯ по-разному для Залпа и Натиска (см. ниже). Бейдж: «(задано)».</li>
      <li><strong>Токен под курсором</strong> — снап на <strong>самую достижимую точку его тела</strong> (<code>snapAimHeight</code> = <code>clamp(глаза стрелка, ноги, голова)</code>), не на голые ноги: иначе короткий swarm на земле под стрелком снапился на плоскость, до которой не дотянуться. <strong>Залп:</strong> результат БЕЗ клэмпа — снап на реального летающего/далёкого врага всегда разрешён, даже если колесо само по себе туда не докрутить. <strong>Натиск:</strong> результат КЛЭМПИТСЯ через <code>_meleeAimRange</code> тем же диапазоном, что и колесо (баг фикс 2026-08-15: снап раньше обходил лимит длины оружия целиком — можно было навестись на цель выше собственного реча просто наведя курсор на неё). Бейдж: «(цель)».</li>
      <li><strong>Уровень самого стрелка</strong> — если под курсором пусто. Без тега.</li>
    </ol>
    <p>Земля под курсором в высоту прицела <strong>не</strong> входит (автоподнятие по рельефу убрано). Override сбрасывается при новой атаке, отмене и смене инструмента; при наведении на <em>новый</em> токен тоже сбрасывается — снап снова берёт верх (колесо = разовый override для пустого воздуха, не режим).</p>
    <h4>Клэмп колеса</h4>
    <ul>
      <li><strong>Залп:</strong> <code>[0, HEIGHT_BAND_CEILING_M]</code> (0..18 м, абсолютно) — верх самой высокой определённой группы высот (см. страницу «Линия»). Выше нет группы вообще, так что дальше крутить бессмысленно — там не может быть цели по определению.</li>
      <li><strong>Натиск:</strong> <code>[пол − L/2, пол + рост + L/2]</code>, где L — длина оружия/шаблона (<code>_meleeAimRange</code>). Асимметрично: вверх — весь свой рост (бесплатно, как и на цели) плюс полоружия сверху; вниз — только полоружия от пола, рост вниз не добавляет.</li>
    </ul>
    <h3>Главный инвариант</h3>
    <p><strong>Дэнжер-зона (янтарь) считается тем же кодом, что и реальный удар</strong> — иначе в одновременном планировании игрок чувствует обман. Любой индикатор обязан совпадать с попаданием.</p>
  `;
}

function _tplLinePage() {
  return `
    <h3>Линия и Широкая линия</h3>
    <p>Общая направленная ветка <code>_recomputeDraw</code> — с 2026-08-15 Натиск и Залп используют ОДНУ и ту же геометрию (<code>directionalWallClip</code>): плоский 2D шаблон, БЕЗ какого-либо высотного расчёта на уровне шаблона вообще — только обычное вырезание клеток полными стенами (<code>ctx.fullWalls</code>), как у любой другой AOE. Попадание — простое членство клетки. Никакой красной мёртвой зоны ни у одного из режимов больше нет (RETIRED: Натиска реч-обрезание <code>directionalReachClip</code>, Залпа модель «разгон-и-полка»).</p>
    <ul>
      <li><strong>Высота — чистый модификатор УРОНА, не геометрии.</strong> Target Z (высота, на которую навёлся боец) и <code>weaponReachM</code> (длина оружия/шаблона в метрах) едут на штрихе; после обычного попадания <code>aimHeightDamageTier</code> сравнивает Target Z с реальным телом цели [пол, пол+рост] и даёт full/half/zero — симметрично, неважно цель выше или ниже. См. <code>module/combat/aim-height-damage.mjs</code>, встроено в общую композицию <code>combineAttackOutcome</code> (плюс укрытие, плюс «слышу-не-вижу» для Залпа).</li>
      <li><strong>Разница в пороге «zero» ВНУТРИ одной группы высот</strong> (<code>gapZeroM</code>, параметр <code>aimHeightDamageTier</code>): Залп — фиксированные <code>HEIGHT_GAP_ZERO_M</code> = 10 м (снаряд летит, есть допуск — шире любой отдельной группы, так что внутри одной группы почти никогда не режет). Натиск — половина <code>weaponReachM</code> (рука/оружие никуда не летит, допуск = сам физический размах оружия, обычно меньше метра-двух).</li>
      <li><strong>Высотные группы</strong> (<code>HEIGHT_BANDS</code>, заменили старую «лётную зону» 2026-08-17): мир поделен на именованные слои — по умолчанию Земля (0–6 м), Низкий полёт (6–12 м), Высокий полёт (12–18 м), выше 18 м группы нет вообще. Target Z и floorZ цели каждые попадают в свою группу; РАЗНЫЕ группы — жёсткий ZERO ДО проверки зазора, каким бы малым он ни казался в метрах (заменяет старый плоский 8-метровый порог как межгрупповую границу). Внутри ОДНОЙ группы обычная формула зазора выше по-прежнему решает full/half/zero. «На цели» (тело реально накрывает Target Z) всё равно получает FULL первым, до проверки групп. <strong>Залп</strong> дополнительно требует явный флаг на карточке оружия (<code>canHitLowFlight</code>/<code>canHitHighFlight</code>, items.mjs) чтобы вообще коснуться не-земной группы — без флага ZERO даже в упор; Натиск этим не ограничен.</li>
      <li><strong>Обычная (без Wall Height) стена</strong> на пути шаблона блокирует насквозь — клетка просто вырезается, ни попадание, ни красная зона (для обоих режимов).</li>
      <li><strong>Дальность:</strong> реч оружия (Натиск) или дистанция (Залп), зашита в <code>lengthCells</code> — тот же <code>lengthCells</code> становится <code>weaponReachM</code> после перевода в метры.</li>
    </ul>
  `;
}

function _tplConePage() {
  return `
    <h3>Конус — веер</h3>
    <p>Работает как линия выше, только со следом-<strong>веером</strong> (60°, <code>computeCoverage</code>) — Натиск и Залп ОДИНАКОВЫ (см. страницу «Линия»): тот же <code>directionalWallClip</code>, плоский шаблон без высотной геометрии, высота — только модификатор урона после попадания. Юнит поражён, если его клетка в веере.</p>
    <ul>
      <li><strong>Мёртвой зоны больше нет</strong> ни у Натиска, ни у Залпа — раньше у Натиска был отдельный радиальный реч-обрез (RETIRED вместе с <code>directionalReachClip</code>).</li>
      <li><strong>Дэнжер-зона:</strong> <code>wouldHitIfAimed</code> (прицел прямо в цель = она на оси веера) — тот же единый тест, что и у линии/круга/квадрата (см. «Дэнжер-зона и служебные»), с 2026-08-17 зеркалит реальный удар вместо своей 3D-модели.</li>
    </ul>
  `;
}

function _tplAreaPage() {
  return `
    <h3>Круг и Квадрат (площадные)</h3>
    <p>С 2026-08-16 полностью унифицированы с направленными формами (см. страницу «Линия») — та же <code>directionalWallClip</code>, плоский 2D-след, БЕЗ высотного расчёта на уровне геометрии, одинаково для ближнего и дальнего боя. RETIRED: старая 3D-модель <code>meleeReachClip</code> (реч-обрезание по стандартному телу) для Натиска.</p>
    <ul>
      <li><strong>На себя (rangeModifier 0, <code>selfCentered</code>):</strong> ставится сразу на клетку кастера без подтверждающего клика. Плоский след, вырезается только полными стенами.</li>
      <li><strong>Направленный (rangeModifier &gt; 0, <code>directedFromToken</code>):</strong> взрыв на фиксированной дистанции <code>rangeCells</code> в сторону курсора + линия доставки от кастера, один клик ставит. Достижимость: луч доставки должен долететь до центра (<code>beamWallClip</code>) — перекрыт стеной короче центра → весь взрыв красный (<code>unreachableCells</code>), <strong>теперь одинаково для ближнего и дальнего боя</strong> (раньше эта проверка была только у дальнего). Долетел → след вырезается по стенам от точки приземления (<code>directionalWallClip</code>), как у любой другой AOE.</li>
      <li><strong>Высота — чистый модификатор урона, не геометрии</strong> (как у линии/конуса): <code>targetZ</code> = точка приземления/центра (<code>_aimElevation(draw.aim)</code>), <code>weaponReachM</code> едет на штрихе, <code>aimHeightDamageTier</code> считает full/half/zero после обычного попадания.</li>
    </ul>
  `;
}

function _tplNavesnoyPage() {
  return `
    <h3>Навесной (brosok)</h3>
    <p>Горизонтальный шейп (круг/квадрат, но и любая другая форма) = след. Вертикальной модели выбора больше нет (2026-08-16 днём, RETIRED поле «Объём»/<code>templateVolume</code> и UI-галочка «Взрыв»); тем же вечером решение пересмотрено ещё раз — Навесной больше НЕ ведёт себя как «Столб» безусловно. Разделены доставка и эффект: <strong>арка над стенами</strong> — свойство только ДОСТАВКИ (бросок долетает до точки приземления, не обрезаясь стенами по пути). Сам след на земле — hit / cover / высотный tier — считается ТОЧНО как у настильного шаблона той же формы: <code>directionalWallClip(footprint, draw.origin)</code> от точки приземления наружу, плюс <code>targetZ</code>/<code>weaponReachM</code> для <code>aimHeightDamageTier</code>, всё как у Настильного. Cover (<code>coverTargetsForShooter</code>/<code>region-cover-overlay.mjs</code>) теперь тоже считается по-настоящему для Навесного — но точкой отсчёта («глаз») служит точка приземления (<code>lobbedBlastEye</code>), а не тело стрелка, ведь укрытие защищает от взрыва, а не от стрелка за стеной.</p>
    <p>Угроза Навесного (янтарное кольцо, <code>navesnoyCanReachTarget</code>) — доставка по-прежнему чисто <strong>горизонтальная</strong> (бросок+радиус, без стен, аркует). Высотный tier ДОБАВЛЕН 2026-08-17 (тем же <code>aimHeightDamageTier</code>, что и реальный след) — закрывает разрыв, который раньше здесь был (см. «Дэнжер-зона и служебные»).</p>
  `;
}

function _tplDangerPage() {
  return `
    <h3>Три кольца-индикатора (приоритет красное &gt; янтарь &gt; голубое)</h3>
    <ul>
      <li>🔴 <strong>Красное</strong> (пульс) — попадает <strong>прямо сейчас</strong> (в следе + по высоте). <code>_onHitTicker</code>.</li>
      <li>🟠 <strong>Янтарь</strong> — «достанешь, если прицелишься прямо в него» (текущие позиции). <code>_recomputeDangerZoneRings</code>.</li>
      <li>🔵 <strong>Голубое</strong> — тело юнита <strong>пройдёт по текущей высоте</strong> шаблона: если он зайдёт в достижимый след — попадёт. Планинг-помощь для вида сверху (вертикаль невидима). Только направленные формы; союзники тоже (баф-шаблоны). <code>bodyCrossesPlaneTokenIds</code> + <code>HEIGHT_FIT_COLOR</code>. Не рисуется на красных/янтарных. <strong>Учитывает реч:</strong> если плоскость дальше реча по вертикали (весь след мёртв — например конус вниз с уступа не достаёт swarm на земле), голубых колец нет — иначе обещало бы то, что красная зона уже отрицает.</li>
    </ul>
    <h3>Дэнжер-зона (янтарь) — единый тест (2026-08-17)</h3>
    <p>«Кого достанешь, если прицелиться прямо в него». Линия/широкая линия/конус, ближний бой и доставляемый AOE круга/квадрата — ВСЕ через один <code>wouldHitIfAimed</code>, зеркалящий реальный удар вместо своей отдельной 3D-модели: горизонтальная дальность (БЕЗ вертикальной составляющей — подъём/спуск к высоте цели больше ничего не стоит, ровно как у плоского 2D-следа с 2026-08-14), стена/парапет блокирует насквозь, а сама высота — <code>aimHeightDamageTier</code> (та же band/flag-логика, что и у настоящего броска, см. страницу «Обзор и высота») не должна дать zero. Раньше <code>beamHitsTarget</code>/<code>meleeCanReachTarget</code> заряжали 3D-евклидову дистанцию (горизонталь + подъём) против плоской дальности оружия — расходилось с реальным ударом на любом крутом прицеле (живой репро: арбалет на 10м, прицел на высоту 12 при 5м по горизонтали — янтарь молчал «вне дальности», реальный выстрел бил ПОЛНОСТЬЮ). Прицельная высота — <code>snapAimHeight</code> = <code>clamp(глаза стрелка, ноги, голова)</code>, или заданная колесом.</p>
    <ul>
      <li><strong>Навесной:</strong> <code>navesnoyCanReachTarget</code> — доставка по-прежнему только горизонталь, без стен (аркует). Высотный tier (2026-08-17) теперь ТОЖЕ проверяется тем же <code>aimHeightDamageTier</code> — раньше эта функция была чисто горизонтальной и расходилась с реальным следом, который уже год как считает высоту после приземления.</li>
    </ul>
    <h3>Служебные формы</h3>
    <ul>
      <li><strong>Движение (thin_line):</strong> путь по клеткам (Брезенхэм), всегда 1 клетка шириной, без попадания и без 3D.</li>
      <li><strong>Линейка (ruler):</strong> только измерение, не сохраняется, не пишется в лог.</li>
    </ul>
    <h3>Числа высот</h3>
    <p>swarm = 1 м, small = 1, medium = 2, large = 3, veryLarge = 4, incrediblyLarge = 6 (<code>EYE_HEIGHT_METERS_BY_SIZE</code>, blind-spot.mjs). Предполагаемое стандартное тело footprint — <code>ASSUMED_TARGET_HEIGHT_M</code> = 1 м.</p>
  `;
}

/** Seed the "Для правок" dev-notes journal entry (folder «Разработка») documenting the
 *  attack-template targeting/height logic. Same idempotent-by-name + seed-registry
 *  protection as the rules journals — created once, never overwrites edits. To refresh it
 *  after the logic changes, delete the entry (or clear its name from the seed registry) and
 *  reload. */
async function seedTemplateLogicJournal() {
  const pack = game.packs.get("god-tactical.journal");
  if (!pack) return;

  const packName = "journal";
  const folderName = "Разработка";
  const entryName = "Для правок";

  const index = await pack.getIndex({ fields: ["folder"] });
  const existingByName = new Map(index.map((e) => [e.name, e]));
  const alreadySeeded = _getSeededSet(packName);

  if (existingByName.has(entryName) || alreadySeeded.has(entryName)) {
    await _markSeeded(packName, [entryName]);
    return;
  }

  let folder = pack.folders?.find((f) => f.name === folderName);
  if (!folder) {
    folder = await Folder.create({ name: folderName, type: "JournalEntry" }, { pack: pack.collection });
  }

  const html = CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML;
  await pack.documentClass.createDocuments([{
    name: entryName,
    folder: folder?.id ?? null,
    pages: [
      { name: "Обзор и высота",            type: "text", text: { content: _tplOverviewPage(),  format: html } },
      { name: "Линия / Широкая линия",     type: "text", text: { content: _tplLinePage(),      format: html } },
      { name: "Конус",                     type: "text", text: { content: _tplConePage(),      format: html } },
      { name: "Круг / Квадрат",            type: "text", text: { content: _tplAreaPage(),      format: html } },
      { name: "Навесной (аркует стены, любая высота)", type: "text", text: { content: _tplNavesnoyPage(),  format: html } },
      { name: "Дэнжер-зона и служебные",   type: "text", text: { content: _tplDangerPage(),    format: html } },
    ],
  }], { pack: pack.collection });
  console.log("god-tactical | Seeded dev-notes journal entry (Для правок)");

  await _markSeeded(packName, [entryName]);
}

// 2026-08-21: dropped the seedPack("weapons"...)/seedPack("armor"...) calls that used to
// sit first here — both targeted "god-tactical.weapons"/"god-tactical.armor" packs that
// have never existed (system.json only ever defined a single combined "god-tactical.
// equipment" Item pack), so seedPack's own `if (!pack) return` made them permanent no-ops.
// The ~20 weapons and armor pieces actually in the equipment compendium were added by
// hand, not through this file — equipment-seed.mjs's WEAPONS/ARMORS (10 stale weapon
// entries, never covering the real roster) were removed along with these calls.
export async function seedCompendiums() {
  await seedPack("classes", "class", CLASSES);
  await seedPack("races", "race", RACES);
  await seedPack("creatures", "creature", CREATURES);
  await seedPack("bestiary", undefined, NPCS);
  await seedAbilities(ABILITIES);
  await linkClassGrantedAbilities();
  await seedStatusJournal();
  await seedRulesJournal();
  await migrateCharSkillsJournalPages();
  await migrateSkillMapStructureV2();
  await seedMezzanineJournal();
  await seedPhasesJournal();
  await seedActionsJournal();
  await seedCompetenciesJournal();
  await seedIntroRulesJournal();
  await seedTemplateLogicJournal();
}
