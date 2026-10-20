import { MID, debounce, esc, formatCp, randomId, sourceIdOf, t, unitCp } from "../util.mjs";
import { CATEGORIES, catLabel, loadCatalog, preferMirror, searchCatalog, subLabel, subsOf } from "../catalog.mjs";
import { BUILTIN_TEMPLATES, addCreatures, addStock, autofill, buyCreatureCp, buyUnitCp, configOf, creaturePriceCp, exportShop, fillFromTemplate, newEvent, newStep, restock, restockChance, saveConfig, saveTemplate, WEALTH, wealthConfig, searchCreatures, sellUnitCp, shelf, stepFilter, stockOf, templateName, templates } from "../shop.mjs";
import { setOpen } from "./shop-sheet.mjs";
import { RARITY, levelBadge, money, rarityLabel } from "./common.mjs";
import { MATERIALS } from "../materials.mjs";

/* ======================================================================== *
 * The GM's shop editor.
 *
 *   진열대   — what is on sale: count, max, daily restock, ∞, price factor
 *   상품 추가 — search every gear pack (Korean / English names, "룬" finds
 *              runes; filters by category, weapon group, rune kind, level,
 *              rarity), tick and add, or "random N of these"; ready-made
 *              shop templates; scrolls and wands of any spell; drop items or
 *              a roll table (rolled N times) onto the window
 *   설정     — merchant, portrait, greeting, buy/sell rates, what it buys,
 *              services (repair, runes), restocking, open/closed
 *   이벤트   — named price events (festival −20%, "buying runes +10%" …)
 *   장부     — every trade
 * ======================================================================== */

const TABS = ["stock", "add", "creatures", "templates", "settings", "events", "ledger"];
const SPELL_FIELDS = ["img", "system.level.value", "system.traits.value", "system.traits.traditions", "system.traits.rarity"];

