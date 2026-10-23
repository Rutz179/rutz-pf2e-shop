import { PLUS } from "./edition.mjs";
import { MID, SOCKET, cpToCoins, esc, formatCp, randomId, setting, sourceIdOf, t, walletCp } from "./util.mjs";
import { buyCreatureCp, buyRateOf, buyUnitCp, buysCategory, configOf, formulaOffers, formulaPriceCp, knowsFormula, saveConfig, sellUnitCp, stockOf, dayNumber } from "./shop.mjs";
import { MATERIALS, MATERIAL_INFO, MATERIAL_STATS, PLAIN_STATS } from "./materials.mjs";
import { classify, loadCatalog, runeEffect, runeFits } from "./catalog.mjs";
import { hpOf, stateOf } from "./durability.mjs";

/* ======================================================================== *
 * Every trade is done by the GM's client: players may not change the shop
 * (and the shop may not change them), so a player's click is sent to the
 * active GM over the module socket, checked again there (money, stock,
 * ownership) and carried out; the answer comes back to the player. A GM
 * trades directly. Each trade is written to the chat and the shop's ledger.
 *
 *   buy      { shopId, itemId, qty, actorId }
 *   sell     { shopId, itemId, qty, actorId }          itemId: the player's item
 *   repair   { shopId, itemId, actorId }
 *   etch     { shopId, runeId, itemId, actorId }       runeId: a rune on the shelf
 *   transfer { shopId, fromId, toId, rune, actorId }   rune: "potency" | "striking" | … | property key
 * ======================================================================== */

const waiting = new Map();

export function initSocket() {
  game.socket.on(SOCKET, async msg => {
    if (msg?.type === "trade") {
      if (game.users.activeGM?.id !== game.user.id) return;
      const user = game.users.get(msg.userId);
      let reply;
      try {
        reply = { ok: true, result: await perform(msg.kind, msg.data, user) };
      } catch (err) {
        reply = { ok: false, error: String(err?.message ?? err) };
      }
      game.socket.emit(SOCKET, { type: "traded", to: msg.userId, requestId: msg.requestId, ...reply });
      return;
    }
    if (msg?.type === "traded" && msg.to === game.user.id) {
      const w = waiting.get(msg.requestId);
      if (!w) return;
      waiting.delete(msg.requestId);
      if (msg.ok) w.resolve(msg.result); else w.reject(new Error(msg.error));
    }
  });
}

/** Ask for a trade: done here by a GM, otherwise by the active GM. Resolves with a summary, rejects with a reason. */
export async function request(kind, data) {
  if (game.user.isGM) return perform(kind, data, game.user);
  if (!game.users.activeGM) throw new Error(t("Trade.NoGM"));
  const requestId = randomId();
  const result = new Promise((resolve, reject) => {
    waiting.set(requestId, { resolve, reject });
    setTimeout(() => { if (waiting.delete(requestId)) reject(new Error(t("Trade.Timeout"))); }, 20000);
  });
  game.socket.emit(SOCKET, { type: "trade", kind, data, userId: game.user.id, requestId });
  return result;
}

/* ---------------- carried out on the GM's side ---------------- */

function need(cond, key, data) {
  if (!cond) throw new Error(t(`Trade.Err.${key}`, data));
}

function shopFor(data, user) {
  const shop = game.actors.get(data.shopId);
  need(shop, "NoShop");
  const cfg = configOf(shop);
  need(cfg.open || user.isGM, "Closed");
  return { shop, cfg };
}

function customerFor(data, user) {
  const actor = game.actors.get(data.actorId);
  need(actor && actor.testUserPermission(user, "OWNER"), "NotYours");
  return actor;
}

const RATE = { cp: 1, sp: 10, gp: 100, pp: 1000 };

/** The coins an actor holds, by denomination. */
function coinCounts(actor) {
  const c = actor?.inventory?.currency ?? actor?.inventory?.coins ?? {};
  return { cp: Number(c.cp) || 0, sp: Number(c.sp) || 0, gp: Number(c.gp) || 0, pp: Number(c.pp) || 0 };
}

/**
 * Which coins to hand over for `cp` copper, and the change to get back: small coins first, then one
 * bigger coin (platinum too) broken when the small ones don't add up. { remove, change } or null.
 */
export function makeChange(have, cp) {
  let left = Math.round(cp);
  const remove = { cp: 0, sp: 0, gp: 0, pp: 0 };
  for (const d of ["cp", "sp", "gp", "pp"]) {
    const use = Math.min(have[d], Math.floor(left / RATE[d]));
    remove[d] = use;
    left -= use * RATE[d];
  }
  let change = 0;
  if (left > 0) {
    const d = ["cp", "sp", "gp", "pp"].find(x => have[x] - remove[x] > 0 && RATE[x] > left);
    if (!d) return null;
    remove[d] += 1;
    change = RATE[d] - left;
  }
  return { remove, change };
}

