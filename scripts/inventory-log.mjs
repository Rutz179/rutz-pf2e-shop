import { MID, SOCKET, esc, formatCp, isPhysical, setting, t, unitCp } from "./util.mjs";

/* ======================================================================== *
 * Inventory log: whatever a player's character gains or loses outside the
 * Rutz modules shows up in chat, with where it came from —
 *   dragged from a compendium, the Items tab, another character, a merchant
 *   or a loot pile; sold with the sheet's sell button; coins typed into the
 *   sheet; a new item made on the sheet.
 * Changes made by the Rutz modules (shop, gacha, forge, days, builder) are
 * left out: those already post their own lines.
 * The client that makes the change writes the line. When PF2e hands a
 * player's drag to the GM (taking from an actor they don't own), the
 * player's client tells the GM where it came from.
 * ======================================================================== */

const QUIET = `${MID}InvQuiet`;
const BEFORE = `${MID}InvBefore`;
const WAIT = 700;           // ms of calm before a burst of changes becomes one line
const DROP_TTL = 5000;      // how long a drag stays "the source" of what follows

const bursts = new Map();   // actorId → { userId, adds: Map, removes: Map, coins, timer, drop }
const drops = new Map();    // actorId → { uuid, at, userId }

const mode = () => setting("invLog", "gm");

/** Is this change the work of one of the Rutz modules? (Its script is somewhere up the call stack.) */
function fromRutz() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  return stack.split("\n").some(l => /\/modules\/rutz-/.test(l) && !l.includes("inventory-log.mjs"));
}

function watched(actor) {
  return actor?.type === "character" && actor.hasPlayerOwner;
}

function isCoin(item) {
  return item?.type === "treasure" && (item.isCoinage || item.system?.category === "coin" || item.system?.stackGroup === "coins");
}

/** Spent rather than handed over: drinking a potion or firing an arrow is no news. */
function usedUp(item) {
  return item?.type === "consumable" || item?.type === "ammo";
}

/* ---------------- where it came from ---------------- */

function sourceOf(burst, actor) {
  const d = burst.drop;
  if (d?.uuid) {
    const uuid = String(d.uuid);
    if (uuid.startsWith("Compendium.")) {
      const [, scope, name] = uuid.split(".");
      const pack = game.packs.get(`${scope}.${name}`);
      return t("Inv.FromPack", { pack: esc(pack?.title ?? `${scope}.${name}`) });
    }
    if (/^Item\.[^.]+$/.test(uuid)) return t("Inv.FromWorld");
    const o = d.owner;
    if (o && o.id !== actor.id) {
      const key = o.merchant ? "Inv.FromMerchant" : o.type === "loot" ? "Inv.FromLoot" : o.type === "party" ? "Inv.FromParty" : "Inv.FromActor";
      return t(key, { name: esc(o.name) });
    }
  }
  // Made right on the sheet: a compendium copy keeps where it was copied from.
  const src = [...burst.adds.values()].map(a => a.from).find(Boolean);
  if (src?.startsWith("Compendium.")) {
    const [, scope, name] = src.split(".");
    return t("Inv.FromPack", { pack: esc(game.packs.get(`${scope}.${name}`)?.title ?? `${scope}.${name}`) });
  }
  if (burst.removes.size && burst.coins > 0) return t("Inv.FromSell");
  return t("Inv.FromSheet");
}

/* ---------------- collecting ---------------- */

function burstFor(actor, userId) {
  let b = bursts.get(actor.id);
  if (!b) {
    b = { userId, adds: new Map(), removes: new Map(), coins: 0, timer: null, drop: null };
    bursts.set(actor.id, b);
  }
  const d = drops.get(actor.id);
  if (d && Date.now() - d.at < DROP_TTL) { b.drop = d; if (d.userId) b.userId = d.userId; }
  clearTimeout(b.timer);
  b.timer = setTimeout(() => flush(actor.id), WAIT);
  return b;
}

function note(item, qty, options, userId) {
  const actor = item.actor;
  if (!qty || !watched(actor) || options?.[QUIET] || userId !== game.user.id || mode() === "off") return;
  // The GM's own changes are the GM's business, unless a player's drag led to them.
  const d = drops.get(actor.id);
  const playerDrop = d && Date.now() - d.at < DROP_TTL && d.userId && d.userId !== game.user.id;
  if (game.user.isGM && !playerDrop && !setting("invLogGM", false)) return;
  const b = burstFor(actor, userId);
  if (isCoin(item)) { b.coins += qty * unitCp(item); return; }
  const key = item.sourceId ?? item._stats?.compendiumSource ?? item.name;
  const bag = qty > 0 ? b.adds : b.removes;
  const row = bag.get(key) ?? { name: item.name, img: item.img, uuid: item.uuid, qty: 0, used: usedUp(item), from: item._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? null };
  row.qty += Math.abs(qty);
  bag.set(key, row);
}

