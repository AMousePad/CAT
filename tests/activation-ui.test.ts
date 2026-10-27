import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { setup } from "../src/ui/app";
import type { Activation } from "../src/shared";

test("startup, live browser sync and authenticated reconnect use server activation without browser storage", async () => {
  const previous = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement,
    Image: globalThis.Image, ResizeObserver: globalThis.ResizeObserver, fetch: globalThis.fetch };
  const window = new Window();
  Object.assign(globalThis, { document: window.document, window, HTMLElement: window.HTMLElement,
    Image: function () { const image = window.document.createElement("img"); Object.defineProperty(image, "src", { set() {} }); return image; },
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response("[]", { headers: { "Content-Type": "application/json" } }),
  });
  for (const name of ["localStorage", "sessionStorage", "indexedDB"]) Object.defineProperty(window, name, { get() { throw new Error("Browser storage must not be used"); } });
  let saved: Activation = { enabled: true, slotIds: ["two"], revision: 1 };
  let failSave = false;
  const clients: Array<{ receive(value: unknown): void; close(): void }> = [];
  const catalog = { settings: { version: 1, cats: false, slots: ["one", "two"].map(id => ({ id, presetId: id, connectionId: null })) },
    presets: ["one", "two"].map(id => ({ id, name: id })), connections: [{ id: "main", name: "Main" }], history: [] };
  const noop = () => {};
  function client() {
    const root = document.createElement("div"), actions = document.createElement("div"); document.body.append(root, actions);
    const listeners = new Set<(value: unknown) => void>(), events = new Map<string, (value: unknown) => void>();
    const calls: string[] = [];
    const receive = (value: unknown) => { for (const listener of listeners) listener(value); };
    const ctx = {
      frontendSessionId: `browser-${clients.length}`, dom: { addStyle: () => noop, findMessageElement: () => null },
      ui: { registerDrawerTab: () => ({ root, tabId: "tab", setBadge: noop, destroy: () => root.remove(), onActivate: () => noop }),
        registerInputBarAction: () => ({ onClick: () => noop, setEnabled: noop, destroy: noop }), mount: () => actions },
      state: { get: (key: string) => key === "chat.active" ? { chatId: "chat" } : { open: false, tabId: "tab" }, subscribe: () => noop },
      connections: { getActive: () => ({ activeProfileId: "main" }) }, host: { capabilities: { "message-preset-context-v1": 1 }, surfaces: { invoke: async () => {} } },
      messages: { getLatestMessageId: () => null }, events: { on: (name: string, callback: (value: unknown) => void) => { events.set(name, callback); return () => events.delete(name); } },
      onBackendMessage: (listener: (value: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      sendToBackend: (request: { id: string; operation: string; input: any }) => queueMicrotask(() => {
        calls.push(request.operation);
        let value: unknown = true;
        if (request.operation === "load") value = { ...catalog, activation: structuredClone(saved) };
        if (request.operation === "activation") {
          if (failSave) { receive({ type: "reply", id: request.id, error: "Cannot save account preference" }); return; }
          saved = { ...saved, ...request.input, revision: saved.revision + 1 };
          for (const browser of clients) browser.receive({ type: "activation", activation: structuredClone(saved) });
          value = structuredClone(saved);
        }
        if (request.operation === "arm" || request.operation === "disarm") value = { phase: request.operation === "arm" ? "ready" : "off", detail: "", run: null };
        receive({ type: "reply", id: request.id, value });
      }),
    } as unknown as SpindleFrontendContext;
    const dispose = setup(ctx);
    const result = { root, actions, calls, events, receive, close: () => { dispose(); actions.remove(); } };
    clients.push(result); return result;
  }
  const settle = () => Bun.sleep(2);
  try {
    const first = client(), second = client(); await settle();
    const toggle = (browser: typeof first) => browser.root.querySelector<HTMLButtonElement>(".ao-toggle")!;
    expect(toggle(first).textContent).toBe("Disable"); expect(toggle(second).textContent).toBe("Disable");
    expect(first.calls).not.toContain("arm");
    first.actions.querySelector<HTMLButtonElement>(".ao-hotbar-trigger")!.click();
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>(".ao-hotbar-profile"));
    expect(rows.map(row => row.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    rows[0].click(); await settle(); expect(saved.slotIds).toEqual(["one", "two"]);
    toggle(second).click(); await settle();
    expect(saved.enabled).toBe(false); expect(toggle(first).textContent).toBe("Enable");
    toggle(first).click(); await settle(); expect(saved.enabled).toBe(true);
    first.receive({ type: "activation", activation: { enabled: false, revision: 1 } });
    expect(toggle(first).textContent).toBe("Disable");
    const third = client(); await settle(); expect(toggle(third).textContent).toBe("Disable");
    const loads = third.calls.filter(call => call === "load").length;
    third.events.get("CONNECTED")!({}); await settle();
    expect(third.calls.filter(call => call === "load")).toHaveLength(loads);
    saved = { ...saved, enabled: false, revision: saved.revision + 1 };
    third.events.get("CONNECTED")!({ role: "owner" }); await settle();
    expect(toggle(third).textContent).toBe("Enable");
    expect(third.calls.filter(call => call === "load")).toHaveLength(loads + 1);
    failSave = true; toggle(third).click(); await settle();
    expect(saved.enabled).toBe(false); expect(third.calls).toContain("disarm");
    expect(third.root.querySelector(".ao-notice")!.textContent).toContain("Cannot save account preference");
  } finally { for (const browser of clients) browser.close(); await settle(); window.close(); Object.assign(globalThis, previous); }
});
