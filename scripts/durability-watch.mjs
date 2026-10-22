import { MID, esc, setting, t } from "./util.mjs";
import { hpOf, stateLabel, stateOf } from "./durability.mjs";

/* ======================================================================== *
 * Damaged gear, seen where the players look.
 *
 * PF2e's character sheet shows an item's Hit Points only inside the item, so
 * a broken breastplate is easy to forget. Here:
 *   - on any actor sheet, an item that is damaged / broken / destroyed gets
 *     a small mark next to its name (nothing for undamaged gear);
 *   - when an item loses Hit Points, its owners (and the GM) get a short
 *     whisper: how much, and whether it is now broken.
 * ======================================================================== */

const ICON = { damaged: "fa-heart-crack", broken: "fa-link-slash", destroyed: "fa-skull" };

function marks(app, html) {
  if (!setting("durabilityMarks", true)) return;
  const actor = app?.actor ?? app?.document;
  if (!actor?.items) return;
  const root = html instanceof HTMLElement ? html : html?.[0] ?? app?.element;
  if (!root?.querySelectorAll) return;
  for (const row of root.querySelectorAll("[data-item-id]")) {
    const item = actor.items.get(row.dataset.itemId);
    if (!item || !hpOf(item).max) continue;
    const st = stateOf(item);
    if (!ICON[st] || row.querySelector(":scope .rps-durmark")) continue;
    const h = hpOf(item);
    const name = row.querySelector(".item-name h4, .item-name .name, .item-name a, h4, .name") ?? row;
    const mark = document.createElement("span");
    mark.className = `rps-durmark ${st}`;
    mark.dataset.tooltip = `${stateLabel(st)} · HP ${h.value}/${h.max} · BT ${h.bt}`;
    mark.innerHTML = `<i class="fa-solid ${ICON[st]}"></i>${st === "damaged" ? "" : ` ${esc(stateLabel(st))}`}`;
    name.appendChild(mark);
  }
}

export function installDurabilityWatch() {
  Hooks.on("renderActorSheet", marks);
  Hooks.on("renderActorSheetV2", marks);
  Hooks.on("preUpdateItem", (item, changes, options) => {
    if (!hpOf(item).max) return;
    options[MID] = { ...(options[MID] ?? {}), hpBefore: hpOf(item).value, maxBefore: hpOf(item).max };
  });
  Hooks.on("updateItem", async (item, changes, options, userId) => {
    if (userId !== game.user.id || !setting("durabilityNotice", true)) return;
    const before = options?.[MID]?.hpBefore;
    const actor = item.actor;
    if (before === undefined || !actor || actor.getFlag?.(MID, "shop")) return;
    const h = hpOf(item);
    if (h.value >= before) return;
    // Damage lowers the value, not the maximum (a merged stack of ammunition is not damage).
    if (!h.max || h.max !== options?.[MID]?.maxBefore || !["weapon", "armor", "shield", "equipment"].includes(item.type)) return;
    const st = stateOf(item);
    const owners = game.users.filter(u => u.isGM || actor.testUserPermission(u, "OWNER")).map(u => u.id);
    const line = t("Dur.Notice", { actor: esc(actor.name), item: esc(item.name), from: before, to: h.value, max: h.max, bt: h.bt });
    const state = ["broken", "destroyed"].includes(st) ? `<p class="warn"><b>${esc(stateLabel(st))}</b> — ${t(`Dur.NoticeState.${st}`)}</p>` : "";
    await ChatMessage.create({
      content: `<div class="rps-log dur ${st}"><header><i class="fa-solid ${ICON[st] ?? "fa-shield-heart"}"></i> <b>${t("Dur.NoticeTitle")}</b></header><p>${line}</p>${state}</div>`,
      whisper: owners, speaker: ChatMessage.getSpeaker({ actor })
    });
  });
}