async function pay(actor, cp) {
  if (cp <= 0) return true;
  const wallet = walletCp(actor);
  need(wallet >= cp, "NoMoney", { need: formatCp(cp), have: formatCp(wallet) });
  const plan = makeChange(coinCounts(actor), cp);
  let ok = false;
  if (plan) {
    const remove = Object.fromEntries(Object.entries(plan.remove).filter(([, n]) => n > 0));
    ok = await actor.inventory.removeCoins(remove, { byValue: false });
    if (ok && plan.change) await actor.inventory.addCoins(cpToCoins(plan.change));
  }
  // Coins PF2e counts but we could not see by kind: leave it to PF2e.
  if (!ok) ok = await actor.inventory.removeCoins({ cp }, { byValue: true });
  need(ok, "NoMoney", { need: formatCp(cp), have: formatCp(walletCp(actor)) });
  return true;
}

async function receive(actor, cp) {
  if (cp <= 0) return;
  await actor.inventory.addCoins(cpToCoins(cp));
}

/** Put bought things in the customer's inventory (stacked onto the same thing when it stacks). */
async function give(actor, item, qty) {
  const source = sourceIdOf(item);
  const stackable = ["consumable", "ammo", "treasure"].includes(item.type) || (item.type === "equipment" && !item.system?.equipped?.invested);
  const same = stackable && source ? actor.items.find(i => i.type === item.type && sourceIdOf(i) === source && !i.isEquipped && !i.system?.containerId) : null;
  if (same) {
    await same.update({ "system.quantity": (same.system.quantity ?? 0) + qty });
    return same;
  }
  const src = item.toObject();
  delete src._id;
  if (src.flags?.[MID]) delete src.flags[MID];
  src.system.quantity = qty;
  src.system.containerId = null;
  src.system.equipped = { carryType: "worn", handsHeld: 0, invested: src.system.traits?.value?.includes("invested") ? false : null };
  const [made] = await actor.createEmbeddedDocuments("Item", [src]);
  return made;
}

async function log(shop, cfg, entry, { whisperTo = [] } = {}) {
  const icon = { buy: "fa-cart-shopping", sell: "fa-hand-holding-dollar", repair: "fa-hammer", etch: "fa-hexagon-nodes", transfer: "fa-right-left", creature: "fa-paw", material: "fa-cubes", formula: "fa-scroll" }[entry.kind] ?? "fa-coins";
  const verb = t(`Log.${entry.kind}`, { actor: esc(entry.actor), qty: entry.qty ?? 1, item: entry.link ?? esc(entry.item), extra: esc(entry.extra ?? "") });
  const money = entry.cp ? `<span class="rps-money ${entry.kind === "sell" ? "in" : "out"}">${entry.kind === "sell" ? "+" : "−"}${formatCp(entry.cp, { html: true })}</span>` : "";
  const content = `<div class="rps-log ${entry.kind}"><header><i class="fa-solid ${icon}"></i> <b>${esc(shop.name)}</b></header><p>${verb}</p>${money}</div>`;
  const mode = setting("logMode", "public");
  const gms = game.users.filter(u => u.isGM).map(u => u.id);
  const whisper = mode === "public" ? [] : mode === "gm" ? gms : [...new Set([...gms, ...whisperTo])];
  await ChatMessage.create({ speaker: { alias: cfg.merchant?.name || shop.name }, content, whisper, flags: { [MID]: { log: entry.kind } } });
  cfg.ledger = [{ ...entry, link: undefined, at: Date.now(), day: dayNumber() }, ...(cfg.ledger ?? [])].slice(0, 200);
  await saveConfig(shop, cfg);
}

export async function perform(kind, data, user = game.user) {
  switch (kind) {
    case "buy": return buy(data, user);
    case "sell": return sell(data, user);
    case "repair": return repair(data, user);
    // @plus — rune forge, animals, the smithy, formulas
    case "etch": return etch(data, user);
    case "transfer": return transfer(data, user);
    case "creature": return buyCreature(data, user);
    case "material": return reforge(data, user);
    case "formula": return buyFormula(data, user);
    // @end-plus
    case "restock": need(user.isGM, "NotYours"); return null;
  }
  throw new Error(`unknown trade ${kind}`);
}

