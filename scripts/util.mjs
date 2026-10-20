/* Small helpers shared by the shop. */

export const MID = "rutz-pf2e-shop";
export const SOCKET = `module.${MID}`;

export function t(key, data) {
  const k = `RPS.${key}`;
  return data ? game.i18n.format(k, data) : game.i18n.localize(k);
}

export function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

export function setting(key, fallback = null) {
  try {
    const v = game.settings.get(MID, key);
    return v === undefined ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

export function randomId() {
  return foundry.utils.randomID();
}

export function sluggify(text) {
  return game.pf2e?.system?.sluggify?.(String(text ?? "")) ?? String(text ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function sourceIdOf(item) {
  return item?._stats?.compendiumSource ?? item?.flags?.core?.sourceId ?? item?.sourceId ?? null;
}

/** The English name of a translated document (PF2e-KR keeps it), else its own name. */
export function englishName(doc) {
  const kr = doc?.flags?.["PF2e-KR"]?.originalName ?? doc?.flags?.babele?.originalName;
  if (kr) return kr;
  const m = /\(([^()]*[A-Za-z][^()]*(?:\([^()]*\))?)\)\s*$/.exec(String(doc?.name ?? ""));
  return m ? m[1] : String(doc?.name ?? "");
}

export function slugOf(doc) {
  return doc?.system?.slug || sluggify(englishName(doc));
}

export function enrich(html, options = {}) {
  const Editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  return Editor.enrichHTML(html ?? "", options).catch(() => html ?? "");
}

/* ---------------- money (all in copper) ---------------- */

const RATE = { pp: 1000, gp: 100, sp: 10, cp: 1 };

export function coinsToCp(coins) {
  let n = 0;
  for (const [d, r] of Object.entries(RATE)) n += (Number(coins?.[d]) || 0) * r;
  return n;
}

/** Price of one unit of an item (or index entry), in copper. */
export function unitCp(item) {
  const p = item?.system?.price ?? {};
  const per = Math.max(1, Number(p.per) || 1);
  return coinsToCp(p.value ?? {}) / per;
}

/** 1234 → { gp: 12, sp: 3, cp: 4 } (no platinum: easier to read and to pay). */
export function cpToCoins(cp) {
  const n = Math.max(0, Math.round(cp));
  return { gp: Math.floor(n / 100), sp: Math.floor((n % 100) / 10), cp: n % 10 };
}

export function formatCp(cp, { html = false } = {}) {
  const n = Math.max(0, Math.round(cp));
  if (!n) return html ? `<span class="coin cp">0</span>` : `0 ${t("Coin.cp")}`;
  const c = cpToCoins(n);
  const parts = [];
  for (const d of ["gp", "sp", "cp"]) {
    if (!c[d]) continue;
    parts.push(html ? `<span class="coin ${d}">${c[d].toLocaleString()}<i>${t(`Coin.${d}`)}</i></span>` : `${c[d].toLocaleString()} ${t(`Coin.${d}`)}`);
  }
  return parts.join(html ? "" : " ");
}

/** What an actor has in coins, in copper. */
export function walletCp(actor) {
  const coins = actor?.inventory?.coins;
  if (coins && typeof coins.copperValue === "number") return coins.copperValue;
  return coinsToCp(coins ?? {});
}

export function physicalTypes() {
  return new Set(["weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack", "ammo", "kit", "book"]);
}

export function isPhysical(item) {
  return physicalTypes().has(item?.type);
}

export function debounce(fn, ms = 150) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
