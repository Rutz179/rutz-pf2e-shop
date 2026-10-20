import { clamp, debounce, enrich, esc, formatCp, isPhysical, setting, sourceIdOf, t, unitCp, walletCp } from "../util.mjs";
import { classify } from "../catalog.mjs";
import { buyCreatureCp, buyUnitCp, buysCategory, configOf, nextRestockIn, restock, saveConfig, sellUnitCp, shelf, stockOf } from "../shop.mjs";
import { composeRuneName, etchPlan, materialLabel, materialOffers, plainStats, repairCost, request, runePriceCp, runesOn } from "../trade.mjs";
import { hpOf, stateLabel, stateOf } from "../durability.mjs";
import { catChips, countCats, levelBadge, money, portrait, rarityLabel, subSelect, traitsHtml } from "./common.mjs";

/* ======================================================================== *
 * The shop window (the shop actor's sheet, for players and the GM).
 *
 *   ┌ merchant ┐┌ 사기 · 팔기 · 수리 · 룬 공방 ───────────────────────┐
 *   │ portrait ││ categories · sub-category · search                  │
 *   │ "어서…"  ││ ▶ list of goods            │ the chosen thing      │
 *   │ wallet   ││                            │ − 1 +   [ 사기 12gp ] │
 *   └──────────┘└──────────────────────────────────────────────────────┘
 *
 * ↑/↓ move through the list, Enter buys/sells. Prices already include the
 * shop's rates and events; the GM's client carries the trade out.
 * ======================================================================== */

const TABS = ["buy", "creatures", "sell", "repair", "material", "runes"];
const TAB_ICON = { buy: "fa-cart-shopping", creatures: "fa-paw", sell: "fa-hand-holding-dollar", repair: "fa-hammer", material: "fa-cubes", runes: "fa-hexagon-nodes" };

function customersOf(user = game.user) {
  const list = game.actors.filter(a => ["character", "party", "familiar"].includes(a.type) && (user.isGM ? a.hasPlayerOwner || a.type === "party" : a.isOwner));
  return list.sort((a, b) => (a.type === "character" ? 0 : 1) - (b.type === "character" ? 0 : 1) || a.name.localeCompare(b.name, game.i18n.lang));
}

function defaultCustomer() {
  const controlled = canvas?.tokens?.controlled?.map(tk => tk.actor).find(a => a?.isOwner && a.type === "character");
  return controlled ?? game.user.character ?? customersOf()[0] ?? null;
}

/**
 * The shop window is a plain application (not the actor's sheet): players only have Limited permission on a
 * shop, and a document sheet would fight that (greyed-out buttons, refused renders). The actor's registered
 * sheet (ShopSheet below) just opens this.
 */
