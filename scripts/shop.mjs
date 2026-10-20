import { MID, clamp, randomId, setting, sourceIdOf, t, unitCp } from "./util.mjs";
import { classify, loadCatalog, preferMirror, searchCatalog } from "./catalog.mjs";

/* ======================================================================== *
 * A shop is a PF2e loot actor with a flag: its stock are ordinary items on
 * it (names, prices and descriptions come from PF2e and the translation as
 * usual; quantity = how many are left), the shop's settings live in
 * flags.rutz-pf2e-shop.shop. So shops are seen, moved, copied and put in
 * compendiums like any actor — and exported to a JSON file for other worlds.
 *
 * Stock item flags (flags.rutz-pf2e-shop.stock):
 *   max      — restocked up to this many
 *   perDay   — how many come back each day (0: none; -1: back to max)
 *   infinite — never runs out
 *   priceMul — this item's own price factor (1 = list price)
 * ======================================================================== */

export const SHEET_ID = `${MID}.ShopSheet`;

export function defaultConfig() {
  return {
    version: 1,
    title: "", greeting: "", farewell: "",
    merchant: { name: "", img: "", show: true },
    theme: "gold",
    open: true,
    buyRate: 1, sellRate: 0.5,
    buys: [],                    // categories bought from players ([] = everything)
    resell: false,               // what players sell goes on the shelf
    events: [],                  // { id, name, active, buy, sell, cats: [] }
    // every: days per restock period; mode "fill" (perDay each period) or "chance" (each item rolls, hidden, by rarity)
    restock: { auto: true, lastDay: null, every: 1, mode: "fill", chance: { common: 80, uncommon: 30, rare: 5, unique: 1 } },
    creatures: [],               // { id, uuid (Actor), name, img, level, priceCp, qty, max, perDay, infinite }
    wealth: "modest",            // poor | modest | rich | lavish
    // What the shop can spend buying from players (cp); refilled each restock period. on: false = unlimited.
    purse: { on: false, max: 0, value: 0, refill: 25 },
    services: {
      repair: { on: false, mode: "percent", percent: 10, perHp: 10 },
      runes: { on: false, transfer: true },
      material: { on: false, rate: 1, allowed: [], reach: 5 }
    },
    ledger: []
  };
}

export function isShop(actor) {
  return !!actor?.getFlag?.(MID, "shop");
}

