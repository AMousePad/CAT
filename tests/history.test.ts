import { expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { Storage } from "../src/backend/storage";
import { restoreMessageContexts } from "../src/backend/message-contexts";
import type { RunRecord } from "../src/shared";

const run = (id: string, chatId = "chat"): RunRecord => ({ id, chatId, chatName: "Chat", messageId: id,
  at: 1, outcome: "complete", steps: [] });
function fixture() {
  const files = new Map<string, string>();
  let writes = 0;
  const storage = new Storage({ exists: async (path, user) => files.has(user + path),
    read: async (path, user) => files.get(user + path)!,
    setJson: async (path, value, options) => { writes++; files.set(options!.userId + path, JSON.stringify(value)); },
  } as SpindleAPI["userStorage"]);
  return { storage, writes: () => writes };
}

test("legacy history resolves real message numbers and names, and distinguishes deleted replies", async () => {
  const messages = [
    { id: "first", index_in_chat: 0, name: "Mio", role: "assistant", swipes: ["First"] },
    { id: "legacy", index_in_chat: 8, name: "Akira", role: "assistant", swipes: ["Second"],
      metadata: { another_one_run: "legacy", another_one_presets: ["preset"] } },
  ];
  const updates: unknown[] = [];
  const api = { chat: { getMessages: async () => messages,
    updateMessage: async (_chat: string, _id: string, patch: unknown) => { updates.push(patch); } } } as unknown as SpindleAPI;
  const f = fixture();
  await f.storage.recordMany("user", [run("first"), run("legacy"), run("deleted"), run("other", "other-chat")]);
  const checked = (await f.storage.history("user")).filter(r => r.chatId === "chat");
  const summaries = await restoreMessageContexts(api, "chat", checked);
  expect(summaries).toEqual({ first: { index: 0, name: "Mio" }, legacy: { index: 8, name: "Akira" }, deleted: null });
  expect(updates).toEqual([{ metadata: { another_one_run: "legacy", another_one_presets: ["preset"], preset_contexts: [{ preset_id: "preset" }] } }]);
  await f.storage.reconcileHistory("user", checked, summaries);
  const history = await f.storage.history("user");
  expect(history.map(r => r.id)).toEqual(["first", "legacy", "other"]);
  expect(history[0]).toMatchObject({ messageIndex: 0, characterName: "Mio" });
  expect(history[1]).toMatchObject({ messageIndex: 8, characterName: "Akira" });
  const writes = f.writes();
  await f.storage.reconcileHistory("user", checked, summaries);
  expect(f.writes()).toBe(writes);
});

test("cleanup preserves new runs, never resurrects deletions and isolates chats and accounts", async () => {
  const f = fixture();
  await f.storage.recordMany("user", [run("old"), run("other", "other-chat")]);
  await f.storage.record("other-user", run("old"));
  const checked = (await f.storage.history("user")).filter(r => r.chatId === "chat");
  await f.storage.record("user", run("new"));
  expect(await f.storage.removeMessage("user", "wrong-chat", "old")).toBe(false);
  expect(await f.storage.removeMessage("user", "chat", "old")).toBe(true);
  await f.storage.reconcileHistory("user", checked, { old: { index: 1, name: "Mio" } });
  expect((await f.storage.history("user")).map(r => r.id)).toEqual(["new", "other"]);
  expect((await f.storage.history("other-user")).map(r => r.id)).toEqual(["old"]);
  await Promise.all([f.storage.record("user", run("queued")), f.storage.removeMessage("user", "chat", "queued")]);
  expect((await f.storage.history("user")).map(r => r.id)).toEqual(["new", "other"]);
  await expect(f.storage.record("user", { ...run("invalid"), messageId: undefined } as unknown as RunRecord)).rejects.toThrow("must belong to a message");
});
