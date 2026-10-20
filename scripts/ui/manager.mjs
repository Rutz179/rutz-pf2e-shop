import { esc, t } from "../util.mjs";
import { WEALTH, configOf, createShop, exportShop, fillFromTemplate, importShop, partySize, restock, shopList, templateName, templates, wealthConfig } from "../shop.mjs";
import { openShop } from "./shop-sheet.mjs";
import { setOpen } from "./shop-sheet.mjs";
import { openEditor } from "./editor.mjs";
import { openDurability } from "./durability-app.mjs";

/* ======================================================================== *
 * 상점 목록 — the GM's front desk: every shop at a glance (open/closed,
 * goods, events on), new shops from templates, import / export (one file
 * per shop, or all at once), "a day passes" for all, and the durability
 * tool. Players see the open shops and walk in.
 * ======================================================================== */

export class ShopManager extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "rps-manager",
    classes: ["rps-manager"],
    window: { title: "RPS.Manager.Title", icon: "fa-solid fa-shop", resizable: true },
    position: { width: 640, height: 600 }
  };

  async _renderHTML() {
    const gm = game.user.isGM;
    const shops = shopList().filter(s => gm || (configOf(s).open && s.testUserPermission(game.user, "LIMITED")));
    const rows = shops.map(s => {
      const c = configOf(s);
      const goods = s.items.filter(i => i.type !== "effect").length;
      const events = (c.events ?? []).filter(e => e.active).map(e => e.name).join(", ");
      return `<div class="rps-mrow ${c.open ? "" : "closed"}"><img src="${esc(c.merchant?.img || s.img)}" alt="">
        <div class="nm"><b>${esc(c.title || s.name)}</b><small>${esc(c.merchant?.name ?? "")} · ${t("Manager.Goods", { n: goods })}${events ? ` · <i class="fa-solid fa-bullhorn"></i> ${esc(events)}` : ""}</small></div>
        <button type="button" data-a="enter" data-id="${s.id}"><i class="fa-solid fa-door-open"></i> ${t("Manager.Enter")}</button>
        ${gm ? `<button type="button" data-a="toggle" data-id="${s.id}" data-tooltip="${esc(t(c.open ? "Manager.Close" : "Manager.Open"))}"><i class="fa-solid ${c.open ? "fa-lock-open" : "fa-lock"}"></i></button>
          <button type="button" data-a="edit" data-id="${s.id}" data-tooltip="${esc(t("Shop.Edit"))}"><i class="fa-solid fa-gear"></i></button>
          <button type="button" data-a="export" data-id="${s.id}" data-tooltip="${esc(t("Edit.Export"))}"><i class="fa-solid fa-file-export"></i></button>
          <button type="button" data-a="chat" data-id="${s.id}" data-tooltip="${esc(t("Manager.ChatHint"))}"><i class="fa-solid fa-bullhorn"></i></button>` : ""}</div>`;
    }).join("");
    return `<div class="rps-man">
      ${gm ? `<div class="row">
        <button type="button" class="primary" data-a="new"><i class="fa-solid fa-plus"></i> ${t("Manager.New")}</button>
        <button type="button" data-a="import"><i class="fa-solid fa-file-import"></i> ${t("Manager.Import")}</button>
        <button type="button" data-a="export-all"><i class="fa-solid fa-file-export"></i> ${t("Manager.ExportAll")}</button>
        <span class="sep"></span>
        <button type="button" data-a="day" data-tooltip="${esc(t("Manager.DayHint"))}"><i class="fa-solid fa-sun"></i> ${t("Manager.Day")}</button>
        <button type="button" data-a="time" data-tooltip="${esc(t("Manager.TimeHint"))}"><i class="fa-solid fa-clock"></i> ${t("Manager.Time")}</button>
        <button type="button" data-a="durability"><i class="fa-solid fa-shield-heart"></i> ${t("Dur.Title")}</button></div>` : ""}
      <div class="list">${rows || `<p class="rps-empty">${t(gm ? "Manager.None" : "Manager.NoneOpen")}</p>`}</div>
      <input type="file" accept=".json,application/json" class="rps-file" hidden></div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    content.querySelector(".rps-file")?.addEventListener("change", ev => this.readFile(ev.target.files?.[0]));
    if (this._wired === content) return;
    this._wired = content;
    content.addEventListener("click", ev => this.onClick(ev));
  }

  async onClick(ev) {
    const el = ev.target.closest("[data-a]");
    if (!el) return;
    ev.preventDefault();
    const shop = game.actors.get(el.dataset.id);
    switch (el.dataset.a) {
      case "enter": return openShop(shop);
      case "edit": return shop && openEditor(shop);
      case "toggle": await setOpen(shop, !configOf(shop).open); return this.render();
      case "export": return save(exportShop(shop), shop.name);
      case "export-all": return save({ format: "rutz-pf2e-shop-list", shops: shopList().map(exportShop) }, "all-shops");
      case "import": return this.element.querySelector(".rps-file")?.click();
      case "chat": return shopToChat(shop);
      case "new": return this.newShop();
      case "durability": return game.rutzShop?.durability ? game.rutzShop.durability() : openDurability();
      case "day": {
        let n = 0;
        for (const s of shopList()) n += await restock(s, 1);
        ui.notifications.info(t("Manager.DayDone", { n }));
        return this.render();
      }
      case "time": await game.time.advance(86400); return this.render();
    }
  }

  async newShop() {
    const tpl = Object.values(templates());
    const res = await foundry.applications.api.DialogV2.prompt({
      window: { title: t("Manager.New") },
      content: `<div class="rps-newshop"><label>${t("Manager.Name")} <input type="text" name="name" value="${esc(t("Shop.DefaultName"))}"></label>
        <label>${t("Manager.Template")} <select name="tpl"><option value="">${t("Tpl.none")}</option>${tpl.map(tp => `<option value="${tp.key}">${esc(templateName(tp))}</option>`).join("")}</select></label>
        <label>${t("Edit.PartyLevel")} <input type="number" name="lv" value="3" min="1" max="20"></label>
        <label>${t("Set.Wealth")} <select name="wealth">${Object.keys(WEALTH).map(w => `<option value="${w}" ${w === "modest" ? "selected" : ""}>${t(`Wealth.${w}`)}</option>`).join("")}</select></label>
        <label>${t("Manager.Party")} <input type="number" name="party" value="${partySize()}" min="1" max="12"></label>
        <p class="hint">${t("Manager.NewHint")}</p></div>`,
      ok: { label: t("Manager.Create"), callback: (_e, b) => ({ name: b.form.elements.name.value, tpl: b.form.elements.tpl.value, lv: Number(b.form.elements.lv.value) || 1,
        wealth: b.form.elements.wealth?.value || "modest", party: Number(b.form.elements.party?.value) || partySize() }) },
      rejectClose: false
    }).catch(() => null);
    if (!res) return;
    const actor = await createShop({ name: res.name, template: res.tpl || null, config: wealthConfig(res.wealth, res.lv) });
    if (res.tpl) await fillFromTemplate(actor, res.tpl, res.lv, { wealth: res.wealth, party: res.party });
    this.render();
    openEditor(actor);
  }

  async readFile(file) {
    if (!file) return;
    try {
      const made = await importShop(JSON.parse(await file.text()));
      ui.notifications.info(t("Manager.Imported", { n: made.length }));
    } catch (err) {
      ui.notifications.error(`${t("Manager.ImportFailed")} ${err.message}`);
    }
    this.render();
  }
}

function save(data, name) {
  foundry.utils.saveDataToFile(JSON.stringify(data, null, 2), "application/json", `shop-${String(name).replace(/[^\p{L}\p{N}_-]+/gu, "_")}.json`);
}

/** A card in chat with a button that opens the shop (for everyone who may see it). */
export async function shopToChat(shop) {
  const c = configOf(shop);
  const content = `<div class="rps-invite"><img src="${esc(c.merchant?.img || shop.img)}" alt=""><div><b>${esc(c.title || shop.name)}</b>
    <p>${esc(c.greeting || t("Talk.Hello"))}</p><button type="button" data-rps-open="${shop.id}"><i class="fa-solid fa-door-open"></i> ${t("Manager.Enter")}</button></div></div>`;
  await ChatMessage.create({ speaker: { alias: c.merchant?.name || shop.name }, content });
}

export function openManager() {
  const open = foundry.applications.instances.get("rps-manager");
  if (open) { open.render(true); return open; }
  const app = new ShopManager();
  app.render(true);
  return app;
}
