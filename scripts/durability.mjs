import { MID, t } from "./util.mjs";

/* ======================================================================== *
 * Item damage, as the rules have it (Player Core p. 269, GM Core p. 252):
 *   - damage to an item is reduced by its Hardness first;
 *   - at or below its Broken Threshold (BT) it is broken, at 0 HP destroyed
 *     (a destroyed item can't be Repaired);
 *   - broken armor keeps its item bonus but takes a status penalty to AC:
 *     –1 light, –2 medium, –3 heavy; other broken items don't work.
 *
 * PF2e only gives shields Hit Points; armor and weapons start at 0 HP (no
 * durability). "Set from material" gives them the GM Core material values
 * (metal weapons and armor are iron or steel unless noted otherwise). The
 * broken-armor penalty is kept as an effect on the wearer while it applies.
 * ======================================================================== */

// GM Core Table 11-4 (Hardness, HP, BT)
export const MATERIALS = {
  paper: [0, 1, 0], "thin-cloth": [0, 1, 0], cloth: [1, 4, 2], "thin-leather": [2, 8, 4], "thin-rope": [2, 8, 4],
  "thin-wood": [3, 12, 6], leather: [4, 16, 8], rope: [4, 16, 8], "thin-stone": [5, 16, 8], "thin-iron": [5, 20, 10],
  wood: [5, 20, 10], stone: [7, 28, 14], iron: [9, 36, 18]
};

const WOODEN_WEAPON_GROUPS = new Set(["club", "bow", "sling", "dart"]);

/** Which material row fits an item (a best guess; the GM can pick another). */
export function guessMaterial(item) {
  const s = item.system ?? {};
  if (item.type === "armor") {
    if (s.category === "unarmored" || s.group === "cloth") return "cloth";
    if (s.group === "leather") return "leather";
    if (s.group === "wood") return "wood";
    return "iron"; // chain, composite, plate, skeletal …: "iron or steel armor"
  }
  if (item.type === "weapon") {
    const traits = s.traits?.value ?? [];
    if (s.baseItem === "whip" || traits.includes("whip")) return "thin-leather";
    if (WOODEN_WEAPON_GROUPS.has(s.group) || /staff|club|bow|sling/.test(s.baseItem ?? "")) return "thin-wood";
    return "thin-iron"; // "sword": thin iron or steel
  }
  if (item.type === "shield") return /wooden/.test(s.baseItem ?? "") ? "thin-wood" : "thin-iron";
  if (item.type === "backpack") return "thin-leather";
  if (item.type === "consumable" && s.category === "scroll") return "paper";
  return "cloth";
}

export function hpOf(item) {
  const hp = item.system?.hp ?? {};
  const max = Number(hp.max ?? 0) || 0;
  const value = Number(hp.value ?? 0) || 0;
  const bt = Number(item.hitPoints?.brokenThreshold ?? item.system?.hp?.brokenThreshold ?? Math.floor(max / 2)) || 0;
  return { value, max, bt, hardness: Number(item.system?.hardness ?? 0) || 0 };
}

export function stateOf(item) {
  const { value, max, bt } = hpOf(item);
  if (max <= 0) return "none";
  if (value <= 0) return "destroyed";
  if (value <= bt) return "broken";
  if (value < max) return "damaged";
  return "ok";
}

export function stateLabel(state) {
  return t(`Dur.State.${state}`);
}

/** Give an item Hardness/HP/BT from a material row (keeps the share of HP it had left). */
export async function setMaterial(item, key) {
  const row = MATERIALS[key];
  if (!row) return;
  const [hardness, max] = row;
  const cur = hpOf(item);
  const value = cur.max > 0 ? Math.round((cur.value / cur.max) * max) : max;
  await item.update({ "system.hardness": hardness, "system.hp.max": max, "system.hp.value": value });
}

/** Damage an item: Hardness first. Returns { taken, state }. */
export async function damageItem(item, amount) {
  const { value, hardness } = hpOf(item);
  const taken = Math.max(0, Math.floor(Number(amount) || 0) - hardness);
  const next = Math.max(0, value - taken);
  await item.update({ "system.hp.value": next });
  return { taken, state: stateOf(item) };
}

export async function healItem(item, amount = null) {
  const { value, max } = hpOf(item);
  if (value <= 0) return false; // destroyed: can't be Repaired
  const next = amount === null ? max : Math.min(max, value + Math.max(0, Number(amount) || 0));
  await item.update({ "system.hp.value": next });
  return true;
}

/** Repair activity results (Player Core p. 236): HP restored by Crafting rank. */
export function repairAmount(rank, critical = false) {
  const r = Math.max(0, Math.min(4, Number(rank) || 0));
  return critical ? 10 + 10 * r : 5 + 5 * r;
}

/* ---------------- broken armor → AC penalty ---------------- */

const PENALTY = { light: -1, medium: -2, heavy: -3 };

export async function syncBrokenArmor(actor) {
  if (!actor?.isOwner || !actor.itemTypes?.armor || !setting0("brokenArmor")) return;
  const worn = actor.itemTypes.armor.find(a => a.isEquipped && stateOf(a) === "broken");
  const value = worn ? PENALTY[worn.system?.category] ?? 0 : 0;
  const existing = actor.itemTypes.effect?.find(e => e.getFlag(MID, "brokenArmor"));
  if (!value) {
    if (existing) await existing.delete();
    return;
  }
  const rule = { key: "FlatModifier", selector: "ac", type: "status", value, label: t("Dur.BrokenArmorLabel") };
  const name = t("Dur.BrokenArmorEffect", { name: worn.name });
  if (existing) {
    const cur = existing.system?.rules?.[0];
    if (cur?.value === value && existing.name === name) return;
    await existing.update({ name, "system.rules": [rule] });
    return;
  }
  await actor.createEmbeddedDocuments("Item", [{
    type: "effect", name, img: "icons/equipment/chest/breastplate-banded-steel-grey.webp",
    system: { rules: [rule], duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true },
      description: { value: `<p>${t("Dur.BrokenArmorDesc")}</p>` } },
    flags: { [MID]: { brokenArmor: true } }
  }]);
}

function setting0(key) {
  try { return game.settings.get(MID, key); } catch (_) { return true; }
}