async function buy(data, user) {
  const { shop, cfg } = shopFor(data, user);
  const actor = customerFor(data, user);
  const item = shop.items.get(data.itemId);
  need(item, "NoItem");
  const st = stockOf(item);
  const qty = Math.max(1, Math.floor(Number(data.qty) || 1));
  need(st.infinite || (item.system.quantity ?? 0) >= qty, "NoStock", { n: item.system.quantity ?? 0 });
  const total = buyUnitCp(cfg, item) * qty;
  await pay(actor, total);
  if (cfg.purse?.on) cfg.purse.value = Math.min(Number(cfg.purse.max ?? 0), Number(cfg.purse.value ?? 0) + total);
  const made = await give(actor, item, qty);
  if (!st.infinite) await item.update({ "system.quantity": (item.system.quantity ?? 0) - qty });
  await log(shop, cfg, { kind: "buy", actor: actor.name, user: user.name, item: item.name, link: made ? `@UUID[${made.uuid}]{${esc(item.name)}}` : null, qty, cp: total }, { whisperTo: [user.id] });
  return { total, item: item.name, qty };
}

async function sell(data, user) {
  const { shop, cfg } = shopFor(data, user);
  const actor = customerFor(data, user);
  const item = actor.items.get(data.itemId);
  need(item, "NoItem");
  need(buysCategory(cfg, item), "NotBuying");
  need(!(item.type === "treasure" && item.isCurrency), "NotBuying");
  const qty = Math.min(Math.max(1, Math.floor(Number(data.qty) || 1)), item.system.quantity ?? 1);
  const total = sellUnitCp(cfg, item) * qty;
  // The shop's purse: it can't pay more than it has (this is what stops endless crafting-and-selling).
  if (cfg.purse?.on) {
    need(total <= Number(cfg.purse.value ?? 0), "NoPurse", { have: formatCp(Number(cfg.purse.value ?? 0)), need: formatCp(total) });
    cfg.purse.value = Number(cfg.purse.value ?? 0) - total;
  }
  if (cfg.resell) {
    const src = item.toObject();
    delete src._id;
    src.system.quantity = qty;
    src.system.containerId = null;
    src.flags = { ...(src.flags ?? {}), [MID]: { stock: { max: qty, perDay: 0, infinite: false, priceMul: 1 }, resold: { from: actor.name, day: dayNumber() } } };
    // Onto a stack only of the very same kind of thing (not a shelf item that never runs out, not a damaged one onto a whole one).
    const same = shop.items.find(i => sourceIdOf(i) && sourceIdOf(i) === sourceIdOf(item) && !stockOf(i).infinite
      && i.name === item.name && Number(i.system?.hp?.value ?? 0) === Number(item.system?.hp?.value ?? 0));
    if (same) await same.update({ "system.quantity": (same.system.quantity ?? 0) + qty });
    else await shop.createEmbeddedDocuments("Item", [src]);
  }
  const name = item.name;
  if (qty >= (item.system.quantity ?? 1)) await item.delete();
  else await item.update({ "system.quantity": item.system.quantity - qty });
  await receive(actor, total);
  await log(shop, cfg, { kind: "sell", actor: actor.name, user: user.name, item: name, qty, cp: total }, { whisperTo: [user.id] });
  return { total, item: name, qty };
}

export function repairCost(cfg, item) {
  const r = cfg.services?.repair ?? {};
  const { value, max } = hpOf(item);
  const missing = Math.max(0, max - value);
  if (!missing) return 0;
  if (r.mode === "perHp") return Math.max(1, Math.round(missing * (Number(r.perHp) || 0)));
  const base = Number(item.system?.price?.value?.gp ?? 0) * 100 + Number(item.system?.price?.value?.sp ?? 0) * 10 + Number(item.system?.price?.value?.cp ?? 0) + Number(item.system?.price?.value?.pp ?? 0) * 1000;
  return Math.max(1, Math.round(base * ((Number(r.percent) || 0) / 100) * (missing / max)));
}

async function repair(data, user) {
  const { shop, cfg } = shopFor(data, user);
  need(cfg.services?.repair?.on, "NoService");
  const actor = customerFor(data, user);
  const item = actor.items.get(data.itemId);
  need(item, "NoItem");
  const state = stateOf(item);
  need(state !== "destroyed", "Destroyed");
  need(state === "damaged" || state === "broken", "NotDamaged");
  const cost = repairCost(cfg, item);
  await pay(actor, cost);
  await item.update({ "system.hp.value": hpOf(item).max });
  await log(shop, cfg, { kind: "repair", actor: actor.name, user: user.name, item: item.name, cp: cost }, { whisperTo: [user.id] });
  return { total: cost, item: item.name };
}

/* ---------------- runes ---------------- */

