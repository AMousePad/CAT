import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import type { RunRecord } from "../src/shared";
import { setup } from "../src/ui/app";

test.each(["a", null])("the Swipes tab stays scoped through startup (%s), navigation, late events and history reloads", async initialChatId => {
  const previous = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement,
    Image: globalThis.Image, ResizeObserver: globalThis.ResizeObserver, fetch: globalThis.fetch };
  const window = new Window();
  Object.assign(globalThis, { document: window.document, window, HTMLElement: window.HTMLElement,
    Image: function () { const image = window.document.createElement("img"); Object.defineProperty(image, "src", { set() {} }); return image; },
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response("[]", { headers: { "Content-Type": "application/json" } }),
  });
  const run = (id: string, chatId: string): RunRecord => ({ id, chatId, chatName: chatId, messageId: id, messageIndex: id.endsWith("past") ? 0 : 12, at: 1, outcome: "complete",
    steps: [{ presetId: "preset", presetName: id, connectionName: "Connection", status: "done" }] });
  const currentA = run("a-latest", "a"), pastA = run("a-past", "a"), currentB = run("b-latest", "b"), fork = run("fork-latest", "fork");
  const history = [currentB, currentA, pastA];
  const listeners = new Set<(raw: unknown) => void>(), states = new Map<string, () => void>();
  const events = new Map<string, Set<(raw: unknown) => void>>();
  const root = document.createElement("div"), actions = document.createElement("div"); document.body.append(root, actions);
  let chatId: string | null = initialChatId, badge: string | null = null, heldLoad: string | null = null, delayLoad = false;
  let holdRestore = false, heldRestore: string | null = null;
  const receive = (raw: unknown) => { for (const listener of listeners) listener(raw); };
  const catalog = () => ({ settings: { version: 1, cats: false, slots: [] }, presets: [], connections: [], history,
    activation: { enabled: false, revision: 0 } });
  const noop = () => {};
  const ctx = {
    frontendSessionId: "session", dom: { addStyle: () => noop, findMessageElement: () => null },
    ui: { registerDrawerTab: () => ({ root, tabId: "tab", setBadge: (value: string | null) => { badge = value; }, destroy: () => root.remove(), onActivate: () => noop }),
      registerInputBarAction: () => ({ onClick: () => noop, setEnabled: noop, destroy: noop }), mount: () => actions },
    state: { get: (key: string) => key === "chat.active" ? { chatId } : { open: false, tabId: "tab" },
      subscribe: (key: string, callback: () => void) => { states.set(key, callback); return () => states.delete(key); } },
    connections: { getActive: () => ({ activeProfileId: "main" }) }, host: { capabilities: { "message-preset-context-v1": true }, surfaces: { invoke: async () => {} } },
    messages: { getLatestMessageId: () => chatId && `${chatId}-latest` }, events: { on: (name: string, callback: (raw: unknown) => void) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name)!.add(callback); return () => events.get(name)!.delete(callback);
    } },
    onBackendMessage: (listener: (raw: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendToBackend: (request: { id: string; operation: string; input: { chatId?: string } }) => queueMicrotask(() => {
      if (request.operation === "load" && delayLoad) { heldLoad = request.id; return; }
      if (request.operation === "restoreContexts") {
        if (holdRestore) { heldRestore = request.id; return; }
        receive({ type: "reply", id: request.id, value: Object.fromEntries(history.filter(r => r.chatId === request.input.chatId)
          .map(r => [r.messageId, { index: r.messageIndex, name: "Mio" }])) }); return;
      }
      receive({ type: "reply", id: request.id, value: request.operation === "load" ? catalog() : { phase: "off", detail: "Disabled", run: null } });
    }),
  } as unknown as SpindleFrontendContext;
  const dispose = setup(ctx);
  const navigate = (id: string | null) => { chatId = id; states.get("chat.active")!(); };
  const rows = () => Array.from(root.querySelectorAll(".ao-step-copy strong"), el => el.textContent);
  const show = (record: RunRecord, phase = "off") => receive({ type: "view", armed: false, view: { phase, detail: `Status from ${record.chatId}`, run: record } });
  try {
    expect(rows()).toEqual([]);
    await Bun.sleep(2);
    if (!initialChatId) {
      expect(rows()).toEqual([]); expect(root.textContent).toContain("Open a chat to see swipes.");
      show(currentB);
      expect(rows()).toEqual([]);
      navigate("a");
    }
    expect(rows()).toEqual(["a-latest", "a-past"]);
    expect(Array.from(root.querySelectorAll(".ao-run-title .ao-count"), el => el.textContent)).toEqual(["#12", "#0"]);
    expect(root.querySelector(".ao-run-head time")!.getAttribute("datetime")).toBe(new Date(currentA.at).toISOString());
    expect(root.querySelector(".ao-run-head .ao-badge")).toBeNull();
    expect(root.querySelector(".ao-run-head button")).toBeNull();
    expect(root.querySelectorAll<HTMLButtonElement>(".ao-step")[0].disabled).toBe(false);
    expect(root.querySelectorAll<HTMLButtonElement>(".ao-step")[1].disabled).toBe(true);
    show(currentA);
    expect(rows()).toEqual(["a-latest", "a-past"]); // Current run must not duplicate saved history.
    navigate("b");
    expect(rows()).toEqual(["b-latest"]);
    expect(root.querySelector(".ao-status")!.textContent).not.toContain("Status from a");
    show({ ...currentA, outcome: "running" }, "running");
    expect(rows()).toEqual(["b-latest"]); expect(badge).toBeNull();
    expect(root.querySelector(".ao-status button")).toBeNull();
    show(currentA);
    navigate(null);
    expect(rows()).toEqual([]); expect(root.textContent).toContain("Open a chat to see swipes.");
    navigate("a"); expect(rows()).toEqual(["a-latest", "a-past"]);

    delayLoad = true; receive({ type: "historyChanged" }); await Bun.sleep(2);
    expect(heldLoad).not.toBeNull();
    navigate("b"); expect(rows()).toEqual(["b-latest"]);
    history.unshift(fork);
    receive({ type: "reply", id: heldLoad!, value: catalog() }); await Bun.sleep(2);
    expect(rows()).toEqual(["b-latest"]);
    navigate("fork"); expect(rows()).toEqual(["fork-latest"]);
    navigate("empty"); expect(rows()).toEqual([]); expect(root.textContent).toContain("No swipes yet.");
    expect(history).toHaveLength(4);

    delayLoad = false; navigate("a"); await Bun.sleep(2);
    expect(root.querySelector(".ao-run-character")!.textContent).toBe("Mio");
    show({ ...currentA, outcome: "stopped", detail: "Stopped. Partial replies saved." });
    expect(root.querySelector(".ao-run")!.textContent).not.toContain("Stopped. Partial replies saved.");
    holdRestore = true; receive({ type: "historyChanged" }); await Bun.sleep(2);
    expect(heldRestore).not.toBeNull();
    const remove = (id: string) => {
      history.splice(history.findIndex(r => r.id === id), 1);
      for (const callback of events.get("MESSAGE_DELETED")!) callback({ chatId: "a", messageId: id });
    };
    remove("a-past"); expect(rows()).toEqual(["a-latest"]);
    receive({ type: "reply", id: heldRestore!, value: { "a-past": { index: 0, name: "Stale" } } }); await Bun.sleep(2);
    expect(rows()).toEqual(["a-latest"]);
    holdRestore = false;
    remove("a-latest"); expect(rows()).toEqual([]);
    receive({ type: "historyChanged" }); await Bun.sleep(2);
    show(currentA); // A late view must not resurrect a reply after its history was removed.
    expect(rows()).toEqual([]);
    for (const callback of events.get("MESSAGE_DELETED")!) callback({ chatId: "a", messageId: "a-latest" });
    navigate("b"); navigate("a"); await Bun.sleep(2);
    expect(rows()).toEqual([]);
  } finally { dispose(); await Bun.sleep(2); window.close(); Object.assign(globalThis, previous); }
});
