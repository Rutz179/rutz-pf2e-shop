import { esc, t } from "../util.mjs";
import { MATERIALS, damageItem, guessMaterial, healItem, hpOf, repairAmount, setMaterial, stateLabel, stateOf, syncBrokenArmor } from "../durability.mjs";

/* ======================================================================== *
 * 내구도 (GM): a character's weapons, armor and shields (and anything else
 * with Hit Points) — Hardness, HP, broken threshold, state — with:
 *   피해      damage that goes through Hardness (a spell that breaks armor,
 *             a Sunder, a rust monster …)
 *   재료      give gear without Hit Points the GM Core material values
 *   수리      the Repair activity's results for the repairer's Crafting rank
 *             (success 5+5/rank, critical 10+10/rank, critical failure 2d6),
 *             or "full" (a smith's work)
 * Every change is said in chat (GM only).
 * ======================================================================== */

export class DurabilityApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "rps-durability",
    classes: ["rps-durability"],
    window: { title: "RPS.Dur.Title", icon: "fa-solid fa-shield-heart", resizable: true },
    position: { width: 760, height: 560 }
  };

  constructor() {
    super();
    const sel = canvas?.tokens?.controlled?.[0]?.actor;
    this.actorId = sel?.id ?? game.actors.find(a => a.type === "character" && a.hasPlayerOwner)?.id ?? null;
    this.showAll = false;
  }

  get target() {
    return game.actors.get(this.actorId) ?? null;
  }

  async _renderHTML() {
    const actors = game.actors.filter(a => ["character", "npc", "familiar"].includes(a.type) && (a.hasPlayerOwner || a.type === "npc"))
      .sort((a, b) => (b.hasPlayerOwner - a.hasPlayerOwner) || a.name.localeCompare(b.name, game.i18n.lang));
    const a = this.target;
    const crafter = a?.skills?.crafting?.rank ?? 0;
    const items = (a?.items ?? []).filter(i => ["weapon", "armor", "shield"].includes(i.type) || (this.showAll && hpOf(i).max > 0))
      .sort((x, y) => ["armor", "shield", "weapon"].indexOf(x.type) - ["armor", "shield", "weapon"].indexOf(y.type) || x.name.localeCompare(y.name, game.i18n.lang));
    const mats = Object.keys(MATERIALS);
    const rows = items.map(i => {
      const h = hpOf(i);
      const st = stateOf(i);
      const pct = h.max ? Math.round((h.value / h.max) * 100) : 0;
      return `<div class="rps-dur ${st}" data-id="${i.id}"><img src="${esc(i.img)}" alt="">
        <div class="nm"><b>${esc(i.name)}</b>${i.isEquipped ? ` <i class="fa-solid fa-shirt" data-tooltip="${esc(t("Shop.Equipped"))}"></i>` : ""}
          ${h.max ? `<div class="hpbar"><i style="width:${pct}%"></i><span>${h.value} / ${h.max} · BT ${h.bt} · ${t("Dur.Hardness")} ${h.hardness}</span></div><small>${stateLabel(st)}</small>`
            : `<small class="rps-dim">${t("Dur.NoHp")}</small>`}</div>
        <div class="acts">
          <select data-a="mat" data-tooltip="${esc(t("Dur.MaterialHint"))}"><option value="">${t("Dur.Material")}</option>${mats.map(m => `<option value="${m}">${guessMaterial(i) === m ? "★ " : ""}${t(`Dur.Mat.${m}`)} (${MATERIALS[m].join("/")})</option>`).join("")}</select>
          ${!h.max ? `<button type="button" data-a="mat-guess" data-tooltip="${esc(t("Dur.GuessHint"))}">★ ${t(`Dur.Mat.${guessMaterial(i)}`)}</button>` : ""}
          ${h.max ? `<input type="number" min="0" value="" placeholder="${esc(t("Dur.Damage"))}" class="n dmg"><button type="button" data-a="hit" data-tooltip="${esc(t("Dur.HitHint"))}"><i class="fa-solid fa-burst"></i></button>
            <button type="button" data-a="fix" data-r="s" data-tooltip="${esc(t("Dur.FixS", { n: repairAmount(crafter) }))}" ${st === "destroyed" ? "disabled" : ""}>+${repairAmount(crafter)}</button>
            <button type="button" data-a="fix" data-r="c" data-tooltip="${esc(t("Dur.FixC", { n: repairAmount(crafter, true) }))}" ${st === "destroyed" ? "disabled" : ""}>+${repairAmount(crafter, true)}</button>
            <button type="button" data-a="fix" data-r="f" data-tooltip="${esc(t("Dur.FixF"))}" ${st === "destroyed" ? "disabled" : ""}><i class="fa-solid fa-dice"></i>2d6</button>
            <button type="button" data-a="fix" data-r="full" data-tooltip="${esc(t("Dur.FixFull"))}" ${st === "destroyed" ? "disabled" : ""}><i class="fa-solid fa-hammer"></i></button>` : ""}
        </div></div>`;
    }).join("");
    return `<div class="rps-durapp">
      <div class="row"><select data-a="actor">${actors.map(x => `<option value="${x.id}" ${x.id === this.actorId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
        <label class="inline"><input type="checkbox" data-a="all" ${this.showAll ? "checked" : ""}> ${t("Dur.ShowAll")}</label>
        <span class="rps-dim">${t("Dur.Crafter", { rank: game.i18n.localize(`PF2E.ProficiencyLevel${crafter}`) })}</span></div>
      <p class="rps-hint">${t("Dur.Hint")}</p>
      <div class="list">${rows || `<p class="rps-empty">${t("Dur.Nothing")}</p>`}</div></div>`;
  }

  _replaceHTML(result, content) {
    const top = content.querySelector(".list")?.scrollTop ?? 0;
    content.innerHTML = result;
    const list = content.querySelector(".list");
    if (list && top) list.scrollTop = top;
    if (this._wired === content) return;
    this._wired = content;
    content.addEventListener("click", ev => this.onClick(ev));
    content.addEventListener("change", ev => this.onChange(ev));
  }

  async say(text) {
    await ChatMessage.create({ content: `<div class="rps-log dur"><header><i class="fa-solid fa-shield-heart"></i> <b>${t("Dur.Title")}</b></header><p>${text}</p></div>`, whisper: game.users.filter(u => u.isGM).map(u => u.id) });
  }

  async onClick(ev) {
    const el = ev.target.closest("[data-a]");
    if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    ev.preventDefault();
    const row = el.closest("[data-id]");
    const item = this.target?.items.get(row?.dataset.id);
    if (!item) return;
    if (el.dataset.a === "mat-guess") {
      await setMaterial(item, guessMaterial(item));
      await syncBrokenArmor(this.target);
      return this.render();
    }
    if (el.dataset.a === "hit") {
      const amount = Number(row.querySelector(".dmg")?.value) || 0;
      if (!amount) return;
      const { taken, state } = await damageItem(item, amount);
      await this.say(t("Dur.SaidHit", { item: esc(item.name), amount, taken, state: stateLabel(state) }));
    } else if (el.dataset.a === "fix") {
      const r = el.dataset.r;
      const rank = this.target?.skills?.crafting?.rank ?? 0;
      if (r === "f") {
        const roll = await new Roll("2d6").evaluate();
        const { taken, state } = await damageItem(item, roll.total);
        await this.say(t("Dur.SaidCritFail", { item: esc(item.name), roll: roll.total, taken, state: stateLabel(state) }));
      } else {
        const amount = r === "full" ? null : repairAmount(rank, r === "c");
        const ok = await healItem(item, amount);
        if (!ok) return ui.notifications.warn(t("Repair.Destroyed"));
        await this.say(t("Dur.SaidFix", { item: esc(item.name), hp: `${hpOf(item).value}/${hpOf(item).max}`, state: stateLabel(stateOf(item)) }));
      }
    }
    await syncBrokenArmor(this.target);
    this.render();
  }

  async onChange(ev) {
    const el = ev.target;
    if (el.dataset.a === "actor") { this.actorId = el.value; return this.render(); }
    if (el.dataset.a === "all") { this.showAll = el.checked; return this.render(); }
    if (el.dataset.a === "mat" && el.value) {
      const item = this.target?.items.get(el.closest("[data-id]")?.dataset.id);
      if (!item) return;
      await setMaterial(item, el.value);
      await syncBrokenArmor(this.target);
      this.render();
    }
  }
}

export function openDurability() {
  const open = foundry.applications.instances.get("rps-durability");
  if (open) { open.render(true); return open; }
  const app = new DurabilityApp();
  app.render(true);
  return app;
}