/** What etching this rune onto this item would change, or why it can't: { ok, update, text } */
export function etchPlan(runeDoc, item) {
  const eff = runeEffect(runeDoc);
  if (!eff) return { ok: false, why: t("Rune.Unmodelled") };
  if (runeFits(runeDoc, item) === false) return { ok: false, why: t("Rune.DoesNotFit") };
  const r = item.system?.runes ?? {};
  if (eff.slot === "property") {
    const list = [...(r.property ?? [])];
    if (list.includes(eff.key)) return { ok: false, why: t("Rune.Already") };
    const slots = Number(r.potency ?? 0) + (item.system?.material?.type === "orichalcum" ? 1 : 0);
    // A greater version replaces the lesser one already there.
    const base = eff.key.replace(/^(greater|major|true|lesser|moderate|minor)(?=[A-Z])/, "").toLowerCase();
    const lesser = list.findIndex(k => k.replace(/^(greater|major|true|lesser|moderate|minor)(?=[A-Z])/, "").toLowerCase() === base);
    if (lesser >= 0) list.splice(lesser, 1, eff.key);
    else {
      if (list.length >= slots) return { ok: false, why: t("Rune.NoSlot", { n: slots }) };
      list.push(eff.key);
    }
    return { ok: true, update: { "system.runes.property": list } };
  }
  const cur = Number(r[eff.slot] ?? 0);
  if (cur >= eff.value) return { ok: false, why: t("Rune.Already") };
  return { ok: true, update: { [`system.runes.${eff.slot}`]: eff.value } };
}

// @plus
async function etch(data, user) {
  const { shop, cfg } = shopFor(data, user);
  need(cfg.services?.runes?.on, "NoService");
  const actor = customerFor(data, user);
  const rune = shop.items.get(data.runeId);
  const item = actor.items.get(data.itemId);
  need(rune && item, "NoItem");
  const st = stockOf(rune);
  need(st.infinite || (rune.system.quantity ?? 0) >= 1, "NoStock", { n: 0 });
  const plan = etchPlan(rune, item);
  need(plan.ok, "Custom", { text: plan.why ?? "" });
  const { cost, upgrade, fee } = await etchCost(cfg, rune, item);
  await pay(actor, cost);
  await item.update(plan.update);
  await renameByRunes(item);
  if (!st.infinite) await rune.update({ "system.quantity": (rune.system.quantity ?? 0) - 1 });
  await log(shop, cfg, { kind: "etch", actor: actor.name, user: user.name, item: item.name, extra: `${rune.name}${upgrade ? ` · ${t("Rune.UpgradeNote")}` : ""}${fee ? ` · ${t("Fee.Line", { cost: formatCp(fee) })}` : ""}`, cp: cost }, { whisperTo: [user.id] });
  return { total: cost, item: item.name, rune: rune.name };
}
// @end-plus

/**
 * What etching costs: a new rune — its shop price; an upgrade (a stronger fundamental rune, or a greater
 * property rune over its lesser one) — the difference in Price (at the shop's prices); plus the fee.
 * { cost, base, was, fee, upgrade }
 */
export async function etchCost(cfg, runeDoc, item) {
  const price = buyUnitCp(cfg, runeDoc);
  const eff = runeEffect(runeDoc);
  const r = item?.system?.runes ?? {};
  let was = 0;
  if (eff?.slot && eff.slot !== "property") {
    const cur = Number(r[eff.slot] ?? 0);
    if (cur > 0) {
      const list = await runePriceCp(item.type, eff.slot, eff.value);
      const old = await runePriceCp(item.type, eff.slot, cur);
      // The shop's own price for the new rune, less what the old one is worth at the same rate.
      was = list > 0 ? Math.round(price * (old / list)) : 0;
    }
  } else if (eff?.slot === "property") {
    const strip = k => String(k).replace(/^(greater|major|true|lesser|moderate|minor)(?=[A-Z])/, "").toLowerCase();
    const lesser = (r.property ?? []).find(k => strip(k) === strip(eff.key) && k !== eff.key);
    if (lesser) {
      const list = await runePriceCp(item.type, eff.key);
      const old = await runePriceCp(item.type, lesser);
      was = list > 0 ? Math.round(price * (old / list)) : 0;
    }
  }
  const base = Math.max(0, price - was);
  const fee = feeCp(cfg, base);
  return { cost: base + fee, base, was, fee, upgrade: was > 0 };
}

/** What moving a rune costs: 10% of its Price (and of the rune that swaps back), at the shop's rate, plus the fee. */
export async function transferCost(cfg, from, to, rune) {
  if (!from || !to || !rune) return { cost: 0, base: 0, fee: 0 };
  if (from.slug === "runestone" || from.system?.slug === "runestone") return { cost: 0, base: 0, fee: 0 };
  const fr = from.system?.runes ?? {};
  const tr = to.system?.runes ?? {};
  const fundamental = ["potency", "striking", "resilient", "reinforcing"].includes(rune);
  let list = await runePriceCp(from.type, rune, Number(fr[rune] ?? 0));
  if (fundamental && Number(tr[rune] ?? 0) > 0) list += await runePriceCp(to.type, rune, Number(tr[rune]));
  const base = Math.round(list * 0.1 * buyRateOf(cfg, "rune"));
  const fee = feeCp(cfg, base);
  return { cost: base + fee, base, fee };
}

