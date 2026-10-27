import { expect, test } from "bun:test";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import type { Bridge } from "../src/ui/bridge";
import type { Catalog, RunRecord } from "../src/shared";
import { Session } from "../src/generation/session";

function fixture() {
  const state = { preset: "source", chat: "chat", connection: "main" };
  const actions: unknown[] = [];
  const calls: Array<{ operation: string; input: any }> = [];
  let disarm = async () => ({ phase: "off", detail: "", run: null });
  let follow: () => Promise<any> = async () => ({ phase: "ready", detail: "Ready", run: null });
  let arm = async () => ({ phase: "ready", detail: "", run: null });
  let receive: (raw: unknown) => void = () => {};
  const bridge = { call: async (operation: string, input: any) => {
    calls.push({ operation, input });
    if (operation === "followFork") return follow();
    if (operation === "selectSwipe" || operation === "launch" || operation === "preparationFailed") return true;
    if (operation === "preparePreset") return { presetId: catalog.settings.slots[input.stepIndex].presetId, token: `capture-${input.stepIndex}` };
    if (operation === "arm") return arm();
    if (operation === "disarm") return disarm();
    throw new Error(`Unexpected operation: ${operation}`);
  } } as unknown as Bridge;
  const ctx = { frontendSessionId: "session", onBackendMessage: (handler: (raw: unknown) => void) => { receive = handler; return () => {}; },
    state: { get: (key: string) => key === "chat.active" ? { chatId: state.chat } : state.preset },
    connections: { getActive: () => ({ activeProfileId: state.connection }), setActiveAcknowledged: async () => { throw new Error("Connection must not change"); } },
    dom: { findMessageElement: () => null },
    host: { capabilities: { "message-preset-context-v1": 1 }, surfaces: { invoke: async (ref: unknown, input: { chatId?: string }) => {
      actions.push(ref); if (!input.chatId) throw new Error("Only chat navigation is expected"); state.chat = input.chatId;
    } } },
  } as unknown as SpindleFrontendContext;
  const catalog: Catalog = { settings: { version: 1, cats: false, slots: [{ id: "slot", presetId: "source", connectionId: null }] }, presets: [{ id: "source", name: "Source" }], connections: [{ id: "main", name: "Main" }] };
  return { state, actions, catalog, calls, setDisarm: (fn: typeof disarm) => { disarm = fn; }, setArm: (fn: typeof arm) => { arm = fn; }, setFollow: (fn: typeof follow) => { follow = fn; }, receive: (raw: unknown) => receive(raw), make: () => new Session(ctx, bridge, () => {}) };
}

test("Stop cancels backend streams and keeps the composer busy through the final save", async () => {
  const f = fixture(), session = f.make();
  await session.enable(f.catalog); expect(session.generatingChatId).toBeNull();
  const view = (phase: string) => f.receive({ type: "view", armed: true, view: { phase, detail: "", run: null } });
  view("preparing"); view("running"); view("running");
  expect(session.generatingChatId).toBe("chat");
  f.setDisarm(async () => ({ phase: "running", detail: "Stopping", run: null }));
  await session.disable("Stopped.", true);
  expect(f.calls.at(-1)).toEqual({ operation: "disarm", input: { stop: true } });
  expect(session.generatingChatId).toBe("chat");
  view("off"); expect(session.generatingChatId).toBeNull();
  expect(f.calls.some(call => call.operation === "activation")).toBe(false);
  await session.dispose();
});

test("composer controls clear on completion, failure, disconnect, navigation and unload", async () => {
  for (const end of ["ready", "error", "disconnect", "navigate", "dispose"]) {
    const f = fixture(), session = f.make(); await session.enable(f.catalog);
    f.receive({ type: "view", armed: true, view: { phase: "running", detail: "", run: null } });
    if (end === "disconnect") session.disconnected();
    else if (end === "dispose") await session.dispose();
    else if (end === "navigate") { f.state.chat = "fork"; await session.chatChanged(); }
    else f.receive({ type: "view", armed: true, view: { phase: end, detail: "", run: null } });
    expect(session.generatingChatId).toBeNull();
    await session.dispose();
  }
});

test("a delayed Stop acknowledgement cannot replace the final saved state", async () => {
  const f = fixture(), session = f.make(); await session.enable(f.catalog);
  f.receive({ type: "view", armed: true, view: { phase: "running", detail: "", run: null } });
  let finish!: (value: any) => void;
  f.setDisarm(() => new Promise(resolve => { finish = resolve; }));
  const stopping = session.disable("Stopped", true);
  f.receive({ type: "view", armed: false, view: { phase: "off", detail: "Saved", run: null } });
  finish({ phase: "running", detail: "Stopping", run: null }); await stopping;
  expect(session.view.phase).toBe("off"); expect(session.generatingChatId).toBeNull();
  await session.dispose();
});

