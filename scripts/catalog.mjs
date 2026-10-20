import { MID, englishName, setting, slugOf, unitCp } from "./util.mjs";
import { PROPERTY_RUNES } from "./rune-keys.mjs";

/* ======================================================================== *
 * What things are, and where to find them.
 *
 *  classify(item)  — shop category (무기 · 방어구 · 룬 · 두루마리 …) and a
 *                    sub-category (weapon group, rune kind …), worked out from
 *                    PF2e's own data, so it works in any language.
 *  Runes: PF2e marks every rune by where it is etched ("etched-onto-a-weapon",
 *  "…-armor", "…-a-shield" …). Fundamental runes (potency, striking,
 *  resilient, reinforcing) and property runes are told apart by slug.
 *  loadCatalog()   — every physical item of the item packs the compendium
 *                    browser uses (a translation's mirror instead of the
 *                    English system pack), read once, for search and auto-fill.
 * ======================================================================== */

export const CATEGORIES = ["weapon", "ammo", "armor", "rune", "material", "scroll", "potion", "consumable", "magic", "gear", "companion", "treasure"];
export const CATEGORY_ICON = {
  all: "fa-border-all", weapon: "fa-khanda", ammo: "fa-bullseye", armor: "fa-shield-halved", rune: "fa-hexagon-nodes", scroll: "fa-scroll", potion: "fa-flask",
  consumable: "fa-bomb", magic: "fa-gem", material: "fa-cubes", gear: "fa-campground", companion: "fa-paw", treasure: "fa-sack-dollar"
};

const ALCHEMY = new Set(["elixir", "mutagen", "poison", "drug", "catalyst", "oil", "potion"]);
const COMPANION_USAGE = /collar|saddle|horseshoe|harness|barding/;

export function runeKind(slug, usage) {
  if (/^(weapon-potency|striking|mythic-weapon-potency|mythic-striking)/.test(slug)) return "weapon-fundamental";
  if (/^(armor-potency|resilient|mythic-armor-potency|mythic-resilient)/.test(slug)) return "armor-fundamental";
  if (/^reinforcing/.test(slug)) return "shield-fundamental";
  if (slug === "runestone") return "runestone";
  if (/shield/.test(usage)) return "shield-property";
  if (/armor/.test(usage)) return "armor-property";
  return "weapon-property";
}

/** Arrows, bolts, darts and sling bullets are everyday; rounds and pellets are for firearms. */
export function ammoKind(slug, traits = []) {
  if (/round|pellet|magazine|cartridge|powder|shot|slug|shell|clip/.test(slug)) return "firearm";
  if (/arrow|bolt|dart|sling|bullet|blowgun|needle|stone|javelin/.test(slug)) return "missile";
  return traits.includes("magical") ? "magic" : "other";
}

/** { cat, sub } for an item or an index entry. */
export function classify(e) {
  const s = e?.system ?? {};
  const usage = s.usage?.value ?? "";
  const traits = s.traits?.value ?? [];
  const slug = s.slug || slugOf(e);
  if (e.type === "equipment" && (usage.startsWith("etched-onto") || slug === "runestone")) return { cat: "rune", sub: runeKind(slug, usage) };
  // Precious materials sold by the chunk / ingot (silver, cold iron, adamantine …).
  if (e.type === "equipment" && traits.includes("precious")) return { cat: "material", sub: /ingot/.test(slug) ? "ingot" : /chunk/.test(slug) ? "chunk" : "precious" };
  switch (e.type) {
    case "weapon": return s.group === "bomb" ? { cat: "potion", sub: "bomb" } : { cat: "weapon", sub: s.group || "other" };
    case "ammo": return { cat: "ammo", sub: ammoKind(slug, traits) };
    case "armor": return /barding/.test(s.category ?? "") ? { cat: "companion", sub: "barding" } : { cat: "armor", sub: s.category || "other" };
    case "shield": return { cat: "armor", sub: "shield" };
    case "treasure": return { cat: "treasure", sub: s.category ?? "treasure" };
    case "backpack": case "kit": case "book": return { cat: "gear", sub: e.type };
    case "consumable": {
      const c = s.category ?? "other";
      if (c === "scroll" || c === "wand") return { cat: "scroll", sub: c };
      if (c === "ammo" || c === "ammunition") return { cat: "ammo", sub: "magic" };
      if (ALCHEMY.has(c)) return { cat: "potion", sub: c };
      if (c === "toolkit" || (c === "other" && !traits.includes("magical") && !traits.includes("alchemical"))) return { cat: "gear", sub: c };
      return { cat: "consumable", sub: c };
    }
  }
  if (COMPANION_USAGE.test(usage) || traits.includes("companion")) return { cat: "companion", sub: "gear" };
  if (traits.includes("magical") || traits.includes("invested")) return { cat: "magic", sub: usage.startsWith("worn") ? "worn" : "held" };
  if (traits.includes("alchemical")) return { cat: "potion", sub: "alchemical" };
  return { cat: "gear", sub: "gear" };
}