export class ShopEditor extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["rps-editor"],
    window: { resizable: true, icon: "fa-solid fa-store" },
    position: { width: 1060, height: 740 }
  };

  constructor(actor) {
    super({ id: `rps-editor-${actor.id}`, window: { title: t("Edit.Title", { name: actor.name }) } });
    this.actor = actor;
    this.ui = {
      tab: "stock", f: { cat: "all", sub: "", text: "", levelMin: 0, levelMax: 25, rarity: new Set(["common", "uncommon"]), magical: null, legacy: true },
      picked: new Set(), opts: { qty: 1, perDay: 1, infinite: false, count: 10 }, limit: 150, spellText: "", spellRank: 1, spellType: "scroll", partyLevel: 3,
      tpl: null, tplDraft: null, cText: "", cAnimals: true, cLevel: 5
    };
    this.saveSoon = debounce(() => saveConfig(this.actor, this.cfg), 400);
  }

  async _renderHTML() {
    this.cfg = configOf(this.actor);
    const tab = this.ui.tab;
    const body = tab === "stock" ? this.stockHtml() : tab === "add" ? await this.addHtml() : tab === "creatures" ? await this.creaturesHtml() : tab === "templates" ? await this.templatesHtml()
      : tab === "settings" ? this.settingsHtml() : tab === "events" ? this.eventsHtml() : this.ledgerHtml();
    return `<div class="rps-ed">
      <nav class="rps-tabs">${TABS.map(k => `<button type="button" class="${tab === k ? "on" : ""}" data-a="tab" data-tab="${k}">${t(`Edit.Tab.${k}`)}</button>`).join("")}
        <span class="gm"><button type="button" data-a="open-shop"><i class="fa-solid fa-store"></i> ${t("Edit.OpenShop")}</button>
        <button type="button" data-a="export"><i class="fa-solid fa-file-export"></i> ${t("Edit.Export")}</button></span></nav>
      <div class="rps-ed-body">${body}</div>
      <p class="rps-drop"><i class="fa-solid fa-hand-pointer"></i> ${t("Edit.DropHint")}</p></div>`;
  }

  _replaceHTML(result, content) {
    const keep = {};
    if (this._lastTab === this.ui.tab) for (const sel of [".scroll", ".list", ".rps-ed-settings", ".rps-ed-events", ".rps-tpl-steps", ".rps-ed-add"]) keep[sel] = content.querySelector(sel)?.scrollTop ?? 0;
    content.innerHTML = result;
    for (const [sel, top] of Object.entries(keep)) { const el = content.querySelector(sel); if (el && top) el.scrollTop = top; }
    this._lastTab = this.ui.tab;
    // Per element: a closed and reopened window has a new one.
    if (this._wired === content) return;
    this._wired = content;
    content.addEventListener("click", ev => this.onClick(ev));
    content.addEventListener("change", ev => this.onChange(ev));
    content.addEventListener("input", ev => this.onInput(ev));
    content.addEventListener("dragover", ev => ev.preventDefault());
    content.addEventListener("drop", ev => this.onDrop(ev));
  }

  /* ---------------- 진열대 ---------------- */

  stockHtml() {
    const cfg = this.cfg;
    const items = shelf(this.actor).sort((a, b) => (a.system.level?.value ?? 0) - (b.system.level?.value ?? 0) || a.name.localeCompare(b.name, game.i18n.lang));
    const chance = cfg.restock?.mode === "chance";
    const rows = items.map(it => {
      const st = stockOf(it);
      return `<tr data-id="${it.id}"><td><span class="nm"><img src="${esc(it.img)}" alt="">${levelBadge(it)}<a data-a="sheet" data-id="${it.id}">${esc(it.name)}</a></span></td>
        <td>${money(Math.round(unitCp(it)))}</td><td>${money(buyUnitCp(cfg, it))}</td><td>${money(sellUnitCp(cfg, it))}</td>
        <td><input type="number" min="0" value="${it.system.quantity ?? 0}" data-s="qty" ${st.infinite ? "disabled" : ""}></td>
        <td><input type="number" min="0" value="${st.max}" data-s="max" ${st.infinite ? "disabled" : ""}></td>
        <td><input type="number" min="-1" value="${st.perDay}" data-s="perDay" ${st.infinite ? "disabled" : ""} data-tooltip="${esc(t("Edit.PerDayHint"))}"></td>
        <td><input type="checkbox" data-s="infinite" ${st.infinite ? "checked" : ""}></td>
        <td><input type="number" min="0" step="5" value="${Math.round(st.priceMul * 100)}" data-s="priceMul" class="pct">%</td>
        <td><input type="checkbox" data-s="featured" ${st.featured ? "checked" : ""} data-tooltip="${esc(t("Edit.FeaturedHint"))}"></td>
        ${chance ? `<td><input type="number" min="0" max="100" value="${st.chance ?? ""}" placeholder="${restockChance(cfg, it)}" data-s="chance" class="pct" ${st.infinite ? "disabled" : ""} data-tooltip="${esc(t("Edit.ChanceHint"))}">%</td>` : ""}
        <td><button type="button" data-a="remove" data-id="${it.id}" data-tooltip="${esc(t("Edit.Remove"))}"><i class="fa-solid fa-trash"></i></button></td></tr>`;
    }).join("");
    return `<div class="rps-ed-stock">
      <div class="row"><button type="button" data-a="restock-full"><i class="fa-solid fa-boxes-stacked"></i> ${t("Edit.FillAll")}</button>
        <button type="button" data-a="restock-day" data-tooltip="${esc(t("Edit.OneDayHint"))}"><i class="fa-solid fa-sun"></i> ${t("Edit.OneDay")}</button>
        <button type="button" data-a="clear-out"><i class="fa-solid fa-broom"></i> ${t("Edit.ClearSoldOut")}</button>
        <button type="button" data-a="clear-all" class="danger"><i class="fa-solid fa-trash-can"></i> ${t("Edit.ClearAll")}</button>
        <span class="rps-dim">${t("Edit.Count", { n: items.length })}</span></div>
      <div class="scroll"><table class="rps-table"><thead><tr><th>${t("Edit.Col.Item")}</th><th>${t("Edit.Col.List")}</th><th>${t("Edit.Col.Buy")}</th><th>${t("Edit.Col.Sell")}</th>
        <th>${t("Edit.Col.Qty")}</th><th>${t("Edit.Col.Max")}</th><th>${t("Edit.Col.PerDay")}</th><th>∞</th><th>${t("Edit.Col.Price")}</th><th data-tooltip="${esc(t("Edit.FeaturedHint"))}"><i class="fa-solid fa-star"></i></th>${chance ? `<th>${t("Edit.Col.Chance")}</th>` : ""}<th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="12" class="rps-empty">${t("Edit.EmptyStock")}</td></tr>`}</tbody></table></div></div>`;
  }

  /* ---------------- 상품 추가 ---------------- */

  async addHtml() {
    const cat = await loadCatalog();
    const f = this.ui.f;
    const found = searchCatalog(cat, { ...f, cat: f.cat, sub: f.sub || null });
    const subs = f.cat !== "all" ? subsOf(cat.list, f.cat) : [];
    const shown = found.slice(0, this.ui.limit);
    const onShelf = new Set(shelf(this.actor).map(i => sourceIdOf(i)));
    const rows = shown.map(e => `<label class="rps-hit ${onShelf.has(e.uuid) ? "have" : ""} rar-${e.rarity}">
        <input type="checkbox" data-pick="${e.uuid}" ${this.ui.picked.has(e.uuid) ? "checked" : ""}>
        <span class="rps-lv">${e.level}</span><img src="${esc(e.img)}" alt="" loading="lazy"><span class="nm">${esc(e.name)}${e.remaster === false ? ` <small class="legacy">L</small>` : ""}</span>
        <small class="sub">${esc(subLabel(e.cat, e.sub))}</small>${money(Math.round(e.price))}
        <button type="button" class="info" data-a="doc-sheet" data-uuid="${e.uuid}" data-tooltip="${esc(t("Shop.OpenSheet"))}"><i class="fa-solid fa-circle-info"></i></button>
        <button type="button" data-a="add-one" data-uuid="${e.uuid}" data-tooltip="${esc(t("Edit.AddOne"))}"><i class="fa-solid fa-plus"></i></button></label>`).join("");
    const o = this.ui.opts;
    return `<div class="rps-ed-add">
      <div class="filters">
        <div class="cats">${["all", ...CATEGORIES].map(c => `<button type="button" class="${f.cat === c ? "on" : ""}" data-a="f-cat" data-cat="${c}">${esc(c === "all" ? t("Cat.all") : catLabel(c))}</button>`).join("")}</div>
        <div class="row">
          ${subs.length ? `<select data-f="sub"><option value="">${t("Cat.allSub")}</option>${subs.map(([s, n]) => `<option value="${esc(s)}" ${f.sub === s ? "selected" : ""}>${esc(subLabel(f.cat, s))} (${n})</option>`).join("")}</select>` : ""}
          <input type="search" data-f="text" value="${esc(f.text)}" placeholder="${esc(t("Edit.SearchHint"))}">
          <label>${t("Shop.Level")} <input type="number" data-f="levelMin" value="${f.levelMin}" min="0" max="25" class="n"> – <input type="number" data-f="levelMax" value="${f.levelMax}" min="0" max="25" class="n"></label>
          ${RARITY.map(r => `<label class="chip"><input type="checkbox" data-f-rarity="${r}" ${f.rarity.has(r) ? "checked" : ""}> ${esc(rarityLabel(r))}</label>`).join("")}
          <select data-f="magical"><option value="">${t("Edit.MagicAny")}</option><option value="1" ${f.magical === true ? "selected" : ""}>${t("Edit.MagicOnly")}</option><option value="0" ${f.magical === false ? "selected" : ""}>${t("Edit.MagicNone")}</option></select>
          <label class="chip"><input type="checkbox" data-f="legacy" ${f.legacy ? "checked" : ""}> ${t("Edit.Legacy")}</label>
        </div>
      </div>
      <div class="results"><div class="head"><label><input type="checkbox" data-a="pick-all"> ${t("Edit.PickAll")}</label><span class="rps-dim">${t("Edit.Found", { n: found.length, shown: shown.length })}</span></div>
        <div class="list">${rows || `<p class="rps-empty">${t("Shop.NoMatch")}</p>`}${found.length > shown.length ? `<button type="button" class="more" data-a="more">${t("Edit.More", { n: found.length - shown.length })}</button>` : ""}</div></div>
      <div class="adder">
        <label>${t("Edit.Col.Qty")} <input type="number" min="1" value="${o.qty}" data-o="qty" class="n"></label>
        <label>${t("Edit.Col.PerDay")} <input type="number" min="-1" value="${o.perDay}" data-o="perDay" class="n"></label>
        <label class="chip"><input type="checkbox" data-o="infinite" ${o.infinite ? "checked" : ""}> ∞ ${t("Edit.Infinite")}</label>
        <button type="button" class="primary" data-a="add-picked" ${this.ui.picked.size ? "" : "disabled"}><i class="fa-solid fa-plus"></i> ${t("Edit.AddPicked", { n: this.ui.picked.size })}</button>
        <span class="sep"></span>
        <label>${t("Edit.Random")} <input type="number" min="1" value="${o.count}" data-o="count" class="n"></label>
        <button type="button" data-a="add-random" ${found.length ? "" : "disabled"}><i class="fa-solid fa-dice"></i> ${t("Edit.AddRandom")}</button>
      </div>
      <details class="extra"><summary><i class="fa-solid fa-wand-magic-sparkles"></i> ${t("Edit.Templates")}</summary>
        <div class="row"><label>${t("Edit.PartyLevel")} <input type="number" min="1" max="20" value="${this.ui.partyLevel}" data-u="partyLevel" class="n"></label>
        ${Object.values(templates()).map(tp => `<button type="button" data-a="template" data-tpl="${tp.key}"><img src="${esc(tp.img)}" alt=""> ${esc(templateName(tp))}</button>`).join("")}
        <button type="button" data-a="tab" data-tab="templates"><i class="fa-solid fa-pen"></i> ${t("Tpl.EditThem")}</button></div>
        <p class="rps-hint">${t("Edit.TemplatesHint")}</p></details>
      <details class="extra" ${this.ui.spellOpen ? "open" : ""}><summary data-a="spell-open"><i class="fa-solid fa-scroll"></i> ${t("Edit.Scrolls")}</summary>${await this.spellHtml()}</details>
    </div>`;
  }

  async spellIndex() {
    if (this._spells) return this._spells;
    const all = game.packs.filter(p => p.documentName === "Item" && /spell/i.test(p.metadata.name) && !/effect/i.test(p.metadata.name));
    const mirrorNames = new Set(all.filter(p => p.metadata.packageType !== "system").map(p => p.metadata.name));
    const out = [];
    for (const pack of all) {
      if (pack.metadata.packageType === "system" && mirrorNames.has(pack.metadata.name)) continue;
      let idx;
      try { idx = await pack.getIndex({ fields: SPELL_FIELDS }); } catch (_) { continue; }
      for (const e of idx) {
        if (e.type !== "spell") continue;
        const traits = e.system?.traits?.value ?? [];
        if (traits.includes("focus") || traits.includes("ritual")) continue;
        out.push({ uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`, name: e.name, img: e.img, level: Number(e.system?.level?.value ?? 1), cantrip: traits.includes("cantrip"), search: e.name.toLowerCase() });
      }
    }
    out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, game.i18n.lang));
    this._spells = out;
    return out;
  }

  async spellHtml() {
    if (!this.ui.spellOpen) return "";
    const list = await this.spellIndex();
    const words = this.ui.spellText.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (words.length ? list.filter(s => words.every(w => s.search.includes(w))) : list).filter(s => !s.cantrip).slice(0, 60);
    const types = Object.entries(CONFIG.PF2E?.spellcastingItems ?? {}).filter(([, v]) => !v.cantripsOnly);
    return `<div class="rps-spells"><div class="row"><input type="search" data-u="spellText" value="${esc(this.ui.spellText)}" placeholder="${esc(t("Edit.SpellSearch"))}">
        <select data-u="spellType">${types.map(([k, v]) => `<option value="${k}" ${this.ui.spellType === k ? "selected" : ""}>${esc(game.i18n.localize(v.name))}</option>`).join("")}</select>
        <label>${t("Edit.Rank")} <input type="number" min="1" max="10" value="${this.ui.spellRank}" data-u="spellRank" class="n"></label></div>
      <div class="list">${hits.map(s => `<div class="rps-hit"><span class="rps-lv">${s.level}</span><img src="${esc(s.img)}" alt=""><span class="nm">${esc(s.name)}</span>
        <button type="button" data-a="add-spell" data-uuid="${s.uuid}" data-tooltip="${esc(t("Edit.AddSpell"))}"><i class="fa-solid fa-plus"></i></button></div>`).join("")}</div></div>`;
  }

  /** A scroll / wand of a spell, the way PF2e makes them (its own template items per rank). */
  async addSpellItem(uuid) {
    const spell = await preferMirror(uuid);
    const type = this.ui.spellType;
    const rank = Math.max(Number(spell?.system?.level?.value ?? 1), Math.min(10, Number(this.ui.spellRank) || 1));
    const data = CONFIG.PF2E?.spellcastingItems?.[type];
    const tplUuid = data?.compendiumUuids?.[rank];
    const tpl = tplUuid ? await preferMirror(tplUuid) : null;
    if (!spell || !tpl) return ui.notifications.warn(t("Edit.NoScrollTemplate"));
    const src = tpl.toObject();
    delete src._id;
    const traits = new Set([...(src.system.traits?.value ?? []), ...(spell.system.traits?.value ?? [])]);
    if ((spell.system.traits?.traditions ?? []).length) traits.delete("magical");
    src.system.traits.value = [...traits].sort();
    src.system.traits.rarity = spell.system.traits?.rarity ?? "common";
    src.name = data.nameTemplate ? game.i18n.format(data.nameTemplate, { name: spell.name, level: rank }) : `${spell.name} (${rank})`;
    src.system.description.value = `<p>@UUID[${spell.uuid}]{${spell.name}}</p><hr>${src.system.description.value ?? ""}`;
    src.system.spell = foundry.utils.mergeObject(spell.toObject(), { _id: randomId(), system: { location: { value: null, heightenedLevel: rank } } }, { inplace: false });
    src._stats = { ...(src._stats ?? {}), compendiumSource: null };
    const o = this.ui.opts;
    const fake = { type: "consumable", pack: null, uuid: `spell-item-${type}-${rank}-${spell.uuid}`, toObject: () => foundry.utils.deepClone(src) };
    await addStock(this.actor, [fake], { qty: o.qty, max: o.qty, perDay: o.perDay, infinite: o.infinite });
    ui.notifications.info(t("Edit.Added", { n: 1 }));
  }

  /* ---------------- 동물 (creatures for sale) ---------------- */

  async creaturesHtml() {
    const cfg = this.cfg;
    const mine = cfg.creatures ?? [];
    const rows = mine.map((c, i) => `<tr data-ci="${i}"><td><span class="nm"><img src="${esc(c.img)}" alt=""><span class="rps-lv">${c.level ?? 0}</span><a data-a="c-sheet" data-uuid="${esc(c.uuid)}">${esc(c.name)}</a></span></td>
        <td><input type="number" min="0" step="0.1" value="${(Number(c.priceCp) || 0) / 100}" data-c="priceGp" class="n"> gp</td><td>${money(buyCreatureCp(cfg, c))}</td>
        <td><input type="number" min="0" value="${c.qty ?? 0}" data-c="qty" class="n" ${c.infinite ? "disabled" : ""}></td>
        <td><input type="number" min="0" value="${c.max ?? 1}" data-c="max" class="n" ${c.infinite ? "disabled" : ""}></td>
        <td><input type="number" min="-1" value="${c.perDay ?? 1}" data-c="perDay" class="n" ${c.infinite ? "disabled" : ""}></td>
        <td><input type="checkbox" data-c="infinite" ${c.infinite ? "checked" : ""}></td>
        <td><input type="number" min="0" max="100" value="${c.chance ?? ""}" placeholder="${cfg.restock?.chance?.[c.rarity ?? "common"] ?? 100}" data-c="chance" class="n">%</td>
        <td><button type="button" data-a="c-del" data-ci="${i}"><i class="fa-solid fa-trash"></i></button></td></tr>`).join("");
    if (!this._cHits || this._cKey !== `${this.ui.cText}|${this.ui.cAnimals}|${this.ui.cLevel}`) {
      this._cKey = `${this.ui.cText}|${this.ui.cAnimals}|${this.ui.cLevel}`;
      this._cHits = await searchCreatures(this.ui.cText, { animalsOnly: this.ui.cAnimals, levelMax: Number(this.ui.cLevel) || null });
    }
    const have = new Set(mine.map(c => c.uuid));
    const hits = this._cHits.slice(0, 120).map(e => `<div class="rps-hit ${have.has(e.uuid) ? "have" : ""} rar-${e.rarity}"><span class="rps-lv">${e.level}</span><img src="${esc(e.img)}" alt="" loading="lazy">
        <a class="nm" data-a="c-sheet" data-uuid="${esc(e.uuid)}" data-tooltip="${esc(t("Creature.OpenSheet"))}">${esc(e.name)}</a><small class="sub">${esc(e.pack)}</small>${money(creaturePriceCp(e))}
        <button type="button" data-a="c-add" data-uuid="${esc(e.uuid)}" data-tooltip="${esc(t("Edit.AddOne"))}"><i class="fa-solid fa-plus"></i></button></div>`).join("");
    return `<div class="rps-ed-creatures">
      <p class="rps-hint">${t("Creature.EditHint")}</p>
      <div class="scroll short"><table class="rps-table"><thead><tr><th>${t("Edit.Col.Item")}</th><th>${t("Creature.Price")}</th><th>${t("Edit.Col.Buy")}</th><th>${t("Edit.Col.Qty")}</th><th>${t("Edit.Col.Max")}</th><th>${t("Edit.Col.PerDay")}</th><th>∞</th><th>${t("Edit.Col.Chance")}</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="9" class="rps-empty">${t("Creature.NoneYet")}</td></tr>`}</tbody></table></div>
      <div class="row"><input type="search" data-u="cText" value="${esc(this.ui.cText)}" placeholder="${esc(t("Creature.Search"))}">
        <label class="chip"><input type="checkbox" data-u="cAnimals" ${this.ui.cAnimals ? "checked" : ""}> ${t("Creature.AnimalsOnly")}</label>
        <label>${t("Creature.MaxLevel")} <input type="number" min="-1" max="25" value="${this.ui.cLevel}" data-u="cLevel" class="n"></label>
        <button type="button" data-a="c-standard"><i class="fa-solid fa-horse"></i> ${t("Creature.Standard")}</button>
        <span class="rps-dim">${t("Edit.Found", { n: this._cHits.length, shown: Math.min(120, this._cHits.length) })}</span></div>
      <div class="list">${hits || `<p class="rps-empty">${t("Shop.NoMatch")}</p>`}</div></div>`;
  }

  /* ---------------- 템플릿 (editable shop templates) ---------------- */

  async templatesHtml() {
    const all = templates();
    if (!this.ui.tpl || !all[this.ui.tpl] && !this.ui.tplDraft) { this.ui.tpl = Object.keys(all)[0]; this.ui.tplDraft = null; }
    this.ui.tplDraft ??= foundry.utils.deepClone(all[this.ui.tpl]);
    const d = this.ui.tplDraft;
    const cat = await loadCatalog();
    const list = Object.values(all).map(tp => `<button type="button" class="${tp.key === this.ui.tpl ? "on" : ""}" data-a="tpl-pick" data-tpl="${tp.key}"><img src="${esc(tp.img)}" alt="">
      <span>${esc(templateName(tp))}</span>${tp.builtin ? (tp.changed ? `<small>${t("Tpl.Changed")}</small>` : "") : `<small>${t("Tpl.Own")}</small>`}</button>`).join("");
    const lv = Number(this.ui.partyLevel) || 1;
    const rarity = RARITY;
    const steps = (d.steps ?? []).map((st, i) => {
      const subs = st.cat && st.cat !== "all" ? subsOf(cat.list, st.cat) : [];
      const { f } = stepFilter(st, lv);
      const n = searchCatalog(cat, f).length;
      const num = (k, ph = "") => `<input type="number" data-st="${k}" data-i="${i}" value="${st[k] ?? ""}" placeholder="${ph}" class="n">`;
      return `<tr data-i="${i}">
        <td><select data-st="cat" data-i="${i}">${CATEGORIES.map(c => `<option value="${c}" ${st.cat === c ? "selected" : ""}>${esc(catLabel(c))}</option>`).join("")}</select>
          ${subs.length ? `<select data-st="sub" data-i="${i}"><option value="">${t("Cat.allSub")}</option>${subs.map(([sb]) => `<option value="${esc(sb)}" ${st.sub === sb ? "selected" : ""}>${esc(subLabel(st.cat, sb))}</option>`).join("")}</select>` : ""}</td>
        <td class="lv">${num("lvMin", "—")} ~ ${num("lvMax", "—")} <small>/ ${t("Tpl.Cap")}</small> ${num("lvCap", "—")}</td>
        <td class="rar">${rarity.map(r => `<label class="chip"><input type="checkbox" data-st-r="${r}" data-i="${i}" ${(st.rarity ?? ["common"]).includes(r) ? "checked" : ""}> ${esc(rarityLabel(r))}</label>`).join("")}</td>
        <td><select data-st="magical" data-i="${i}"><option value="">${t("Edit.MagicAny")}</option><option value="1" ${st.magical === true ? "selected" : ""}>${t("Edit.MagicOnly")}</option><option value="0" ${st.magical === false ? "selected" : ""}>${t("Edit.MagicNone")}</option></select></td>
        <td>${num("count", "0")}</td><td>${num("qty", "1")}</td><td>${num("perDay", "1")}</td>
        <td><input type="checkbox" data-st="infinite" data-i="${i}" ${st.infinite ? "checked" : ""}></td>
        <td class="hits" data-tooltip="${esc(t("Tpl.HitsHint", { level: lv }))}">${n}</td>
        <td><button type="button" data-a="st-del" data-i="${i}"><i class="fa-solid fa-trash"></i></button></td></tr>`;
    }).join("");
    const svc = d.config?.services ?? {};
    const buys = d.config?.buys ?? [];
    const cur = all[this.ui.tpl];
    return `<div class="rps-ed-tpl">
      <aside class="tpl-list">${list}<button type="button" data-a="tpl-new"><i class="fa-solid fa-plus"></i> ${t("Tpl.New")}</button></aside>
      <section class="tpl-edit">
        <div class="row"><label>${t("Tpl.Name")} <input type="text" data-t="name" value="${esc(templateName(d))}"></label>
          <label>${t("Tpl.Img")} <input type="text" data-t="img" value="${esc(d.img ?? "")}" class="img"></label>
          <label class="chip"><input type="checkbox" data-t="creatures" ${d.creatures ? "checked" : ""}> ${t("Tpl.Creatures")}</label></div>
        <div class="row"><span class="rps-dim">${t("Tpl.Services")}</span>
          ${["repair", "material", "runes"].map(k => `<label class="chip"><input type="checkbox" data-t-svc="${k}" ${svc[k]?.on ? "checked" : ""}> ${t(`Tab.${k}`)}</label>`).join("")}
          <span class="rps-dim">${t("Set.Buys")}</span>${CATEGORIES.map(c => `<label class="chip"><input type="checkbox" data-t-buys="${c}" ${!buys.length || buys.includes(c) ? "checked" : ""}> ${esc(catLabel(c))}</label>`).join("")}</div>
        <p class="rps-hint">${t("Tpl.StepsHint")}</p>
        <div class="rps-tpl-steps"><table class="rps-table"><thead><tr><th>${t("Tpl.Col.Cat")}</th><th>${t("Tpl.Col.Level")}</th><th>${t("Tpl.Col.Rarity")}</th><th>${t("Tpl.Col.Magic")}</th>
          <th data-tooltip="${esc(t("Tpl.CountHint"))}">${t("Tpl.Col.Count")}</th><th>${t("Edit.Col.Qty")}</th><th>${t("Edit.Col.PerDay")}</th><th>∞</th><th>${t("Tpl.Col.Hits")}</th><th></th></tr></thead>
          <tbody>${steps || `<tr><td colspan="10" class="rps-empty">${t("Tpl.NoSteps")}</td></tr>`}</tbody></table>
          <button type="button" class="more" data-a="st-add"><i class="fa-solid fa-plus"></i> ${t("Tpl.AddStep")}</button></div>
        <div class="row foot">
          <button type="button" class="primary" data-a="tpl-save"><i class="fa-solid fa-floppy-disk"></i> ${t("Tpl.Save")}</button>
          <button type="button" data-a="tpl-saveas"><i class="fa-solid fa-copy"></i> ${t("Tpl.SaveAs")}</button>
          ${cur?.builtin && cur?.changed ? `<button type="button" data-a="tpl-reset"><i class="fa-solid fa-rotate-left"></i> ${t("Tpl.Reset")}</button>` : ""}
          ${cur && !cur.builtin ? `<button type="button" class="danger" data-a="tpl-del"><i class="fa-solid fa-trash"></i> ${t("Tpl.Delete")}</button>` : ""}
          <span class="sep"></span>
          <label>${t("Edit.PartyLevel")} <input type="number" min="1" max="20" value="${lv}" data-u="partyLevel" class="n"></label>
          <button type="button" data-a="template" data-draft="1"><i class="fa-solid fa-wand-magic-sparkles"></i> ${t("Tpl.FillNow")}</button></div>
      </section></div>`;
  }

  /* ---------------- 설정 ---------------- */

  settingsHtml() {
    const c = this.cfg;
    const field = (k, label, html) => `<label class="field"><span>${label}</span>${html}</label>`;
    const txt = (k, v, ph = "") => `<input type="text" data-k="${k}" value="${esc(v ?? "")}" placeholder="${esc(ph)}">`;
    const pct = (k, v) => `<span class="pctin"><input type="number" min="0" step="5" data-k="${k}" data-pct="1" value="${Math.round((Number(v) || 0) * 100)}">%</span>`;
    const chk = (k, v) => `<input type="checkbox" data-k="${k}" ${v ? "checked" : ""}>`;
    return `<div class="rps-ed-settings">
      <div class="col">
        <h4>${t("Set.Merchant")}</h4>
        ${field("title", t("Set.Title"), txt("title", c.title, this.actor.name))}
        ${field("merchant.name", t("Set.MerchantName"), txt("merchant.name", c.merchant?.name))}
        <div class="field pic"><span>${t("Set.Portrait")}</span><button type="button" class="rps-pic" data-a="portrait">${c.merchant?.img ? `<img src="${esc(c.merchant.img)}" alt="">` : `<i class="fa-solid fa-user-tie"></i>`}</button>
          <div><label class="inline">${chk("merchant.show", c.merchant?.show !== false)} ${t("Set.ShowPortrait")}</label>${c.merchant?.img ? `<button type="button" data-a="portrait-clear">${t("Set.Clear")}</button>` : ""}</div></div>
        ${field("greeting", t("Set.Greeting"), txt("greeting", c.greeting, t("Talk.Hello")))}
        ${field("theme", t("Set.Theme"), `<select data-k="theme">${["gold", "rune", "forest", "night"].map(th => `<option value="${th}" ${c.theme === th ? "selected" : ""}>${t(`Theme.${th}`)}</option>`).join("")}</select>`)}
        <h4>${t("Set.Open")}</h4>
        <label class="inline"><input type="checkbox" data-a="open" ${c.open ? "checked" : ""}> ${t("Set.OpenHint")}</label>
      </div>
      <div class="col">
        <h4>${t("Set.Wealth")}</h4>
        <div class="inline"><select data-k="wealth">${Object.keys(WEALTH).map(w => `<option value="${w}" ${c.wealth === w ? "selected" : ""}>${t(`Wealth.${w}`)}</option>`).join("")}</select>
          <button type="button" class="mini" data-a="wealth-apply" data-tooltip="${esc(t("Set.WealthApplyHint"))}">${t("Set.WealthApply")}</button></div>
        <p class="rps-hint">${t(`Wealth.Hint.${c.wealth ?? "modest"}`)}</p>
        <label class="inline">${chk("purse.on", c.purse?.on)} <b>${t("Set.Purse")}</b></label>
        <div class="sub ${c.purse?.on ? "" : "off"}">
          <label class="inline">${t("Set.PurseNow")} <input type="number" min="0" step="1" data-k="purse.value" data-gp="1" value="${Math.round(Number(c.purse?.value ?? 0) / 100)}" class="n"> gp /
            <input type="number" min="0" step="1" data-k="purse.max" data-gp="1" value="${Math.round(Number(c.purse?.max ?? 0) / 100)}" class="n"> gp</label>
          <label class="inline">${t("Set.PurseRefill")} <input type="number" min="0" max="100" data-k="purse.refill" value="${c.purse?.refill ?? 25}" class="n">%</label>
          <p class="rps-hint">${t("Set.PurseHint")}</p></div>
        <h4>${t("Set.Prices")}</h4>
        ${field("buyRate", t("Set.BuyRate"), pct("buyRate", c.buyRate))}
        ${field("sellRate", t("Set.SellRate"), pct("sellRate", c.sellRate))}
        <p class="rps-hint">${t("Set.RatesHint")}</p>
        <h4>${t("Set.Buys")}</h4>
        <div class="chips">${CATEGORIES.map(cat => `<label class="chip"><input type="checkbox" data-buys="${cat}" ${!c.buys?.length || c.buys.includes(cat) ? "checked" : ""}> ${esc(catLabel(cat))}</label>`).join("")}</div>
        <label class="inline">${chk("resell", c.resell)} ${t("Set.Resell")}</label>
        <h4>${t("Set.Restock")}</h4>
        <label class="inline">${chk("restock.auto", c.restock?.auto)} ${t("Set.AutoRestock")}</label>
        <label class="inline">${t("Set.Every")} <input type="number" min="1" step="1" data-k="restock.every" value="${c.restock?.every ?? 1}" class="n"> ${t("Set.EveryDays")}
          ${[1, 7, 30].map(n => `<button type="button" class="mini" data-a="every" data-n="${n}">${t(`Set.EveryPreset.${n}`)}</button>`).join("")}</label>
        <label class="inline"><input type="radio" name="rsmode" data-k="restock.mode" value="fill" ${c.restock?.mode !== "chance" ? "checked" : ""}> ${t("Set.RestockMode.fill")}</label>
        <label class="inline"><input type="radio" name="rsmode" data-k="restock.mode" value="chance" ${c.restock?.mode === "chance" ? "checked" : ""}> ${t("Set.RestockMode.chance")}</label>
        <div class="sub ${c.restock?.mode === "chance" ? "" : "off"}">${RARITY.map(r => `<label class="inline">${esc(rarityLabel(r))} <input type="number" min="0" max="100" data-k="restock.chance.${r}" value="${c.restock?.chance?.[r] ?? 100}" class="n">%</label>`).join("")}
          <p class="rps-hint">${t("Set.ChanceHint")}</p></div>
      </div>
      <div class="col">
        <h4>${t("Set.Services")}</h4>
        <label class="inline">${chk("services.repair.on", c.services?.repair?.on)} <b>${t("Tab.repair")}</b></label>
        <div class="sub ${c.services?.repair?.on ? "" : "off"}">
          <label class="inline"><input type="radio" name="rmode" data-k="services.repair.mode" value="percent" ${c.services?.repair?.mode !== "perHp" ? "checked" : ""}> ${t("Set.RepairPercent")}
            <input type="number" min="0" step="1" data-k="services.repair.percent" value="${c.services?.repair?.percent ?? 10}" class="n">%</label>
          <label class="inline"><input type="radio" name="rmode" data-k="services.repair.mode" value="perHp" ${c.services?.repair?.mode === "perHp" ? "checked" : ""}> ${t("Set.RepairPerHp")}
            <input type="number" min="0" step="1" data-k="services.repair.perHp" value="${c.services?.repair?.perHp ?? 10}" class="n"> cp</label>
          <p class="rps-hint">${t("Set.RepairHint")}</p></div>
        <label class="inline">${chk("services.material.on", c.services?.material?.on)} <b>${t("Tab.material")}</b></label>
        <div class="sub ${c.services?.material?.on ? "" : "off"}"><label class="inline">${t("Set.MaterialRate")} ${pct("services.material.rate", c.services?.material?.rate ?? 1)}</label>
          <label class="inline">${t("Set.MaterialReach")} <input type="number" min="0" max="20" data-k="services.material.reach" value="${c.services?.material?.reach ?? 5}" class="n"></label>
          <details><summary class="rps-hint">${t("Set.MaterialAllowed", { n: (c.services?.material?.allowed ?? []).length || t("Set.All") })}</summary>
            <div class="chips">${materialTypes().map(m => `<label class="chip"><input type="checkbox" data-mat="${m}" ${!(c.services?.material?.allowed ?? []).length || c.services.material.allowed.includes(m) ? "checked" : ""}> ${esc(materialName(m))}</label>`).join("")}</div></details>
          <p class="rps-hint">${t("Set.MaterialHint")}</p></div>
        <label class="inline">${chk("services.runes.on", c.services?.runes?.on)} <b>${t("Tab.runes")}</b></label>
        <div class="sub ${c.services?.runes?.on ? "" : "off"}"><label class="inline">${chk("services.runes.transfer", c.services?.runes?.transfer)} ${t("Set.RuneTransfer")}</label>
          <p class="rps-hint">${t("Set.RuneHint")}</p></div>
      </div></div>`;
  }

  /* ---------------- 이벤트 ---------------- */

  eventsHtml() {
    const evs = this.cfg.events ?? [];
    return `<div class="rps-ed-events"><p class="rps-hint">${t("Ev.Hint")}</p>
      ${evs.map((ev, i) => `<div class="rps-event ${ev.active ? "" : "off"}" data-i="${i}">
        <label class="inline"><input type="checkbox" data-ev="active" ${ev.active ? "checked" : ""}></label>
        <input type="text" data-ev="name" value="${esc(ev.name)}" placeholder="${esc(t("Ev.Name"))}">
        <label>${t("Ev.Buy")} <input type="number" step="5" data-ev="buy" value="${Math.round((Number(ev.buy) || 1) * 100)}" class="n">%</label>
        <label>${t("Ev.Sell")} <input type="number" step="5" data-ev="sell" value="${Math.round((Number(ev.sell) || 1) * 100)}" class="n">%</label>
        <div class="chips">${CATEGORIES.map(cat => `<label class="chip"><input type="checkbox" data-ev-cat="${cat}" ${ev.cats?.includes(cat) ? "checked" : ""}> ${esc(catLabel(cat))}</label>`).join("")}</div>
        <button type="button" data-a="ev-del" data-i="${i}"><i class="fa-solid fa-trash"></i></button></div>`).join("")}
      <div class="row"><button type="button" data-a="ev-add"><i class="fa-solid fa-plus"></i> ${t("Ev.Add")}</button>
        ${["sale", "festival", "runeWeek", "shortage"].map(k => `<button type="button" data-a="ev-preset" data-k="${k}">${t(`Ev.Preset.${k}`)}</button>`).join("")}</div></div>`;
  }

  ledgerHtml() {
    const rows = (this.cfg.ledger ?? []).map(l => `<tr class="${l.kind}"><td>${new Date(l.at).toLocaleString()}</td><td>${esc(t(`Log.Kind.${l.kind}`))}</td><td>${esc(l.actor)}<small> (${esc(l.user ?? "")})</small></td>
      <td>${esc(l.item)}${l.qty > 1 ? ` ×${l.qty}` : ""}${l.extra ? ` <small>${esc(l.extra)}</small>` : ""}</td><td>${l.cp ? `${l.kind === "sell" ? "+" : "−"}${formatCp(l.cp)}` : ""}</td></tr>`).join("");
    const income = (this.cfg.ledger ?? []).reduce((n, l) => n + (l.kind === "sell" ? -l.cp : l.cp || 0), 0);
    return `<div class="rps-ed-ledger"><div class="row"><b>${t("Ledger.Net")}</b> ${formatCp(Math.abs(income))} ${income < 0 ? t("Ledger.Paid") : t("Ledger.Earned")}
      <button type="button" data-a="ledger-clear">${t("Ledger.Clear")}</button></div>
      <div class="scroll"><table class="rps-table"><thead><tr><th>${t("Ledger.When")}</th><th></th><th>${t("Ledger.Who")}</th><th>${t("Ledger.What")}</th><th>${t("Ledger.Money")}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="rps-empty">${t("Ledger.Empty")}</td></tr>`}</tbody></table></div></div>`;
  }

  /* ---------------- input ---------------- */

  async onClick(ev) {
    const el = ev.target.closest("[data-a]");
    if (!el) return;
    if (el.tagName === "INPUT" && el.type === "checkbox" && el.dataset.a !== "open" && el.dataset.a !== "pick-all") return;
    const a = el.dataset.a;
    if (!["open", "pick-all"].includes(a) && el.tagName !== "SUMMARY") ev.preventDefault();
    const items = this.actor.items;
    switch (a) {
      case "tab": this.ui.tab = el.dataset.tab; return this.render();
      case "open-shop": return (await import("./shop-sheet.mjs")).openShop(this.actor);
      case "export": return this.export();
      case "sheet": return items.get(el.dataset.id)?.sheet.render(true);
      case "doc-sheet": return (await fromUuid(el.dataset.uuid).catch(() => null))?.sheet?.render(true);
      case "remove": await items.get(el.dataset.id)?.delete(); return this.render();
      case "restock-full": await this.actor.updateEmbeddedDocuments("Item", shelf(this.actor).filter(i => !stockOf(i).infinite).map(i => ({ _id: i.id, "system.quantity": Math.max(stockOf(i).max, i.system.quantity ?? 0) }))); return this.render();
      case "restock-day": await restock(this.actor, 1); return this.render();
      case "clear-out": await this.actor.deleteEmbeddedDocuments("Item", shelf(this.actor).filter(i => !stockOf(i).infinite && (i.system.quantity ?? 0) <= 0).map(i => i.id)); return this.render();
      case "clear-all": {
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t("Edit.ClearAll") }, content: `<p>${t("Edit.ClearAllAsk")}</p>`, rejectClose: false }).catch(() => false);
        if (ok) await this.actor.deleteEmbeddedDocuments("Item", shelf(this.actor).map(i => i.id));
        return this.render();
      }
      case "f-cat": this.ui.f.cat = el.dataset.cat; this.ui.f.sub = ""; this.ui.limit = 150; return this.render();
      case "more": this.ui.limit += 150; return this.render();
      case "add-one": {
        const o = this.ui.opts;
        const n = await addStock(this.actor, [el.dataset.uuid], { qty: o.qty, max: o.qty, perDay: o.perDay, infinite: o.infinite });
        ui.notifications.info(t("Edit.Added", { n }));
        return this.render();
      }
      case "add-picked": {
        const o = this.ui.opts;
        const n = await addStock(this.actor, [...this.ui.picked], { qty: o.qty, max: o.qty, perDay: o.perDay, infinite: o.infinite });
        this.ui.picked.clear();
        ui.notifications.info(t("Edit.Added", { n }));
        return this.render();
      }
      case "add-random": {
        const o = this.ui.opts;
        const f = this.ui.f;
        const n = await autofill(this.actor, { ...f, sub: f.sub || null }, { count: o.count, qty: o.qty, perDay: o.perDay, infinite: o.infinite, random: true });
        ui.notifications.info(t("Edit.Added", { n }));
        return this.render();
      }
      case "template": {
        const tp = el.dataset.draft ? this.ui.tplDraft : templates()[el.dataset.tpl];
        const n = await fillFromTemplate(this.actor, tp, Number(this.ui.partyLevel) || 1, { wealth: this.cfg.wealth, party: this.ui.party });
        const extra = tp?.config;
        if (extra) { foundry.utils.mergeObject(this.cfg, extra); await saveConfig(this.actor, this.cfg); }
        ui.notifications.info(t("Edit.Added", { n }));
        return this.render();
      }
      case "wealth-apply": {
        Object.assign(this.cfg, wealthConfig(this.cfg.wealth, Number(this.ui.partyLevel) || 1));
        await saveConfig(this.actor, this.cfg);
        return this.render();
      }
      case "every": this.cfg.restock.every = Number(el.dataset.n) || 1; await saveConfig(this.actor, this.cfg); return this.render();
      case "c-sheet": return (await fromUuid(el.dataset.uuid).catch(() => null))?.sheet?.render(true);
      case "c-add": {
        const e = this._cHits?.find(x => x.uuid === el.dataset.uuid);
        if (e) await addCreatures(this.actor, [e], { qty: 1, perDay: 1 });
        return this.render();
      }
      case "c-del": this.cfg.creatures.splice(Number(el.dataset.ci), 1); await saveConfig(this.actor, this.cfg); return this.render();
      case "c-standard": {
        const { stockAnimals } = await import("../shop.mjs");
        const n = await stockAnimals(this.actor, Number(this.ui.cLevel) || 2);
        ui.notifications.info(t("Edit.Added", { n }));
        return this.render();
      }
      case "tpl-pick": this.ui.tpl = el.dataset.tpl; this.ui.tplDraft = null; return this.render();
      case "tpl-new": {
        const key = `own-${randomId().slice(0, 8)}`;
        this.ui.tpl = key;
        this.ui.tplDraft = { key, name: t("Tpl.NewName"), img: "icons/environment/settlement/market-stall.webp", config: { buys: [] }, steps: [newStep("gear")], builtin: false };
        return this.render();
      }
      case "st-add": (this.ui.tplDraft.steps ??= []).push(newStep(this.ui.tplDraft.steps.at(-1)?.cat ?? "gear")); return this.render();
      case "st-del": this.ui.tplDraft.steps.splice(Number(el.dataset.i), 1); return this.render();
      case "tpl-save": await saveTemplate(this.ui.tpl, this.ui.tplDraft); ui.notifications.info(t("Tpl.Saved")); this.ui.tplDraft = null; return this.render();
      case "tpl-saveas": {
        const key = `own-${randomId().slice(0, 8)}`;
        const name = `${templateName(this.ui.tplDraft)} (${t("Tpl.Copy")})`;
        await saveTemplate(key, { ...this.ui.tplDraft, name });
        this.ui.tpl = key; this.ui.tplDraft = null;
        return this.render();
      }
      case "tpl-reset": case "tpl-del": {
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t(a === "tpl-reset" ? "Tpl.Reset" : "Tpl.Delete") }, content: `<p>${t(a === "tpl-reset" ? "Tpl.ResetAsk" : "Tpl.DeleteAsk", { name: esc(templateName(this.ui.tplDraft)) })}</p>`, rejectClose: false }).catch(() => false);
        if (!ok) return;
        await saveTemplate(this.ui.tpl, null);
        if (a === "tpl-del") this.ui.tpl = null;
        this.ui.tplDraft = null;
        return this.render();
      }
      case "spell-open": this.ui.spellOpen = !this.ui.spellOpen; return this.render();
      case "add-spell": await this.addSpellItem(el.dataset.uuid); return this.render();
      case "portrait": return this.pickPortrait();
      case "portrait-clear": this.cfg.merchant.img = ""; await saveConfig(this.actor, this.cfg); return this.render();
      case "ev-add": this.cfg.events.push(newEvent(t("Ev.New"))); await saveConfig(this.actor, this.cfg); return this.render();
      case "ev-del": this.cfg.events.splice(Number(el.dataset.i), 1); await saveConfig(this.actor, this.cfg); return this.render();
      case "ev-preset": {
        const p = { sale: { buy: 0.8, sell: 1, cats: [] }, festival: { buy: 0.9, sell: 1.1, cats: [] }, runeWeek: { buy: 0.85, sell: 1, cats: ["rune"] }, shortage: { buy: 1.5, sell: 1.2, cats: ["potion"] } }[el.dataset.k];
        this.cfg.events.push({ ...newEvent(t(`Ev.Preset.${el.dataset.k}`)), ...p });
        await saveConfig(this.actor, this.cfg);
        return this.render();
      }
      case "ledger-clear": this.cfg.ledger = []; await saveConfig(this.actor, this.cfg); return this.render();
    }
  }

  async onChange(ev) {
    const el = ev.target;
    // stock rows
    const row = el.closest("tr[data-id]");
    if (row && el.dataset.s) {
      const item = this.actor.items.get(row.dataset.id);
      if (!item) return;
      const s = el.dataset.s;
      if (s === "qty") await item.update({ "system.quantity": Math.max(0, Number(el.value) || 0) });
      else if (s === "infinite" || s === "featured") await item.update({ [`flags.${MID}.stock.${s}`]: el.checked });
      else if (s === "priceMul") await item.update({ [`flags.${MID}.stock.priceMul`]: Math.max(0, Number(el.value) || 0) / 100 });
      else if (s === "chance") await item.update({ [`flags.${MID}.stock.chance`]: el.value === "" ? null : Math.max(0, Math.min(100, Number(el.value) || 0)) });
      else await item.update({ [`flags.${MID}.stock.${s}`]: Number(el.value) || 0 });
      if (s === "infinite" || s === "priceMul") this.render();
      return;
    }
    // creatures for sale
    const crow = el.closest("tr[data-ci]");
    if (crow && el.dataset.c) {
      const c = this.cfg.creatures?.[Number(crow.dataset.ci)];
      if (!c) return;
      const k = el.dataset.c;
      if (k === "infinite") c.infinite = el.checked;
      else if (k === "priceGp") c.priceCp = Math.max(0, Math.round((Number(el.value) || 0) * 100));
      else if (k === "chance") c.chance = el.value === "" ? null : Math.max(0, Math.min(100, Number(el.value) || 0));
      else c[k] = Number(el.value) || 0;
      await saveConfig(this.actor, this.cfg);
      if (k === "infinite" || k === "priceGp") this.render();
      return;
    }
    // template being edited (kept in the draft until saved)
    const d = this.ui.tplDraft;
    if (d && (el.dataset.st || el.dataset.stR)) {
      const st = d.steps[Number(el.dataset.i)];
      if (!st) return;
      if (el.dataset.stR) {
        const set = new Set(st.rarity ?? ["common"]);
        if (el.checked) set.add(el.dataset.stR); else set.delete(el.dataset.stR);
        st.rarity = RARITY.filter(r => set.has(r));
      } else {
        const k = el.dataset.st;
        if (k === "cat") { st.cat = el.value; st.sub = ""; }
        else if (k === "sub") st.sub = el.value;
        else if (k === "magical") st.magical = el.value === "" ? null : el.value === "1";
        else if (k === "infinite") st.infinite = el.checked;
        else st[k] = el.value === "" ? (["lvMin", "lvMax", "lvCap"].includes(k) ? null : 0) : Number(el.value);
      }
      return this.render();
    }
    if (d && (el.dataset.t || el.dataset.tSvc || el.dataset.tBuys)) {
      d.config ??= {};
      if (el.dataset.t === "creatures") d.creatures = el.checked;
      else if (el.dataset.t) d[el.dataset.t] = el.value;
      else if (el.dataset.tSvc) { d.config.services ??= {}; d.config.services[el.dataset.tSvc] = { ...(d.config.services[el.dataset.tSvc] ?? {}), on: el.checked }; }
      else {
        const all = [...this.element.querySelectorAll("[data-t-buys]")];
        const on = all.filter(b => b.checked).map(b => b.dataset.tBuys);
        d.config.buys = on.length === all.length ? [] : on;
      }
      return;
    }
    // filters
    if (el.dataset.f) {
      const f = this.ui.f;
      const k = el.dataset.f;
      if (k === "legacy") f.legacy = el.checked;
      else if (k === "magical") f.magical = el.value === "" ? null : el.value === "1";
      else if (k === "levelMin" || k === "levelMax") f[k] = Number(el.value) || 0;
      else f[k] = el.value;
      this.ui.limit = 150;
      return this.render();
    }
    if (el.dataset.fRarity) { if (el.checked) this.ui.f.rarity.add(el.dataset.fRarity); else this.ui.f.rarity.delete(el.dataset.fRarity); return this.render(); }
    if (el.dataset.pick) { if (el.checked) this.ui.picked.add(el.dataset.pick); else this.ui.picked.delete(el.dataset.pick); return this.updateAddButton(); }
    if (el.dataset.a === "pick-all") {
      for (const box of this.element.querySelectorAll("[data-pick]")) { box.checked = el.checked; if (el.checked) this.ui.picked.add(box.dataset.pick); else this.ui.picked.delete(box.dataset.pick); }
      return this.updateAddButton();
    }
    if (el.dataset.o) { this.ui.opts[el.dataset.o] = el.type === "checkbox" ? el.checked : Number(el.value) || 0; return; }
    if (el.dataset.u) {
      this.ui[el.dataset.u] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) || 0 : el.value;
      if (el.dataset.u.startsWith("spell") || el.dataset.u.startsWith("c") || this.ui.tab === "templates") this.render();
      return;
    }
    // settings
    if (el.dataset.a === "open") { await setOpen(this.actor, el.checked); this.cfg = configOf(this.actor); return this.render(); }
    if (el.dataset.k) {
      let v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) || 0 : el.value;
      if (el.dataset.pct) v = (Number(el.value) || 0) / 100;
      if (el.dataset.gp) v = Math.max(0, Math.round((Number(el.value) || 0) * 100));
      if (el.type === "radio" && !el.checked) return;
      foundry.utils.setProperty(this.cfg, el.dataset.k, v);
      await saveConfig(this.actor, this.cfg);
      if (el.dataset.k === "title" && v) await this.actor.update({ name: v });
      if (el.type === "checkbox" || el.type === "radio" || el.dataset.k === "theme" || el.dataset.k === "wealth") this.render();
      return;
    }
    if (el.dataset.mat) {
      const all = [...this.element.querySelectorAll("[data-mat]")];
      const on = all.filter(b => b.checked).map(b => b.dataset.mat);
      this.cfg.services.material.allowed = on.length === all.length ? [] : on;
      return saveConfig(this.actor, this.cfg);
    }
    if (el.dataset.buys) {
      const all = [...this.element.querySelectorAll("[data-buys]")];
      const on = all.filter(b => b.checked).map(b => b.dataset.buys);
      this.cfg.buys = on.length === all.length ? [] : on;
      return saveConfig(this.actor, this.cfg);
    }
    // events
    const evRow = el.closest(".rps-event");
    if (evRow) {
      const e = this.cfg.events[Number(evRow.dataset.i)];
      if (!e) return;
      if (el.dataset.ev === "active") e.active = el.checked;
      else if (el.dataset.ev === "name") e.name = el.value;
      else if (el.dataset.ev) e[el.dataset.ev] = (Number(el.value) || 0) / 100;
      else if (el.dataset.evCat) e.cats = [...evRow.querySelectorAll("[data-ev-cat]:checked")].map(b => b.dataset.evCat);
      await saveConfig(this.actor, this.cfg);
      if (el.dataset.ev === "active") this.render();
    }
  }

  onInput(ev) {
    const el = ev.target;
    if (el.dataset.f === "text" || el.dataset.u === "spellText" || el.dataset.u === "cText") {
      if (el.dataset.f) this.ui.f.text = el.value; else this.ui[el.dataset.u] = el.value;
      this.typeSoon ??= debounce(async () => {
        await this.render();
        const box = this.element.querySelector(el.dataset.f ? '[data-f="text"]' : `[data-u="${el.dataset.u}"]`);
        box?.focus();
        box?.setSelectionRange(box.value.length, box.value.length);
      }, 250);
      this.typeSoon();
    }
  }

  updateAddButton() {
    const b = this.element.querySelector('[data-a="add-picked"]');
    if (!b) return;
    b.disabled = !this.ui.picked.size;
    b.innerHTML = `<i class="fa-solid fa-plus"></i> ${t("Edit.AddPicked", { n: this.ui.picked.size })}`;
  }

  async onDrop(ev) {
    ev.preventDefault();
    const Editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    const data = Editor.getDragEventData(ev);
    if (!data?.uuid) return;
    const doc = await fromUuid(data.uuid);
    if (!doc) return;
    if (doc.documentName === "RollTable") return this.fromTable(doc);
    if (doc.documentName === "Item") {
      const o = this.ui.opts;
      const n = await addStock(this.actor, [doc.pack ? doc.uuid : doc], { qty: o.qty, max: o.qty, perDay: o.perDay, infinite: o.infinite });
      ui.notifications.info(t("Edit.Added", { n }));
      this.render();
    }
  }

  /** A roll table dropped in: roll it N times and put what comes up on the shelf. */
  async fromTable(table) {
    const n = await foundry.applications.api.DialogV2.prompt({
      window: { title: t("Edit.TableTitle", { name: table.name }) },
      content: `<label>${t("Edit.TableCount")} <input type="number" name="n" value="10" min="1" max="100"></label>`,
      ok: { label: t("Edit.TableRoll"), callback: (_e, b) => Number(b.form.elements.n.value) || 0 }, rejectClose: false
    }).catch(() => 0);
    if (!n) return;
    const uuids = [];
    for (let i = 0; i < n; i++) {
      const { results } = await table.draw({ displayChat: false, recursive: true }).catch(() => ({ results: [] }));
      for (const r of results ?? []) {
        const u = r.documentUuid ?? (r.documentCollection && r.documentId ? (r.documentCollection.includes(".") ? `Compendium.${r.documentCollection}.Item.${r.documentId}` : `Item.${r.documentId}`) : null);
        if (u) uuids.push(u);
      }
    }
    await table.resetResults?.().catch(() => {});
    const o = this.ui.opts;
    const added = await addStock(this.actor, uuids, { qty: o.qty, max: o.qty, perDay: o.perDay, infinite: o.infinite });
    ui.notifications.info(t("Edit.Added", { n: added }));
    this.render();
  }

  pickPortrait() {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    new FP({
      type: "image", current: this.cfg.merchant?.img ?? "",
      callback: async path => { this.cfg.merchant.img = path; this.cfg.merchant.show = true; await saveConfig(this.actor, this.cfg); this.render(); }
    }).render(true);
  }

  export() {
    const json = JSON.stringify(exportShop(this.actor), null, 2);
    foundry.utils.saveDataToFile(json, "application/json", `shop-${this.actor.name.replace(/[^\p{L}\p{N}_-]+/gu, "_")}.json`);
  }

  async close(options) {
    this.saveSoon.flush?.();
    return super.close(options);
  }
}

export function openEditor(actor) {
  const id = `rps-editor-${actor.id}`;
  const open = foundry.applications.instances.get(id);
  if (open) { open.cfg = configOf(actor); open.render(true); open.bringToFront?.(); return open; }
  const app = new ShopEditor(actor);
  app.render(true);
  return app;
}

function materialTypes() {
  return [...new Set([...Object.keys(MATERIALS.weapon), ...Object.keys(MATERIALS.armor)])].sort();
}
function materialName(type) {
  const key = CONFIG.PF2E?.preciousMaterials?.[type];
  return key ? game.i18n.localize(key) : type;
}
