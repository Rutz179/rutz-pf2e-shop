import { esc, formatCp, t } from "../util.mjs";
import { CATEGORY_ICON, catLabel, classify, subLabel } from "../catalog.mjs";

/* Pieces of markup the shop window, the editor and the manager share. */

export const RARITY = ["common", "uncommon", "rare", "unique"];

export function rarityLabel(r) {
  const key = CONFIG.PF2E?.rarityTraits?.[r];
  return key ? game.i18n.localize(key) : r;
}

export function traitLabel(tr) {
  const key = CONFIG.PF2E?.equipmentTraits?.[tr] ?? CONFIG.PF2E?.weaponTraits?.[tr] ?? CONFIG.PF2E?.armorTraits?.[tr]
    ?? CONFIG.PF2E?.consumableTraits?.[tr] ?? CONFIG.PF2E?.magicTraditions?.[tr] ?? CONFIG.PF2E?.featTraits?.[tr];
  return key ? game.i18n.localize(key) : tr;
}

export function money(cp, cls = "") {
  return `<span class="rps-price ${cls}">${formatCp(cp, { html: true })}</span>`;
}

/** Category chips: [{ cat, n }] → buttons. */
export function catChips(counts, current, action = "cat") {
  const all = counts.reduce((n, c) => n + c.n, 0);
  return `<div class="rps-cats">${[{ cat: "all", n: all }, ...counts].map(c => `
    <button type="button" class="rps-cat ${current === c.cat ? "on" : ""}" data-a="${action}" data-cat="${c.cat}">
      <i class="fa-solid ${CATEGORY_ICON[c.cat] ?? "fa-box"}"></i><span>${esc(c.cat === "all" ? t("Cat.all") : catLabel(c.cat))}</span><small>${c.n}</small></button>`).join("")}</div>`;
}

export function countCats(items) {
  const m = new Map();
  for (const it of items) {
    const { cat } = classify(it);
    m.set(cat, (m.get(cat) ?? 0) + 1);
  }
  const order = ["weapon", "ammo", "armor", "rune", "material", "scroll", "potion", "consumable", "magic", "gear", "companion", "treasure"];
  return order.filter(c => m.has(c)).map(cat => ({ cat, n: m.get(cat) }));
}

export function subSelect(items, cat, current, action = "sub") {
  if (!cat || cat === "all") return "";
  const m = new Map();
  for (const it of items) {
    const c = classify(it);
    if (c.cat === cat) m.set(c.sub, (m.get(c.sub) ?? 0) + 1);
  }
  if (m.size < 2) return "";
  const opts = [...m].sort((a, b) => subLabel(cat, a[0]).localeCompare(subLabel(cat, b[0]), game.i18n.lang));
  return `<select class="rps-sub" data-a="${action}"><option value="">${t("Cat.allSub")}</option>${opts.map(([s, n]) => `<option value="${esc(s)}" ${current === s ? "selected" : ""}>${esc(subLabel(cat, s))} (${n})</option>`).join("")}</select>`;
}

export function traitsHtml(item) {
  const s = item.system ?? {};
  const r = s.traits?.rarity ?? "common";
  return `${r !== "common" ? `<span class="rps-trait rar ${r}">${esc(rarityLabel(r))}</span>` : ""}${(s.traits?.value ?? []).map(tr => `<span class="rps-trait">${esc(traitLabel(tr))}</span>`).join("")}`;
}

export function levelBadge(item) {
  const lv = Number(item.system?.level?.value ?? 0);
  return `<span class="rps-lv" data-tooltip="${esc(t("Shop.Level"))}">${lv}</span>`;
}

/** Bring an image into a frame; empty → a quiet placeholder. */
export function portrait(img, name) {
  return img ? `<img src="${esc(img)}" alt="${esc(name ?? "")}">` : `<i class="fa-solid fa-user-tie"></i>`;
}