/** Runes on an item, as rows for the transfer picker: { rune, label, kind, value } */
export function runesOn(item) {
  const r = item.system?.runes ?? {};
  const out = [];
  for (const slot of ["potency", "striking", "resilient", "reinforcing"]) {
    if (Number(r[slot] ?? 0) > 0) out.push({ rune: slot, fundamental: true, value: Number(r[slot]) });
  }
  for (const key of r.property ?? []) out.push({ rune: key, fundamental: false });
  return out;
}

// @plus
async function transfer(data, user) {
  const { shop, cfg } = shopFor(data, user);
  need(cfg.services?.runes?.on && cfg.services?.runes?.transfer, "NoService");
  const actor = customerFor(data, user);
  const from = actor.items.get(data.fromId);
  const to = actor.items.get(data.toId);
  need(from && to && from.id !== to.id, "NoItem");
  need(from.type === to.type || (from.slug === "runestone"), "Custom", { text: t("Rune.SameKind") });
  const fr = from.system.runes ?? {};
  const tr = to.system.runes ?? {};
  const fromUpdate = {};
  const toUpdate = {};
  const fundamental = ["potency", "striking", "resilient", "reinforcing"].includes(data.rune);
  if (fundamental) {
    const v = Number(fr[data.rune] ?? 0);
    need(v > 0, "NoItem");
    need(Number(tr[data.rune] ?? 0) < v, "Custom", { text: t("Rune.Already") });
    fromUpdate[`system.runes.${data.rune}`] = Number(tr[data.rune] ?? 0); // swap: the target's rune goes back
    toUpdate[`system.runes.${data.rune}`] = v;
  } else {
    const list = [...(fr.property ?? [])];
    need(list.includes(data.rune), "NoItem");
    const target = [...(tr.property ?? [])];
    need(!target.includes(data.rune), "Custom", { text: t("Rune.Already") });
    need(target.length < Number(tr.potency ?? 0), "Custom", { text: t("Rune.NoSlot", { n: Number(tr.potency ?? 0) }) });
    fromUpdate["system.runes.property"] = list.filter(k => k !== data.rune);
    toUpdate["system.runes.property"] = [...target, data.rune];
  }
  // Price: 10% of the rune's Price (GM Core) — of both when they swap; free from a runestone; plus the fee.
  const { cost, fee } = await transferCost(cfg, from, to, data.rune);
  await pay(actor, cost);
  await from.update(fromUpdate);
  await to.update(toUpdate);
  await renameByRunes(from);
  await renameByRunes(to);
  await log(shop, cfg, { kind: "transfer", actor: actor.name, user: user.name, item: `${from.name} → ${to.name}`, extra: `${data.runeLabel ?? data.rune}${fee ? ` · ${t("Fee.Line", { cost: formatCp(fee) })}` : ""}`, cp: cost }, { whisperTo: [user.id] });
  return { total: cost };
}
// @end-plus

/*
 * Fundamental runes' Prices (gp, GM Core) — what upgrading and moving them costs by the rules:
 *   upgrading a rune (+1 → +2) costs the difference between the two Prices;
 *   moving a rune (Transfer) costs 10% of its Price — of both, when two runes swap places.
 */
const FUNDAMENTAL_GP = {
  weapon: { potency: [0, 35, 935, 8935], striking: [0, 65, 1065, 31065] },
  armor: { potency: [0, 160, 1060, 20560], resilient: [0, 340, 3440, 49440] },
  shield: { reinforcing: [0, 75, 300, 900, 2500, 8000, 32000] }
};

/** The smith's fee (shop setting, percent) on top of a rules price. */
export function feeCp(cfg, cp) {
  return Math.max(0, Math.round(cp * (Number(cfg.services?.fee ?? 10) || 0) / 100));
}

/** List price of a rune (copper): fundamental runes from the table, property runes from the catalog. */
export async function runePriceCp(itemType, rune, value = 0) {
  const kind = itemType === "weapon" ? "weapon" : itemType === "armor" ? "armor" : "shield";
  const table = FUNDAMENTAL_GP[kind]?.[rune];
  if (table) return (table[Math.max(0, Math.min(table.length - 1, Number(value) || 0))] ?? 0) * 100;
  const cat = await loadCatalog();
  const hit = cat.list.find(e => {
    if (e.cat !== "rune") return false;
    const eff = runeEffect(e);
    if (!eff || eff.kind !== kind) return false;
    return eff.slot === "property" ? eff.key === rune : eff.slot === rune && eff.value === value;
  });
  return hit?.price ?? 0;
}