export function catLabel(cat) {
  return game.i18n.localize(`RPS.Cat.${cat}`);
}

/** Label of a sub-category (weapon groups from PF2e, the rest from our language file). */
export function subLabel(cat, sub) {
  if (cat === "weapon" && sub !== "ammo") return game.i18n.localize(CONFIG.PF2E?.weaponGroups?.[sub] ?? sub);
  if (cat === "armor" && sub !== "shield") return game.i18n.localize(CONFIG.PF2E?.armorCategories?.[sub] ?? sub);
  const key = `RPS.Sub.${sub}`;
  const l = game.i18n.localize(key);
  if (l !== key) return l;
  return game.i18n.localize(CONFIG.PF2E?.consumableCategories?.[sub] ?? sub);
}

/* ---------------- runes on items ---------------- */

/** What a rune item does on a weapon/armor/shield: { slot: "potency"|"striking"|"resilient"|"reinforcing"|"property", value, kind, key }. */
export function runeEffect(doc) {
  const slug = slugOf(doc);
  let m;
  if ((m = /^weapon-potency-(\d)$/.exec(slug))) return { kind: "weapon", slot: "potency", value: Number(m[1]) };
  if ((m = /^armor-potency-(\d)$/.exec(slug))) return { kind: "armor", slot: "potency", value: Number(m[1]) };
  if ((m = /^striking(?:-(greater|major))?$/.exec(slug))) return { kind: "weapon", slot: "striking", value: { undefined: 1, greater: 2, major: 3 }[m[1]] };
  if ((m = /^resilient(?:-(greater|major))?$/.exec(slug))) return { kind: "armor", slot: "resilient", value: { undefined: 1, greater: 2, major: 3 }[m[1]] };
  if ((m = /^reinforcing-rune-(minor|lesser|moderate|greater|major|supreme)$/.exec(slug))) {
    return { kind: "shield", slot: "reinforcing", value: ["minor", "lesser", "moderate", "greater", "major", "supreme"].indexOf(m[1]) + 1 };
  }
  const p = PROPERTY_RUNES[slug];
  if (p) return { kind: p[0], slot: "property", key: p[1] };
  return null;
}

/** Can this rune go on this item (by PF2e's "etched onto …" wording)? true / false / null (can't tell). */
export function runeFits(runeDoc, item) {
  const usage = runeDoc.system?.usage?.value ?? "";
  const eff = runeEffect(runeDoc);
  const kind = item.type === "weapon" ? "weapon" : item.type === "armor" ? "armor" : item.type === "shield" ? "shield" : null;
  if (!kind || (eff && eff.kind !== kind)) return false;
  if (kind === "weapon") {
    const ranged = !!item.system?.range || item.isRanged;
    const dmg = item.system?.damage?.damageType;
    if (/melee/.test(usage) && ranged) return false;
    if (/thrown/.test(usage) && !(item.system?.traits?.value ?? []).some(tr => /^thrown/.test(tr))) return false;
    if (/bludgeoning/.test(usage) && dmg !== "bludgeoning") return false;
    if (/piercing-or-slashing/.test(usage) && !["piercing", "slashing"].includes(dmg)) return false;
    if (/slashing-melee/.test(usage) && dmg !== "slashing") return false;
    if (/clan-dagger/.test(usage) && item.system?.baseItem !== "clan-dagger") return false;
    return true;
  }
  if (kind === "armor") {
    const cat = item.system?.category;
    if (/light-armor/.test(usage) && cat !== "light") return false;
    if (/heavy-armor/.test(usage) && !/med/.test(usage) && cat !== "heavy") return false;
    if (/med-heavy|medium-heavy/.test(usage) && !["medium", "heavy"].includes(cat)) return false;
    if (/lm-nonmetal/.test(usage) && !["light", "medium"].includes(cat)) return false;
    return true;
  }
  return /shield/.test(usage) || eff?.kind === "shield";
}

/* ---------------- the compendium catalog ---------------- */

const FIELDS = ["img", "system.slug", "system.level.value", "system.price", "system.traits.value", "system.traits.rarity",
  "system.category", "system.group", "system.usage.value", "system.publication.remaster", "system.publication.title",
  "system.baseItem", "system.damage.damageType", "system.range", "system.quantity", "system.material", "flags.PF2e-KR.originalName", "flags.babele.originalName"];
const TYPES = new Set(["weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack", "ammo", "kit"]);
let catalog = null;
let loading = null;

function browserOff(pack) {
  try {
    const conf = game.settings.get(game.system.id, "compendiumBrowserPacks") ?? {};
    return Object.values(conf).some(tab => tab?.[pack.collection]?.load === false);
  } catch (_) {
    return false;
  }
}

function translationPackage(id) {
  const mod = game.modules.get(id);
  return /translat|번역|한글|korean|babele|(^|[-_ ])(ko|kr)([-_ ]|$)/i.test(`${id} ${mod?.title ?? ""}`);
}

