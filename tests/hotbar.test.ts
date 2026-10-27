import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { SpindleFrontendContext, SpindleInputBarActionHandle } from "lumiverse-spindle-types";
import type { Catalog } from "../src/shared";
import { SwipeHotbar } from "../src/ui/hotbar";

test("hotbar toggles preserve configuration, forbid an empty batch and survive status updates", async () => {
  const previous = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement };
  const window = new Window(); Object.assign(globalThis, { document: window.document, window, HTMLElement: window.HTMLElement });
  let open!: () => void;
  const action = { onClick: (handler: () => void) => { open = handler; return () => {}; }, destroy() {} } as SpindleInputBarActionHandle;
  const mount = document.createElement("span"); document.body.append(mount);
  const ctx = { ui: { registerInputBarAction: () => action, mount: () => mount }, state: { subscribe: () => () => {} } } as unknown as SpindleFrontendContext;
  const catalog: Catalog = { presets: [{ id: "a", name: "First" }, { id: "b", name: "Second" }], connections: [],
    settings: { version: 1, cats: false, slots: [{ id: "one", presetId: "a", connectionId: null }, { id: "two", presetId: "b", connectionId: null }] } };
  const selections: string[][] = []; let managed = false, refreshes = 0;
  const bar = new SwipeHotbar(ctx, { catalog: () => catalog, enabled: () => true, toggle: async () => {}, select: async ids => { selections.push(ids); },
    manage: () => { managed = true; }, refreshCats: () => refreshes++, error: error => { throw error; } });
  try {
    mount.querySelector<HTMLButtonElement>("button")!.click();
    expect(document.querySelectorAll(".ao-hotbar")).toHaveLength(1);
    open(); expect(document.querySelectorAll(".ao-hotbar")).toHaveLength(1);
    const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'));
    rows()[0].click(); await Promise.resolve(); await Promise.resolve();
    expect(bar.ids).toEqual(["two"]); expect(selections).toEqual([["two"]]);
    expect((document.activeElement as HTMLElement).dataset.profile).toBe("one");
    expect(rows()[1].disabled).toBe(true); expect(rows()[0].getAttribute("aria-checked")).toBe("false");
    expect(catalog.settings.slots).toHaveLength(2); expect(refreshes).toBe(3);
    bar.update(); bar.close(); open();
    expect(bar.ids).toEqual(["two"]); expect(rows()[0].getAttribute("aria-checked")).toBe("false");
    expect(rows()[1].getAttribute("aria-checked")).toBe("true");
    document.querySelector<HTMLButtonElement>(".ao-hotbar-manage")!.click();
    expect(managed).toBe(true); expect(document.querySelector(".ao-hotbar")).toBeNull();
  } finally { bar.dispose(); window.close(); Object.assign(globalThis, previous); }
});
