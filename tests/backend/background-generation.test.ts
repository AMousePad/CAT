import { expect, spyOn, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { Automation } from "../../src/backend/automation";
import { Leases } from "../../src/backend/leases";
import type { Storage } from "../../src/backend/storage";

const deferred = () => Promise.withResolvers<void>();
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

function fixture() {
  const handlers = new Map<string, Function>();
  let context!: (raw: unknown) => Promise<any>, sweep!: () => void;
  let now = 0;
  const leases = new Leases(() => now);
  const messages: any[] = [], records: any[] = [], sent: any[] = [], requests: any[] = [], sessions: any[] = [];
  const gate = deferred(), dryRunGate = deferred(), appendGate = deferred();
  let prepare = async () => {}, append = async () => {};
  let preparing = false, creating = false, aborted = false;
  const snapshot = { local: { tone: "quiet" }, global: {}, chat: {} };
  const api = {
    on: (event: string, fn: Function) => { handlers.set(event, fn); return () => {}; },
    registerContextHandler: (fn: typeof context) => { context = fn; },
    sendToFrontend: (data: unknown, user: string, options: unknown) => sent.push({ data, user, options }),
    council: { getSettings: async () => ({ councilMode: false, members: [] }) },
    chats: { get: async () => ({ id: "chat", name: "Chat", metadata: {} }) },
    memories: { chatMemory: { warm: async () => ({ status: "skipped" }) } },
    chat: {
      getMessages: async () => messages,
      appendMessage: async (_chat: string, message: any) => {
        const reply = { ...message, id: "reply", chat_id: _chat, index_in_chat: 1, swipes: [""], extra: { character_id: message.characterId } };
        messages.push(reply); creating = true; await append(); return { id: reply.id };
      },
      updateMessage: async (_chat: string, id: string, patch: any) => {
        const message = messages.find(m => m.id === id);
        Object.assign(message, { swipes: patch.swipes, content: patch.swipes[0], metadata: { ...message.metadata, ...patch.metadata_patch } });
      },
      deleteMessage: async (_chat: string, id: string) => { messages.splice(messages.findIndex(m => m.id === id), 1); },
    },
    generate: {
      dryRun: async () => {
        preparing = true; await prepare();
        return { responseContextId: "context", request_messages: [{ role: "user", content: "Hi" }],
          parameters: {}, provider: "custom", model: "fixture", variable_state: snapshot };
      },
      beginMessage: async (input: unknown) => { sessions.push(input); return { id: "managed" }; },
      abortMessage: async () => { aborted = true; },
      finishMessage: async () => ({ messageId: "reply", completed: !aborted }),
      rawStream: async function* (request: any) {
        requests.push(request); yield { type: "token", token: "partial" };
        await Promise.race([gate.promise, new Promise<void>(resolve => {
          if (request.signal.aborted) resolve(); else request.signal.addEventListener("abort", () => resolve(), { once: true });
        })]);
        if (!request.signal.aborted) yield { type: "done", content: "complete", finish_reason: "stop" };
      },
    },
  } as unknown as SpindleAPI;
  const variables = { capture: {
    create: async () => ({ token: "token", presetId: "preset" }), cancel: async () => {},
    finish: async () => ({ presetId: "preset", changes: [], local: snapshot.local, snapshot, before: { global: {}, chat: {} }, revision: null }),
  }, selection: { sync: async () => {} } } as unknown as ConstructorParameters<typeof Automation>[5];
  const storage = { activation: async () => ({ enabled: true }), history: async () => records,
    record: async (_user: string, record: unknown) => { records.push(record); } } as unknown as Storage;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
    sweep = fn; return { unref() {} };
  }) as typeof setInterval);
  let automation: Automation;
  try {
    automation = new Automation(api, storage, leases, async () => ({ settings: { version: 1, cats: false,
      slots: [{ id: "slot", presetId: "preset", connectionId: "connection" }] },
      presets: [{ id: "preset", name: "Preset" }], connections: [{ id: "connection", name: "Connection" }] }),
      async () => ({ chatId: "chat", chatName: "Chat", busy: false }), variables);
  } finally { interval.mockRestore(); }
  const emit = (event: string, value: unknown) => handlers.get(event)!(value, "user");
  return { automation, messages, records, sent, requests, sessions, gate, dryRunGate, appendGate,
    preparing: () => preparing, creating: () => creating,
    blockPreparation: () => { prepare = () => dryRunGate.promise; },
    failPreparation: () => { prepare = async () => { throw new Error("Preparation failed"); }; },
    blockAppend: () => { append = () => appendGate.promise; },
    expire: () => { now += 60_001; sweep(); },
    advance: (ms: number) => { now += ms; sweep(); },
    close: (session = "browser") => emit("FRONTEND_SESSION_CLOSED", { frontendSessionId: session }),
    stop: () => emit("GENERATION_STOPPED", { chatId: "chat", generationId: "managed" }),
    handoff: () => emit("GENERATION_STOPPED", { chatId: "chat", generationId: "native" }),
    async start() {
      await automation.arm("user", "browser", "chat", "connection");
      emit("GENERATION_STARTED", { generationId: "native", chatId: "chat", frontendSessionId: "browser", generationType: "normal", characterName: "Character", characterId: "character" });
      expect((await context({ userId: "user", chatId: "chat", frontendSessionId: "browser", generationType: "normal" })).cancelGeneration).toBe(true);
    },
  };
}

