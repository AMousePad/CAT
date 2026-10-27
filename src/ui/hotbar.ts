import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import type { Catalog } from "../shared";
import { button, catIcon, el } from "./components";
import { ICON } from "./styles";
import { uiScale } from "./layout";

/** Profile switches stay selected across sends and chat forks. */
export class SwipeHotbar {
  private selected?: string[];
  private panel?: HTMLElement;
  private anchor?: HTMLElement;
  private busy = false;
  private focusProfile?: string;
  private disposed = false;
  private action;
  private unsubscribe;
  private layoutUnsubscribe;
  private trigger: HTMLButtonElement;
  constructor(ctx: SpindleFrontendContext, private options: {
    catalog(): Catalog | null; enabled(): boolean; toggle(): Promise<void>;
    select(ids: string[]): Promise<void>; manage(): void; refreshCats(): void; error(error: unknown): void;
  }) {
    this.action = ctx.ui.registerInputBarAction({ id: "another_one_profiles", label: "Concurrent Alternate Trajectories",
      subtitle: "Choose which profiles generate swipes", iconSvg: ICON });
    this.unsubscribe = this.action.onClick(() => { this.options.refreshCats(); this.close(); this.open(); });
    this.layoutUnsubscribe = ctx.state!.subscribe("ui.layout", () => this.position());
    this.trigger = button("", () => { this.options.refreshCats(); if (this.panel) this.close(); else this.open(); }, "ao-hotbar-trigger");
    this.trigger.append(catIcon()); this.trigger.title = "Concurrent Alternate Trajectories";
    this.trigger.setAttribute("aria-label", "Concurrent Alternate Trajectories"); this.trigger.setAttribute("aria-haspopup", "dialog");
    this.trigger.setAttribute("aria-expanded", "false");
    ctx.ui.mount("chat_actions").append(this.trigger);
    document.addEventListener("pointerdown", this.outside, true);
    document.addEventListener("keydown", this.keydown, true);
  }
  get ids() { return this.selected ? [...this.selected] : undefined; }
  restore(ids?: string[]) { this.selected = ids ? [...ids] : undefined; this.update(); }
  update() {
    this.trigger.dataset.enabled = String(this.options.enabled());
    const catalog = this.options.catalog();
    if (this.selected && catalog) {
      this.selected = this.selected.filter(id => catalog.settings.slots.some(s => s.id === id));
      if (!this.selected.length) this.selected = undefined;
    }
    if (this.panel) this.render();
  }
  private open() {
    this.anchor = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined;
    this.panel = el("div", "ao-root ao-hotbar");
    this.panel.setAttribute("role", "dialog"); this.panel.setAttribute("aria-label", "Swipe profiles");
    this.panel.addEventListener("click", () => this.options.refreshCats());
    document.body.append(this.panel); this.render();
    this.trigger.setAttribute("aria-expanded", "true");
    this.position();
    this.panel.querySelector<HTMLButtonElement>("button")?.focus();
  }
  private position() {
    if (!this.panel) return;
    const scale = uiScale(), width = window.innerWidth / scale, height = window.innerHeight / scale;
    const rect = this.anchor?.getBoundingClientRect();
    this.panel.style.left = `${Math.max(8, Math.min(width - this.panel.offsetWidth - 8, rect ? rect.left / scale : width - 300))}px`;
    this.panel.style.bottom = `${Math.max(8, Math.min(height - this.panel.offsetHeight - 8, height - (rect ? rect.top / scale : height - 80) + 8))}px`;
  }
  private render() {
    const panel = this.panel!;
    const focusId = (document.activeElement as HTMLElement | null)?.dataset.profile ?? this.focusProfile;
    panel.replaceChildren();
    const title = el("div", "ao-hotbar-title", "Swipe profiles"); title.prepend(catIcon()); panel.append(title);
    const enabled = this.options.enabled();
    panel.append(button(enabled ? "Disable CAT" : "Enable CAT", () => { void this.toggle(); }, "ao-hotbar-enable", this.busy));
    const catalog = this.options.catalog(), slots = catalog?.settings.slots ?? [];
    const ids = this.selected ?? slots.map(s => s.id);
    for (const [index, slot] of slots.entries()) {
      const on = ids.includes(slot.id);
      const row = button("", () => { void this.choose(slot.id); }, "ao-hotbar-profile", this.busy || (on && ids.length === 1));
      row.dataset.profile = slot.id; row.setAttribute("role", "checkbox"); row.setAttribute("aria-checked", String(on));
      if (on && ids.length === 1) { row.classList.add("ao-hotbar-required"); row.title = "Keep at least one profile enabled."; }
      row.append(catIcon("ao-cat-icon", index % 2 ? "settings" : "swipes"), el("span", "ao-hotbar-state", on ? "ON" : "OFF"), el("span", "", catalog?.presets.find(p => p.id === slot.presetId)?.name || `Profile ${index + 1}`));
      panel.append(row);
    }
    if (!slots.length) panel.append(el("p", "ao-muted", "Add profiles in Settings."));
    panel.append(el("p", "ao-hotbar-hint", "Keeps your selection for following sends."),
      button("Manage profiles", () => { this.close(); this.options.manage(); }, "ao-hotbar-manage"));
    if (focusId) Array.from(panel.querySelectorAll<HTMLButtonElement>("[data-profile]")).find(b => b.dataset.profile === focusId)?.focus();
    this.position();
  }
  private async toggle() {
    this.busy = true; this.render();
    try { await this.options.toggle(); } catch (error) { this.options.error(error); }
    finally { this.busy = false; if (!this.disposed && this.panel) this.render(); }
  }
  private async choose(id: string) {
    const slots = this.options.catalog()?.settings.slots ?? [];
    const previous = this.ids;
    const current = this.selected ?? slots.map(s => s.id);
    const next = current.includes(id) ? current.filter(value => value !== id) : slots.filter(s => s.id === id || current.includes(s.id)).map(s => s.id);
    if (!next.length || this.busy) return;
    this.focusProfile = id;
    this.selected = next; this.busy = true; this.render();
    try { await this.options.select(next); }
    catch (error) { this.selected = previous; this.options.error(error); }
    finally { this.busy = false; if (!this.disposed && this.panel) this.render(); }
  }
  private outside = (event: PointerEvent) => { if (this.panel && !this.panel.contains(event.target as Node) && !this.anchor?.contains(event.target as Node)) this.close(); };
  private keydown = (event: KeyboardEvent) => {
    if (!this.panel) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); this.anchor?.focus(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); const buttons = Array.from(this.panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(i + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  };
  close() { this.panel?.remove(); this.panel = undefined; this.focusProfile = undefined; this.trigger?.setAttribute("aria-expanded", "false"); }
  dispose() { this.disposed = true; this.close(); this.trigger.remove(); this.unsubscribe(); this.layoutUnsubscribe(); this.action.destroy(); document.removeEventListener("pointerdown", this.outside, true); document.removeEventListener("keydown", this.keydown, true); }
}