function mirrored(pack, all) {
  return pack.metadata.packageType === "system"
    && all.some(p => p !== pack && p.metadata.packageType !== "system" && p.metadata.name === pack.metadata.name
      && translationPackage(p.metadata.packageName ?? p.metadata.package ?? ""));
}

/** Item packs the shop searches: the GM's list, or every pack with gear in it the browser uses. */
export function catalogPacks() {
  const all = game.packs.filter(p => p.documentName === "Item");
  const custom = String(setting("packs", "") ?? "").split(/[,\s]+/).filter(Boolean);
  if (custom.length) return all.filter(p => custom.includes(p.collection));
  return all.filter(p => !/spell|feat|class|ancestr|heritage|background|deit|effect|action|condition|bestiary|journal|macro|table|familiar/i.test(p.metadata.name)
    && !browserOff(p) && !mirrored(p, all));
}

function entryOf(e, pack) {
  const { cat, sub } = classify(e);
  const s = e.system ?? {};
  return {
    uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`,
    name: e.name, english: englishName(e), img: e.img, type: e.type, slug: s.slug || slugOf(e),
    level: Number(s.level?.value ?? 0) || 0, price: unitCp(e), rarity: s.traits?.rarity ?? "common",
    traits: Array.isArray(s.traits?.value) ? s.traits.value : [], cat, sub, usage: s.usage?.value ?? "",
    remaster: s.publication?.remaster ?? true, source: s.publication?.title ?? "", pack: pack.collection,
    search: `${e.name} ${englishName(e)}`.toLowerCase(), system: s
  };
}

export async function loadCatalog({ force = false } = {}) {
  if (catalog && !force) return catalog;
  if (loading && !force) return loading;
  loading = (async () => {
    const list = [];
    const seen = new Set();
    for (const pack of catalogPacks()) {
      let idx;
      try { idx = await pack.getIndex({ fields: FIELDS }); } catch (err) { console.warn(`${MID} | index ${pack.collection}`, err); continue; }
      for (const e of idx) {
        if (!TYPES.has(e.type)) continue;
        const entry = entryOf(e, pack);
        if (seen.has(entry.uuid)) continue;
        seen.add(entry.uuid);
        list.push(entry);
      }
    }
    list.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, game.i18n.lang));
    catalog = { list, byUuid: new Map(list.map(e => [e.uuid, e])) };
    loading = null;
    return catalog;
  })();
  return loading;
}

export function forgetCatalog() {
  catalog = null;
  loading = null;
}

/**
 * Search the catalog. f: { text, cat, sub, levelMin, levelMax, rarity: Set, magical: bool|null, legacy: bool, traits: [] }
 * Text matches Korean and English names, and "룬"/"rune" finds every rune.
 */
export function searchCatalog(cat, f = {}) {
  const words = String(f.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return cat.list.filter(e => {
    if (f.cat && f.cat !== "all" && e.cat !== f.cat) return false;
    if (f.sub && e.sub !== f.sub) return false;
    if (f.levelMin !== undefined && f.levelMin !== null && e.level < f.levelMin) return false;
    if (f.levelMax !== undefined && f.levelMax !== null && e.level > f.levelMax) return false;
    if (f.rarity && f.rarity.size && !f.rarity.has(e.rarity)) return false;
    if (f.legacy === false && e.remaster === false) return false;
    if (f.magical === true && !e.traits.includes("magical")) return false;
    if (f.magical === false && e.traits.includes("magical")) return false;
    if (f.traits?.length && !f.traits.every(tr => e.traits.includes(tr))) return false;
    for (const w of words) {
      if ((w === "룬" || w === "rune" || w === "runes") && e.cat === "rune") continue;
      if (!e.search.includes(w) && !e.traits.includes(w)) return false;
    }
    return true;
  });
}

/** Sub-categories that occur in a list (for the dropdown). */
export function subsOf(list, cat) {
  const out = new Map();
  for (const e of list) if (e.cat === cat) out.set(e.sub, (out.get(e.sub) ?? 0) + 1);
  return [...out].sort((a, b) => subLabel(cat, a[0]).localeCompare(subLabel(cat, b[0]), game.i18n.lang));
}

/** A translated mirror of a system document if there is one (same id), else the document. */
export async function preferMirror(uuid) {
  const m = /^Compendium\.([^.]+)\.([^.]+)\.Item\.(.+)$/.exec(uuid ?? "");
  let doc = null;
  try { doc = await fromUuid(uuid); } catch (_) { doc = null; }
  if (!m || m[1] !== game.system.id) return doc;
  const mirror = game.packs.find(p => p.metadata.name === m[2] && p.metadata.packageType !== "system" && p.documentName === "Item"
    && translationPackage(p.metadata.packageName ?? p.metadata.package ?? ""));
  if (!mirror) return doc;
  try { return (await mirror.getDocument(m[3])) ?? doc; } catch (_) { return doc; }
}
