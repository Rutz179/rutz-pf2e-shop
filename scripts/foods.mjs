/* ======================================================================== *
 * Rutz food catalog — the same file in Rutz's PF2e Days, Gacha and Shop, so
 * each makes the very same items on its own (keep the copies in step).
 *
 * One item = one meal (uses 1). Food counts as a day's food in Days; drinks
 * don't. Quality decides what eating it does (Days applies it — when it eats
 * a day's food, or when a player uses the item from the sheet):
 *   poor     cheaper than Rations; a DC 5 flat check after eating, or fatigued
 *   plain    nothing special (about what Rations cost a day: 4 sp a week)
 *   fine     well fed: temporary HP 2 + half your level, 8 hours
 *   luxury   a feast: temporary HP 5 + your level, 8 hours (some add more)
 * Prices are copper, near Player Core's Basic Services and Cuisine.
 * The item keeps its catalog key: flags["rutz-pf2e-days"].food = { key, quality, meal }.
 * ======================================================================== */

const IMG = {
  rations: "systems/pf2e/icons/equipment/adventuring-gear/rations.webp",
  meat: "icons/consumables/meat/hock-leg-stylized.webp",
  steak: "icons/consumables/food/steak-aged-brown.webp",
  jerky: "icons/consumables/meat/steak-alien-orange.webp",
  fruit: "icons/consumables/fruit/apple-ripe-red.webp",
  herb: "icons/consumables/plants/dried-herb-bundle-brown.webp",
  jug: "icons/consumables/drinks/water-jug-clay-brown.webp",
  cup: "icons/consumables/drinks/wine-amphora-cup-gray.webp",
  wine: "icons/consumables/drinks/wine-amphora-clay-pink.webp"
};

/*
 * kind: "food" (a day's food) | "drink"
 * extra: more than the quality gives — { fastHealing, hours }
 */
export const FOOD_CATALOG = {
  // poor — cheap, a gamble on the stomach
  poorMeal:   { kind: "food", quality: "poor", cp: 1, img: IMG.fruit, ko: "허름한 식사", en: "Poor meal", koD: "빵 쪼가리와 묽은 죽.", enD: "A heel of bread and thin gruel." },
  gruel:      { kind: "food", quality: "poor", cp: 1, img: IMG.rations, ko: "묽은 죽 한 봉지", en: "Bag of gruel", koD: "물을 부어 끓이면 그럭저럭 배는 찬다.", enD: "Add water and boil; it fills you, mostly." },
  hardtack:   { kind: "food", quality: "poor", cp: 2, img: IMG.rations, ko: "딱딱한 건빵", en: "Hardtack", koD: "이가 상할 만큼 딱딱하다. 오래 간다.", enD: "Hard enough to chip a tooth. It keeps." },
  staleBread: { kind: "food", quality: "poor", cp: 1, img: IMG.rations, ko: "묵은 빵", en: "Stale bread", koD: "곰팡이는 떼어 냈다… 아마도.", enD: "The mould has been scraped off. Probably." },
  // plain — about a day of Rations
  squareMeal: { kind: "food", quality: "plain", cp: 3, img: IMG.steak, ko: "든든한 식사", en: "Square meal", koD: "따뜻하고 배부른 한 끼.", enD: "A warm, filling meal." },
  honeyBread: { kind: "food", quality: "plain", cp: 3, img: IMG.rations, ko: "꿀 바른 빵", en: "Honey bread", koD: "아직 말랑한 빵에 꿀을 듬뿍.", enD: "Soft bread with plenty of honey." },
  driedFruit: { kind: "food", quality: "plain", cp: 4, img: IMG.fruit, ko: "말린 과일 주머니", en: "Pouch of dried fruit", koD: "달콤한 무화과와 살구.", enD: "Sweet figs and apricots." },
  stew:       { kind: "food", quality: "plain", cp: 4, img: IMG.meat, ko: "여행자의 스튜", en: "Traveler's stew", koD: "모닥불에 끓인 스튜 한 그릇.", enD: "A bowl of campfire stew." },
  jerky:      { kind: "food", quality: "plain", cp: 5, img: IMG.jerky, ko: "훈제 육포", en: "Smoked jerky", koD: "짭짤하게 훈제한 고기. 오래 씹을수록 맛있다.", enD: "Salty smoked meat; better the longer you chew." },
  cheese:     { kind: "food", quality: "plain", cp: 6, img: IMG.rations, ko: "숙성 치즈 덩어리", en: "Wedge of aged cheese", koD: "천에 싸인 단단한 치즈.", enD: "A hard cheese wrapped in cloth." },
  // fine — well fed
  roast:      { kind: "food", quality: "fine", cp: 30, img: IMG.meat, ko: "구운 다리고기", en: "Roast leg", koD: "기름이 뚝뚝 떨어지는 다리고기.", enD: "A roast leg dripping with fat." },
  steak:      { kind: "food", quality: "fine", cp: 50, img: IMG.steak, ko: "잘 숙성된 스테이크", en: "Aged steak", koD: "제대로 숙성시킨 두툼한 고기.", enD: "A thick, properly aged steak." },
  fineDining: { kind: "food", quality: "fine", cp: 100, img: IMG.meat, ko: "고급 요리", en: "Fine dining", koD: "이름난 요리사의 코스.", enD: "A course from a renowned cook." },
  // luxury — a feast
  feast:      { kind: "food", quality: "luxury", cp: 300, img: IMG.meat, ko: "잔치 바구니", en: "Feast basket", koD: "고기·빵·과일이 가득한 바구니.", enD: "A basket full of meat, bread and fruit." },
  // drinks
  ale:        { kind: "drink", quality: "plain", cp: 1, img: IMG.cup, ko: "에일 한 잔", en: "Mug of ale", koD: "주점의 에일 한 잔.", enD: "A mug of tavern ale." },
  tea:        { kind: "drink", quality: "plain", cp: 2, img: IMG.cup, ko: "커피·차 한 주전자", en: "Pot of coffee or tea", koD: "커피나 차 한 주전자.", enD: "A pot of coffee or tea." },
  herbTea:    { kind: "drink", quality: "plain", cp: 2, img: IMG.herb, ko: "허브차 꾸러미", en: "Herbal tea bundle", koD: "마음을 가라앉히는 향.", enD: "A calming scent." },
  keg:        { kind: "drink", quality: "plain", cp: 20, bulk: 2, img: IMG.wine, ko: "에일 한 통", en: "Keg of ale", koD: "에일 한 통. 여럿이 나눠 마신다.", enD: "A keg of ale to share." },
  wine:       { kind: "drink", quality: "fine", cp: 10, img: IMG.wine, ko: "포도주 한 병", en: "Bottle of wine", koD: "평범한 포도주. 한 잔이면 기운이 난다.", enD: "Ordinary wine; a glass lifts the spirits." },
  fruitWine:  { kind: "drink", quality: "fine", cp: 10, img: IMG.jug, ko: "과일주 한 병", en: "Bottle of fruit wine", koD: "새콤달콤한 과일주.", enD: "Sweet and sour fruit wine." },
  fineWine:   { kind: "drink", quality: "luxury", cp: 100, img: IMG.wine, ko: "고급 포도주 한 병", en: "Bottle of fine wine", koD: "좋은 해의 포도주.", enD: "Wine from a good year." },
  dwarvenSpirit: { kind: "drink", quality: "luxury", cp: 200, img: IMG.jug, extra: { fastHealing: 2, hours: 1 }, ko: "드워프 화주", en: "Dwarven fire spirit", koD: "목이 타들어 가는 독주. 몸속에 불이 붙는다.", enD: "It burns all the way down and keeps burning." }
};

