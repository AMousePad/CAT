/** Real isolated host + extension worker + concurrent streaming local provider. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import type { Operations, Reply, Preparation } from "../src/types";
import type { ViewState } from "../src/shared";
import { PRESET_CHANGE_NOTE } from "../src/generation/preset-context";

const repo = resolve(import.meta.dir, "..");
const host = resolve(process.argv[2] || "../Lumiverse");
const installedIndex = process.argv.indexOf("--installed");
const probePath = process.argv[installedIndex + 1];
const installedProbes = installedIndex < 0 ? undefined : await Bun.file(resolve(repo,
  probePath && !probePath.startsWith("--") ? probePath : "local/preset-probes.json")).json();
const runDir = join(repo, "local", "host", String(Date.now()));
mkdirSync(runDir, { recursive: true }); process.chdir(runDir);
const port = Number(process.env.ANOTHER_ONE_TEST_PORT || 18790);
const origin = `http://localhost:${port}`;
Object.assign(process.env, { DATA_DIR: join(runDir, "data"), PORT: String(port), FRONTEND_DIR: process.env.ANOTHER_ONE_TEST_FRONTEND_DIR || join(host, "frontend", "dist"),
  OWNER_USERNAME: "anotherone_test", OWNER_PASSWORD: "", AUTH_SECRET: "", ENCRYPTION_KEY: "", TRUSTED_ORIGINS: origin,
  LUMIVERSE_FORCE_BUN_WORKERS: "1", LUMIVERSE_LANCEDB_STARTUP_MAINTENANCE: "off" });
const fromHost = (path: string) => import(pathToFileURL(join(host, "src", path)).href);
const password = crypto.randomUUID();
let cookie = "";
let socket: WebSocket | undefined;
let view: ViewState | undefined;
let preparation: Preparation | undefined;
let failB = false;
let active = 0, maxActive = 0;
let tokenDelay = 90;
let firstTokenDelay = 0;
const requests: any[] = [];
const results: string[] = [];
const session = crypto.randomUUID().replaceAll("-", "");
const replies = new Map<string, Reply>();
const generationEvents: Array<{ event: string; payload: any }> = [];
const provider = Bun.serve({ port: port + 1, hostname: "127.0.0.1", async fetch(req) {
  if (req.method === "GET") return Response.json({ data: [{ id: "fixture-main" }, { id: "fixture-alt" }] });
  const body = await req.json() as any;
  const marker = String(body.messages.find((m: any) => String(m.content).includes("PRESET_"))?.content).match(/PRESET_[ABC]/)?.[0] || "unknown";
  requests.push({ ...body, marker, at: Date.now() });
  if (failB && marker === "PRESET_B") return new Response("Synthetic B failure", { status: 400 });
  active++; maxActive = Math.max(active, maxActive);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ async start(controller) {
    try {
      if (firstTokenDelay) await Bun.sleep(firstTokenDelay);
      for (let i = 1; i <= 3; i++) {
        await Bun.sleep(tokenDelay);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: `${marker} thought${i} ` }, finish_reason: null }] })}\n\n`));
      }
      for (let i = 1; i <= 30; i++) {
        await Bun.sleep(tokenDelay);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${marker} word${i} ` }, finish_reason: null }] })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } })}\n\ndata: [DONE]\n\n`));
      controller.close();
    } catch { /* A stop intentionally closes the consumer. */ }
    finally { active--; }
  } });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
} });
async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(origin + path, { method, headers: { "content-type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  if (response.headers.has("set-cookie")) cookie = response.headers.getSetCookie().map(s => s.split(";")[0]).join("; ");
  const value = await response.json(); assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value;
}
async function until<T>(label: string, read: () => T | Promise<T>, valid: (value: T) => boolean, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (valid(value)) return value; await Bun.sleep(25); }
  throw new Error(`Timed out: ${label}; view=${JSON.stringify(view)}`);
}
function pass(text: string) { results.push(text); console.log(`HOST PASS: ${text}`); }
try {
  const { initDatabase } = await fromHost("db/connection.ts");
  const { runMigrations } = await fromHost("db/migrate.ts"); await runMigrations(initDatabase());
  const { hashPassword } = await fromHost("crypto/password.ts");
  const { writeOwnerCredentials } = await fromHost("crypto/credentials.ts");
  await writeOwnerCredentials(join(process.env.DATA_DIR!, "owner.credentials"), "anotherone_test", await hashPassword(password));
  const manager = await fromHost("spindle/manager.service.ts");
  const files = new Map<string, Uint8Array>();
  for (const file of ["spindle.json", "dist/backend.js", "dist/frontend.js"]) files.set(file, new Uint8Array(await Bun.file(join(repo, file)).arrayBuffer()));
  const extension = await manager.installFromFiles(files, {});
  for (const permission of extension.permissions) manager.grantPermission("another_one", permission);
  manager.enable("another_one"); await fromHost("main.ts");
  await api("/api/auth/sign-in/username", "POST", { username: "anotherone_test", password });
  const { user } = await api("/api/auth/get-session");
  const { buildPortablePresetExportAsync } = await fromHost("services/preset-export.service.ts");
  const BunWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  async function connectBrowser(frontendSession: string) {
    socket = new BunWebSocket(`ws://localhost:${port}/api/ws?frontend_session=${frontendSession}`, { headers: { Cookie: cookie, Origin: origin } });
    socket.addEventListener("message", event => {
      const msg = JSON.parse(String(event.data));
      if (msg.event?.startsWith("GENERATION_") || msg.event === "STREAM_TOKEN_RECEIVED") generationEvents.push(msg);
      if (msg.event !== "SPINDLE_FRONTEND_MSG") return;
      const data = msg.payload.data;
      if (data.type === "reply") replies.set(data.id, data);
      else if (data.type === "view") view = data.view;
      else if (data.type === "prepare") preparation = data;
    });
    await until("WebSocket", () => socket!.readyState, state => state === WebSocket.OPEN);
  }
  await connectBrowser(session);
  await until("worker boot", () => api("/api/v1/spindle"), v => v.extensions.some((e: any) => e.id === extension.id && e.status === "running"));
  async function rpc<K extends keyof Operations>(operation: K, input: Operations[K]["input"]): Promise<Operations[K]["output"]> {
    const id = crypto.randomUUID();
    socket!.send(JSON.stringify({ type: "SPINDLE_BACKEND_MSG", extensionId: extension.id, payload: { type: "request", id, operation, input } }));
    const reply = await until(operation, () => replies.get(id), Boolean); replies.delete(id);
    if (reply!.error) throw new Error(reply!.error); return reply!.value as Operations[K]["output"];
  }
  const connection = await api("/api/v1/connections", "POST", { name: "Main · local fixture", provider: "custom", api_url: `http://127.0.0.1:${port + 1}/v1`, model: "fixture-main", is_default: true });
  const alternate = await api("/api/v1/connections", "POST", { name: "Alternate · local fixture", provider: "custom", api_url: `http://127.0.0.1:${port + 1}/v1`, model: "fixture-alt" });
  const character = await api("/api/v1/characters", "POST", { name: "Miso", description: "A quiet little cat at a rainy window.", first_mes: "Hello from the isolated test chat." });
  const chat = await api("/api/v1/chats", "POST", { character_id: character.id, name: "Another One verification" });
  const presets: { id: string }[] = [];
  const { DEFAULT_SAMPLER_OVERRIDES } = await import(pathToFileURL(join(host, "frontend/src/lib/loom/constants.ts")).href);
  for (const [index, name] of ["A · Storyteller", "B · Dialogue", "C · Reflection"].entries()) {
    const block = { enabled: true, role: "system", position: "pre_history", depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null };
    const marker = "ABC"[index];
    const content = `PRESET_${marker}: Write one reply. TONE={{var::ao_tone}};LOCAL={{getvar::ao_tone}};INITIAL={{getvar::ao_scratch}};{{setvar::ao_scratch::${marker}}}AFTER={{getvar::ao_scratch}};{{setgvar::ao_probe_global::${marker}}}GLOBAL={{getgvar::ao_probe_global}};COUNT={{addchatvar::ao_probe_counter::${10 ** index}}};`;
    const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    const sealed = index === 0 ? {} : { sealed: true, sealedKey: "main", sealedOriginPresetId: `fixture-${marker}`, sealedOriginVersion: "1", sealedSha256: sha256,
      ...(index === 1 ? { sealedSource: "lumihub" } : {}) };
    const originMetadata = index === 0 ? {} : { _lumiverse_install_source: index === 1 ? "lumihub" : "illarin", _lumiverse_lumihub_id: `fixture-${marker}`,
      ...(index === 1 ? { _lumiverse_sealed_preset: { version: "1", blocks: [{ key: "main", sha256 }] } } : {}) };
    presets.push(await api("/api/v1/presets", "POST", { name, provider: "loom", metadata: { ...originMetadata, promptVariables: { main: { ao_tone: `saved_${marker}` } } }, parameters: { samplerOverrides: { ...DEFAULT_SAMPLER_OVERRIDES, enabled: index !== 1, temperature: .3 + index * .2, topP: .8 + index * .05, maxTokens: 512 } },
      prompt_order: [{ ...block, id: "main", name: "Main", variables: [{ id: "tone", name: "ao_tone", label: "Tone", type: "text", defaultValue: `default_${marker}` }],
        ...sealed, content, marker: null },
        { ...block, id: "history", name: "Chat History", content: "", marker: "chat_history" }] }));
    const rule = await api("/api/v1/regex-scripts", "POST", { name: `Prompt rule ${marker}`, preset_id: presets[index].id,
      target: ["prompt"], placement: ["world_info"], find_regex: "PRESET_", replace_string: `RULE_${marker}:PRESET_` });
    await api(`/api/v1/regex-scripts/${rule.id}/toggle`, "PUT", { disabled: false, active_preset_id: presets[index].id });
  }
  const unsupported = await api("/api/v1/presets", "POST", { name: "LumiRealm fixture", provider: "loom", metadata: { source: "risupreset", lumirealm: { defaultVariables: "a=1" } } });
  await api("/api/v1/settings", "PUT", { activeLoomPresetId: presets[0].id, activeProfileId: connection.id, activeChatId: chat.id });
  const vanillaDryRun = await api("/api/v1/generate/dry-run", "POST", { chat_id: chat.id, connection_id: connection.id, generation_type: "normal" });
  assert(!Object.hasOwn(vanillaDryRun, "variable_state"));
  assert(!Object.hasOwn(vanillaDryRun, "request_messages"));
  pass("ordinary native dry runs retain their response shape without snapshot allocation");
  const legacy = await api("/api/v1/presets", "POST", { name: "Renamed compatibility preset", provider: "loom", metadata: { another_one: { kind: "controller", version: 1 } } });
  const sameName = await api("/api/v1/presets", "POST", { name: "CAT (Cross-Compatibility Preset)", provider: "loom" });
  await api("/api/v1/settings", "PUT", { activeLoomPresetId: legacy.id });
  const catalog = await rpc("load", {});
  const remainingPresets = (await api("/api/v1/presets?limit=100")).data;
  assert(!remainingPresets.some((p: any) => p.id === legacy.id));
  assert(catalog.presets.some(p => p.id === sameName.id));
  const selectionAfterCleanup = (await api("/api/v1/settings/activeLoomPresetId")).value;
  assert(remainingPresets.some((p: any) => p.id === selectionAfterCleanup));
  await api("/api/v1/settings", "PUT", { activeLoomPresetId: presets[0].id });
  pass("legacy controller presets are retired by ownership while same-name user presets and a usable active selection survive");
  assert(!catalog.presets.some(p => p.id === unsupported.id));
  pass("LumiRealm presets are excluded from source profiles");
  catalog.settings.slots = presets.map((p, index) => ({ id: crypto.randomUUID(), presetId: p.id, connectionId: index === 1 ? alternate.id : null }));
  catalog.settings.cats = true; await rpc("save", { settings: catalog.settings });
  pass("real worker loads and saves the preset/connection sequence");

  const boundPreset = await api("/api/v1/presets", "POST", { name: "Conflicting connection preset", provider: "custom",
    parameters: { temperature: 1.9, stop: ["BOUND_ONLY"], model: "bound-only-model" } });
  for (const profile of [connection, alternate]) await api(`/api/v1/connections/${profile.id}`, "PUT", { preset_id: boundPreset.id });

  async function begin(text: string, targetChatId = chat.id) {
    preparation = undefined;
    await api(`/api/v1/chats/${targetChatId}/messages`, "POST", { is_user: true, name: "User", content: text });
    await api("/api/v1/generate", "POST", { chat_id: targetChatId, connection_id: connection.id, preset_id: presets[0].id, generation_type: "normal" });
    const prepared = await until("native send handoff", () => preparation, Boolean) as Preparation;
    const prompts = await Promise.all(prepared.slots.map(async (s, stepIndex) => {
      const source = await api(`/api/v1/presets/${s.presetId}`);
      const capture = await rpc("preparePreset", { runId: prepared.runId, stepIndex });
      const copy = await api(`/api/v1/presets/${capture.presetId}`);
      assert.equal(capture.presetId, source.id);
      if (source.prompt_order[0].sealed) {
        assert.deepEqual(copy.prompt_order, source.prompt_order);
        const portable = await buildPortablePresetExportAsync(user.id, copy);
        assert.equal(portable.blocks[0].content, "{{presetBlock::main}}");
        assert(!JSON.stringify(portable).includes(source.prompt_order[0].content));
        assert.deepEqual(copy.metadata._lumiverse_sealed_preset, source.metadata._lumiverse_sealed_preset);
      }
      assert.deepEqual(await api(`/api/v1/presets/${s.presetId}`), source, "preparing must not modify the source preset");
      return capture.prompt;
    }));
    const reply = await api(`/api/v1/chats/${targetChatId}/messages`, "POST", { is_user: false, name: prepared.name, content: "", extra: { character_id: character.id, spindle_metadata: { another_one_run: prepared.runId } } });
    await rpc("launch", { runId: prepared.runId, messageId: reply.id, prompts });
    return reply.id;
  }
  await rpc("arm", { chatId: chat.id, connectionId: connection.id });
  const { interceptorPipeline } = await fromHost("spindle/interceptor-pipeline.ts");
  interceptorPipeline.register({ extensionId: "synthetic-audio", priority: 100, handler: async (messages: any[]) => ({ messages: messages.map(message => message.role === "user"
    ? { ...message, content: [{ type: "text", text: message.content }, { type: "audio", data: "UklGRg==", mime_type: "audio/wav" }] } : message) }) });
  const replyId = await begin("USER_TURN_ONE: Tell me about the rain.");
  await until("three concurrent provider streams", () => maxActive, n => n === 3);
  const thinking = await until("parallel reasoning before prose", async () => (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1),
    m => m.extra.reasoningBySwipe?.length === 3 && m.extra.reasoningBySwipe.every((r: string) => r?.includes("thought1")));
  assert(thinking.swipes.every((s: string) => s === ""));
  assert(thinking.extra.reasoning.startsWith("PRESET_A thought1"));
  pass("all three reasoning streams are saved before any prose arrives");
  const live = await until("all three native swipe slots contain live tokens", async () => (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1), m => m.swipes.length === 3 && m.swipes.every((s: string) => s.includes("word1")) && !m.swipes.some((s: string) => s.includes("word30")));
  assert.equal(live.id, replyId); assert.equal(active, 3);
  assert.deepEqual(live.extra.spindle_metadata.another_one_presets, presets.map(p => p.id));
  const liveRun = view!.run!;
  const messageService = await fromHost("services/chats.service.ts");
  const concurrentMessage = messageService.getMessage(user.id, replyId);
  messageService.updateMessage(user.id, replyId, { extra: { ...concurrentMessage.extra,
    spindle_metadata: { ...concurrentMessage.extra.spindle_metadata, other_extension: { value: "written during streaming" } } } });
  assert.equal(await rpc("selectSwipe", { chatId: chat.id, runId: liveRun.id, stepIndex: 2 }), true);
  assert.equal((await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1).swipe_id, 2);
  await rpc("selectSwipe", { chatId: chat.id, runId: liveRun.id, stepIndex: 0 });
  const navigated = await api(`/api/v1/chats/${chat.id}/messages/${replyId}/swipe`, "POST", { direction: "right" });
  assert.equal(navigated.swipe_id, 1);
  pass("three provider requests overlap and all three native swipes grow before any finishes");
  await until("completed set", () => view, v => v?.phase === "ready" && v.run?.outcome === "complete");
  assert.equal(requests.length, 3, "the replaced native generation must not send an extra model request");
  const saved = (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1);
  assert.deepEqual(saved.extra.spindle_metadata.other_extension, { value: "written during streaming" });
  pass("final stream writes retain metadata added by another extension");
  assert.equal(saved.id, replyId); assert.equal(saved.name, "Miso");
  assert.equal(saved.swipe_id, 1, "stream writes must preserve the user's selected swipe");
  assert.deepEqual(saved.extra.reasoningBySwipe, [..."ABC"].map(marker => [1, 2, 3].map(i => `PRESET_${marker} thought${i} `).join("")));
  assert.equal(saved.extra.reasoning, saved.extra.reasoningBySwipe[1]);
  assert(saved.extra.reasoningDurationBySwipe.every((ms: number) => ms > 0));
  assert(saved.swipes.every((s: string) => !s.includes("thought")));
  pass("reasoning stays separate from prose and follows the swipe selected during streaming");
  assert.equal(new Set(saved.extra.spindle_metadata.preset_contexts.map((context: any) => context.another_one_swipe_id)).size, 3);
  const editedText = saved.content + " Edited by an automatic tool.";
  await api(`/api/v1/chats/${chat.id}/messages/${replyId}`, "PUT", { content: editedText });
  await rpc("selectSwipe", { chatId: chat.id, runId: liveRun.id, stepIndex: 0 });
  await rpc("selectSwipe", { chatId: chat.id, runId: liveRun.id, stepIndex: 1 });
  assert.equal((await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1).content, editedText);
  pass("native content edits preserve CAT swipe selection and per-swipe variables");
  for (const [i, marker] of [..."ABC"].entries()) {
    assert(saved.swipes[i].startsWith(`PRESET_${marker}`)); assert(saved.swipes[i].includes("word30"));
    const req = requests.find(r => r.marker === `PRESET_${marker}`);
    assert.equal(req.model, i === 1 ? "fixture-alt" : "fixture-main");
    if (i === 1) assert.equal(req.temperature, undefined);
    else assert(Math.abs(req.temperature - (.3 + i * .2)) < .0001);
    assert(!(req.stop ?? []).includes("BOUND_ONLY"));
    assert(JSON.stringify(req.messages).includes("USER_TURN_ONE"));
    assert.equal(req.messages.filter((m: any) => m.content === PRESET_CHANGE_NOTE).length, 1);
    assert(req.messages.some((m: any) => String(m.content).includes(`TONE=saved_${marker};LOCAL=saved_${marker};INITIAL=;AFTER=${marker};GLOBAL=${marker};COUNT=${10 ** i};`)));
    assert.deepEqual(JSON.stringify(req.messages).match(/RULE_[ABC]:/g), [`RULE_${marker}:`]);
    assert(!JSON.stringify(req.messages).includes("anotherone_capture_variables"));
  }
  pass("slot order, full replies, preset samplers and optional connections are preserved with no extra native call");
  assert(requests.every(request => request.messages.some((message: any) => Array.isArray(message.content)
    && message.content.some((part: any) => part.type === "input_audio" && part.input_audio?.data === "UklGRg=="))));
  interceptorPipeline.unregisterByExtension("synthetic-audio");
  pass("interceptor-injected audio reaches every provider request as structured media");
  pass("bound connection presets cannot replace prepared models or inject disabled samplers and stop strings");
  assert.equal((await api("/api/v1/settings/activeLoomPresetId")).value, presets[0].id);
  assert(!(await api("/api/v1/presets?limit=100")).data.some((p: any) => p.metadata?.another_one?.kind === "controller"));
  pass("normal sends and swipe selection preserve the selected source preset; each prompt uses only its own preset regex once");
  pass("every mixed-preset request contains the exact note once; replies retain preset provenance");
  const variableChat = await api(`/api/v1/chats/${chat.id}`);
  assert.equal(variableChat.metadata.macro_variables.global.ao_probe_global, "B");
  assert.equal(variableChat.metadata.chat_variables.ao_probe_counter, "10");
  assert.deepEqual(saved.extra.spindle_metadata.another_one_variables.slots.map((s: any) => s.local.ao_scratch), ["A", "B", "C"]);
  assert(!(await api("/api/v1/presets?limit=100")).data.some((p: any) => p.metadata?.another_one?.kind === "preparation"));
  pass("preset variables stay isolated; native arrows apply only the selected swipe's persistent state without copying presets");
  pass("sealed LumiHub and legacy Illarin blocks generate normally, exports hide their content, and source presets stay unchanged");
  assert.equal((await rpc("load", { chatId: chat.id })).history[0].outcome, "complete");
  await api(`/api/v1/chats/${chat.id}/messages/${replyId}/swipe/0`, "DELETE");
  await rpc("selectSwipe", { chatId: chat.id, runId: liveRun.id, stepIndex: 2 });
  const afterDeletion = (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1);
  assert.equal(afterDeletion.swipe_id, 1);
  assert.deepEqual(afterDeletion.extra.reasoningBySwipe, saved.extra.reasoningBySwipe.slice(1));
  assert.equal(afterDeletion.extra.reasoning, saved.extra.reasoningBySwipe[2]);
  assert.equal((await api(`/api/v1/chats/${chat.id}`)).metadata.chat_variables.ao_probe_counter, "100");
  pass("result selection works during streams and follows a retained swipe after an earlier swipe is deleted");
  const sourceA = await api(`/api/v1/presets/${presets[0].id}`);
  await api(`/api/v1/presets/${sourceA.id}`, "PUT", { expected_cache_revision: sourceA.cache_revision,
    metadata: { ...sourceA.metadata, promptVariables: { main: { ao_tone: "edited_A" } } } });
  failB = true;
  await begin("USER_TURN_TWO: One preset fails.");
  await until("partial failure", () => view, v => v?.phase === "error" && v.run?.outcome === "error");
  assert.deepEqual(view!.run!.steps.map(s => s.status), ["done", "error", "done"]);
  assert.equal(requests.length, 6); failB = false;
  const secondA = requests.slice(3).find(r => r.marker === "PRESET_A");
  assert(secondA.messages.some((m: any) => String(m.content).includes("COUNT=101;")));
  assert(secondA.messages.some((m: any) => String(m.content).includes("TONE=edited_A;LOCAL=edited_A;")));
  assert.equal(saved.extra.spindle_metadata.another_one_variables.slots[0].local.ao_tone, "saved_A");
  pass("source-preset edits affect new requests while earlier swipes retain their captured variables");
  pass("one provider failure leaves its siblings streaming and preserves their completed replies");
  await rpc("arm", { chatId: chat.id, connectionId: connection.id });
  await rpc("activation", { enabled: true, slotIds: [catalog.settings.slots[1].id] });
  const beforeSubset = requests.length;
  const subsetId = await begin("NEXT_PROFILES: use just the selected profile.");
  await until("one selected profile completes", () => view, v => v?.phase === "ready" && v.run?.messageId === subsetId && v.run?.outcome === "complete");
  assert.equal(requests.length, beforeSubset + 1); assert.equal(requests.at(-1).marker, "PRESET_B");
  assert.equal((await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1).swipes.length, 1);
  await assert.rejects(rpc("selectSwipe", { chatId: chat.id, runId: liveRun.id, stepIndex: 2 }), /latest reply/);
  pass("hotbar selection generates only the requested next profile; older replies cannot be selected");
  tokenDelay = 15;
  const repeatedSubsetId = await begin("SAME_PROFILES: keep my profile selection.");
  await until("same selected profile completes", () => view, v => v?.phase === "ready" && v.run?.messageId === repeatedSubsetId);
  assert.equal(requests.length, beforeSubset + 2); assert.equal(requests.at(-1).marker, "PRESET_B");
  assert.equal(view!.run!.steps.length, 1);
  pass("hotbar selection persists across consecutive sends until changed explicitly");
  await rpc("activation", { enabled: true, slotIds: catalog.settings.slots.map(s => s.id) });
  tokenDelay = 90;
  const stoppedId = await begin("USER_TURN_THREE: Stop the parallel streams.");
  await until("partial tokens", async () => (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1), m => m.swipes.length === 3 && m.swipes.every((s: string) => s.includes("word1")));
  await rpc("disarm", { stop: true });
  await until("all stopped", () => view, v => v?.run?.outcome === "stopped" && v.phase === "off");
  const stopped = (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1);
  assert.equal(stopped.id, stoppedId); assert(stopped.swipes.every((s: string) => s.includes("word1") && !s.includes("word30")));
  pass("explicitly re-enabling all profiles affects the next send; Stop retains all partial swipes");

  await rpc("arm", { chatId: chat.id, connectionId: connection.id });
  await begin("STOP_DURING_REASONING");
  await until("partial reasoning to stop", async () => (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1),
    m => m.extra.reasoningBySwipe?.every((r: string) => r?.includes("thought1")));
  await rpc("disarm", { stop: true });
  await until("reasoning stopped", () => view, v => v?.run?.outcome === "stopped" && v.phase === "off");
  const stoppedThinking = (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1);
  assert(stoppedThinking.swipes.every((s: string) => s === ""));
  assert(stoppedThinking.extra.reasoningBySwipe.every((r: string) => r.includes("thought1")));
  assert(stoppedThinking.extra.reasoningDurationBySwipe.every((ms: number) => ms > 0));
  pass("stopping before prose retains partial reasoning and its duration for every swipe");

  await rpc("arm", { chatId: chat.id, connectionId: connection.id });
  const editedReasoningId = await begin("EDIT_REASONING_DURING_STREAM");
  const beforeReasoningEdit = await until("reasoning to edit", async () => (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1),
    m => m.extra.reasoningBySwipe?.every((r: string) => r?.includes("thought1")));
  await api(`/api/v1/chats/${chat.id}/messages/${editedReasoningId}`, "PUT", { extra: { ...beforeReasoningEdit.extra, reasoning: "User correction" } });
  await until("reasoning edit stops generation", () => view, v => v?.run?.outcome === "stopped" && v.phase === "off");
  const editedReasoning = (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data.at(-1);
  assert.equal(editedReasoning.extra.reasoning, "User correction");
  assert.equal(editedReasoning.extra.reasoningBySwipe[0], "User correction");
  pass("editing reasoning during generation stops streaming and preserves the user's correction");

  tokenDelay = 15;
  await rpc("arm", { chatId: chat.id, connectionId: connection.id });
  const forkBaseId = await begin("FORK_BASE: A completed latest reply.");
  await until("fork base complete", () => view, v => v?.phase === "ready" && v.run?.messageId === forkBaseId);
  const sourceMessages = (await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data;
  const sourceMetadata = (await api(`/api/v1/chats/${chat.id}`)).metadata;
  const latestFork = await api(`/api/v1/chats/${chat.id}/branch`, "POST", { message_id: forkBaseId });
  await api("/api/v1/settings", "PUT", { activeChatId: latestFork.id });
  assert.equal((await rpc("followFork", { chatId: latestFork.id }))?.phase, "ready");
  const copied = (await api(`/api/v1/chats/${latestFork.id}/messages?full=true`)).data;
  for (const [index, message] of copied.entries()) {
    assert.notEqual(message.id, sourceMessages[index].id);
    assert.deepEqual(message.swipes, sourceMessages[index].swipes);
    assert.equal(message.swipe_id, sourceMessages[index].swipe_id);
    assert.deepEqual(message.extra.spindle_metadata?.preset_contexts, sourceMessages[index].extra.spindle_metadata?.preset_contexts);
  }
  assert.equal((await api(`/api/v1/chats/${latestFork.id}`)).metadata._swipe_variable_state.messageId, copied.at(-1).id);
  const forkHistory = (await rpc("load", { chatId: latestFork.id })).history.filter(r => r.chatId === latestFork.id);
  const lastRun = forkHistory.find(r => r.messageId === copied.at(-1).id)!;
  assert(lastRun);
  await rpc("selectSwipe", { chatId: latestFork.id, runId: lastRun.id, stepIndex: 1 });
  await rpc("selectSwipe", { chatId: latestFork.id, runId: lastRun.id, stepIndex: 0 });
  await assert.rejects(rpc("selectSwipe", { chatId: latestFork.id, runId: forkHistory.find(r => r.messageId === copied[2].id)!.id, stepIndex: 0 }), /latest reply/);
  pass("latest forks copy every swipe and captured context, remap variable ownership and expose selectable fork-local results");
  const forkReply = copied.at(-1);
  assert.deepEqual(forkReply.extra.reasoningBySwipe, sourceMessages.at(-1).extra.reasoningBySwipe);
  assert.deepEqual(forkReply.extra.reasoningDurationBySwipe, sourceMessages.at(-1).extra.reasoningDurationBySwipe);
  pass("forked messages retain reasoning and durations for every copied swipe");
  for (let index = 0; index < 3; index++) {
    const rule = await api("/api/v1/regex-scripts", "POST", { name: `Fork rule ${index}`, preset_id: presets[index].id,
      target: ["display"], placement: ["ai_output"], find_regex: "^", replace_string: `SOURCE_${index}:{{getvar::ao_tone}}:`, substitute_macros: "after" });
    await api(`/api/v1/regex-scripts/${rule.id}/toggle`, "PUT", { disabled: false, active_preset_id: presets[index].id });
  }
  for (let index = 0; index < 3; index++) {
    const variables = forkReply.extra.spindle_metadata.preset_contexts[index].variables;
    const resolved = await api("/api/v1/macros/resolve-batch", "POST", { templates: { value: "{{getvar::ao_tone}}/{{getchatvar::ao_probe_counter}}" },
      chat_id: latestFork.id, message_id: forkReply.id, swipe_index: index, use_message_preset: true });
    assert.equal(resolved.resolved.value, `${variables.local.ao_tone}/${variables.chat.ao_probe_counter}`);
    const scripts = await api(`/api/v1/regex-scripts/active?target=display&chat_id=${latestFork.id}&preset_id=${presets[index].id}`);
    const rendered = await api("/api/v1/regex-scripts/apply", "POST", { content: forkReply.swipes[index], scripts,
      context: { chat_id: latestFork.id, message_id: forkReply.id, swipe_index: index, use_message_preset: true, is_user: false, depth: 0, role: "assistant" } });
    assert(rendered.result.startsWith(`SOURCE_${index}:${variables.local.ao_tone}:PRESET_${"ABC"[index]}`));
    assert.deepEqual(rendered.result.match(/SOURCE_[012]:/g), [`SOURCE_${index}:`]);
  }
  pass("forked swipes render with only their own source regexes, exactly once, and captured variables");
  await api(`/api/v1/chats/${latestFork.id}/messages/${forkReply.id}`, "PUT", { content: "USER_EDITED_REPLY: corrected prose." });
  const forkNextId = await begin("FORK_CONTINUATION", latestFork.id);
  await until("latest fork continuation", () => view, v => v?.phase === "ready" && v.run?.messageId === forkNextId);
  assert.equal(view!.run!.steps.length, 3); assert.equal(view!.run!.chatId, latestFork.id);
  assert.deepEqual((await api(`/api/v1/chats/${chat.id}/messages?full=true`)).data, sourceMessages);
  assert.deepEqual((await api(`/api/v1/chats/${chat.id}`)).metadata, sourceMetadata);
  pass("following a fork stays enabled and new generations do not modify the source chat");
  assert(requests.at(-1).messages.some((m: any) => String(m.content).includes("USER_EDITED_REPLY")));
  pass("editing the latest CAT reply preserves its variables and allows the next generation");

  await rpc("arm", { chatId: chat.id, connectionId: connection.id, slotIds: [catalog.settings.slots[0].id] });
  await api(`/api/v1/chats/${chat.id}/messages/${replyId}/swipe`, "POST", { direction: "left" });
  const intermediateReply = sourceMessages.find((m: any) => m.id !== replyId && m.id !== forkBaseId && m.extra?.spindle_metadata?.another_one_variables);
  await api(`/api/v1/chats/${chat.id}/messages/${intermediateReply.id}/swipe`, "POST", { direction: "left" });
  const olderFork = await api(`/api/v1/chats/${chat.id}/branch`, "POST", { message_id: replyId });
  await api("/api/v1/settings", "PUT", { activeChatId: olderFork.id });
  await rpc("followFork", { chatId: olderFork.id });
  const olderMessages = (await api(`/api/v1/chats/${olderFork.id}/messages?full=true`)).data;
  const olderReply = olderMessages.at(-1);
  const historical = olderReply.extra.spindle_metadata.preset_contexts[olderReply.swipe_id].variables.chat.ao_probe_counter;
  assert.equal((await api(`/api/v1/chats/${olderFork.id}`)).metadata.chat_variables.ao_probe_counter, historical);
  const beforeOlder = requests.length;
  const olderNext = await begin("OLDER_FORK_CONTINUATION", olderFork.id);
  await until("older fork continuation", () => view, v => v?.phase === "ready" && v.run?.messageId === olderNext);
  assert.equal(requests.length, beforeOlder + 1); assert.equal(requests.at(-1).marker, "PRESET_A");
  assert(requests.at(-1).messages.some((m: any) => String(m.content).includes(`COUNT=${Number(historical) + 1};`)));
  pass("older forks use the displayed alternate's counter even after intermediate swipes change, and retain hotbar selection");

  await rpc("activation", { enabled: true, slotIds: catalog.settings.slots.map(s => s.id) });
  tokenDelay = 90;
  const streamingId = await begin("FORK_WHILE_STREAMING", olderFork.id);
  const partial = await until("stream before fork", async () => (await api(`/api/v1/chats/${olderFork.id}/messages?full=true`)).data.at(-1),
    m => m.swipes.length === 3 && m.swipes.every((s: string) => s.includes("word1")));
  const liveFork = await api(`/api/v1/chats/${olderFork.id}/branch`, "POST", { message_id: streamingId });
  const frozen = (await api(`/api/v1/chats/${liveFork.id}/messages?full=true`)).data.at(-1).swipes;
  await api("/api/v1/settings", "PUT", { activeChatId: liveFork.id });
  assert.equal((await rpc("followFork", { chatId: liveFork.id }))?.phase, "ready");
  const stoppedSource = (await api(`/api/v1/chats/${olderFork.id}/messages?full=true`)).data.at(-1);
  assert.equal(stoppedSource.id, partial.id); assert(stoppedSource.swipes.every((s: string) => !s.includes("word30")));
  assert.deepEqual((await api(`/api/v1/chats/${liveFork.id}/messages?full=true`)).data.at(-1).swipes, frozen);
  const liveForkRun = (await rpc("load", { chatId: liveFork.id })).history.find(r => r.chatId === liveFork.id)!;
  assert.equal(liveForkRun.outcome, "stopped");
  await rpc("selectSwipe", { chatId: liveFork.id, runId: liveForkRun.id, stepIndex: 2 });
  pass("forking mid-stream stops original requests, preserves the copied partial replies, and keeps the fork enabled");
  await rpc("disarm", { stop: true });
  await rpc("save", { settings: { ...catalog.settings, slots: [
    { id: "repeat-main", presetId: presets[0].id, connectionId: connection.id },
    { id: "repeat-alt", presetId: presets[0].id, connectionId: alternate.id },
  ] } });
  await rpc("arm", { chatId: liveFork.id, connectionId: connection.id });
  const beforeRepeat = requests.length;
  const repeatId = await begin("REPEATED_PRESET", liveFork.id);
  await until("repeated preset completion", () => view, v => v?.phase === "ready" && v.run?.messageId === repeatId);
  assert.deepEqual(requests.slice(beforeRepeat).map(r => r.model).sort(), ["fixture-alt", "fixture-main"]);
  assert(requests.slice(beforeRepeat).every(r => r.marker === "PRESET_A"));
  const repeatFork = await api(`/api/v1/chats/${liveFork.id}/branch`, "POST", { message_id: repeatId });
  await api("/api/v1/settings", "PUT", { activeChatId: repeatFork.id });
  const repeatedView = await rpc("followFork", { chatId: repeatFork.id });
  assert.deepEqual(repeatedView!.run!.steps.map(s => s.connectionName), [connection.name, alternate.name]);
  pass("repeated presets generate through independent connections and keep both profile identities in forks");
  await rpc("disarm", { stop: true });
  const remembered = await rpc("activation", { enabled: true, slotIds: ["repeat-alt"] });
  await api(`/api/v1/spindle/${extension.id}/restart`, "POST", {});
  await until("restarted worker", () => api("/api/v1/spindle"), v => v.extensions.some((e: any) => e.id === extension.id && e.status === "running"));
  assert.deepEqual((await rpc("load", {})).activation, remembered);
  const beforeRestore = requests.length;
  const restoredId = await begin("RESTORED_AFTER_RESTART", repeatFork.id);
  await until("restored generation", () => view, v => v?.phase === "ready" && v.run?.messageId === restoredId);
  assert.equal(requests.length, beforeRestore + 1); assert.equal(requests.at(-1).model, "fixture-alt");
  pass("worker restart restores the account's enabled state and selected profiles on the next send without an arm request");
  const previousBrowser = socket!; previousBrowser.close();
  await until("old browser closed", () => previousBrowser.readyState, state => state === WebSocket.CLOSED);
  await connectBrowser(crypto.randomUUID().replaceAll("-", ""));
  assert.deepEqual((await rpc("load", {})).activation, remembered);
  const beforeBrowser = requests.length;
  const browserId = await begin("RESTORED_IN_ANOTHER_BROWSER", repeatFork.id);
  await until("other browser generation", () => view, v => v?.phase === "ready" && v.run?.messageId === browserId);
  assert.equal(requests.length, beforeBrowser + 1); assert.equal(requests.at(-1).model, "fixture-alt");
  const disabled = await rpc("activation", { enabled: false });
  await api(`/api/v1/spindle/${extension.id}/restart`, "POST", {});
  await until("disabled preference worker restart", () => api("/api/v1/spindle"), v => v.extensions.some((e: any) => e.id === extension.id && e.status === "running"));
  assert.deepEqual((await rpc("load", {})).activation, disabled);
  assert.deepEqual(disabled.slotIds, ["repeat-alt"]);
  pass("another browser uses the saved account preference, and an explicit Disable also survives worker restart");
  const exported = await api(`/api/v1/chats/${repeatFork.id}/export`);
  const importedRuns: string[] = [];
  for (let copy = 0; copy < 2; copy++) {
    const imported = await api("/api/v1/chats/import", "POST", { ...exported, character_id: character.id });
    const metadataBefore = (await api(`/api/v1/chats/${imported.chat_id}`)).metadata;
    await rpc("restoreContexts", { chatId: imported.chat_id });
    const restored = (await rpc("load", { chatId: imported.chat_id })).history.filter(run => run.chatId === imported.chat_id);
    assert(restored.length > 0);
    const importedMessages = (await api(`/api/v1/chats/${imported.chat_id}/messages?full=true`)).data;
    assert(restored.every(run => importedMessages.some((message: any) => message.id === run.messageId && message.extra.spindle_metadata.another_one_run === run.id)));
    assert.deepEqual((await api(`/api/v1/chats/${imported.chat_id}`)).metadata, metadataBefore);
    importedRuns.push(...restored.map(run => run.id));
  }
  assert.equal(new Set(importedRuns).size, importedRuns.length);
  pass("native export and repeated import restore independent message-linked history without rewinding variables");
  const beforeDeletion = (await api(`/api/v1/chats/${repeatFork.id}/messages?full=true`)).data;
  const lastReply = beforeDeletion.find((m: any) => m.id === browserId);
  const summaries = await rpc("restoreContexts", { chatId: repeatFork.id });
  assert.deepEqual(summaries.messages[browserId], { index: lastReply.index_in_chat, name: lastReply.name });
  assert.equal((await rpc("load", { chatId: repeatFork.id })).history.find(r => r.messageId === browserId)!.characterName, lastReply.name);
  await api(`/api/v1/chats/${repeatFork.id}/messages/${browserId}`, "DELETE");
  await until("deleted reply history removed", () => rpc("load", { chatId: repeatFork.id }), value => !value.history.some(r => r.messageId === browserId));
  assert.equal((await api(`/api/v1/chats/${repeatFork.id}/messages?full=true`)).data.length, beforeDeletion.length - 1);
  pass("message deletion removes its saved swipe entry, and existing headers use native message numbers and character names");

  await rpc("arm", { chatId: repeatFork.id, connectionId: connection.id });
  tokenDelay = 90;
  const deletedDuringStream = await begin("DELETE_WHILE_STREAMING", repeatFork.id);
  await until("reply before deletion", async () => (await api(`/api/v1/chats/${repeatFork.id}/messages?full=true`)).data.at(-1),
    m => m.id === deletedDuringStream && m.swipes.some((s: string) => s.includes("word1")));
  await api(`/api/v1/chats/${repeatFork.id}/messages/${deletedDuringStream}`, "DELETE");
  await until("deleted stream settled", () => view, v => v?.phase === "off" && v.run === null);
  assert(!(await rpc("load", { chatId: repeatFork.id })).history.some(r => r.messageId === deletedDuringStream));
  assert(!(await api(`/api/v1/chats/${repeatFork.id}/messages?full=true`)).data.some((m: any) => m.id === deletedDuringStream));
  pass("deleting a streaming reply stops its requests without recreating the message or its swipe history");
  await rpc("arm", { chatId: repeatFork.id, connectionId: connection.id });
  preparation = undefined;
  await api(`/api/v1/chats/${repeatFork.id}/messages`, "POST", { is_user: true, name: "User", content: "CANCEL_DURING_PREPARATION" });
  await api("/api/v1/generate", "POST", { chat_id: repeatFork.id, connection_id: connection.id, generation_type: "normal" });
  const cancelled = await until("preparation to cancel", () => preparation, Boolean) as Preparation;
  await rpc("disarm", { stop: true });
  const abandoned = await api(`/api/v1/chats/${repeatFork.id}/messages`, "POST", { is_user: false, name: cancelled.name, content: "",
    extra: { spindle_metadata: { another_one_run: cancelled.runId } } });
  await rpc("preparationFailed", { runId: cancelled.runId, chatId: repeatFork.id, messageId: abandoned.id, error: "Stopped" });
  assert(!(await api(`/api/v1/chats/${repeatFork.id}/messages?full=true`)).data.some((m: any) => m.id === abandoned.id));
  pass("a blank reply created after cancellation is removed without creating a swipe entry");
  const variablesChat = await api("/api/v1/chats", "POST", { character_id: character.id, name: "Variable history verification" });
  await rpc("save", { settings: { version: 1, cats: false, slots: [0, 1].map(i => ({ id: `variables-${i}`, presetId: presets[i].id, connectionId: connection.id })) } });
  await rpc("arm", { chatId: variablesChat.id, connectionId: connection.id });
  const variableReplies: string[] = [];
  for (let turn = 0; turn < 3; turn++) {
    const id = await begin(`VARIABLE_TURN_${turn}`, variablesChat.id); variableReplies.push(id);
    await until("variable reply finished", () => view, v => v?.phase === "ready" && v.run?.messageId === id);
  }
  const count = async () => (await api(`/api/v1/chats/${variablesChat.id}`)).metadata.chat_variables.ao_probe_counter;
  assert.equal(await count(), "3");
  const variableMessages = (await api(`/api/v1/chats/${variablesChat.id}/messages?full=true`)).data;
  const firstVariableReply = variableMessages.findIndex((message: any) => message.id === variableReplies[0]);
  await api(`/api/v1/chats/${variablesChat.id}/messages/bulk-delete`, "POST", { message_ids: variableMessages.slice(firstVariableReply + 1).map((message: any) => message.id) });
  assert.equal(await count(), "1");
  await api(`/api/v1/chats/${variablesChat.id}/messages/${variableReplies[0]}/swipe`, "POST", { direction: "right" });
  assert.equal(await count(), "10");
  await api(`/api/v1/chats/${variablesChat.id}/messages/${variableReplies[0]}/swipe`, "POST", { direction: "left" });
  assert.equal(await count(), "1");
  pass("bulk deletion restores the surviving reply's variables before observers run and its alternate still selects correctly");
  await rpc("disarm", { stop: true });
  const nativeChat = await api("/api/v1/chats", "POST", { character_id: character.id, name: "Native variable verification" });
  await api(`/api/v1/chats/${nativeChat.id}/messages`, "POST", { is_user: true, name: "User", content: "Native reply." });
  assert.equal((await api(`/api/v1/chats/${nativeChat.id}`)).metadata._swipe_variable_state, undefined);
  let nativeReplyId: string | undefined;
  for (const mode of ["normal", "regenerate"] as const) {
    const eventStart = generationEvents.length;
    await api(`/api/v1/generate${mode === "regenerate" ? "/regenerate" : ""}`, "POST", {
      chat_id: nativeChat.id, ...(nativeReplyId ? { message_id: nativeReplyId } : {}), connection_id: connection.id,
      preset_id: presets[0].id, force_preset_id: true,
    });
    const completed = await until("native default variables", () => generationEvents.slice(eventStart).find(event => event.event === "GENERATION_ENDED" && event.payload.chatId === nativeChat.id), Boolean);
    nativeReplyId = completed!.payload.messageId;
    const reply = (await api(`/api/v1/chats/${nativeChat.id}/messages?full=true`)).data.find((message: any) => message.id === nativeReplyId);
    assert.equal((await api(`/api/v1/chats/${nativeChat.id}`)).metadata.chat_variables.ao_probe_counter, "1");
    assert.equal(reply.extra.variableStateBySwipe[reply.swipe_id].before.values.chat.ao_probe_counter, undefined);
  }
  pass("native generation tracks variables without extension setup and regeneration uses the original starting state");
  const nativeEventStart = generationEvents.length;
  await api("/api/v1/generate/regenerate", "POST", { chat_id: variablesChat.id, message_id: variableReplies[0], connection_id: connection.id,
    preset_id: presets[0].id, force_preset_id: true });
  await until("native variable generation finished", () => generationEvents.slice(nativeEventStart), events => events.some(e => e.event === "GENERATION_ENDED" && e.payload.chatId === variablesChat.id));
  assert.equal(await count(), "1");
  for (const [direction, expected] of [["left", "10"], ["left", "1"], ["right", "10"], ["right", "1"]]) {
    await api(`/api/v1/chats/${variablesChat.id}/messages/${variableReplies[0]}/swipe`, "POST", { direction });
    assert.equal(await count(), expected);
  }
  pass("native regeneration owns its prompt and response variables alongside CAT swipes without stale state or repeated counters");
  for (const stopEarly of [false, true]) {
    const generationId = crypto.randomUUID();
    const eventStart = generationEvents.length;
    const beforeIds = new Set((await api(`/api/v1/chats/${variablesChat.id}/messages?full=true`)).data.map((m: any) => m.id));
    const beforeCount = await count();
    tokenDelay = stopEarly ? 90 : 5;
    await api("/api/v1/generate", "POST", { chat_id: variablesChat.id, connection_id: connection.id,
      generationId, preset_id: presets[0].id, force_preset_id: true });
    if (stopEarly) {
      await until("late reply streaming", () => api(`/api/v1/generate/status/${variablesChat.id}`), status => status.generationId === generationId && status.content?.includes("word1"));
      await api("/api/v1/generate/stop", "POST", { generation_id: generationId });
    }
    await until("late reply settled", () => generationEvents.slice(eventStart), events => events.some(e => ["GENERATION_ENDED", "GENERATION_STOPPED"].includes(e.event) && e.payload.generationId === generationId));
    const created = (await api(`/api/v1/chats/${variablesChat.id}/messages?full=true`)).data.filter((m: any) => !beforeIds.has(m.id));
    assert.equal(created.length, 1);
    assert(created[0].extra.variableStateBySwipe[0]?.id);
    assert.equal(await count(), String(Number(beforeCount) + 1));
    await api(`/api/v1/chats/${variablesChat.id}/messages/${created[0].id}`, "DELETE");
    assert.equal(await count(), beforeCount);
  }
  pass("late-created native replies own prompt effects on completion and stop, and deletion restores the preceding reply");
  const lifecycleChat = await api("/api/v1/chats", "POST", { character_id: character.id, name: "Completion verification" });
  for (const [index, preset] of presets.slice(0, 2).entries()) {
    const rule = await api("/api/v1/regex-scripts", "POST", { name: `Response ${index}`, preset_id: preset.id,
      target: ["response"], placement: ["ai_output", "reasoning"], find_regex: "word30|thought3", replace_string: `FINAL_${index}` });
    await api(`/api/v1/regex-scripts/${rule.id}/toggle`, "PUT", { disabled: false, active_preset_id: preset.id });
  }
  const { eventBus } = await fromHost("ws/bus.ts");
  const chatsService = await fromHost("services/chats.service.ts");
  const observed: any[] = [];
  const unsubscribe = eventBus.on("GENERATION_ENDED", (event: any) => {
    if (event.payload.chatId === lifecycleChat.id) observed.push(structuredClone({ payload: event.payload,
      message: chatsService.getMessage(user.id, event.payload.messageId) }));
  });
  tokenDelay = 20;
  for (const [failure, selected, expectedCompletions] of [[false, 1, 1], [true, 0, 1], [true, 1, 0]] as const) {
    failB = failure; await rpc("arm", { chatId: lifecycleChat.id, connectionId: connection.id });
    const before = observed.length;
    const id = await begin("COMPLETION_CHECK", lifecycleChat.id);
    const status = await until("managed session started", () => api(`/api/v1/generate/status/${lifecycleChat.id}`), s => s.active && s.targetMessageId === id);
    assert.equal(status.renderMode, "persisted-message"); assert.equal(status.targetMessageId, id);
    if (selected) await api(`/api/v1/chats/${lifecycleChat.id}/messages/${id}/swipe`, "POST", { direction: "right" });
    await until("completion check settled", () => view, v => v?.run?.messageId === id && v?.phase !== "running");
    assert.equal(observed.length - before, expectedCompletions);
    if (expectedCompletions) {
      const event = observed.at(-1); assert.equal(event.message.swipe_id, selected);
      assert.equal(event.payload.content, event.message.content);
      assert(event.message.content.includes(`FINAL_${selected}`));
      assert(event.message.extra.reasoning.includes(`FINAL_${selected}`));
      assert.equal(event.message.extra.reasoningCarrier.type, "reasoning_content");
      assert(event.message.extra.reasoningCarrier.content.includes("thought3"));
    }
  }
  pass("completion listeners run once on the selected successful reply after response regexes, reasoning and native carriers are saved");
  failB = false; firstTokenDelay = 1500;
  for (const restart of [false, true]) {
    await rpc("arm", { chatId: lifecycleChat.id, connectionId: connection.id });
    const before = observed.length;
    const id = await begin("STOP_BEFORE_FIRST_TOKEN", lifecycleChat.id);
    const status = await until("managed session started before stop", () => api(`/api/v1/generate/status/${lifecycleChat.id}`), s => s.active && s.targetMessageId === id);
    if (restart) await api(`/api/v1/spindle/${extension.id}/restart`, "POST", {});
    else assert.equal((await api("/api/v1/generate/stop", "POST", { generation_id: status.generationId })).stopped, true);
    await until("native busy state cleared", () => api(`/api/v1/generate/status/${lifecycleChat.id}`), s => !s.active);
    await Bun.sleep(1600);
    assert.equal((await api(`/api/v1/generate/status/${lifecycleChat.id}`)).active, false);
    assert.equal(observed.length, before, "Stopping or restarting must not report a completed reply");
    assert.equal(chatsService.getMessage(user.id, id).content, "");
  }
  firstTokenDelay = 0; unsubscribe();
  pass("native Stop and worker restart cancel requests before the first token without stuck streaming or successful completion events");
  if (installedProbes) {
    const { auditInstalledPresets } = await import("./installed-presets");
    await auditInstalledPresets(host, api, chat.id, connection.id, user.id, await fromHost("services/regex-scripts.service.ts"), pass, installedProbes);
  }
  socket?.close(); socket = undefined;
  await Bun.write(join(runDir, "results.json"), JSON.stringify({ results, maxConcurrent: maxActive, requests: requests.map(r => ({ model: r.model, temperature: r.temperature, marker: r.marker, at: r.at })) }, null, 2));
  await Bun.write(join(repo, "local", "latest-host.json"), JSON.stringify({ origin, username: "anotherone_test", password, chatId: chat.id, runDir }, null, 2));
  console.log(`HOST COMPLETE: ${results.length} checks. Evidence: ${join(runDir, "results.json")}`);
  if (process.argv.includes("--serve")) { tokenDelay = 400; firstTokenDelay = 3500; console.log(`Disposable preview ready at ${origin}. Credentials: local/latest-host.json`); await new Promise(() => {}); }
  provider.stop(); process.exit(0);
} catch (error) { console.error(error); socket?.close(); provider.stop(); process.exit(1); }