async function flush(actorId) {
  const b = bursts.get(actorId);
  bursts.delete(actorId);
  const actor = game.actors.get(actorId);
  if (!b || !actor) return;
  if (b.drop && drops.get(actorId) === b.drop) drops.delete(actorId); // a drag explains one burst only
  // Something used up with nothing to show for it is just use, not trade.
  if (!(b.coins > 0) && !b.drop) for (const [k, r] of b.removes) if (r.used) b.removes.delete(k);
  // A stack moved in one burst (split, merge) nets out.
  for (const [k, r] of b.adds) {
    const back = b.removes.get(k);
    if (!back) continue;
    const n = Math.min(r.qty, back.qty);
    r.qty -= n; back.qty -= n;
    if (!r.qty) b.adds.delete(k);
    if (!back.qty) b.removes.delete(k);
  }
  const coins = Math.round(b.coins);
  if (!b.adds.size && !b.removes.size && !coins) return;

  const kind = b.removes.size && coins > 0 && !b.adds.size ? "Sold"
    : b.adds.size && coins < 0 && !b.removes.size ? "Bought"
    : b.adds.size && !b.removes.size ? "Added"
    : b.removes.size && !b.adds.size ? "Removed"
    : b.adds.size || b.removes.size ? "Changed"
    : coins > 0 ? "CoinsIn" : "CoinsOut";
  const line = (r, sign) => `<li class="${sign === "+" ? "in" : "out"}"><img src="${esc(r.img)}" alt=""> <span>${sign} @UUID[${r.uuid}]{${esc(r.name)}}${r.qty > 1 ? ` ×${r.qty}` : ""}</span></li>`;
  const rows = [...[...b.adds.values()].map(r => line(r, "+")), ...[...b.removes.values()].map(r => line(r, "−"))];
  if (coins) rows.push(`<li class="${coins > 0 ? "in" : "out"}"><i class="fa-solid fa-coins"></i> <span>${coins > 0 ? "+" : "−"} ${formatCp(Math.abs(coins))}</span></li>`);
  const user = game.users.get(b.userId);
  const content = `<div class="rps-invlog"><header><i class="fa-solid fa-box-open"></i> <b>${esc(actor.name)}</b> · ${t(`Inv.${kind}`)}</header>
    <ul>${rows.join("")}</ul>
    <p class="src"><i class="fa-solid fa-route"></i> ${sourceOf(b, actor)}${user ? ` · ${esc(user.name)}` : ""}</p></div>`;
  const whisper = mode() === "gm" ? game.users.filter(u => u.isGM).map(u => u.id) : [];
  await ChatMessage.create({ content, whisper, speaker: { alias: t("Inv.Title") }, flags: { [MID]: { invLog: true } } }).catch(() => null);
}

/* ---------------- hooks ---------------- */

export function installInventoryLog() {
  // Mark what the Rutz modules do before it happens (the call stack is only there now).
  const mark = (item, options) => {
    if (!watched(item.actor) || !(isPhysical(item) || isCoin(item))) return;
    if (fromRutz()) options[QUIET] = true;
  };
  Hooks.on("preCreateItem", (item, data, options) => mark(item, options));
  Hooks.on("preDeleteItem", (item, options) => mark(item, options));
  Hooks.on("preUpdateItem", (item, changes, options) => {
    if (foundry.utils.getProperty(changes, "system.quantity") === undefined) return;
    mark(item, options);
    options[BEFORE] = item.system?.quantity ?? 0;
  });

  Hooks.on("createItem", (item, options, userId) => {
    if (isPhysical(item) || isCoin(item)) note(item, item.system?.quantity ?? 1, options, userId);
  });
  Hooks.on("deleteItem", (item, options, userId) => {
    if (isPhysical(item) || isCoin(item)) note(item, -(item.system?.quantity ?? 1), options, userId);
  });
  Hooks.on("updateItem", (item, changes, options, userId) => {
    const before = options?.[BEFORE];
    if (before === undefined) return;
    note(item, (item.system?.quantity ?? 0) - before, options, userId);
  });

  // Where a drag came from (the owner is looked up now: after a transfer the item is gone).
  const ownerOf = uuid => {
    let o = null;
    try { o = fromUuidSync(uuid)?.parent ?? null; } catch (_) { o = null; }
    return o?.documentName === "Actor" ? { id: o.id, name: o.name, type: o.type, merchant: o.type === "loot" && o.system?.lootSheetType === "Merchant" } : null;
  };
  Hooks.on("dropActorSheetData", (actor, sheet, data) => {
    if (data?.type !== "Item" || !data.uuid || !watched(actor)) return;
    const d = { uuid: data.uuid, at: Date.now(), userId: game.user.id, owner: ownerOf(data.uuid) };
    drops.set(actor.id, d);
    // Taking from an actor the player doesn't own runs on the GM's side: tell the GM.
    if (!game.user.isGM) game.socket.emit(SOCKET, { type: "invDrop", data: { actorId: actor.id, uuid: data.uuid, userId: game.user.id } });
  });
  game.socket.on(SOCKET, msg => {
    if (msg?.type !== "invDrop" || !game.user.isGM) return;
    drops.set(msg.data.actorId, { uuid: msg.data.uuid, at: Date.now(), userId: msg.data.userId, owner: ownerOf(msg.data.uuid) });
  });
}