export const QUALITY_NOTE = {
  poor: { ko: "싸구려 — 먹은 뒤 DC 5 단순 판정, 실패하면 피로", en: "Cheap — after eating, a DC 5 flat check or fatigued" },
  plain: { ko: "", en: "" },
  fine: { ko: "든든함 — 임시 HP 2 + 레벨의 절반 (8시간)", en: "Well fed — temporary HP 2 + half your level (8 hours)" },
  luxury: { ko: "호사 — 임시 HP 5 + 레벨 (8시간)", en: "Feast — temporary HP 5 + your level (8 hours)" }
};

const ko = () => (game?.i18n?.lang ?? "ko").startsWith("ko");
export const foodName = key => { const f = FOOD_CATALOG[key]; return f ? (ko() ? f.ko : f.en) : key; };
export const foodDesc = key => { const f = FOOD_CATALOG[key]; return f ? (ko() ? f.koD : f.enD) : ""; };

function noteOf(f) {
  const q = QUALITY_NOTE[f.quality]?.[ko() ? "ko" : "en"] ?? "";
  const fh = f.extra?.fastHealing ? (ko() ? ` · 빠른 치유 ${f.extra.fastHealing} (${f.extra.hours}시간)` : ` · fast healing ${f.extra.fastHealing} (${f.extra.hours} h)`) : "";
  const meal = f.kind === "food" ? (ko() ? "하루치 식량." : "A day's food.") : (ko() ? "마실 것 (식량으로 치지 않음)." : "A drink (not a day's food).");
  return `${meal}${q ? ` <b>${q}</b>` : ""}${fh}`;
}

/** The item for `qty` of a catalog food (flags: Days' food marker + whatever the maker adds). */
export function foodSource(key, qty = 1, flags = {}) {
  const f = FOOD_CATALOG[key];
  if (!f) return null;
  return {
    type: "consumable", name: foodName(key), img: f.img,
    system: {
      quantity: Math.max(1, Math.round(qty)), price: { value: { cp: f.cp } }, category: "other", bulk: { value: f.bulk ?? 0.1 }, level: { value: 0 },
      uses: { value: 1, max: 1, autoDestroy: true }, traits: { value: [], rarity: "common" },
      description: { value: `<p>${foodDesc(key)}</p><p><em>${noteOf(f)}</em></p>` }
    },
    flags: { ...flags, "rutz-pf2e-days": { ...(flags["rutz-pf2e-days"] ?? {}), food: f.kind === "food", meal: { key, quality: f.quality, kind: f.kind } } }
  };
}

/** The catalog entry of an item (by its flag, else by its name), or null. */
export function foodOf(item) {
  const m = item?.flags?.["rutz-pf2e-days"]?.meal;
  if (m?.key && FOOD_CATALOG[m.key]) return { key: m.key, ...FOOD_CATALOG[m.key] };
  const cuisine = item?.flags?.["rutz-pf2e-shop"]?.cuisine;
  if (cuisine && FOOD_CATALOG[cuisine]) return { key: cuisine, ...FOOD_CATALOG[cuisine] };
  return null;
}

/** Copper one meal of this item costs (to eat the cheapest first). Rations: 4 sp a week. */
export function mealCp(item) {
  const f = foodOf(item);
  if (f) return f.cp;
  const v = item?.system?.price?.value ?? {};
  const cp = (v.pp ?? 0) * 1000 + (v.gp ?? 0) * 100 + (v.sp ?? 0) * 10 + (v.cp ?? 0);
  const uses = Math.max(1, Number(item?.system?.uses?.max) || 1);
  return cp / uses || 6;
}