test.each(["handoff", "preparation", "reply creation", "streaming", "heartbeat expiry"])("backend generation finishes after browser loss during %s", async phase => {
  const f = fixture();
  if (phase === "preparation") f.blockPreparation();
  if (phase === "reply creation") f.blockAppend();
  await f.start();
  if (phase === "handoff") f.close();
  f.handoff();
  if (phase === "preparation") { await until(f.preparing); f.close(); f.dryRunGate.resolve(); }
  if (phase === "reply creation") { await until(f.creating); f.close(); f.appendGate.resolve(); }
  await until(() => f.requests.length === 1);
  if (phase === "streaming") f.close();
  if (phase === "heartbeat expiry") {
    f.expire();
    expect(f.automation.heartbeat("user", "browser")).toBe(true);
    f.expire();
  }
  expect(f.requests[0].signal.aborted).toBe(false);
  expect(f.sessions[0]).not.toHaveProperty("frontendSessionId");
  await expect(f.automation.arm("user", "other", "chat", "connection")).rejects.toThrow("finish");
  f.gate.resolve(); await until(() => f.records.length === 1);
  expect(f.records[0].outcome).toBe("complete");
  expect(f.messages[0]).toMatchObject({ chat_id: "chat", name: "Character", extra: { character_id: "character" }, swipes: ["complete"] });
  expect(f.messages[0].metadata.preset_contexts[0].variables.local).toEqual({ tone: "quiet" });
  expect(f.automation.isCurrentRun("user", f.records[0].id)).toBe(false);
  await f.automation.arm("user", "other", "chat", "connection");
  await f.automation.disarm("user", "other");
});

test("a reconnecting browser regains status and Stop without an old disconnect cancelling the run", async () => {
  const f = fixture(); await f.start(); f.handoff(); await until(() => f.requests.length === 1);
  f.automation.resume("user", "new-browser", "chat");
  expect(f.automation.heartbeat("user", "new-browser")).toBe(false);
  f.close(); f.automation.resume("user", "new-browser", "chat");
  expect(f.sent.at(-1).options.frontendSessionId).toBe("new-browser");
  expect(f.sent.at(-1).data.view.phase).toBe("running");
  f.close(); expect(f.requests[0].signal.aborted).toBe(false);
  await f.automation.disarm("user", "new-browser", true);
  await until(() => f.records.length === 1);
  expect(f.records[0].outcome).toBe("stopped");
});

test("native Stop still cancels a detached run", async () => {
  const f = fixture(); await f.start(); f.handoff(); await until(() => f.requests.length === 1);
  f.close(); f.stop(); await until(() => f.records.length === 1);
  expect(f.records[0].outcome).toBe("stopped");
});

test("disabled generation reports completion after reconnecting and renewing the lease", async () => {
  const f = fixture(); await f.start(); f.handoff(); await until(() => f.requests.length === 1);
  await f.automation.disarm("user", "browser"); f.close();
  f.automation.resume("user", "returning-browser", "chat");
  expect(f.sent.at(-1).data).toMatchObject({ armed: false, view: { phase: "running" } });
  f.advance(59_000); expect(f.automation.heartbeat("user", "returning-browser")).toBe(true);
  f.advance(59_000); expect(f.automation.heartbeat("user", "returning-browser")).toBe(true);
  f.gate.resolve(); await until(() => f.records.length === 1);
  expect(f.records[0].outcome).toBe("complete");
  expect(f.sent.at(-1).data).toMatchObject({ armed: false, view: { phase: "off" } });
  expect(f.sent.at(-1).options.frontendSessionId).toBe("returning-browser");
});

test("Stop during backend reply creation cleans up the late blank reply", async () => {
  const f = fixture(); f.blockAppend(); await f.start(); f.handoff(); await until(f.creating);
  await f.automation.disarm("user", "browser", true); f.appendGate.resolve();
  await until(() => f.messages.length === 0);
  expect(f.requests).toHaveLength(0);
});

test("backend preparation failures are reported before a reply is created", async () => {
  const f = fixture(); f.failPreparation(); await f.start(); f.handoff();
  await until(() => f.sent.some(s => s.data.view.phase === "error"));
  expect(f.sent.at(-1).data.view.detail).toContain("Preparation failed");
  expect(f.messages).toHaveLength(0); expect(f.requests).toHaveLength(0);
});

test("a detached preparation error is shown when the user returns to the chat", async () => {
  const f = fixture(); f.failPreparation(); await f.start(); f.close(); f.handoff();
  await until(f.preparing); await Bun.sleep(0);
  f.close();
  f.automation.resume("user", "new-browser", "elsewhere");
  expect(f.sent.some(s => s.data.view.phase === "error")).toBe(false);
  f.automation.resume("user", "new-browser", "chat");
  expect(f.sent.at(-1).data.view).toMatchObject({ phase: "error", detail: "Preparation failed" });
  expect(f.messages).toHaveLength(0); expect(f.requests).toHaveLength(0);
});