export { classify };

/* ---------------- names that follow the runes ---------------- */

const loc = k => (k ? game.i18n.localize(k) : "");
const known = k => !!k && game.i18n.localize(k) !== k;

/** The item's name without the runes we put in front ("+1 타격 롱소드" → "롱소드"). */
export function baseNameOf(item) {
  return item.getFlag?.(MID, "baseName") ?? item.flags?.[MID]?.baseName ?? item.name;
}

function runeLabel(kind, slot, value) {
  const R = CONFIG.PF2E?.runes ?? null;
  if (slot === "striking") return loc(["", "PF2E.Item.Weapon.Rune.Striking.Striking", "PF2E.Item.Weapon.Rune.Striking.Greater", "PF2E.Item.Weapon.Rune.Striking.Major"][value]);
  if (slot === "resilient") return loc(["", "PF2E.ArmorResilientRune", "PF2E.ArmorGreaterResilientRune", "PF2E.ArmorMajorResilientRune"][value]);
  if (slot === "reinforcing") return loc(`PF2E.Item.Shield.Rune.Reinforcing.${["", "Minor", "Lesser", "Moderate", "Greater", "Major", "Supreme"][value]}`);
  void R;
  return "";
}

function propertyLabel(kind, key) {
  for (const k of kind === "armor" ? [`PF2E.ArmorPropertyRune.${key}.Name`, `PF2E.ArmorPropertyRune${key[0].toUpperCase()}${key.slice(1)}`] : [`PF2E.WeaponPropertyRune.${key}.Name`]) {
    if (known(k)) return loc(k);
  }
  return key;
}

function materialWord(item) {
  const type = item.system?.material?.type;
  if (!type) return "";
  const key = CONFIG.PF2E?.preciousMaterials?.[type];
  return key ? loc(key) : type;
}

/**
 * Runes, then the material, then the base: "+1 상급 타격 화염의 냉철 석궁" / "+1 Greater Striking Flaming Cold Iron Crossbow".
 * In Korean the last rune word takes 의. The grade (low/standard/high) is left out — PF2e shows it on the item and the roll card.
 */
export function composeRuneName(item, base = baseNameOf(item)) {
  const r = item.system?.runes ?? {};
  const kind = item.type;
  const potency = Number(r.potency ?? 0);
  const second = kind === "weapon" ? runeLabel(kind, "striking", Number(r.striking ?? 0)) : kind === "armor" ? runeLabel(kind, "resilient", Number(r.resilient ?? 0)) : "";
  const reinforcing = kind === "shield" && Number(r.reinforcing ?? 0) ? runeLabel(kind, "reinforcing", Number(r.reinforcing)) : "";
  const props = (r.property ?? []).filter(Boolean).map(k => propertyLabel(kind, k));
  const ko = game.i18n.lang === "ko";
  const bare = ko ? String(base).replace(/\s*\([^()]*[A-Za-z][^()]*\)\s*$/, "") : String(base);
  const words = [reinforcing, second, ...props].filter(Boolean);
  if (ko && words.length) words[words.length - 1] = `${words.at(-1)}의`;
  return [potency ? `+${potency}` : "", ...words, materialWord(item), bare].filter(Boolean).join(" ");
}

/** The name the item had before we touched it, if it was the ordinary one (from its compendium). */
async function plainName(item) {
  const flag = item.getFlag?.(MID, "baseName") ?? item.flags?.[MID]?.baseName;
  if (flag) return flag;
  const src = sourceIdOf(item);
  const doc = src ? await fromUuid(src).catch(() => null) : null;
  if (!doc) return item.name;
  const names = new Set([doc.name, doc.flags?.["PF2e-KR"]?.originalName, doc.flags?.babele?.originalName].filter(Boolean));
  // A name the player gave ("달빛 파수꾼") is left alone.
  return names.has(item.name) || item.name.includes(doc.name) ? item.name : null;
}

/** After runes or material change: rename the item (setting) — unless the player named it themselves. */
export async function renameByRunes(item) {
  if (!setting("renameRunes", true) || !["weapon", "armor", "shield"].includes(item?.type)) return;
  const auto = item.getFlag?.(MID, "autoName") ?? item.flags?.[MID]?.autoName;
  const base = await plainName(item);
  if (base === null) return;
  // Renamed by hand since we last named it: keep the player's name.
  if (auto && item.name !== auto && item.name !== base) return;
  const r = item.system?.runes ?? {};
  const none = !Number(r.potency ?? 0) && !Number(r.striking ?? 0) && !Number(r.resilient ?? 0) && !Number(r.reinforcing ?? 0) && !(r.property ?? []).length && !item.system?.material?.type;
  const name = none ? base : composeRuneName(item, base);
  if (name === item.name) return;
  await item.update({ name, [`flags.${MID}.baseName`]: base, [`flags.${MID}.autoName`]: name });
}