test("late enable replies cannot undo Disable, unload, or navigation", async () => {
  for (const action of ["disable", "dispose", "navigate"]) {
    const f = fixture(), session = f.make();
    let finish!: (value: any) => void;
    f.setArm(() => new Promise(resolve => { finish = resolve; }));
    const enabling = session.enable(f.catalog);
    if (action === "navigate") { f.state.chat = "other"; await session.chatChanged(); }
    else if (action === "dispose") await session.dispose();
    else await session.disable();
    finish({ phase: "ready", detail: "", run: null }); await enabling;
    expect(session.armed).toBe(false); expect(session.enabled).toBe(false);
    expect(f.calls.some(c => c.operation === "disarm")).toBe(true);
    await session.dispose();
  }
});

test("a failed enable requests cancellation so a timed-out backend cannot arm later", async () => {
  const f = fixture(), session = f.make();
  f.setArm(async () => { throw new Error("Backend did not respond"); });
  await session.enable(f.catalog);
  expect(session.armed).toBe(false); expect(session.view.phase).toBe("error");
  expect(f.calls.map(c => c.operation)).toEqual(["arm", "disarm"]);
  await session.dispose();
});

test("enable, swipe selection, disable and unload leave the selected preset and connection untouched", async () => {
  const f = fixture(), session = f.make();
  f.catalog.settings.slots[0].connectionId = "alternate";
  await session.enable(f.catalog); expect(session.armed).toBe(true);
  const run = { id: "run", chatId: "chat", messageId: "reply", steps: [{ presetId: "other-source" }] } as RunRecord;
  await session.openSwipe(run, 0);
  await session.disable();
  await session.openSwipe(run, 0);
  await session.dispose();
  expect(f.state).toEqual({ preset: "source", connection: "main", chat: "chat" });
  expect(f.actions).toEqual([]);
  expect(f.calls.map(call => call.operation)).toEqual(["arm", "selectSwipe", "disarm", "selectSwipe"]);
});

test("a manual preset selection is preserved when disabling", async () => {
  const f = fixture(), session = f.make(); await session.enable(f.catalog);
  f.state.preset = "manually-selected";
  await session.disable(); expect(f.state.preset).toBe("manually-selected");
  await session.dispose();
});

test("a restored backend session prepares the next send; disconnect and unload never save Disable", async () => {
  const f = fixture(), session = f.make();
  f.receive({ type: "view", armed: true, view: { phase: "preparing", detail: "Preparing", run: null } });
  expect(session.armed).toBe(true);
  session.disconnected(); expect(session.armed).toBe(false);
  expect(f.calls).toEqual([]);
  f.receive({ type: "view", armed: true, view: { phase: "ready", detail: "Enabled", run: null } });
  await session.dispose();
  expect(f.calls.map(c => c.operation)).toEqual(["disarm"]);
});

test("parallel prompts use each profile's preset and variables while the user's manual selection stays unchanged", async () => {
  const f = fixture(), session = f.make(), previousFetch = globalThis.fetch;
  f.catalog.settings.slots.push({ id: "second", presetId: "second-source", connectionId: "alternate" });
  const selectedAtRequest: string[] = [];
  const dryRuns: any[] = [];
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    selectedAtRequest.push(f.state.preset);
    if (!url.includes("dry-run")) return Response.json({ id: "reply" });
    const body = JSON.parse(String(options.body)); dryRuns.push(body);
    return Response.json({ messages: [{ role: "system", content: "Display-only text" }], request_messages: [{ role: "system", content: body.preset_id },
      { role: "user", content: [{ type: "audio", data: "UklGRg==", mime_type: "audio/wav" }] },
      { role: "assistant", content: "Reply", reasoning_content: "Thought", thinking_blocks: [{ type: "thinking", thinking: "Signed", signature: "signature" }] }], parameters: {}, provider: "custom", model: body.connection_id,
      variable_state: { local: { tone: body.preset_id }, global: {}, chat: {} } });
  }) as typeof fetch;
  try {
    await session.enable(f.catalog); f.state.preset = "manually-selected";
    expect(session.armed).toBe(true);
    f.receive({ type: "prepare", runId: "run", chatId: "chat", name: "Cat", slots: [
      { presetId: "source", connectionId: "main" }, { presetId: "second-source", connectionId: "alternate" },
    ] });
    await Bun.sleep(5);
    expect(selectedAtRequest).toEqual(["manually-selected", "manually-selected", "manually-selected"]);
    expect(dryRuns.map(r => [r.preset_id, r.connection_id, r.force_preset_id])).toEqual([
      ["source", "main", true], ["second-source", "alternate", true],
    ]);
    const prompts = f.calls.find(c => c.operation === "launch")!.input.prompts;
    expect(dryRuns.every(request => request.include_request_messages === true)).toBe(true);
    expect(prompts[0].messages).toEqual([{ role: "system", content: "source" },
      { role: "user", content: [{ type: "audio", data: "UklGRg==", mime_type: "audio/wav" }] },
      { role: "assistant", content: "Reply", reasoning_content: "Thought", thinking_blocks: [{ type: "thinking", thinking: "Signed", signature: "signature" }] }]);
    expect(prompts.map((p: any) => p.variableState.local.tone)).toEqual(["source", "second-source"]);
    expect(prompts.map((p: any) => [p.provider, p.model])).toEqual([["custom", "main"], ["custom", "alternate"]]);
    expect(f.actions).toEqual([]);
    await session.disable(); expect(f.state.preset).toBe("manually-selected");
  } finally { globalThis.fetch = previousFetch; await session.dispose(); }
});

