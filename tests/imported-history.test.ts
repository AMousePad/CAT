import { expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { restoreRunHistory } from "../src/backend/run-history";
import { Storage } from "../src/backend/storage";

function fixture() {
  const files = new Map<string, string>();
  const storage = new Storage({ exists: async (path, user) => files.has(user + path), read: async (path, user) => files.get(user + path)!,
    setJson: async (path, value, options) => { files.set(options!.userId + path, JSON.stringify(value)); } } as SpindleAPI["userStorage"]);
  const chats = new Map(["source", "import", "duplicate"].map(id => [id, { id, name: id, metadata: { chat_variables: { counter: "17" } } }]));
  const messages = new Map([...chats.keys()].map(chatId => [chatId, [{ id: `${chatId}-message`, chat_id: chatId, role: "assistant", name: "Miso", send_date: 1000,
    index_in_chat: 8, branch_id: null, swipe_id: 0, content: "Edited", swipes: ["Edited", "Alternate"], metadata: { another_one_run: "source-run",
      another_one_presets: ["a", "b"], preset_contexts: [{ preset_id: "a", another_one_swipe_id: "first" }, { preset_id: "b", another_one_swipe_id: "second" }] } }]]));
  let updates = 0;
  const api = { chat: { getMessages: async (id: string) => structuredClone(messages.get(id)!), updateMessage: async (chat: string, id: string, patch: any) => {
    const message = messages.get(chat)!.find(m => m.id === id)!; updates++; Object.assign(message.metadata, patch.metadata_patch);
  } }, presets: { get: async (id: string) => ({ name: `Preset ${id}` }) } } as unknown as SpindleAPI;
  return { storage, chats, messages, api, updates: () => updates };
}

test("native imports and duplicate imports recover independent history without changing variables or requiring a source", async () => {
  const f = fixture();
  for (const id of ["source", "import", "duplicate"]) await restoreRunHistory(f.api, f.storage, "user", f.chats.get(id)!, f.messages.get(id)! as any);
  const history = (await Promise.all([...f.chats.keys()].map(id => f.storage.history("user", id)))).flat();
  expect(new Set(history.map(run => run.id)).size).toBe(3);
  for (const id of f.chats.keys()) {
    const run = history.find(run => run.chatId === id)!;
    expect(run).toMatchObject({ messageId: `${id}-message`, messageIndex: 8, characterName: "Miso" });
    expect(run.steps.map(step => step.swipeId)).toEqual(["first", "second"]);
    expect(f.chats.get(id)!.metadata.chat_variables.counter).toBe("17");
    expect(f.messages.get(id)![0].metadata.another_one_run).toBe(run.id);
  }
  const updates = f.updates();
  await restoreRunHistory(f.api, f.storage, "user", f.chats.get("import")!, f.messages.get("import")! as any);
  expect(f.updates()).toBe(updates);
  expect(await f.storage.history("other-user", "import")).toEqual([]);
});

test("recovery skips a live run and ignores native swipes appended to an existing CAT message", async () => {
  const f = fixture(); const chat = f.chats.get("import")!; const messages = f.messages.get("import")!;
  await restoreRunHistory(f.api, f.storage, "user", chat, messages as any, () => true);
  expect(await f.storage.history("user", "import")).toEqual([]); expect(f.updates()).toBe(0);
  messages[0].swipes.push("Native reply"); messages[0].metadata.preset_contexts.push(null as any);
  await restoreRunHistory(f.api, f.storage, "user", chat, messages as any);
  expect((await f.storage.history("user", "import"))[0].steps).toHaveLength(2);
});

test("completion queued between destination and source history reads cannot rebind a live run", async () => {
  const f = fixture(); const chat = f.chats.get("import")!;
  Object.assign(chat.metadata, { branched_from: "source" });
  const message = f.messages.get("import")![0];
  const files = new Map([["history/import.json", "[]"], ["history/source.json", "[]"]]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let first = true, current = true;
  const storage = new Storage({ exists: async path => files.has(path), read: async path => {
    const old = files.get(path)!;
    if (first && path === "history/import.json") { first = false; entered(); await gate; }
    return old;
  }, setJson: async (path, value) => { files.set(path, JSON.stringify(value)); } } as SpindleAPI["userStorage"]);
  const run = { id: message.metadata.another_one_run, chatId: chat.id, chatName: chat.name, messageId: message.id, at: 1000, outcome: "complete" as const, steps: [] };
  const recovery = restoreRunHistory(f.api, storage, "user", chat, [structuredClone(message)] as any, id => current && id === run.id);
  await waiting;
  const saving = storage.record("user", run).then(() => { current = false; });
  release(); await Promise.all([saving, recovery]);
  expect((await storage.history("user", chat.id)).map(run => run.id)).toEqual([run.id]);
  expect(message.metadata.another_one_run).toBe(run.id);
  expect(f.updates()).toBe(0);
});