export class ShopApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["rps-sheet"],
    position: { width: 1040, height: 700 },
    window: { resizable: true, icon: "fa-solid fa-store" }
  };

  constructor(actor, options = {}) {
    super({ ...options, id: `rps-shop-${actor.id}` });
    this.actor = actor;
    this.ui = { tab: "buy", cat: "all", sub: "", search: "", sel: null, qty: 1, line: null, runeTarget: null, matTarget: null, creature: null, tf: { from: null, rune: null, to: null } };
    this.customerId = defaultCustomer()?.id ?? null;
    this.descCache = new Map();
    this.refreshSoon = debounce(() => { if (this.rendered) this.render(); }, 120);
  }

  get title() {
    const cfg = configOf(this.actor);
    return cfg.title || this.actor.name;
  }

  get customer() {
    return game.actors.get(this.customerId) ?? null;
  }

  get cfg() {
    return configOf(this.actor);
  }

  /* ---------------- render ---------------- */

  async _renderHTML() {
    const cfg = this.cfg;
    const on = { buy: true, sell: true, creatures: (cfg.creatures ?? []).length > 0, repair: !!cfg.services?.repair?.on, material: !!cfg.services?.material?.on, runes: !!cfg.services?.runes?.on };
    const tabs = TABS.filter(k => on[k]);
    if (!tabs.includes(this.ui.tab)) this.ui.tab = "buy";
    const tab = this.ui.tab;
    const body = tab === "buy" ? this.buyHtml(cfg) : tab === "sell" ? this.sellHtml(cfg) : tab === "creatures" ? this.creaturesHtml(cfg)
      : tab === "repair" ? this.repairHtml(cfg) : tab === "material" ? this.materialHtml(cfg) : this.runesHtml(cfg);
    const next = nextRestockIn(cfg);
    return `<div class="rps rps-theme-${esc(cfg.theme || "gold")} ${cfg.merchant?.show !== false && cfg.merchant?.img ? "" : "no-portrait"}">
      ${this.merchantHtml(cfg)}
      <section class="rps-main">
        <nav class="rps-tabs">${tabs.map(k => `<button type="button" class="${tab === k ? "on" : ""}" data-a="tab" data-tab="${k}"><i class="fa-solid ${TAB_ICON[k]}"></i> ${t(`Tab.${k}`)}</button>`).join("")}
          ${game.user.isGM ? `<span class="gm">
            ${cfg.open ? "" : `<span class="closed"><i class="fa-solid fa-lock"></i> ${t("Shop.Closed")}</span>`}
            <button type="button" data-a="restock" data-tooltip="${esc(t("Shop.RestockHint", { mode: t(`Set.RestockMode.${cfg.restock?.mode === "chance" ? "chance" : "fill"}`), next: next === null ? t("Shop.RestockManual") : t("Shop.RestockIn", { n: next }) }))}"><i class="fa-solid fa-sun"></i></button>
            <button type="button" data-a="edit" data-tooltip="${esc(t("Shop.EditHint"))}"><i class="fa-solid fa-gear"></i> ${t("Shop.Edit")}</button></span>` : ""}
        </nav>
        ${body}
      </section>
    </div>`;
  }

  _replaceHTML(result, content) {
    // Keep where each list was scrolled to (a dropdown or a purchase must not jump back to the top).
    const keep = {};
    if (this._lastTab === this.ui.tab) for (const sel of [".rps-list", ".rps-pane", ".rps-rune-list", ".rps-desc"]) keep[sel] = content.querySelector(sel)?.scrollTop ?? 0;
    content.innerHTML = result;
    for (const [sel, top] of Object.entries(keep)) { const el = content.querySelector(sel); if (el && top) el.scrollTop = top; }
    this._lastTab = this.ui.tab;
    // Listeners go on the element itself: after the window is closed and opened again it is a new element.
    if (this._wired !== content) {
      this._wired = content;
      content.addEventListener("click", ev => this.onClick(ev));
      content.addEventListener("change", ev => this.onChange(ev));
      content.addEventListener("input", ev => this.onInput(ev));
      content.addEventListener("dblclick", ev => { const row = ev.target.closest(".rps-row"); if (row) this.openSheet(row.dataset.id); });
      content.addEventListener("keydown", ev => this.onKey(ev));
    }
    this.fillDetail();
    if (!keep[".rps-list"]) content.querySelector(".rps-row.sel")?.scrollIntoView({ block: "nearest" });
    const search = content.querySelector("input.rps-search");
    if (search && this._focusSearch) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); this._focusSearch = false; }
  }

  merchantHtml(cfg) {
    const who = this.customer;
    const people = customersOf();
    const line = this.ui.line ?? (cfg.greeting || t("Talk.Hello"));
    const showPic = cfg.merchant?.show !== false && cfg.merchant?.img;
    return `<aside class="rps-merchant">
      ${showPic ? `<div class="rps-portrait">${portrait(cfg.merchant.img, cfg.merchant.name)}</div>` : ""}
      <div class="rps-name">${esc(cfg.merchant?.name || this.actor.name)}</div>
      <div class="rps-bubble">${esc(line)}</div>
      <div class="rps-wallet">
        <label>${t("Shop.Customer")}<select data-a="customer">${people.map(a => `<option value="${a.id}" ${a.id === this.customerId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
        <div class="coins">${who ? coinsHtml(who) : `<span class="rps-dim">${t("Shop.NoCustomer")}</span>`}</div>
      </div>
    </aside>`;
  }

  filterBar(items) {
    return `<div class="rps-filter">${catChips(countCats(items), this.ui.cat)}
      <div class="row">${subSelect(items, this.ui.cat, this.ui.sub)}
        <input type="search" class="rps-search" placeholder="${esc(t("Shop.Search"))}" value="${esc(this.ui.search)}"></div></div>`;
  }

  filtered(items) {
    const words = this.ui.search.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(it => {
      const c = classify(it);
      if (this.ui.cat !== "all" && c.cat !== this.ui.cat) return false;
      if (this.ui.sub && c.sub !== this.ui.sub) return false;
      const hay = `${it.name} ${it.flags?.["PF2e-KR"]?.originalName ?? ""}`.toLowerCase();
      return words.every(w => ((w === "룬" || w === "rune") && c.cat === "rune") || hay.includes(w));
    });
  }

  /* ---------- buy ---------- */

  buyHtml(cfg) {
    const goods = shelf(this.actor).sort((a, b) => (stockOf(b).featured - stockOf(a).featured) || (a.system.level?.value ?? 0) - (b.system.level?.value ?? 0) || a.name.localeCompare(b.name, game.i18n.lang));
    const list = this.filtered(goods);
    if (!list.some(i => i.id === this.ui.sel)) this.ui.sel = list[0]?.id ?? null;
    const rows = list.map(it => {
      const st = stockOf(it);
      const q = it.system.quantity ?? 0;
      const out = !st.infinite && q <= 0;
      const price = buyUnitCp(cfg, it);
      const listCp = Math.round(unitCp(it));
      const cls = price < listCp ? "deal" : price > listCp ? "dear" : "";
      return `<button type="button" class="rps-row ${this.ui.sel === it.id ? "sel" : ""} ${out ? "out" : ""} rar-${it.system?.traits?.rarity ?? "common"}" data-a="pick" data-id="${it.id}">
        <span class="cur">▶</span>${levelBadge(it)}<img src="${esc(it.img)}" alt="" loading="lazy"><span class="nm">${esc(it.name)}${st.featured ? ` <i class="fa-solid fa-star feat" data-tooltip="${esc(t("Shop.Featured"))}"></i>` : ""}</span>
        <span class="stock">${st.infinite ? "∞" : out ? t("Shop.SoldOut") : `×${q}`}</span>${money(price, cls)}</button>`;
    }).join("");
    return `${this.filterBar(goods)}
      <div class="rps-body"><div class="rps-list">${rows || `<p class="rps-empty">${t(goods.length ? "Shop.NoMatch" : "Shop.Empty")}</p>`}</div>
      <div class="rps-detail" data-kind="buy">${this.ui.sel ? `<div class="rps-detail-body"></div>` : ""}</div></div>`;
  }

  /* ---------- sell ---------- */

  sellable() {
    const who = this.customer;
    if (!who) return [];
    return who.items.filter(i => isPhysical(i) && !(i.type === "treasure" && i.isCurrency) && (i.system.quantity ?? 1) > 0)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  sellHtml(cfg) {
    const goods = this.sellable();
    const list = this.filtered(goods);
    if (!list.some(i => i.id === this.ui.sel)) this.ui.sel = list[0]?.id ?? null;
    const rows = list.map(it => {
      const price = sellUnitCp(cfg, it);
      const no = !buysCategory(cfg, it) || !price;
      return `<button type="button" class="rps-row ${this.ui.sel === it.id ? "sel" : ""} ${no ? "out" : ""}" data-a="pick" data-id="${it.id}">
        <span class="cur">▶</span>${levelBadge(it)}<img src="${esc(it.img)}" alt="" loading="lazy"><span class="nm">${esc(it.name)}
        ${it.isEquipped ? `<i class="fa-solid fa-shirt eq" data-tooltip="${esc(t("Shop.Equipped"))}"></i>` : ""}${durBadge(it)}</span>
        <span class="stock">×${it.system.quantity ?? 1}</span>${no ? `<span class="rps-dim">${t("Shop.WontBuy")}</span>` : money(price)}</button>`;
    }).join("");
    const purse = cfg.purse?.on ? `<div class="rps-purse" data-tooltip="${esc(t("Shop.PurseHint"))}"><i class="fa-solid fa-sack-dollar"></i> ${t("Shop.Purse")} ${money(Number(cfg.purse.value ?? 0))}</div>` : "";
    return `${this.filterBar(goods)}${purse}
      <div class="rps-body"><div class="rps-list">${rows || `<p class="rps-empty">${t("Shop.NothingToSell")}</p>`}</div>
      <div class="rps-detail" data-kind="sell">${this.ui.sel ? `<div class="rps-detail-body"></div>` : ""}</div></div>`;
  }

  /* ---------- repair ---------- */

  repairHtml(cfg) {
    const who = this.customer;
    const items = (who?.items ?? []).filter(i => isPhysical(i) && hpOf(i).max > 0 && ["damaged", "broken", "destroyed"].includes(stateOf(i)));
    const rows = items.map(it => {
      const { value, max } = hpOf(it);
      const st = stateOf(it);
      const cost = repairCost(cfg, it);
      return `<div class="rps-repair ${st}"><img src="${esc(it.img)}" alt=""><div class="nm"><b>${esc(it.name)}</b>
          <div class="hpbar"><i style="width:${Math.round((value / max) * 100)}%"></i><span>${value} / ${max}</span></div>
          <small>${stateLabel(st)}</small></div>
        ${st === "destroyed" ? `<span class="rps-dim">${t("Repair.Destroyed")}</span>` : `${money(cost)}<button type="button" class="rps-go" data-a="repair" data-id="${it.id}"><i class="fa-solid fa-hammer"></i> ${t("Repair.Do")}</button>`}</div>`;
    }).join("");
    return `<div class="rps-pane"><p class="rps-hint">${t("Repair.Hint")}</p>${rows || `<p class="rps-empty">${t("Repair.Nothing")}</p>`}</div>`;
  }

  /* ---------- creatures ---------- */

  creaturesHtml(cfg) {
    const list = [...(cfg.creatures ?? [])].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name, game.i18n.lang));
    const words = this.ui.search.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = list.filter(c => words.every(w => c.name.toLowerCase().includes(w)));
    if (!shown.some(c => c.id === this.ui.creature)) this.ui.creature = shown[0]?.id ?? null;
    const rows = shown.map(c => {
      const out = !c.infinite && (c.qty ?? 0) <= 0;
      return `<button type="button" class="rps-row ${this.ui.creature === c.id ? "sel" : ""} ${out ? "out" : ""} rar-${c.rarity ?? "common"}" data-a="pick-creature" data-cid="${c.id}">
        <span class="cur">▶</span><span class="rps-lv">${c.level ?? 0}</span><img src="${esc(c.img)}" alt="" loading="lazy"><span class="nm">${esc(c.name)}</span>
        <span class="stock">${c.infinite ? "∞" : out ? t("Shop.SoldOut") : `×${c.qty}`}</span>${money(buyCreatureCp(cfg, c))}</button>`;
    }).join("");
    return `<div class="rps-filter"><div class="row"><input type="search" class="rps-search" placeholder="${esc(t("Shop.Search"))}" value="${esc(this.ui.search)}"></div></div>
      <div class="rps-body"><div class="rps-list">${rows || `<p class="rps-empty">${t("Creature.None")}</p>`}</div>
      <div class="rps-detail" data-kind="creature">${this.ui.creature ? `<div class="rps-detail-body"></div>` : ""}</div></div>`;
  }

  /* ---------- the smithy: precious materials ---------- */

  materialHtml(cfg) {
    const who = this.customer;
    const gear = (who?.items ?? []).filter(i => ["weapon", "armor"].includes(i.type));
    if (!gear.some(i => i.id === this.ui.matTarget)) this.ui.matTarget = gear[0]?.id ?? null;
    const target = who?.items.get(this.ui.matTarget);
    const all = target ? materialOffers(cfg, target) : [];
    // By default only what fits the character (up to level + N); the rest behind "show all".
    const reach = Number(cfg.services?.material?.reach ?? 5);
    const lvl = Number(who?.level ?? 1);
    const offers = this.ui.matAll ? all : all.filter(o => o.level <= lvl + reach);
    const cur = target?.system?.material ?? {};
    const now = target ? [Number(target.system?.hardness ?? 0), Number(target.system?.hp?.max ?? 0)] : [0, 0];
    const base = target ? plainStats(target) : null;
    const stat = (h, hp, bt) => `<span class="st">${t("Material.Stats", { h, hp, bt })}</span>`;
    const rows = offers.map(o => {
      const s = o.stats;
      const diff = s && base ? `${stat(...s)} <small class="${s[0] > (now[0] || base[0]) ? "up" : s[0] < (now[0] || base[0]) ? "down" : ""}">(${t("Material.Plain")} ${base[0]}/${base[1]})</small>` : `<small class="rps-dim">${t("Material.StatsBook")}</small>`;
      return `<div class="rps-mat rar-${o.rarity}"><span class="rps-lv" data-tooltip="${esc(t("Material.LevelHint"))}">${o.level}</span>
        <div class="nm"><b>${esc(materialLabel(o.type, o.grade))}</b>${o.rarity !== "common" ? ` <span class="rps-trait rar ${o.rarity}">${esc(rarityLabel(o.rarity))}</span>` : ""}
          <div class="info">${diff}${o.info ? ` · ${esc(o.info)}` : ""}</div>
          <small>${t("Material.NewPrice")} ${formatCp(o.priceCp)} → <b>${esc(this.matPreview(target, o))}</b></small></div>
        ${money(o.costCp)}<button type="button" class="rps-go" data-a="reforge" data-m="${o.type}" data-g="${o.grade}"><i class="fa-solid fa-hammer"></i> ${t("Material.Do")}</button></div>`;
    }).join("");
    const hidden = all.length - offers.length;
    return `<div class="rps-pane rps-matpane">
      <div class="rps-matcard">${target ? `<img src="${esc(target.img)}" alt="">` : `<i class="fa-solid fa-hammer"></i>`}
        <div class="who"><label>${t("Material.Target")} <select data-a="mat-target">${gear.map(g => `<option value="${g.id}" ${g.id === this.ui.matTarget ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>
          ${target ? `<div class="now"><span class="tag">${cur.type ? esc(materialLabel(cur.type, cur.grade)) : t("Material.Plain")}</span> ${stat(now[0], now[1], Math.floor(now[1] / 2))} <span class="lv">${t("Shop.Level")} ${target.system?.level?.value ?? 0}</span></div>` : `<span class="rps-dim">${t("Material.NoGear")}</span>`}</div></div>
      <p class="rps-hint">${t("Material.Hint")}</p>
      <div class="rps-rune-list">${rows || (target ? `<p class="rps-empty">${t("Material.NoOffers")}</p>` : "")}
        ${hidden > 0 || this.ui.matAll ? `<button type="button" class="rps-more" data-a="mat-all">${this.ui.matAll ? t("Material.ShowFit", { n: reach }) : t("Material.ShowAll", { n: hidden })}</button>` : ""}</div></div>`;
  }

  /** The item's name once reforged ("+1 타격의 냉철 석궁"). */
  matPreview(item, o) {
    if (!item || !setting("renameRunes", true)) return "";
    return composeRuneName({ type: item.type, name: item.name, flags: item.flags, getFlag: (m, k) => item.getFlag?.(m, k), system: { runes: item.system?.runes ?? {}, material: { type: o.type, grade: o.grade } } });
  }

  /* ---------- runes ---------- */

  runesHtml(cfg) {
    const who = this.customer;
    const gear = (who?.items ?? []).filter(i => ["weapon", "armor", "shield"].includes(i.type));
    if (!gear.some(i => i.id === this.ui.runeTarget)) this.ui.runeTarget = gear[0]?.id ?? null;
    const target = who?.items.get(this.ui.runeTarget);
    const runes = shelf(this.actor).filter(i => classify(i).cat === "rune");
    const now = target ? runesOn(target) : [];
    const runeName = r => r.fundamental ? t(`Rune.Slot.${r.rune}`, { n: r.value }) : (game.i18n.localize(`PF2E.WeaponPropertyRune.${r.rune}.Name`) !== `PF2E.WeaponPropertyRune.${r.rune}.Name`
      ? game.i18n.localize(`PF2E.WeaponPropertyRune.${r.rune}.Name`) : game.i18n.localize(`PF2E.ArmorPropertyRune.${r.rune}.Name`) !== `PF2E.ArmorPropertyRune.${r.rune}.Name` ? game.i18n.localize(`PF2E.ArmorPropertyRune.${r.rune}.Name`) : r.rune);
    const offers = target ? runes.map(r => {
      const plan = etchPlan(r, target);
      const st = stockOf(r);
      const out = !st.infinite && (r.system.quantity ?? 0) <= 0;
      return `<div class="rps-rune ${plan.ok && !out ? "" : "no"}"><img src="${esc(r.img)}" alt=""><div class="nm"><b>${esc(r.name)}</b>${levelBadge(r)}
          <small>${plan.ok ? (out ? t("Shop.SoldOut") : this.namePreview(target, plan.update)) : esc(plan.why)}</small></div>${money(buyUnitCp(cfg, r))}
        <button type="button" class="rps-go" data-a="etch" data-id="${r.id}" ${plan.ok && !out ? "" : "disabled"}><i class="fa-solid fa-hexagon-nodes"></i> ${t("Rune.Etch")}</button></div>`;
    }).join("") : "";
    const tf = this.ui.tf;
    const fromItem = who?.items.get(tf.from);
    const fromRunes = fromItem ? runesOn(fromItem) : [];
    const transfer = cfg.services?.runes?.transfer ? `<div class="rps-transfer"><h4><i class="fa-solid fa-right-left"></i> ${t("Rune.Transfer")}</h4>
      <p class="rps-hint">${t("Rune.TransferHint")}</p>
      <div class="row"><select data-a="tf-from"><option value="">${t("Rune.From")}</option>${gear.map(g => `<option value="${g.id}" ${tf.from === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
        <select data-a="tf-rune" ${fromRunes.length ? "" : "disabled"}><option value="">${t("Rune.Which")}</option>${fromRunes.map(r => `<option value="${r.rune}" ${tf.rune === r.rune ? "selected" : ""}>${esc(runeName(r))}</option>`).join("")}</select>
        <i class="fa-solid fa-arrow-right"></i>
        <select data-a="tf-to"><option value="">${t("Rune.To")}</option>${gear.filter(g => g.id !== tf.from && (!fromItem || g.type === fromItem.type)).map(g => `<option value="${g.id}" ${tf.to === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
        <span class="rps-tf-cost"></span>
        <button type="button" class="rps-go" data-a="transfer" ${tf.from && tf.rune && tf.to ? "" : "disabled"}>${t("Rune.Move")}</button></div></div>` : "";
    return `<div class="rps-pane rps-runes">
      <div class="rps-runes-target"><label>${t("Rune.Target")} <select data-a="rune-target">${gear.map(g => `<option value="${g.id}" ${g.id === this.ui.runeTarget ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>
        <div class="now">${target ? (now.length ? now.map(r => `<span class="rps-trait rune">${esc(runeName(r))}</span>`).join("") : `<span class="rps-dim">${t("Rune.None")}</span>`) : `<span class="rps-dim">${t("Rune.NoGear")}</span>`}</div></div>
      <p class="rps-hint">${t("Rune.Hint")}</p>
      <div class="rps-rune-list">${offers || `<p class="rps-empty">${t(runes.length ? "Rune.PickGear" : "Rune.NoneInShop")}</p>`}</div>
      ${transfer}</div>`;
  }

  /* ---------- the chosen thing ---------- */

  /** What the item will be called after etching ("→ +1 타격 롱소드"). */
  namePreview(item, update) {
    if (!item || !setting("renameRunes", true)) return "";
    const runes = foundry.utils.deepClone(item.system?.runes ?? {});
    for (const [k, v] of Object.entries(update ?? {})) if (k.startsWith("system.runes.")) runes[k.slice(13)] = v;
    return `→ ${esc(composeRuneName({ type: item.type, system: { runes, material: item.system?.material ?? {} }, name: item.name, flags: item.flags, getFlag: (m, k) => item.getFlag?.(m, k) }))}`;
  }

  async creatureDetail(holder) {
    const cfg = this.cfg;
    const c = (cfg.creatures ?? []).find(x => x.id === this.ui.creature);
    if (!c) { holder.innerHTML = ""; return; }
    let desc = this.descCache.get(c.uuid);
    if (desc === undefined) {
      const doc = await fromUuid(c.uuid).catch(() => null);
      const notes = doc?.system?.details?.publicNotes ?? doc?.system?.details?.blurb ?? "";
      const stats = doc ? `<p class="rps-cstats"><b>HP</b> ${doc.system?.attributes?.hp?.max ?? "?"} · <b>AC</b> ${doc.system?.attributes?.ac?.value ?? "?"} · <b>${t("Creature.Speed")}</b> ${doc.system?.attributes?.speed?.value ?? doc.system?.movement?.speeds?.land?.value ?? "?"}</p>` : "";
      desc = stats + await enrich(notes, { relativeTo: doc, secrets: false });
      this.descCache.set(c.uuid, desc);
    }
    const unit = buyCreatureCp(cfg, c);
    const who = this.customer;
    const block = !who ? t("Shop.NoCustomer") : !c.infinite && (c.qty ?? 0) <= 0 ? t("Shop.SoldOut") : walletCp(who) < unit ? t("Shop.TooDear", { need: formatCp(unit - walletCp(who)) }) : "";
    holder.innerHTML = `<header><img src="${esc(c.img)}" alt=""><div><h3>${esc(c.name)}</h3><div class="traits"><span class="rps-lv">${c.level ?? 0}</span>
        <button type="button" class="rps-open" data-a="open-creature" data-tooltip="${esc(t("Shop.OpenSheet"))}"><i class="fa-solid fa-up-right-from-square"></i> ${t("Shop.Details")}</button></div></div></header>
      <div class="rps-desc">${desc || `<p class="rps-dim">${t("Shop.NoDesc")}</p>`}<p class="rps-hint">${t("Creature.Hint")}</p></div>
      <footer><div></div><div class="sum">${money(unit)}</div>
        <button type="button" class="rps-go big" data-a="buy-creature" ${block ? "disabled" : ""}><i class="fa-solid fa-paw"></i> ${t("Shop.Buy")}</button>
        ${block ? `<p class="why">${esc(block)}</p>` : ""}</footer>`;
  }

  async fillDetail() {
    const holder = this.element?.querySelector(".rps-detail-body");
    if (!holder) return;
    if (this.ui.tab === "creatures") return this.creatureDetail(holder);
    const kind = this.ui.tab;
    const item = kind === "buy" ? this.actor.items.get(this.ui.sel) : this.customer?.items.get(this.ui.sel);
    if (!item) { holder.innerHTML = ""; return; }
    const cfg = this.cfg;
    let desc = this.descCache.get(item.uuid);
    if (desc === undefined) {
      desc = await enrich(item.system?.description?.value ?? "", { relativeTo: item, secrets: false });
      this.descCache.set(item.uuid, desc);
    }
    const st = stockOf(item);
    const have = kind === "buy" ? (st.infinite ? 99 : item.system.quantity ?? 0) : item.system.quantity ?? 1;
    const qty = clamp(this.ui.qty, 1, Math.max(1, have));
    this.ui.qty = qty;
    const unit = kind === "buy" ? buyUnitCp(cfg, item) : sellUnitCp(cfg, item);
    const total = unit * qty;
    const who = this.customer;
    let block = "";
    if (kind === "buy") {
      if (!who) block = t("Shop.NoCustomer");
      else if (!st.infinite && have <= 0) block = t("Shop.SoldOut");
      else if (walletCp(who) < total) block = t("Shop.TooDear", { need: formatCp(total - walletCp(who)) });
    } else if (!buysCategory(cfg, item) || !unit) block = t("Shop.WontBuy");
    else if (cfg.purse?.on && total > Number(cfg.purse.value ?? 0)) block = t("Trade.Err.NoPurse", { have: formatCp(Number(cfg.purse.value ?? 0)), need: formatCp(total) });
    const english = item.flags?.["PF2e-KR"]?.originalName;
    const dur = hpOf(item);
    const durLine = dur.max && !["ok", "none"].includes(stateOf(item)) ? `<p class="rps-durline ${stateOf(item)}"><i class="fa-solid fa-shield-heart"></i> ${stateLabel(stateOf(item))} · HP ${dur.value}/${dur.max} · BT ${dur.bt}</p>` : "";
    holder.innerHTML = `<header><img src="${esc(item.img)}" alt=""><div><h3>${esc(item.name)}</h3>
        ${english && !item.name.includes(english) ? `<small>${esc(english)}</small>` : ""}<div class="traits">${levelBadge(item)}${traitsHtml(item)}</div>
        <button type="button" class="rps-open" data-a="open-sheet" data-id="${item.id}" data-tooltip="${esc(t("Shop.OpenSheet"))}"><i class="fa-solid fa-up-right-from-square"></i> ${t("Shop.Details")}</button></div></header>
      ${durLine}
      <div class="rps-desc">${desc || `<p class="rps-dim">${t("Shop.NoDesc")}</p>`}</div>
      <footer>
        <div class="qty"><button type="button" data-a="qty" data-d="-1">−</button><input type="number" min="1" max="${have}" value="${qty}" data-a="qty-set"><button type="button" data-a="qty" data-d="1">+</button></div>
        <div class="sum">${money(total)}${qty > 1 ? `<small>${t("Shop.Each", { price: formatCp(unit) })}</small>` : ""}</div>
        <button type="button" class="rps-go big" data-a="act" ${block ? "disabled" : ""}><i class="fa-solid ${kind === "buy" ? "fa-cart-shopping" : "fa-hand-holding-dollar"}"></i> ${t(kind === "buy" ? "Shop.Buy" : "Shop.Sell")}</button>
        ${block ? `<p class="why">${esc(block)}</p>` : ""}
      </footer>`;
    const tfCost = this.element.querySelector(".rps-tf-cost");
    if (tfCost) this.fillTransferCost(tfCost);
  }

  async fillTransferCost(el) {
    const { from, rune } = this.ui.tf;
    const item = this.customer?.items.get(from);
    if (!item || !rune) { el.innerHTML = ""; return; }
    const value = Number(item.system?.runes?.[rune] ?? 0);
    const cp = item.slug === "runestone" ? 0 : Math.round((await runePriceCp(item.type, rune, value)) * 0.1 * (Number(this.cfg.buyRate) || 1));
    el.innerHTML = money(cp);
  }

  /* ---------------- input ---------------- */

  say(key, data) {
    this.ui.line = t(`Talk.${key}`, data);
  }

  async onClick(ev) {
    const el = ev.target.closest("[data-a]");
    if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    ev.preventDefault();
    const a = el.dataset.a;
    switch (a) {
      case "tab": this.ui.tab = el.dataset.tab; this.ui.sel = null; this.ui.qty = 1; this.ui.cat = "all"; this.ui.sub = ""; this.ui.line = null; return this.render();
      case "cat": this.ui.cat = el.dataset.cat; this.ui.sub = ""; return this.render();
      case "pick":
        if (this.ui.sel !== el.dataset.id) { this.ui.sel = el.dataset.id; this.ui.qty = 1; }
        for (const r of this.element.querySelectorAll(".rps-row.sel")) r.classList.remove("sel");
        el.classList.add("sel");
        return this.fillDetail();
      case "qty": this.ui.qty = Math.max(1, this.ui.qty + Number(el.dataset.d)); return this.fillDetail();
      case "act": return this.act();
      case "open-sheet": return this.openSheet(el.dataset.id);
      case "pick-creature":
        this.ui.creature = el.dataset.cid;
        for (const r of this.element.querySelectorAll(".rps-row.sel")) r.classList.remove("sel");
        el.classList.add("sel");
        return this.fillDetail();
      case "open-creature": {
        const c = (this.cfg.creatures ?? []).find(x => x.id === this.ui.creature);
        const doc = c ? await fromUuid(c.uuid).catch(() => null) : null;
        return doc?.sheet?.render(true);
      }
      case "mat-all": this.ui.matAll = !this.ui.matAll; return this.render();
      case "buy-creature": return this.trade("creature", { creatureId: this.ui.creature });
      case "reforge": {
        const target = this.customer?.items.get(this.ui.matTarget);
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t("Material.Do") }, content: `<p>${t("Material.Ask", { item: esc(target?.name ?? ""), material: esc(materialLabel(el.dataset.m, el.dataset.g)) })}</p>`, rejectClose: false }).catch(() => false);
        if (!ok) return;
        return this.trade("material", { itemId: this.ui.matTarget, material: el.dataset.m, grade: el.dataset.g });
      }
      case "repair": return this.trade("repair", { itemId: el.dataset.id });
      case "etch": return this.trade("etch", { runeId: el.dataset.id, itemId: this.ui.runeTarget });
      case "transfer": return this.trade("transfer", { fromId: this.ui.tf.from, toId: this.ui.tf.to, rune: this.ui.tf.rune });
      case "edit": return game.rutzShop?.edit(this.actor);
      case "restock": {
        // One restock period right now (with the shop's rule: fill, or the hidden chance rolls).
        const n = await restock(this.actor, 1);
        ui.notifications.info(n ? t("Restock.DoneNow", { shop: this.actor.name, n }) : t("Restock.Nothing", { shop: this.actor.name }));
        return this.render();
      }
    }
  }

  onChange(ev) {
    const el = ev.target;
    switch (el.dataset.a) {
      case "customer": this.customerId = el.value; this.ui.sel = null; return this.render();
      case "sub": this.ui.sub = el.value; return this.render();
      case "qty-set": this.ui.qty = Math.max(1, Number(el.value) || 1); return this.fillDetail();
      case "rune-target": this.ui.runeTarget = el.value; return this.render();
      case "mat-target": this.ui.matTarget = el.value; return this.render();
      case "tf-from": this.ui.tf = { from: el.value || null, rune: null, to: null }; return this.render();
      case "tf-rune": this.ui.tf.rune = el.value || null; return this.render();
      case "tf-to": this.ui.tf.to = el.value || null; return this.render();
    }
  }

  onInput(ev) {
    if (!ev.target.classList.contains("rps-search")) return;
    this.ui.search = ev.target.value;
    this._focusSearch = true;
    this.searchSoon ??= debounce(() => this.render(), 200);
    this.searchSoon();
  }

  onKey(ev) {
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT") {
      if (ev.key === "Enter" && ev.target.tagName === "INPUT") ev.preventDefault();
      return;
    }
    const rows = [...this.element.querySelectorAll(".rps-row")];
    if (!rows.length) return;
    const i = rows.findIndex(r => r.classList.contains("sel"));
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const next = rows[clamp(i + (ev.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1)];
      next?.click();
      next?.focus();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      this.act();
    }
  }

  /** The item's own sheet: the compendium original for goods on the shelf (players can't open the shop's items). */
  async openSheet(id) {
    const item = this.ui.tab === "buy" ? this.actor.items.get(id) : this.customer?.items.get(id);
    if (!item) return;
    if (this.ui.tab !== "buy" || game.user.isGM) return item.sheet?.render(true);
    const src = sourceIdOf(item);
    const doc = src ? await fromUuid(src).catch(() => null) : null;
    if (doc) return doc.sheet?.render(true);
    return item.sheet?.render(true);
  }

  async act() {
    if (this.ui.tab === "creatures") return this.trade("creature", { creatureId: this.ui.creature });
    if (this.ui.tab === "buy") return this.trade("buy", { itemId: this.ui.sel, qty: this.ui.qty });
    if (this.ui.tab === "sell") {
      const item = this.customer?.items.get(this.ui.sel);
      if (item?.isEquipped) {
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t("Shop.Sell") }, content: `<p>${t("Shop.SellEquipped", { name: esc(item.name) })}</p>`, rejectClose: false }).catch(() => false);
        if (!ok) return;
      }
      return this.trade("sell", { itemId: this.ui.sel, qty: this.ui.qty });
    }
  }

  async trade(kind, data) {
    const who = this.customer;
    if (!who) return ui.notifications.warn(t("Shop.NoCustomer"));
    if (this._busy) return;
    this._busy = true;
    this.element.classList.add("busy");
    try {
      const res = await request(kind, { ...data, shopId: this.actor.id, actorId: who.id });
      this.say({ buy: "Thanks", sell: "Bought", repair: "Repaired", etch: "Etched", transfer: "Moved", creature: "Creature", material: "Reforged" }[kind], { item: res?.item ?? "" });
      if (kind === "buy" || kind === "sell") this.ui.qty = 1;
      if (kind === "transfer") this.ui.tf = { from: null, rune: null, to: null };
    } catch (err) {
      this.ui.line = err.message;
      ui.notifications.warn(err.message);
    } finally {
      this._busy = false;
      this.element?.classList.remove("busy");
      this.render();
    }
  }

  /** The customer's inventory changed (bought, sold, repaired …): show it. */
  watch(actor) {
    if (actor?.id === this.customerId || actor?.id === this.actor.id) this.refreshSoon();
  }
}

/** All open shop windows follow their customer's changes too. */
export function refreshShops(actor) {
  for (const app of foundry.applications.instances.values()) if (app instanceof ShopApp) app.watch(actor);
}

/** Open (or bring up) a shop's window. */
export function openShop(actor) {
  if (!actor) return null;
  if (!game.user.isGM && !actor.testUserPermission(game.user, "LIMITED")) { ui.notifications.warn(t("Trade.Err.Closed")); return null; }
  const id = `rps-shop-${actor.id}`;
  let app = foundry.applications.instances.get(id);
  if (!(app instanceof ShopApp)) app = new ShopApp(actor);
  // render() is async: bring the window up only once it exists (a new window has no element yet).
  const wasOpen = app.rendered;
  app.render({ force: true }).then(() => { if (wasOpen && app.rendered && app.element) app.bringToFront?.(); }).catch(e => console.error(e));
  return app;
}

/** The sheet registered for shop actors: it only opens the shop window. */
export class ShopSheet extends foundry.applications.sheets.ActorSheetV2 {
  static DEFAULT_OPTIONS = { classes: ["rps-proxy"], viewPermission: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED };

  async render(_options = {}, _legacy) {
    openShop(this.document);
    return this;
  }
}

/** The customer's purse as the coins they hold (platinum too), with the total on hover. */
function coinsHtml(actor) {
  const c = actor?.inventory?.currency ?? actor?.inventory?.coins ?? {};
  const parts = ["pp", "gp", "sp", "cp"].filter(d => Number(c[d]) > 0).map(d => `<span class="coin ${d}">${Number(c[d]).toLocaleString()}<i>${t(`Coin.${d}`)}</i></span>`);
  if (!parts.length) return money(walletCp(actor));
  return `<span class="rps-price" data-tooltip="${esc(t("Shop.WalletTotal", { total: formatCp(walletCp(actor)) }))}">${parts.join("")}</span>`;
}

/** A small mark on items with Hit Points that took damage (the sell list, the detail). */
function durBadge(item) {
  const st = stateOf(item);
  if (!hpOf(item).max || st === "ok" || st === "none") return "";
  return ` <span class="rps-durbadge ${st}" data-tooltip="${esc(stateLabel(st))}"><i class="fa-solid ${st === "damaged" ? "fa-heart-crack" : "fa-link-slash"}"></i></span>`;
}

export async function setOpen(actor, open) {
  const cfg = configOf(actor);
  cfg.open = open;
  await saveConfig(actor, cfg);
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  await actor.update({ "ownership.default": open ? L.LIMITED : L.NONE });
}