/* ---------------- creatures ---------------- */

async function boughtFolder() {
  const name = t("Creature.Folder");
  return game.folders?.find(f => f.type === "Actor" && f.name === name) ?? (await Folder.create({ name, type: "Actor", color: "#6b4f2a" }).catch(() => null));
}

/** A formula into the character's formula book (Player Core, Formulas: copying it in takes an hour). */
// @plus
async function buyFormula(data, user) {
  const { shop, cfg } = shopFor(data, user);
  const actor = customerFor(data, user);
  const offer = formulaOffers(shop, cfg).find(f => f.uuid === data.uuid);
  need(offer, "NoItem");
  need(actor.type === "character", "NotYours");
  need(!knowsFormula(actor, offer.uuid), "KnowsFormula");
  const total = formulaPriceCp(cfg, offer.level, offer.rarity);
  await pay(actor, total);
  if (cfg.purse?.on) cfg.purse.value = Math.min(Number(cfg.purse.max ?? 0), Number(cfg.purse.value ?? 0) + total);
  const formulas = [...(actor.system?.crafting?.formulas ?? []).map(f => ({ ...f })), { uuid: offer.uuid }];
  await actor.update({ "system.crafting.formulas": formulas });
  await log(shop, cfg, { kind: "formula", actor: actor.name, user: user.name, item: offer.name, link: `@UUID[${offer.uuid}]{${esc(offer.name)}}`, qty: 1, cp: total }, { whisperTo: [user.id] });
  return { total, item: offer.name, qty: 1 };
}
// @end-plus

// @plus
async function buyCreature(data, user) {
  const { shop, cfg } = shopFor(data, user);
  const actor = customerFor(data, user);
  const c = (cfg.creatures ?? []).find(x => x.id === data.creatureId);
  need(c, "NoItem");
  need(c.infinite || (c.qty ?? 0) >= 1, "NoStock", { n: c.qty ?? 0 });
  const src = await fromUuid(c.uuid).catch(() => null);
  need(src, "NoItem");
  const total = buyCreatureCp(cfg, c);
  await pay(actor, total);
  const data2 = src.toObject();
  delete data2._id;
  delete data2.uuid;
  // The buyer's players own it; the other players can look at it.
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  const ownership = { default: L.NONE };
  for (const u of game.users) if (!u.isGM) ownership[u.id] = actor.testUserPermission(u, "OWNER") ? L.OWNER : L.OBSERVER;
  ownership[user.id] = L.OWNER;
  data2.ownership = ownership;
  // A bought animal is a minion (it acts when commanded).
  if (setting("creatureMinion", true) && data2.system?.traits) {
    const traits = new Set(data2.system.traits.value ?? []);
    traits.add("minion");
    data2.system.traits.value = [...traits];
  }
  data2.folder = (await boughtFolder())?.id ?? null;
  data2.name = t("Creature.OwnedName", { name: c.name, owner: actor.name });
  data2.prototypeToken = { ...(data2.prototypeToken ?? {}), actorLink: true, disposition: 1, name: c.name };
  data2._stats = { ...(data2._stats ?? {}), compendiumSource: c.uuid };
  data2.flags = { ...(data2.flags ?? {}), [MID]: { boughtBy: actor.id, from: shop.id } };
  const made = await Actor.create(data2);
  if (!c.infinite) c.qty = Math.max(0, (c.qty ?? 0) - 1);
  await log(shop, cfg, { kind: "creature", actor: actor.name, user: user.name, item: c.name, link: made ? `@UUID[${made.uuid}]{${esc(c.name)}}` : null, qty: 1, cp: total }, { whisperTo: [user.id] });
  return { total, item: c.name };
}
// @end-plus

/* ---------------- the smithy: precious materials ---------------- */

/** Price of an item in copper as PF2e works it out (material and runes included). */
function priceCp(item) {
  const v = item?.price?.value;
  if (v && typeof v.copperValue === "number") return v.copperValue;
  const p = item?.system?.price?.value ?? {};
  return (Number(p.pp) || 0) * 1000 + (Number(p.gp) || 0) * 100 + (Number(p.sp) || 0) * 10 + (Number(p.cp) || 0);
}

