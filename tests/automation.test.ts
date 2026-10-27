import { expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { Automation } from "../src/backend/automation";
import { Leases } from "../src/backend/leases";
import { Storage } from "../src/backend/storage";
import type { Catalog } from "../src/shared";
import { inspectChat } from "../src/backend/inspection";

function fixture(savedStorage?: Storage, variables?: ConstructorParameters<typeof Automation>[5]) {
  const handlers = new Map<string, Function>();
  let context!: (raw: unknown, signal?: AbortSignal) => Promise<any>;
  let messages: any[] = [];
  let read = async () => messages;
  let council = async () => ({ councilMode: false, members: [] });
  const sent: any[] = [], writes: string[][] = [], records: any[] = [], targets: string[] = [], deleted: string[] = [], generated: any[] = [];
  const api = {
    on: (event: string, fn: Function) => { handlers.set(event, fn); return () => {}; },
    registerContextHandler: (fn: typeof context) => { context = fn; },
    sendToFrontend: (data: unknown, _user: string, options?: { frontendSessionId: string }) => { sent.push(data); targets.push(options?.frontendSessionId ?? "all"); },
    council: { getSettings: () => council() },
    chats: { get: async (id: string) => ({ id, name: "Chat", metadata: id === "fork" ? { branched_from: "chat" } : {} }) },
    presets: { getActive: async () => { throw new Error('Unrecognized message type: "presets_get_active"'); } },
    memories: { chatMemory: { warm: async () => ({ status: "skipped" }) } },
    chat: { getMessages: () => read(), setSwipeVariables: async () => true, updateMessage: async (_c: string, id: string, patch: { swipes: string[]; metadata?: object; metadata_patch?: object }) => {
      writes.push(patch.swipes);
      const message = messages.find(m => m.id === id);
      if (message) {
        message.swipes = patch.swipes;
        const reasoning = (patch as any).swipe_reasoning;
        message.extra = { ...message.extra, reasoningBySwipe: reasoning?.map((r: any) => r.text), reasoningDurationBySwipe: reasoning?.map((r: any) => r.duration) };
      }
      if (message && patch.metadata) message.metadata = patch.metadata;
      if (message && patch.metadata_patch) message.metadata = { ...message.metadata, ...patch.metadata_patch };
    },
      deleteMessage: async (_c: string, id: string) => { deleted.push(id); } },
    generate: {
      dryRun: async () => ({ responseContextId: "context", request_messages: [{ role: "user", content: "Hi" }], parameters: {}, provider: "custom", model: "fixture" }),
      beginMessage: async () => ({ id: "managed" }), abortMessage: async () => {},
      finishMessage: async () => ({ messageId: "reply", completed: false }),
      rawStream: async function* (request: { signal: AbortSignal }) {
      const { signal } = request; generated.push(request);
      yield { type: "token", token: "partial" };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    } },
  } as unknown as SpindleAPI;
  const catalog: Catalog = { settings: { version: 1, cats: false, slots: [{ id: "slot", presetId: "p", connectionId: null }] },
    presets: [{ id: "p", name: "Preset" }], connections: [{ id: "c", name: "Connection" }] };
  const files = new Map<string, string>();
  const storage = savedStorage ?? new Storage({ exists: async (path: string, user: string) => files.has(user + path),
    read: async (path: string, user: string) => files.get(user + path)!,
    setJson: async (path: string, value: unknown, options: { userId: string }) => { files.set(options.userId + path, JSON.stringify(value)); },
  } as SpindleAPI["userStorage"]);
  storage.history = async () => records;
  storage.record = async (_user, record) => { records.push(record); };
  storage.settings = async () => catalog.settings;
  const automation = new Automation(api, storage, new Leases(), async () => catalog,
    (chatId, userId) => inspectChat(api, new Map(), chatId, userId), variables);
  const raw = { userId: "user", chatId: "chat", frontendSessionId: "session", connectionId: "c", generationType: "normal", dryRun: false };
  const emit = (event: string, payload: unknown) => handlers.get(event)!(payload, "user");
  async function arm() {
    await automation.arm("user", "session", "chat", "c");
    emit("GENERATION_STARTED", { generationId: "native", chatId: "chat", frontendSessionId: "session", generationType: "normal" });
  }
  return { automation, catalog, sent, targets, storage, writes, records, deleted, generated, raw, emit, arm, context: (signal?: AbortSignal) => context(raw, signal),
    setCouncil: (fn: typeof council) => { council = fn; },
    setRead: (fn: typeof read) => { read = fn; }, setMessages: (value: any[]) => { messages = value; } };
}

test("final streaming writes preserve metadata added by another extension", async () => {
  const f = fixture(); await f.arm(); await f.context();
  f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
  const prep = f.sent.find(s => s.type === "prepare");
  const message = { id: "reply", role: "assistant", content: "", metadata: { another_one_run: prep.runId } as Record<string, unknown> };
  f.setMessages([message]);
  await f.automation.launch("user", "session", prep.runId, "reply", [{ messages: [{ role: "user", content: "Hi" }], parameters: {}, connectionId: "c", responseContextId: "context", provider: "custom", model: "fixture" }]);
  await Bun.sleep(5);
  message.metadata.other_extension = { value: "written during streaming" };
  await f.automation.disarm("user", "session", true);
  expect(message.metadata.other_extension).toEqual({ value: "written during streaming" });
  expect(message.metadata.another_one_presets).toEqual(["p"]);
});

test("swipe identities retain asynchronously captured variables and reject failed capture before streaming", async () => {
  for (const fail of [false, true]) {
    const snapshot = { local: { mode: "one" }, global: {}, chat: { counter: "1" } };
    const variables = { capture: { create: async () => ({ token: "token", presetId: "p" }), cancel: async () => {},
      finish: async () => { await Bun.sleep(1); if (fail) throw new Error("Capture failed"); return { presetId: "p", changes: [], local: snapshot.local, snapshot,
        before: { global: snapshot.global, chat: snapshot.chat }, revision: null }; } },
      selection: { sync: async () => {} } } as unknown as ConstructorParameters<typeof Automation>[5];
    const f = fixture(undefined, variables); await f.arm(); await f.context();
    f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
    const prep = f.sent.find(s => s.type === "prepare");
    await f.automation.preparePreset("user", "session", prep.runId, 0);
    const message = { id: "reply", role: "assistant", content: "", metadata: { another_one_run: prep.runId } as Record<string, any> };
    f.setMessages([message]);
    const launch = f.automation.launch("user", "session", prep.runId, "reply", [{ messages: [{ role: "user", content: "Hi" }], captureToken: "token", parameters: {}, connectionId: "c", responseContextId: "context", provider: "custom", model: "fixture" }]);
    if (fail) { await expect(launch).rejects.toThrow("Capture failed"); expect(f.generated).toHaveLength(0); }
    else {
      await launch; await Bun.sleep(5);
      const context = message.metadata.preset_contexts[0];
      expect(context.variables).toEqual(snapshot);
      expect(message.metadata.another_one_variables.slots[0]).toMatchObject({ presetId: "p", changes: [], local: snapshot.local, swipeId: context.another_one_swipe_id });
      expect(f.automation.getRun("user", prep.runId)?.steps[0].swipeId).toBe(context.another_one_swipe_id);
    }
    await f.automation.disarm("user", "session", true);
  }
});

test("a settled run remains protected from history recovery until its final save finishes", async () => {
  const f = fixture(); await f.arm(); await f.context();
  f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
  const prep = f.sent.find(s => s.type === "prepare");
  f.setMessages([{ id: "reply", role: "assistant", content: "", metadata: { another_one_run: prep.runId } }]);
  let finish!: () => void, writing!: () => void;
  const entered = new Promise<void>(resolve => { writing = resolve; });
  f.storage.record = async () => { writing(); await new Promise<void>(resolve => { finish = resolve; }); };
  await f.automation.launch("user", "session", prep.runId, "reply", [{ messages: [{ role: "user", content: "Hi" }], parameters: {}, connectionId: "c", responseContextId: "context", provider: "custom", model: "fixture" }]);
  const stopping = f.automation.disarm("user", "session", true);
  await entered;
  expect(f.automation.getRun("user", prep.runId)?.outcome).toBe("stopped");
  expect(f.automation.isCurrentRun("user", prep.runId)).toBe(true);
  finish(); await stopping; await Bun.sleep(0);
  expect(f.automation.isCurrentRun("user", prep.runId)).toBe(false);
});

test("disabling during enable cancels ownership; concurrent enable attempts cannot race", async () => {
  const f = fixture();
  let finish!: (value: any) => void;
  f.setCouncil(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.automation.arm("user", "session", "chat", "c").catch(error => error);
  await expect(f.automation.arm("user", "second-session", "chat", "c")).rejects.toThrow("already enabling");
  expect((await f.automation.disarm("user", "session", true)).phase).toBe("off");
  finish({ councilMode: false, members: [] }); expect((await pending).message).toContain("cancelled");
  expect(f.sent.some(s => s.armed)).toBe(false);
  f.setCouncil(async () => ({ councilMode: false, members: [] }));
  await f.arm(); expect(f.sent.at(-1).armed).toBe(true);
  await f.automation.disarm("user", "session", true);
});

test("profiles can reuse the same preset with different connections", async () => {
  const f = fixture();
  f.catalog.settings.slots.push({ id: "second", presetId: "p", connectionId: "other" });
  f.catalog.connections.push({ id: "other", name: "Other connection" });
  await f.arm(); await f.context();
  f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
  expect(f.sent.find(s => s.type === "prepare").slots.map((s: any) => [s.presetId, s.connectionId])).toEqual([["p", "c"], ["p", "other"]]);
  await f.automation.disarm("user", "session", true);
});

test("disabling while the context handler awaits chat data prevents a late takeover", async () => {
  const f = fixture(); await f.arm();
  let resolve!: (value: any[]) => void;
  f.setRead(() => new Promise(r => { resolve = r; }));
  const pending = f.context();
  await f.automation.disarm("user", "session", true); resolve([]);
  expect(await pending).toBe(f.raw);
  f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
  expect(f.sent.some(s => s.type === "prepare")).toBe(false);
});

test("following a fork stops source streams before transferring ownership and keeps the profile selection", async () => {
  const f = fixture(); await f.arm();
  await f.context(); f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
  const prep = f.sent.find(s => s.type === "prepare");
  f.setMessages([{ id: "reply", index_in_chat: 12, name: "Mio", role: "assistant", content: "", metadata: { another_one_run: prep.runId } }]);
  await f.automation.launch("user", "session", prep.runId, "reply", [{ messages: [{ role: "user", content: "Hi" }], parameters: {}, connectionId: "c", responseContextId: "context", provider: "custom", model: "fixture" }]);
  await Bun.sleep(5);
  const view = await f.automation.followFork("user", "session", "fork");
  expect(view?.phase).toBe("ready"); expect(f.records[0].chatId).toBe("chat"); expect(f.records[0].outcome).toBe("stopped");
  expect(f.records[0].messageIndex).toBe(12);
  expect(f.records[0].characterName).toBe("Mio");
  expect(f.sent.at(-1).armed).toBe(true);
  f.setMessages([]); f.raw.chatId = "fork";
  f.emit("GENERATION_STARTED", { generationId: "fork-native", chatId: "fork", frontendSessionId: "session", generationType: "normal" });
  expect((await f.context()).cancelGeneration).toBe(true);
  await f.automation.disarm("user", "session", true);
});

test("deleting a streaming reply clears its view and prevents a late history entry or write", async () => {
  const f = fixture(); await f.arm();
  await f.context(); f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
  const prep = f.sent.find(s => s.type === "prepare");
  f.setMessages([{ id: "reply", index_in_chat: 12, name: "Mio", role: "assistant", content: "", metadata: { another_one_run: prep.runId } }]);
  await f.automation.launch("user", "session", prep.runId, "reply", [{ messages: [{ role: "user", content: "Hi" }], parameters: {}, connectionId: "c", responseContextId: "context", provider: "custom", model: "fixture" }]);
  await Bun.sleep(5);
  const writes = f.writes.length;
  f.setMessages([]); f.emit("MESSAGE_DELETED", { chatId: "chat", messageId: "reply" });
  expect(f.sent.at(-1).view.run).toBeNull();
  await Bun.sleep(5);
  expect(f.records).toHaveLength(0);
  expect(f.writes).toHaveLength(writes);
  expect(f.sent.at(-1).view.run).toBeNull();
});

test("prepared model overrides reach raw streaming without mutating the prepared parameters", async () => {
  const f = fixture(); await f.arm(); await f.context();
  f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
  const prep = f.sent.find(s => s.type === "prepare");
  f.setMessages([{ id: "reply", role: "assistant", content: "", metadata: { another_one_run: prep.runId } }]);
  const parameters = { model: " selected-model ", temperature: 0.7 };
  await f.automation.launch("user", "session", prep.runId, "reply", [{ connectionId: "c", responseContextId: "context", provider: "custom", model: "connection-model", parameters,
    messages: [{ role: "user", content: "Hi" }] }]);
  await Bun.sleep(0);
  expect(f.generated[0]).toMatchObject({ type: "raw", connection_id: "c", sessionId: "managed", swipeIndex: 0, provider: "custom", model: "selected-model", parameters: { temperature: 0.7 } });
  expect(f.generated[0].parameters).not.toHaveProperty("model");
  expect(parameters.model).toBe(" selected-model ");
  await f.automation.disarm("user", "session", true);
});

test("saved profile selection is nonempty and ordered without a reset after sending", async () => {
  const f = fixture(); f.catalog.settings.slots.push({ id: "second", presetId: "q", connectionId: null });
  f.catalog.presets.push({ id: "q", name: "Other" });
  await f.arm();
  await expect(f.automation.setActivation("user", { slotIds: [] })).rejects.toThrow();
  await expect(f.automation.setActivation("user", { slotIds: ["missing"] })).rejects.toThrow();
  await f.automation.setActivation("user", { enabled: true, slotIds: ["second"] });
  expect((await f.context()).cancelGeneration).toBe(true);
  f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
  expect(f.sent.find(s => s.type === "prepare").slots.map((s: any) => s.presetId)).toEqual(["q"]);
  expect(f.sent.filter(s => s.type === "profilesConsumed")).toHaveLength(0);
  expect((await f.storage.activation("user")).slotIds).toEqual(["second"]);
  await f.automation.disarm("user", "session", true);
});

test("enable works when the host rejects presets_get_active", async () => {
  const f = fixture();
  await f.arm();
  expect(f.sent.at(-1).view.phase).toBe("ready");
  await f.automation.disarm("user", "session");
});

test("failed preparation removes only its untouched blank reply, even after disarming", async () => {
  for (const protectedBy of ["none", "text", "stream", "reasoning", "attachment", "other-run"]) {
    const f = fixture(); await f.arm(); await f.context();
    f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
    const prep = f.sent.find(s => s.type === "prepare");
    await f.automation.disarm("user", "session", true);
    f.setMessages([{ id: "blank", content: protectedBy === "text" ? "User edit" : "", swipes: [""],
      extra: protectedBy === "reasoning" ? { reasoningBySwipe: ["Thought"] } : protectedBy === "attachment" ? { attachments: [{}] } : {},
      metadata: { another_one_run: protectedBy === "other-run" ? "other" : prep.runId,
        ...(protectedBy === "stream" ? { another_one_presets: ["p"] } : {}) } }]);
    await f.automation.preparationFailed("user", "session", prep.runId, "Stopped", "chat", "blank");
    expect(f.deleted).toEqual(protectedBy === "none" ? ["blank"] : []);
  }
});

test("an aborted native context is never taken over", async () => {
  const f = fixture(); await f.arm();
  const abort = new AbortController(); abort.abort();
  expect(await f.context(abort.signal)).toBe(f.raw);
  await f.automation.disarm("user", "session");
});

test("saved enable state restores after a worker restart and routes preparation to the sending browser", async () => {
  const first = fixture();
  await first.automation.setActivation("user", { enabled: true, slotIds: ["slot"] });
  const restarted = fixture(first.storage);
  restarted.raw.frontendSessionId = "new-browser";
  restarted.emit("GENERATION_STARTED", { generationId: "new-generation", chatId: "chat", frontendSessionId: "new-browser", generationType: "normal" });
  expect((await restarted.context()).cancelGeneration).toBe(true);
  restarted.emit("GENERATION_STOPPED", { generationId: "new-generation", chatId: "chat" });
  expect(restarted.sent.at(-1).type).toBe("prepare"); expect(restarted.targets.at(-1)).toBe("new-browser");
  expect(restarted.sent.at(-1).slots.map((s: any) => s.presetId)).toEqual(["p"]);
  restarted.emit("FRONTEND_SESSION_CLOSED", { frontendSessionId: "new-browser" });
  expect((await restarted.storage.activation("user")).enabled).toBe(true);
  const disabled = await restarted.automation.setActivation("user", { enabled: false });
  expect(disabled.enabled).toBe(false); expect(restarted.targets.at(-1)).toBe("all");
  restarted.emit("GENERATION_STARTED", { generationId: "disabled-generation", chatId: "chat", frontendSessionId: "new-browser", generationType: "normal" });
  expect(await restarted.context()).toBe(restarted.raw);
});

test("a different browser can send with the account preference without stealing an active run", async () => {
  const f = fixture(); await f.automation.setActivation("user", { enabled: true }); await f.arm();
  f.raw.frontendSessionId = "second-browser";
  f.emit("GENERATION_STARTED", { generationId: "second-generation", chatId: "chat", frontendSessionId: "second-browser", generationType: "normal" });
  expect((await f.context()).cancelGeneration).toBe(true);
  f.emit("GENERATION_STOPPED", { generationId: "second-generation", chatId: "chat" });
  expect(f.targets.at(-1)).toBe("second-browser");
  f.raw.frontendSessionId = "third-browser";
  f.emit("GENERATION_STARTED", { generationId: "third-generation", chatId: "elsewhere", frontendSessionId: "third-browser", generationType: "normal" });
  f.raw.chatId = "elsewhere";
  await expect(f.context()).rejects.toThrow("current swipes");
  await f.automation.setActivation("user", { enabled: false });
});

test("a saved Disable cancels automatic restoration while host inspection is pending", async () => {
  const f = fixture(); await f.automation.setActivation("user", { enabled: true });
  let finish!: (value: any) => void;
  f.setCouncil(() => new Promise(resolve => { finish = resolve; }));
  f.emit("GENERATION_STARTED", { generationId: "native", chatId: "chat", frontendSessionId: "session", generationType: "normal" });
  const pending = f.context().catch(error => error);
  for (let i = 0; !finish && i < 100; i++) await Bun.sleep(1);
  expect(typeof finish).toBe("function");
  await f.automation.setActivation("user", { enabled: false });
  finish({ councilMode: false, members: [] });
  expect((await pending).message).toContain("cancelled");
  expect(f.sent.some(s => s.armed)).toBe(false);
});

test("native swipe navigation keeps streams alive; deleting a swipe stops further writes", async () => {
  const f = fixture(); await f.arm();
  expect((await f.context()).cancelGeneration).toBe(true);
  f.emit("GENERATION_STOPPED", { generationId: "native", chatId: "chat" });
  const prep = f.sent.find(s => s.type === "prepare");
  f.setMessages([{ id: "reply", role: "assistant", content: "", metadata: { another_one_run: prep.runId } }]);
  await f.automation.launch("user", "session", prep.runId, "reply", [{ messages: [{ role: "user", content: "Hi" }], parameters: {}, connectionId: "c", responseContextId: "context", provider: "custom", model: "fixture" }]);
  await Bun.sleep(5);
  f.emit("MESSAGE_SWIPED", { action: "navigated", message: { id: "reply", swipes: ["partial"] } });
  expect(f.records).toHaveLength(0);
  const count = f.writes.length;
  f.emit("MESSAGE_SWIPED", { action: "deleted", message: { id: "reply", swipes: [] } });
  await Bun.sleep(5);
  expect(f.records[0].outcome).toBe("stopped");
  expect(f.writes).toHaveLength(count);
});