test("opening a fork keeps the session enabled without switching the user's preset", async () => {
  const f = fixture(), session = f.make(); await session.enable(f.catalog, ["slot"]);
  f.state.chat = "fork"; await session.chatChanged();
  expect(session.armed).toBe(true); expect(f.state.preset).toBe("source"); expect(f.actions).toEqual([]);
  expect(f.calls.filter(c => c.operation === "disarm")).toHaveLength(0);
  expect(f.calls.find(c => c.operation === "followFork")?.input).toEqual({ chatId: "fork" });
  await session.disable(); expect(f.state.preset).toBe("source"); await session.dispose();
});

test("a host without prepared messages fails before creating a reply or sending provider requests", async () => {
  const f = fixture(), session = f.make(), previousFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => { urls.push(url); return Response.json({ messages: [{ role: "user", content: "Display text" }] }); }) as typeof fetch;
  try {
    await session.enable(f.catalog);
    f.receive({ type: "prepare", runId: "run", chatId: "chat", name: "Cat", slots: [{ presetId: "source", connectionId: "main" }] });
    await Bun.sleep(5);
    expect(urls).toHaveLength(1); expect(urls[0]).toContain("dry-run");
    expect(f.calls.some(call => call.operation === "launch")).toBe(false);
    expect(f.calls.find(call => call.operation === "preparationFailed")?.input.error).toContain("prepared request messages");
  } finally { globalThis.fetch = previousFetch; await session.dispose(); }
});

test.each([false, true])("cancellation during reply creation cleans up before unload, with response loss %s", async lost => {
  const f = fixture(), session = f.make(), previousFetch = globalThis.fetch;
  let acknowledge!: () => void;
  let creating!: () => void;
  const created = new Promise<void>(resolve => { creating = resolve; });
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    if (url.includes("dry-run")) return Response.json({ request_messages: [{ role: "user", content: "Hi" }], parameters: {}, provider: "custom", model: "fixture" });
    return new Promise<Response>((resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      acknowledge = () => lost ? reject(new Error("Response lost after creating the reply")) : resolve(Response.json({ id: "late-reply" })); creating();
    });
  }) as typeof fetch;
  try {
    await session.enable(f.catalog);
    f.receive({ type: "prepare", runId: "run", chatId: "chat", name: "Cat", slots: [{ presetId: "source", connectionId: "main" }] });
    await created;
    const disposing = session.dispose(); acknowledge(); await disposing;
    expect(f.calls.some(c => c.operation === "launch")).toBe(false);
    expect(f.calls.find(c => c.operation === "preparationFailed")?.input).toMatchObject({ runId: "run", chatId: "chat", messageId: lost ? undefined : "late-reply" });
  } finally { globalThis.fetch = previousFetch; }
});

test("opening an unrelated chat still disables; a late fork response cannot undo Disable", async () => {
  const f = fixture(), session = f.make(); await session.enable(f.catalog);
  f.setFollow(async () => null); f.state.chat = "unrelated"; await session.chatChanged();
  expect(session.armed).toBe(false); expect(f.state.preset).toBe("source");
  await session.enable(f.catalog);
  let resolve!: (view: any) => void;
  f.setFollow(() => new Promise(r => { resolve = r; }));
  f.state.chat = "fork"; const changing = session.chatChanged();
  await session.disable(); resolve({ phase: "ready", detail: "Ready", run: null }); await changing;
  expect(session.armed).toBe(false); expect(f.state.preset).toBe("source"); await session.dispose();
});

test("returning to the original chat while a fork opens cancels the pending transfer", async () => {
  const f = fixture(), session = f.make(); await session.enable(f.catalog);
  let resolve!: (view: any) => void;
  f.setFollow(() => new Promise(r => { resolve = r; }));
  f.state.chat = "fork"; const changing = session.chatChanged();
  f.state.chat = "chat"; await session.chatChanged();
  resolve({ phase: "ready", detail: "Ready", run: null }); await changing;
  expect(session.armed).toBe(false); expect(f.state.preset).toBe("source"); await session.dispose();
});
