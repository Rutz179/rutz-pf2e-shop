import { MID, esc, t } from "./util.mjs";
import { forgetCatalog } from "./catalog.mjs";
import { ARMS_ICON, BROKEN_ICONS, configOf, createShop, exportShop, importShop, isShop, restock, restockByTime, shopList } from "./shop.mjs";
import { initSocket, request } from "./trade.mjs";
import { syncBrokenArmor } from "./durability.mjs";
import { ShopSheet, openShop, refreshShops, setOpen } from "./ui/shop-sheet.mjs";
import { installDurabilityWatch } from "./durability-watch.mjs";
import { installInventoryLog } from "./inventory-log.mjs";
import { openEditor } from "./ui/editor.mjs";
import { openManager, shopToChat } from "./ui/manager.mjs";
import { openDurability } from "./ui/durability-app.mjs";

/* ======================================================================== *
 * Rutz's PF2e Shop — entry point.
 *
 * Shops are PF2e loot actors shown with the shop window (their sheet).
 * Opens from: the Actors sidebar ("상점"), a shop actor or token, a chat
 * invitation card, or game.rutzShop.open(name | actor).
 * ======================================================================== */

export const forgeActive = () => !!game.modules.get("rutz-pf2e-forge")?.active;

function registerSettings() {
  const s = (key, data) => game.settings.register(MID, key, { config: true, scope: "world", ...data });
  s("logMode", {
    name: t("Settings.Log"), hint: t("Settings.LogHint"), type: String, default: "public",
    choices: { public: t("Settings.LogPublic"), involved: t("Settings.LogInvolved"), gm: t("Settings.LogGM") }
  });
  s("invLog", {
    name: t("Settings.InvLog"), hint: t("Settings.InvLogHint"), type: String, default: "gm",
    choices: { gm: t("Settings.LogGM"), public: t("Settings.LogPublic"), off: t("Settings.InvLogOff") }
  });
  s("invLogGM", { name: t("Settings.InvLogGM"), hint: t("Settings.InvLogGMHint"), type: Boolean, default: false });
  s("treasureFull", { name: t("Settings.Treasure"), hint: t("Settings.TreasureHint"), type: Boolean, default: true });
  s("brokenArmor", { name: t("Settings.BrokenArmor"), hint: t("Settings.BrokenArmorHint"), type: Boolean, default: true });
  s("packs", { name: t("Settings.Packs"), hint: t("Settings.PacksHint"), type: String, default: "", onChange: () => forgetCatalog() });
  s("creatureMinion", { name: t("Settings.Minion"), hint: t("Settings.MinionHint"), type: Boolean, default: true });
  s("renameRunes", { name: t("Settings.RenameRunes"), hint: t("Settings.RenameRunesHint"), type: Boolean, default: true });
  s("durabilityMarks", { name: t("Settings.DurMarks"), hint: t("Settings.DurMarksHint"), type: Boolean, default: true });
  s("durabilityNotice", { name: t("Settings.DurNotice"), hint: t("Settings.DurNoticeHint"), type: Boolean, default: true });
  game.settings.register(MID, "templates", { scope: "world", config: false, type: String, default: "{}" });
}

function registerSheet() {
  const Config = foundry.applications?.apps?.DocumentSheetConfig ?? globalThis.DocumentSheetConfig;
  const opts = { types: ["loot"], makeDefault: false, label: t("Sheet.Label") };
  if (Config?.registerSheet) Config.registerSheet(Actor, MID, ShopSheet, opts);
  else foundry.documents.collections.Actors.registerSheet(MID, ShopSheet, opts);
}

/* ---------------- where it opens from ---------------- */

function directoryButton(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const header = root?.querySelector(".header-actions, .directory-header .action-buttons");
  if (!header || header.querySelector(".rps-dir")) return;
  if (!game.user.isGM && !shopList().some(s => configOf(s).open)) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rps-dir";
  btn.innerHTML = `<i class="fa-solid fa-shop"></i> ${esc(t("Dir.Shops"))}`;
  btn.addEventListener("click", ev => { ev.preventDefault(); openManager(); });
  header.appendChild(btn);
}

function wireChat(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  for (const btn of root?.querySelectorAll?.("[data-rps-open]") ?? []) {
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      const shop = game.actors.get(btn.dataset.rpsOpen);
      if (!shop) return ui.notifications.warn(t("Trade.Err.NoShop"));
      if (!configOf(shop).open && !game.user.isGM) return ui.notifications.warn(t("Trade.Err.Closed"));
      openShop(shop);
    });
  }
}

function open(target) {
  const shop = typeof target === "string" ? (game.actors.get(target) ?? shopList().find(s => s.name === target || configOf(s).title === target)) : target;
  if (!shop || !isShop(shop)) return openManager();
  return openShop(shop);
}

/* ---------------- hooks ---------------- */

Hooks.once("init", () => {
  registerSettings();
  registerSheet();
});

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e" && game.system.id !== "sf2e") return;
  initSocket();
  installInventoryLog();
  Hooks.on("renderActorDirectory", directoryButton);
  Hooks.on("renderChatMessageHTML", wireChat);
  Hooks.on("updateWorldTime", () => restockByTime());
  const touched = (doc, options, userId) => {
    const actor = doc.parent ?? doc;
    refreshShops(actor);
    // The broken-armor penalty follows the armor (done once, by whoever changed it).
    if (userId === game.user.id && actor?.type && doc.type === "armor" && !forgeActive()) syncBrokenArmor(actor);
  };
  Hooks.on("updateItem", touched);
  Hooks.on("createItem", touched);
  Hooks.on("deleteItem", touched);
  Hooks.on("updateActor", (actor, changes) => refreshShops(actor, changes ?? {}));
  // Rutz's PF2e Forge does durability (marks, notices, broken armor) when it is on.
  if (!forgeActive()) installDurabilityWatch();
  ui.actors?.render?.();
  game.rutzShop = {
    open, manager: openManager, edit: openEditor, durability: (...a) => (forgeActive() && game.rutzForge?.durability ? game.rutzForge.durability(...a) : openDurability(...a)),
    create: createShop, restock, restockAll: async (days = 1) => { for (const s of shopList()) await restock(s, days); },
    exportShop, importShop, setOpen, invite: shopToChat, trade: request, shops: shopList
  };
  if (game.user.isGM) {
    restockByTime();
    // Shops made with the old weapon-shop icon (a file Foundry doesn't have).
    for (const a of shopList()) if (BROKEN_ICONS.includes(a.img)) a.update({ img: ARMS_ICON }).catch(() => {});
  }
  console.log(`${MID} | ready`);
});