/** Materials a weapon or armor can be remade in: [{ type, grade, level, rarity, priceCp, costCp }] */
export function materialOffers(cfg, item) {
  const kind = item?.type === "weapon" ? "weapon" : item?.type === "armor" ? "armor" : null;
  if (!kind) return [];
  const cur = item.system?.material ?? {};
  const now = priceCp(item);
  const out = [];
  const allowed = cfg.services?.material?.allowed ?? [];
  for (const [type, grades] of Object.entries(MATERIALS[kind] ?? {})) {
    if (allowed.length && !allowed.includes(type)) continue;
    for (const [grade, d] of Object.entries(grades)) {
      if (cur.type === type && cur.grade === grade) continue;
      let price = null;
      try {
        const clone = item.clone?.({ "system.material": { type, grade } }, { keepId: true });
        if (clone) { clone.prepareData?.(); price = priceCp(clone); }
      } catch (_) { price = null; }
      // PF2e not at hand (or it kept the old price): the material's own price, plus what the runes cost.
      if (!price || price === now) {
        const was = cur.type ? (MATERIALS[kind][cur.type]?.[cur.grade]?.price ?? 0) * 100 : basePriceCp(item);
        price = d.price * 100 + Math.max(0, now - was);
      }
      // The rules: an upgrade costs the difference in Price (at the shop's rate) — plus the smith's fee.
      const diff = Math.max(0, Math.round((price - now) * (Number(cfg.services?.material?.rate) || 1)));
      const fee = feeCp(cfg, diff);
      const cost = diff + fee;
      const st = MATERIAL_STATS[type]?.[grade];
      out.push({ type, grade, level: d.level, rarity: d.rarity, priceCp: price, costCp: cost, diffCp: diff, feeCp: fee, stats: st ? (kind === "armor" ? st.item : st.thin) : null, info: materialInfo(type) });
    }
  }
  const R = { common: 0, uncommon: 1, rare: 2, unique: 3 };
  return out.sort((a, b) => (R[a.rarity] ?? 9) - (R[b.rarity] ?? 9) || a.level - b.level || a.costCp - b.costCp);
}

function basePriceCp(item) {
  const p = item?._source?.system?.price?.value ?? item?.system?.price?.value ?? {};
  return (Number(p.pp) || 0) * 1000 + (Number(p.gp) || 0) * 100 + (Number(p.sp) || 0) * 10 + (Number(p.cp) || 0);
}

/** One line on what the material does (the language file, else English). */
export function materialInfo(type) {
  const key = `RPS.MatInfo.${type}`;
  const l = game.i18n.localize(key);
  return l !== key ? l : MATERIAL_INFO[type] ?? "";
}

/** Hardness/HP/BT an item has now, and ordinary gear of its kind. */
export function plainStats(item) {
  const woodish = /bow|club|staff|wood/.test(`${item.system?.baseItem ?? ""} ${item.system?.group ?? ""}`);
  if (item.type === "armor") return ["light", "unarmored"].includes(item.system?.category) ? PLAIN_STATS.leather : PLAIN_STATS.metal;
  return woodish ? PLAIN_STATS.thinWood : PLAIN_STATS.thinMetal;
}

export function materialLabel(type, grade) {
  const m = CONFIG.PF2E?.preciousMaterials?.[type];
  const g = CONFIG.PF2E?.preciousMaterialGrades?.[grade];
  return `${m ? loc(m) : type}${grade ? ` (${g ? loc(g) : t(`Material.Grade.${grade}`)})` : ""}`;
}

// @plus
async function reforge(data, user) {
  const { shop, cfg } = shopFor(data, user);
  need(cfg.services?.material?.on, "NoService");
  const actor = customerFor(data, user);
  const item = actor.items.get(data.itemId);
  need(item && ["weapon", "armor"].includes(item.type), "NoItem");
  const offer = materialOffers(cfg, item).find(o => o.type === data.material && o.grade === data.grade);
  need(offer, "NoItem");
  await pay(actor, offer.costCp);
  const upd = { "system.material": { type: offer.type, grade: offer.grade } };
  // Hardness and Hit Points of the new material (the share of HP left is kept).
  if (offer.stats) {
    const [h, hp] = offer.stats;
    const cur = Number(item.system?.hp?.max ?? 0);
    const share = cur > 0 ? Number(item.system?.hp?.value ?? cur) / cur : 1;
    upd["system.hardness"] = h;
    upd["system.hp.max"] = hp;
    upd["system.hp.value"] = Math.max(1, Math.round(hp * share));
  }
  await item.update(upd);
  await renameByRunes(item);
  await log(shop, cfg, { kind: "material", actor: actor.name, user: user.name, item: item.name, extra: `${materialLabel(offer.type, offer.grade)}${offer.feeCp ? ` · ${t("Fee.Line", { cost: formatCp(offer.feeCp) })}` : ""}`, cp: offer.costCp }, { whisperTo: [user.id] });
  return { total: offer.costCp, item: item.name };
}
// @end-plus