export function shopList() {
  return game.actors.filter(a => isShop(a)).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

export function configOf(actor) {
  const raw = actor?.getFlag?.(MID, "shop") ?? {};
  return foundry.utils.mergeObject(defaultConfig(), foundry.utils.deepClone(raw), { inplace: false, insertKeys: true, insertValues: true });
}

export async function saveConfig(actor, cfg) {
  // Lists are written whole (Foundry would otherwise merge them).
  await actor.update({ [`flags.${MID}.shop`]: cfg });
}

export function stockOf(item) {
  const s = item?.getFlag?.(MID, "stock") ?? item?.flags?.[MID]?.stock ?? {};
  return { max: Number(s.max ?? item?.system?.quantity ?? 1) || 0, perDay: Number(s.perDay ?? 1), infinite: !!s.infinite, priceMul: Number(s.priceMul ?? 1) || 1, featured: !!s.featured,
    chance: s.chance === undefined || s.chance === null || s.chance === "" ? null : Number(s.chance) };
}

export function shelf(actor) {
  return actor.items.filter(i => i.isOfType?.("physical") ?? ["weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack", "ammo", "kit"].includes(i.type))
    .filter(i => !(i.type === "treasure" && i.isCurrency));
}

/* ---------------- prices ---------------- */

export function eventFactor(cfg, kind, cat) {
  let f = 1;
  for (const ev of cfg.events ?? []) {
    if (!ev.active) continue;
    if (ev.cats?.length && !ev.cats.includes(cat)) continue;
    f *= Number(kind === "buy" ? ev.buy : ev.sell) || 1;
  }
  return f;
}

/** What a player pays for one (copper, rounded; at least 1 cp for anything with a price). */
export function buyUnitCp(cfg, item) {
  const base = unitCp(item);
  if (!base) return 0;
  const st = stockOf(item);
  return Math.max(1, Math.round(base * (Number(cfg.buyRate) || 1) * st.priceMul * eventFactor(cfg, "buy", classify(item).cat)));
}

/** What the shop pays a player for one. Gems, art and other treasure sell at full price. */
export function sellUnitCp(cfg, item) {
  const base = unitCp(item);
  if (!base) return 0;
  const { cat } = classify(item);
  const rate = cat === "treasure" && setting("treasureFull", true) ? 1 : Number(cfg.sellRate) || 0;
  return Math.max(0, Math.floor(base * rate * eventFactor(cfg, "sell", cat)));
}

export function buysCategory(cfg, item) {
  return !cfg.buys?.length || cfg.buys.includes(classify(item).cat);
}

/* ---------------- how rich a shop is ---------------- */

/*
 * 풍요도. A suggestion the GM can change afterwards (each value is an ordinary setting):
 *   count / qty   how many lines and how many of each the templates shelve
 *   rarity        what rarities they may pick
 *   level         shift of the level range
 *   buy / sell    price to players / share paid for players' goods
 *   purse         gold the shop can spend buying from players (× party level factor), refilled 25% a period
 * Poor shops are small, a little dear, pay less and run out of money soon — a lavish one has rare things,
 * pays fairly and can buy a treasure hoard. Selling crafted goods is limited by the purse, not by a rule.
 */
export const WEALTH = {
  poor: { count: 0.5, qty: 0.5, rarity: ["common"], level: -1, buy: 1.1, sell: 0.4, purse: 25 },
  modest: { count: 1, qty: 1, rarity: ["common"], level: 0, buy: 1, sell: 0.5, purse: 150 },
  rich: { count: 1.5, qty: 1.5, rarity: ["common", "uncommon"], level: 1, buy: 1, sell: 0.5, purse: 800 },
  lavish: { count: 2.5, qty: 2, rarity: ["common", "uncommon", "rare"], level: 2, buy: 1.05, sell: 0.5, purse: 4000 }
};

/** Gold (cp) a shop of this wealth can spend, for a party of this level. */
export function purseFor(wealth, level = 1) {
  const w = WEALTH[wealth] ?? WEALTH.modest;
  return Math.round(w.purse * (1 + Math.max(0, Number(level) - 1) / 3)) * 100;
}

/** Settings that follow from a wealth level (for a new shop or the "apply" button). */
export function wealthConfig(wealth, level = 1) {
  const w = WEALTH[wealth] ?? WEALTH.modest;
  const purse = purseFor(wealth, level);
  return { wealth, buyRate: w.buy, sellRate: w.sell, purse: { on: true, max: purse, value: purse, refill: 25 } };
}

/** Player characters, for how many of each thing a shop keeps. */
export function partySize() {
  return Math.max(1, game.actors.filter(a => a.type === "character" && a.hasPlayerOwner).length || 4);
}

/* ---------------- making and filling shops ---------------- */

export async function createShop({ name, template = null, config = {} } = {}) {
  const cfg = foundry.utils.mergeObject(defaultConfig(), config, { inplace: false });
  const tpl = template ? templates()[template] : null;
  if (tpl) foundry.utils.mergeObject(cfg, tpl.config ?? {});
  cfg.title ||= name;
  cfg.restock.lastDay = dayNumber();
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  const actor = await Actor.create({
    name: name || t("Shop.DefaultName"), type: "loot", img: tpl?.img ?? "icons/environment/settlement/market-stall.webp",
    ownership: { default: cfg.open ? L.LIMITED : L.NONE },
    system: { lootSheetType: "Merchant", hiddenWhenEmpty: false },
    flags: { [MID]: { shop: cfg }, core: { sheetClass: SHEET_ID } },
    prototypeToken: { actorLink: true, name: name || t("Shop.DefaultName") }
  });
  return actor;
}

/** Add items (uuids or documents) to a shop; the same item again only raises its count. */
export async function addStock(actor, things, { qty = 1, max = null, perDay = 1, infinite = false } = {}) {
  const creates = [];
  const updates = [];
  for (const thing of things) {
    const doc = typeof thing === "string" ? await preferMirror(thing) : thing;
    if (!doc || !["weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack", "ammo", "kit"].includes(doc.type)) continue;
    const source = sourceIdOf(doc) ?? doc.uuid;
    const same = actor.items.find(i => (sourceIdOf(i) ?? i.uuid) === source || (doc.pack && sourceIdOf(i) === doc.uuid));
    if (same) {
      const q = (same.system.quantity ?? 0) + qty;
      updates.push({ _id: same.id, "system.quantity": q, [`flags.${MID}.stock.max`]: Math.max(stockOf(same).max, q) });
      continue;
    }
    const src = doc.toObject();
    delete src._id;
    src.system.quantity = qty;
    src.system.equipped = { carryType: "worn", handsHeld: 0, invested: null };
    src.system.containerId = null;
    src._stats = { ...(src._stats ?? {}), compendiumSource: doc.pack ? doc.uuid : (sourceIdOf(doc) ?? null) };
    src.flags = { ...(src.flags ?? {}), [MID]: { stock: { max: max ?? qty, perDay, infinite, priceMul: 1 } } };
    creates.push(src);
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (creates.length) await actor.createEmbeddedDocuments("Item", creates);
  return creates.length + updates.length;
}

/* ---------------- time and restocking ---------------- */

export function dayNumber(time = game.time?.worldTime ?? 0) {
  return Math.floor(time / 86400);
}

/** Chance (0–100) that an item comes back in one restock period, by its own setting or its rarity. */
export function restockChance(cfg, item) {
  const st = stockOf(item);
  if (st.chance !== null && !Number.isNaN(st.chance)) return clamp(st.chance, 0, 100);
  const r = item?.system?.traits?.rarity ?? "common";
  return clamp(Number(cfg.restock?.chance?.[r] ?? 100), 0, 100);
}

/**
 * Bring the shelves back for `periods` restock periods. "fill": perDay each period (-1 = to max).
 * "chance": each period every item rolls (unseen) against its chance; on a success it gets perDay (or to max).
 * Creatures follow the same rules. Returns how many lines changed.
 */
export async function restock(actor, periods = 1, { roll = Math.random } = {}) {
  const cfg = configOf(actor);
  const chanceMode = cfg.restock?.mode === "chance";
  const updates = [];
  const grow = (q, st, ch) => {
    let next = q;
    for (let i = 0; i < periods; i++) {
      if (chanceMode && roll() * 100 >= ch) continue;
      next = st.perDay < 0 ? Math.max(next, st.max) : clamp(next + st.perDay, 0, Math.max(st.max, next));
    }
    return next;
  };
  for (const item of shelf(actor)) {
    const st = stockOf(item);
    if (st.infinite || (!st.perDay && !chanceMode)) continue;
    if (chanceMode && !st.perDay) st.perDay = 1;
    const q = Number(item.system.quantity ?? 0);
    if (q >= st.max) continue;
    const next = grow(q, st, restockChance(cfg, item));
    if (next !== q) updates.push({ _id: item.id, "system.quantity": next });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  let changed = updates.length;
  for (const c of cfg.creatures ?? []) {
    if (c.infinite) continue;
    const st = { max: Number(c.max ?? 1), perDay: Number(c.perDay ?? 1) || (chanceMode ? 1 : 0) };
    if (!st.perDay || c.qty >= st.max) continue;
    const ch = c.chance ?? Number(cfg.restock?.chance?.[c.rarity ?? "common"] ?? 100);
    const next = grow(Number(c.qty ?? 0), st, ch);
    if (next !== c.qty) { c.qty = next; changed++; }
  }
  // The purse fills up again a bit each period.
  if (cfg.purse?.on && cfg.purse.max > 0) {
    const add = Math.round(cfg.purse.max * (Number(cfg.purse.refill ?? 25) / 100) * periods);
    cfg.purse.value = Math.min(cfg.purse.max, Number(cfg.purse.value ?? 0) + add);
  }
  cfg.restock.lastDay = dayNumber();
  await saveConfig(actor, cfg);
  return changed;
}

/** The world's clock moved on: restock every shop that follows time, once per its period (GM only). */
export async function restockByTime() {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  const today = dayNumber();
  for (const actor of shopList()) {
    const cfg = configOf(actor);
    if (!cfg.restock.auto) continue;
    const every = Math.max(1, Math.round(Number(cfg.restock.every) || 1));
    const last = cfg.restock.lastDay ?? today;
    if (today - last >= every) {
      const periods = Math.floor((today - last) / every);
      const n = await restock(actor, periods);
      // Keep the rhythm: the next period counts from the last one, not from today.
      const after = configOf(actor);
      after.restock.lastDay = last + periods * every;
      await saveConfig(actor, after);
      if (n) ui.notifications.info(t("Restock.Done", { shop: actor.name, n, days: periods * every }));
    } else if (cfg.restock.lastDay === null || today < last) {
      cfg.restock.lastDay = today;
      await saveConfig(actor, cfg);
    }
  }
}

/** Days until the next restock (null when the shop does not follow time). */
export function nextRestockIn(cfg) {
  if (!cfg.restock?.auto) return null;
  const every = Math.max(1, Math.round(Number(cfg.restock.every) || 1));
  const last = cfg.restock.lastDay ?? dayNumber();
  return Math.max(0, last + every - dayNumber());
}

/* ---------------- auto-fill and templates ---------------- */

/**
 * Fill a shop from the catalog. f: search filters (cat, sub, levelMin, levelMax, rarity, text, magical);
 * opts: { count (0 = all), qty, perDay, infinite, random }
 */
export async function autofill(actor, f, opts = {}) {
  const cat = await loadCatalog();
  let found = searchCatalog(cat, f);
  if (f.cats?.length) found = found.filter(e => f.cats.includes(e.cat));
  if (f.slugs?.length) found = found.filter(e => f.slugs.includes(e.slug));
  const count = Number(opts.count) || 0;
  if (opts.random !== false && count && found.length > count) {
    found = [...found].sort(() => Math.random() - 0.5).slice(0, count).sort((a, b) => a.level - b.level);
  } else if (count) found = found.slice(0, count);
  return addStock(actor, found.map(e => e.uuid), { qty: Number(opts.qty) || 1, max: Number(opts.qty) || 1, perDay: Number(opts.perDay ?? 1), infinite: !!opts.infinite });
}

/*
 * Templates are data, so the GM can change them (and add their own) in the editor:
 *   { name, img, config: {…shop settings…}, steps: [step], creatures: bool }
 *   step: { cat, sub, lvMin, lvMax, lvCap, rarity: [...], magical: true|false|null, legacy: bool,
 *           count, qty, perDay, infinite, text }
 * lvMin / lvMax are relative to the level asked for (the party's), lvCap an absolute top (null = none).
 */
// Core Foundry icon (an earlier version pointed at a file Foundry doesn't have).
export const ARMS_ICON = "icons/svg/sword.svg";
export const BROKEN_ICONS = ["icons/weapons/swords/swords-crossed-steel.webp"];
const step = (cat, o = {}) => ({ cat, sub: "", lvMin: null, lvMax: 0, lvCap: null, rarity: ["common"], magical: null, legacy: false, count: 0, qty: 1, perDay: 1, infinite: false, text: "", slugs: [], ...o });

/*
 * Things PF2e has no item for — Player Core, Basic Services and Cuisine (prices in copper).
 * The shop makes them as plain consumables; food is flagged so Rutz's PF2e Days eats it.
 */
const DRINK = "icons/consumables/drinks/wine-amphora-cup-gray.webp";
const WINE = "icons/consumables/drinks/wine-amphora-clay-pink.webp";
export const CUISINE = {
  ale: { cp: 1, bulk: 0.1, img: DRINK, drink: true },
  keg: { cp: 20, bulk: 2, img: WINE, drink: true },
  tea: { cp: 2, bulk: 0.1, img: DRINK, drink: true },
  wine: { cp: 10, bulk: 0.1, img: WINE, drink: true },
  fineWine: { cp: 100, bulk: 0.1, img: WINE, drink: true },
  poorMeal: { cp: 1, bulk: 0.1, img: "icons/consumables/fruit/apple-ripe-red.webp", food: true },
  squareMeal: { cp: 3, bulk: 0.1, img: "icons/consumables/food/steak-aged-brown.webp", food: true },
  fineDining: { cp: 100, bulk: 0.1, img: "icons/consumables/meat/hock-leg-stylized.webp", food: true }
};

/** Make (or top up) the cuisine items a template lists. */
export async function stockCuisine(actor, keys = [], { qty = 10 } = {}) {
  const creates = [];
  for (const key of keys) {
    const c = CUISINE[key];
    if (!c) continue;
    if (actor.items.some(i => i.getFlag(MID, "cuisine") === key)) continue;
    creates.push({
      type: "consumable", name: game.i18n.localize(`RPS.Cuisine.${key}`), img: c.img,
      system: { quantity: qty, price: { value: { cp: c.cp } }, category: "other", bulk: { value: c.bulk }, level: { value: 0 },
        uses: { value: 1, max: 1, autoDestroy: true }, traits: { value: [], rarity: "common" },
        description: { value: `<p>${game.i18n.localize(`RPS.Cuisine.${key}Desc`)}</p>` }, equipped: { carryType: "worn", handsHeld: 0 } },
      flags: { [MID]: { cuisine: key, food: !!c.food, stock: { max: qty, perDay: -1, infinite: true, priceMul: 1 } }, "rutz-pf2e-days": c.food ? { food: true } : {} }
    });
  }
  if (creates.length) await actor.createEmbeddedDocuments("Item", creates);
  return creates.length;
}
export const BUILTIN_TEMPLATES = {
  arms: {
    name: "Tpl.arms", img: ARMS_ICON,
    config: { buys: ["weapon", "armor"], services: { repair: { on: false }, runes: { on: false }, material: { on: false } } },
    steps: [
      step("weapon", { lvMax: 0, lvCap: 2, magical: false, count: 18, qty: 2 }),
      step("weapon", { lvMin: -3, lvMax: 0, magical: true, count: 5, qty: 1, perDay: 0 }),
      step("armor", { sub: "light", lvCap: 2, magical: false, count: 4, qty: 1 }),
      step("armor", { sub: "medium", lvCap: 2, magical: false, count: 4, qty: 1 }),
      step("armor", { sub: "heavy", lvCap: 2, magical: false, count: 3, qty: 1 }),
      step("armor", { sub: "shield", lvCap: 2, magical: false, count: 4, qty: 1 }),
      step("ammo", { sub: "missile", lvCap: 1, count: 0, qty: 10, perDay: -1 })
    ]
  },
  smith: {
    name: "Tpl.smith", img: "icons/tools/smithing/anvil.webp",
    config: { buys: ["weapon", "armor", "material"], services: { repair: { on: true, mode: "percent", percent: 10 }, runes: { on: false }, material: { on: true, rate: 1 } } },
    steps: [
      step("material", { lvMax: 2, rarity: ["common", "uncommon"], count: 0, qty: 3, perDay: 1 }),
      step("weapon", { lvCap: 1, magical: false, count: 8, qty: 1 }),
      step("armor", { lvCap: 1, magical: false, count: 4, qty: 1 })
    ]
  },
  runes: {
    name: "Tpl.runes", img: "icons/magic/symbols/runes-star-pentagon-orange.webp",
    config: { buys: ["rune"], services: { runes: { on: true, transfer: true }, repair: { on: false }, material: { on: false } } },
    steps: [
      step("rune", { sub: "weapon-fundamental", lvMax: 2, infinite: true }),
      step("rune", { sub: "armor-fundamental", lvMax: 2, infinite: true }),
      step("rune", { sub: "shield-fundamental", lvMax: 2, infinite: true }),
      step("rune", { sub: "weapon-property", lvMax: 2, count: 12, perDay: 0 }),
      step("rune", { sub: "armor-property", lvMax: 2, count: 8, perDay: 0 }),
      step("rune", { sub: "runestone", lvMax: null, infinite: true })
    ]
  },
  alchemist: {
    name: "Tpl.alchemist", img: "icons/consumables/potions/bottle-round-corked-orante-red.webp",
    config: { buys: ["potion", "consumable", "treasure"] },
    steps: [step("potion", { lvMin: -4, count: 16, qty: 3 }), step("consumable", { lvMin: -4, count: 6, qty: 2 })]
  },
  general: {
    name: "Tpl.general", img: "icons/containers/bags/pack-leather-brown.webp",
    config: { buys: [] },
    steps: [step("gear", { lvMax: null, lvCap: 1, magical: false, count: 20, qty: 5, perDay: -1 })]
  },
  magic: {
    name: "Tpl.magic", img: "icons/magic/symbols/question-stone-yellow.webp",
    config: { buys: ["magic", "scroll", "treasure"] },
    steps: [step("magic", { lvMin: -3, lvMax: 1, count: 12, perDay: 0 }), step("scroll", { count: 6, perDay: 0 })]
  },
  provisions: {
    name: "Tpl.provisions", img: "systems/pf2e/icons/equipment/adventuring-gear/rations.webp",
    config: { buys: ["gear"] },
    cuisine: Object.keys(CUISINE),
    steps: [
      step("all", { lvMax: null, slugs: ["rations", "feed-standard", "feed-unique"], qty: 10, perDay: -1, infinite: true }),
      step("all", { lvMax: null, slugs: ["waterskin", "bedroll", "torch", "flint-and-steel", "rope", "soap", "candle", "chalk", "sack", "backpack", "oil-1-pint", "tent-pup"], qty: 4, perDay: -1 })
    ]
  },
  companion: {
    name: "Tpl.companion", img: "icons/environment/creatures/horse-brown.webp",
    config: { buys: ["companion", "gear"] }, creatures: true,
    steps: [step("companion", { lvMax: 1, count: 14 })]
  }
};
// Old shops and macros still say TEMPLATES.
export const TEMPLATES = BUILTIN_TEMPLATES;

/** Built-in templates with the GM's changes, plus the GM's own. */
export function templates() {
  let own = {};
  try { own = JSON.parse(setting("templates", "{}") || "{}") ?? {}; } catch (_) { own = {}; }
  const out = {};
  for (const [k, v] of Object.entries(BUILTIN_TEMPLATES)) out[k] = { ...foundry.utils.deepClone(v), key: k, builtin: true, changed: !!own[k] };
  for (const [k, v] of Object.entries(own)) if (v) out[k] = { ...foundry.utils.deepClone(v), key: k, builtin: !!BUILTIN_TEMPLATES[k], changed: !!BUILTIN_TEMPLATES[k] };
  for (const tp of Object.values(out)) if (BROKEN_ICONS.includes(tp.img)) tp.img = ARMS_ICON;
  return out;
}

export function templateName(tpl) {
  return tpl?.name?.startsWith?.("Tpl.") ? game.i18n.localize(`RPS.${tpl.name}`) : tpl?.name ?? "";
}

export async function saveTemplate(key, tpl) {
  let own = {};
  try { own = JSON.parse(setting("templates", "{}") || "{}") ?? {}; } catch (_) { own = {}; }
  if (tpl === null) delete own[key]; else {
    const { key: _k, builtin: _b, changed: _c, ...data } = tpl;
    own[key] = data;
  }
  await game.settings.set(MID, "templates", JSON.stringify(own));
}

export function newStep(cat = "gear") {
  return step(cat);
}

export function stepFilter(st, level) {
  const lv = Number(level) || 1;
  let max = st.lvMax === null || st.lvMax === "" || st.lvMax === undefined ? null : lv + Number(st.lvMax);
  if (st.lvCap !== null && st.lvCap !== "" && st.lvCap !== undefined) max = max === null ? Number(st.lvCap) : Math.min(max, Number(st.lvCap));
  const min = st.lvMin === null || st.lvMin === "" || st.lvMin === undefined ? null : Math.max(0, lv + Number(st.lvMin));
  return {
    f: { cat: st.cat || "all", sub: st.sub || "", levelMin: min, levelMax: max, rarity: new Set(st.rarity?.length ? st.rarity : ["common"]),
      magical: st.magical === true || st.magical === false ? st.magical : null, legacy: !!st.legacy, text: st.text ?? "", slugs: st.slugs?.length ? st.slugs : null },
    opts: { count: Number(st.count) || 0, qty: Number(st.qty) || 1, perDay: Number(st.perDay ?? 1), infinite: !!st.infinite }
  };
}

export async function fillFromTemplate(actor, key, level, { wealth = null, party = null } = {}) {
  const tpl = typeof key === "object" ? key : templates()[key];
  if (!tpl) return 0;
  const w = WEALTH[wealth ?? configOf(actor).wealth] ?? WEALTH.modest;
  // Four players is what the templates are written for.
  const people = Math.max(1, Number(party) || partySize()) / 4;
  let n = 0;
  for (const st of tpl.steps ?? []) {
    const { f, opts } = stepFilter(st, Number(level) + w.level);
    if (opts.count) opts.count = Math.max(1, Math.round(opts.count * w.count));
    if (!opts.infinite) opts.qty = Math.max(1, Math.round(opts.qty * w.qty * (opts.qty > 1 ? people : 1)));
    // Richer shops also carry rarer things; a step the GM set to several rarities keeps its own list.
    if ((st.rarity ?? ["common"]).length <= 1) f.rarity = new Set([...f.rarity, ...w.rarity]);
    n += await autofill(actor, f, opts);
  }
  if (tpl.creatures) n += await stockAnimals(actor, level);
  if (tpl.cuisine?.length) n += await stockCuisine(actor, tpl.cuisine);
  return n;
}

/* ---------------- creatures (animals for sale) ---------------- */

// Player Core p.295 (Animals): price in silver.
export const ANIMAL_PRICES = {
  "messenger-raven": 40, "hunting-eagle": 80, "guard-dog": 2, "service-dog": 40, "riding-dog": 40,
  "riding-horse": 80, "horse": 80, "warhorse": 300, "pack-animal": 20, "riding-pony": 70, "pony": 70, "warpony": 240,
  "camel": 30, "riding-drake": 3000, "mule": 20, "donkey": 20
};
const ANIMAL_ALIASES = { raven: "messenger-raven", eagle: "hunting-eagle", dog: "guard-dog" };

/** Actor packs with creatures (bestiaries), for the GM to pick animals from. */
export function creaturePacks() {
  return game.packs.filter(p => p.documentName === "Actor");
}

/** A reasonable price for a creature (copper): the rulebook price, else by level (the GM can change it). */
export function creaturePriceCp(entry) {
  const slug = entry.slug ?? "";
  const sp = ANIMAL_PRICES[slug] ?? ANIMAL_PRICES[ANIMAL_ALIASES[slug]];
  if (sp) return sp * 10;
  const lv = Math.max(-1, Number(entry.level ?? 0));
  return Math.round([20, 40, 120, 250, 500, 800, 1200, 1800, 2500][lv + 1] ?? 3000 * (lv - 6)) * 10;
}

export async function searchCreatures(text = "", { animalsOnly = true, levelMax = null } = {}) {
  const out = [];
  const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  for (const pack of creaturePacks()) {
    let idx;
    try { idx = await pack.getIndex({ fields: ["system.details.level.value", "system.traits.value", "system.traits.rarity", "system.slug", "flags.PF2e-KR.originalName"] }); } catch (_) { continue; }
    for (const e of idx) {
      if (e.type !== "npc") continue;
      const traits = e.system?.traits?.value ?? [];
      if (animalsOnly && !traits.includes("animal")) continue;
      const level = Number(e.system?.details?.level?.value ?? 0);
      if (levelMax !== null && level > levelMax) continue;
      const english = e.flags?.["PF2e-KR"]?.originalName ?? "";
      const hay = `${e.name} ${english}`.toLowerCase();
      if (!words.every(w => hay.includes(w))) continue;
      const slug = e.system?.slug || game.pf2e?.system?.sluggify?.(english || e.name) || "";
      out.push({ uuid: e.uuid ?? `Compendium.${pack.collection}.Actor.${e._id}`, name: e.name, img: e.img, level, slug, rarity: e.system?.traits?.rarity ?? "common", pack: pack.collection });
    }
  }
  return out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, game.i18n.lang));
}

export async function addCreatures(actor, entries, { qty = 1, perDay = 1, infinite = false } = {}) {
  const cfg = configOf(actor);
  cfg.creatures ??= [];
  let n = 0;
  for (const e of entries) {
    const same = cfg.creatures.find(c => c.uuid === e.uuid);
    if (same) { same.qty += qty; same.max = Math.max(same.max, same.qty); n++; continue; }
    cfg.creatures.push({ id: randomId(), uuid: e.uuid, name: e.name, img: e.img, level: e.level, rarity: e.rarity ?? "common", slug: e.slug ?? "",
      priceCp: e.priceCp ?? creaturePriceCp(e), qty, max: qty, perDay, infinite, chance: null });
    n++;
  }
  await saveConfig(actor, cfg);
  return n;
}

/** The Player Core animals that this world's bestiaries have, up to a level. */
export async function stockAnimals(actor, level = 1) {
  const all = await searchCreatures("", { levelMax: Math.max(2, Number(level) || 1) });
  const known = all.filter(e => ANIMAL_PRICES[e.slug] || ANIMAL_PRICES[ANIMAL_ALIASES[e.slug]]);
  const seen = new Set();
  const pick = known.filter(e => (seen.has(e.slug) ? false : seen.add(e.slug)));
  return addCreatures(actor, pick, { qty: 1, perDay: 1 });
}

export function buyCreatureCp(cfg, c) {
  return Math.max(1, Math.round((Number(c.priceCp) || 0) * (Number(cfg.buyRate) || 1) * eventFactor(cfg, "buy", "companion")));
}

/* ---------------- moving shops between worlds ---------------- */

export function exportShop(actor) {
  return {
    format: "rutz-pf2e-shop", version: 1, exported: new Date().toISOString(), world: game.world?.title ?? "",
    name: actor.name, img: actor.img, config: { ...configOf(actor), ledger: [] },
    stock: shelf(actor).map(i => {
      const data = i.toObject();
      delete data._id;
      return { uuid: sourceIdOf(i), name: i.name, data };
    })
  };
}

/** A shop from an exported file: items by their compendium link when this world has it, else as saved. */
export async function importShop(json) {
  const list = Array.isArray(json) ? json : json?.shops ?? [json];
  const made = [];
  for (const s of list) {
    if (s?.format !== "rutz-pf2e-shop") continue;
    const actor = await createShop({ name: s.name, config: s.config ?? {} });
    if (s.img) await actor.update({ img: s.img });
    const creates = [];
    for (const row of s.stock ?? []) {
      let data = row.data;
      if (row.uuid) {
        const doc = await preferMirror(row.uuid).catch(() => null);
        if (doc) {
          const fresh = doc.toObject();
          delete fresh._id;
          fresh.system.quantity = data?.system?.quantity ?? 1;
          fresh.flags = { ...(fresh.flags ?? {}), [MID]: data?.flags?.[MID] ?? {} };
          fresh._stats = { ...(fresh._stats ?? {}), compendiumSource: doc.uuid };
          data = fresh;
        }
      }
      if (data) creates.push(data);
    }
    if (creates.length) await actor.createEmbeddedDocuments("Item", creates);
    made.push(actor);
  }
  return made;
}

export function newEvent(name = "") {
  return { id: randomId(), name, active: true, buy: 1, sell: 1, cats: [] };
}
