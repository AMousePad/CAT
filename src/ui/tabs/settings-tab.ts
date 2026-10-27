import type { Catalog, Settings } from "../../shared";
import { MAX_SWIPES } from "../../shared";
import { button, catIcon, el, select } from "../components";
import { profileDrag } from "../profile-drag";
import { randomId } from "../id";

export interface SettingsActions {
  save(settings: Settings): void; reload(): void;
}
export function renderSettings(host: HTMLElement, catalog: Catalog, locked: boolean, saving: boolean, actions: SettingsActions) {
  const sequence = el("section");
  const intro = el("div", "ao-settings-intro");
  const hint = el("p", "ao-pill ao-hint", "One swipe is generated per profile."); hint.prepend(catIcon());
  intro.append(hint, el("span", "ao-pill ao-count", `${catalog.settings.slots.length} / ${MAX_SWIPES} profiles`)); sequence.append(intro);
  if (!catalog.settings.slots.length) sequence.append(el("p", "ao-empty ao-pill", "Add a profile to get started."));
  const rows = el("div", "ao-slots"); rows.setAttribute("role", "list"); rows.setAttribute("aria-label", "Swipe profiles");
  const timers: ReturnType<typeof setTimeout>[] = [];
  const change = (fn: (settings: Settings) => void) => { const next = structuredClone(catalog.settings); fn(next); actions.save(next); };
  for (const [index, slot] of catalog.settings.slots.entries()) {
    const row = el("div", "ao-slot");
    row.dataset.slotId = slot.id; row.setAttribute("role", "listitem"); row.setAttribute("aria-label", `Profile ${index + 1}`);
    const heading = el("div", "ao-slot-heading");
    const name = el("span", "ao-slot-name"); name.append(catIcon("ao-cat-icon", "settings"), el("span", "", `Profile ${index + 1}`)); heading.append(name);
    const controls = el("div", "ao-slot-controls");
    const move = (direction: number) => change(s => { [s.slots[index], s.slots[index + direction]] = [s.slots[index + direction], s.slots[index]]; });
    const drag = button("⠿", () => {}, "ao-small ao-drag-handle", locked || saving); drag.setAttribute("aria-label", `Drag profile ${index + 1} to reorder`);
    drag.title = "Drag to reorder, or use the Up and Down keys.";
    drag.addEventListener("keydown", event => {
      if ((event.key === "ArrowUp" && index > 0) || (event.key === "ArrowDown" && index < catalog.settings.slots.length - 1)) { event.preventDefault(); move(event.key === "ArrowUp" ? -1 : 1); }
    });
    const remove = button("×", () => change(s => { s.slots.splice(index, 1); }), "ao-small", locked || saving); remove.setAttribute("aria-label", `Remove profile ${index + 1}`);
    controls.append(drag, remove); heading.append(controls); row.append(heading);
    const presets = [{ id: "", name: "Choose a preset…" }, ...catalog.presets];
    if (slot.presetId && !catalog.presets.some(p => p.id === slot.presetId)) presets.push({ id: slot.presetId, name: "Unavailable preset — choose another" });
    row.append(select("Preset", slot.presetId, presets, id => change(s => { s.slots[index].presetId = id; }), locked || saving));
    const connections = [{ id: "", name: "Connection active when enabled" }, ...catalog.connections.map(c => ({ id: c.id, name: c.model ? `${c.name} · ${c.model}` : c.name }))];
    if (slot.connectionId && !catalog.connections.some(c => c.id === slot.connectionId)) connections.push({ id: slot.connectionId, name: "Unavailable connection — choose another" });
    row.append(select("Connection", slot.connectionId || "", connections, id => change(s => { s.slots[index].connectionId = id || null; }), locked || saving));
    if (locked) {
      const cover = button("", () => {
        row.querySelector(".ao-lock-tip")?.remove();
        const tip = el("div", "ao-lock-tip ao-pill", "Disable to edit profiles."); tip.setAttribute("role", "status"); tip.prepend(catIcon()); row.append(tip);
        timers.push(setTimeout(() => tip.remove(), 3000));
      }, "ao-lock-cover");
      cover.setAttribute("aria-label", `Edit profile ${index + 1}: disable to edit profiles`); row.append(cover);
    }
    rows.append(row);
  }
  sequence.append(rows);
  const actionsRow = el("div", "ao-actions");
  actionsRow.append(button("Add profile", () => change(s => {
    const preset = catalog.presets.find(p => !s.slots.some(slot => slot.presetId === p.id)) ?? catalog.presets[0];
    s.slots.push({ id: randomId(), presetId: preset?.id || "", connectionId: null });
  }), "", locked || saving || catalog.settings.slots.length >= MAX_SWIPES), button("Refresh lists", actions.reload, "", locked || saving));
  sequence.append(actionsRow);
  const credits = el("a", "ao-icon-credits", "Icon credits");
  credits.href = "https://github.com/AMousePad/CAT/blob/main/CREDITS.md";
  credits.target = "_blank"; credits.rel = "noopener noreferrer";
  sequence.append(credits);
  host.append(sequence);
  const removeDrag = profileDrag(rows, ids => change(s => { s.slots = ids.map(id => s.slots.find(slot => slot.id === id)!); }));
  return () => { removeDrag(); for (const timer of timers) clearTimeout(timer); };
}
