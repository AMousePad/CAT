import { expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { Forks } from "../src/backend/forks";
import { VariableSelection } from "../src/backend/variable-selection";
import { selectSwipe } from "../src/backend/select-swipe";
import { contentHash } from "../src/generation/preset-context";
import type { RunRecord } from "../src/shared";
import type { Storage } from "../src/backend/storage";

async function fixture(forkAt = 0) {
  const make = async (id: string, index: number, before: string, after: string, extra = false) => {
    const changes = [{ scope: "chat", key: "counter", before, after }, ...(extra ? [{ scope: "chat", key: "later", before: null, after: "future" }] : [])];
    const alternate = String(Number(before) + 10);
    const slots = await Promise.all([after, alternate].map(async (value, i) => ({ presetId: `p${i}`, local: {},
      contentHash: await contentHash(`${id}-${i}`), changes: changes.map(c => c.key === "counter" ? { ...c, after: value } : c) })));
    return { id, chat_id: "source", index_in_chat: index, role: "assistant", content: `${id}-0`, swipe_id: 0,
      swipes: [`${id}-0`, `${id}-1`], branch_id: null, send_date: 1000, metadata: { another_one_run: `run-${id}`,
        another_one_variables: { version: 1, slots }, another_one_presets: ["p0", "p1"],
        preset_contexts: slots.map((s, i) => ({ preset_id: s.presetId, variables: { local: {}, global: {}, chat: { counter: i ? alternate : after, ...(index >= 3 ? { later: "future" } : {}) } } })) }, extra: {} };
  };
  const original = [await make("a", 0, "0", "1"), await make("b", 3, "1", "2", true), await make("c", 7, "2", "3")];
  const copy = original.filter(m => m.index_in_chat <= forkAt).map(m => ({ ...structuredClone(m), id: `copy-${m.id}`, chat_id: "fork", branch_id: "branch" }));
  const metadata = { chat_variables: { counter: "3", later: "future", character_value: 123 }, macro_variables: { local: { untouched: "yes" }, global: { other: "keep" } },
    character_state: { value: 99 }, another_one_applied_variables: { messageId: "c", slot: 0, changes: original[2].metadata.another_one_variables.slots[0].changes } };
  const chats = new Map<string, any>([["source", { id: "source", name: "Original", metadata: structuredClone(metadata) }],
    ["fork", { id: "fork", name: "Branch", metadata: { ...structuredClone(metadata), branched_from: "source", branch_at_message: original.find(m => m.index_in_chat === forkAt)!.id } }]]);
  const messages = new Map<string, any[]>([["source", original], ["fork", copy]]);
  const history: RunRecord[] = original.map(m => ({ id: m.metadata.another_one_run, chatId: "source", chatName: "Original", messageId: m.id,
    at: 1000, outcome: "complete", steps: m.swipes.map((_, i) => ({ presetId: `p${i}`, presetName: `Preset ${i}`, connectionName: "Connection", status: "done" })) }));
  let writes = 0;
  const handlers = new Map<string, Function>();
  const api = { on: (event: string, fn: Function) => { handlers.set(event, fn); return () => {}; }, log: { error() {} }, sendToFrontend() {},
    presets: { get: async (id: string) => ({ id, name: `Preset ${id}` }) },
    chats: { get: async (id: string) => structuredClone(chats.get(id) ?? null), update: async (id: string, patch: any) => { writes++; Object.assign(chats.get(id), structuredClone(patch)); } },
    chat: { getMessages: async (id: string) => structuredClone(messages.get(id)), updateMessage: async (chatId: string, id: string, patch: any) => {
      writes++; const m = messages.get(chatId)!.find(m => m.id === id); Object.assign(m, structuredClone(patch));
      if (patch.swipe_id !== undefined) m.content = m.swipes[m.swipe_id];
    } },
  } as unknown as SpindleAPI;
  const storage = { history: async () => structuredClone(history), recordMany: async (_u: string, runs: RunRecord[]) => {
    for (const run of runs) { const old = history.findIndex(r => r.id === run.id); if (old >= 0) history.splice(old, 1); }
    history.unshift(...structuredClone(runs));
  } } as unknown as Storage;
  const forks = new Forks(api, storage);
  return { api, forks, chats, messages, history, handlers, writes: () => writes,
    variables: new VariableSelection(api, (u, c) => forks.ensure(u, c)) };
}

test("older forks rewind all later extension deltas, including introduced variables, without changing the original or character state", async () => {
  const f = await fixture();
  const source = structuredClone(f.chats.get("source")), sourceMessages = structuredClone(f.messages.get("source"));
  await Promise.all([f.forks.ensure("u", "fork"), f.forks.ensure("u", "fork")]);
  const chat = f.chats.get("fork");
  expect(chat.metadata.chat_variables).toEqual({ counter: "1", character_value: 123 });
  expect(chat.metadata.macro_variables).toEqual(source.metadata.macro_variables);
  expect(chat.metadata.character_state).toEqual(source.metadata.character_state);
  expect(chat.metadata.another_one_applied_variables.messageId).toBe("copy-a");
  expect(f.chats.get("source")).toEqual(source); expect(f.messages.get("source")).toEqual(sourceMessages);
  const run = f.history.find(r => r.chatId === "fork")!;
  expect(run.id).toBe("fork:copy-a"); expect(run.steps[0].connectionName).toBe("Connection");
  expect(run.messageIndex).toBe(0);
  await selectSwipe(f.api, run, 1, () => f.variables.sync("u", "fork"));
  expect(f.chats.get("fork").metadata.chat_variables.counter).toBe("10");
  expect(f.messages.get("source")![0].swipe_id).toBe(0);
  const writes = f.writes(); await f.forks.ensure("u", "fork"); expect(f.writes()).toBe(writes);
});

test("latest forks preserve manual edits and rebind the applied state without applying it twice", async () => {
  const f = await fixture(7); f.chats.get("fork").metadata.chat_variables.counter = "manual";
  await f.forks.ensure("u", "fork"); await f.variables.sync("u", "fork");
  expect(f.chats.get("fork").metadata.chat_variables.counter).toBe("manual");
  expect(f.chats.get("fork").metadata.another_one_applied_variables.messageId).toBe("copy-c");
  expect(f.history.filter(r => r.chatId === "fork")).toHaveLength(3);
  await expect(selectSwipe(f.api, f.history.find(r => r.messageId === "copy-a")!, 0)).rejects.toThrow("latest reply");
});

test("an older fork applies its displayed swipe after rewinding later replies, preserving manual values", async () => {
  for (const manual of [false, true]) {
    const f = await fixture();
    for (const message of [f.messages.get("source")![0], f.messages.get("fork")![0]]) {
      message.swipe_id = 1; message.content = message.swipes[1];
      message.metadata.another_one_variables.slots[0].changes.push(
        { scope: "chat", key: "introduced", before: null, after: "first-swipe" },
        { scope: "global", key: "removed", before: "restore", after: null });
      message.metadata.preset_contexts[0].variables.chat.introduced = "first-swipe";
      message.metadata.preset_contexts[1].variables.global.removed = "restore";
    }
    for (const context of f.messages.get("source")![1].metadata.preset_contexts) {
      context.variables.chat.introduced = "first-swipe";
    }
    const intermediate = f.messages.get("source")![1];
    intermediate.swipe_id = 1; intermediate.content = intermediate.swipes[1];
    const metadata = f.chats.get("fork").metadata;
    metadata.chat_variables.introduced = manual ? "manual" : "first-swipe";
    if (manual) metadata.chat_variables.counter = "manual";
    await f.forks.ensure("u", "fork");
    await f.variables.sync("u", "fork");
    expect(f.chats.get("fork").metadata.chat_variables).toEqual({ counter: manual ? "manual" : "10", character_value: 123,
      ...(manual ? { introduced: "manual" } : {}) });
    expect(f.chats.get("fork").metadata.macro_variables.global).toEqual({ other: "keep", removed: "restore" });
    expect(f.chats.get("fork").metadata.another_one_applied_variables.slot).toBe(1);
    expect(f.chats.get("source").metadata.chat_variables.counter).toBe("3");
  }
});

test("forks distinguish profiles sharing a preset, including after deleting an earlier swipe", async () => {
  for (const deletedFirst of [false, true]) {
    const f = await fixture();
    const message = f.messages.get("fork")![0];
    message.metadata.preset_contexts.forEach((c: any) => { c.preset_id = "p0"; });
    message.metadata.another_one_variables.slots.forEach((s: any) => { s.presetId = "p0"; });
    const run = f.history.find(r => r.messageId === "a")!;
    for (const [i, step] of run.steps.entries()) {
      step.presetId = "p0"; step.connectionName = `Connection ${i}`;
      step.contentHash = await contentHash(message.swipes[i]);
    }
    if (deletedFirst) {
      message.swipes.shift(); message.metadata.preset_contexts.shift();
      message.content = message.swipes[0];
    }
    await f.forks.ensure("u", "fork");
    expect(f.history.find(r => r.chatId === "fork")!.steps.map(s => s.connectionName))
      .toEqual(deletedFirst ? ["Connection 1"] : ["Connection 0", "Connection 1"]);
  }
});

test("initializing an existing fork with new replies does not rewind its independent state", async () => {
  const f = await fixture();
  const next = { ...structuredClone(f.messages.get("source")![2]), id: "new-reply", chat_id: "fork", branch_id: null, index_in_chat: 1 };
  f.messages.get("fork")!.push(next);
  f.chats.get("fork").metadata.chat_variables.counter = "independent";
  f.chats.get("fork").metadata.another_one_applied_variables.messageId = "new-reply";
  await f.forks.ensure("u", "fork");
  expect(f.chats.get("fork").metadata.chat_variables.counter).toBe("independent");
  expect(f.chats.get("fork").metadata.another_one_applied_variables.messageId).toBe("new-reply");
});

test("nested forks initialize separately and initialized forks no longer require the source chat", async () => {
  const f = await fixture(7); await f.forks.ensure("u", "fork");
  const child = structuredClone(f.chats.get("fork")); child.id = "child"; child.metadata.branched_from = "fork";
  f.chats.set("child", child);
  f.messages.set("child", f.messages.get("fork")!.slice(0, 1).map(m => ({ ...structuredClone(m), id: "child-a", chat_id: "child", branch_id: "child-branch" })));
  await f.forks.ensure("u", "child");
  expect(f.chats.get("child").metadata.chat_variables.counter).toBe("1");
  expect(f.chats.get("child").metadata.another_one_fork).toBe("child");
  f.chats.delete("fork"); await f.forks.ensure("u", "child");
  expect(f.chats.get("child").metadata.chat_variables.counter).toBe("1");
});

test("streaming copies are independent partial replies and remain selectable", async () => {
  const f = await fixture(); f.history.splice(0);
  for (const slot of f.messages.get("fork")![0].metadata.another_one_variables.slots) delete slot.contentHash;
  await f.forks.ensure("u", "fork");
  const run = f.history[0]; expect(run.outcome).toBe("stopped");
  expect(run.steps.every(s => s.status === "stopped" && s.contentHash)).toBe(true);
  await selectSwipe(f.api, run, 1, () => f.variables.sync("u", "fork"));
  expect(f.chats.get("fork").metadata.chat_variables.counter).toBe("10");
});

test("fork restoration ignores source generations made after the copy and keeps an unrelated edit", async () => {
  const f = await fixture();
  const future = structuredClone(f.messages.get("source")![2]); future.id = "future"; future.index_in_chat = 9;
  future.metadata.another_one_variables.slots[0].changes[0].before = "999";
  f.messages.get("source")!.push(future);
  f.chats.get("fork").metadata.chat_variables.later = "manual";
  await f.forks.ensure("u", "fork");
  expect(f.chats.get("fork").metadata.chat_variables).toEqual({ counter: "1", later: "manual", character_value: 123 });
});

test.each([[0, "99"], [1, "99"], [0, "0"], [1, "1"]] as const)("fork rewind preserves manual values after reply %s: %s", async (after, manual) => {
  const f = await fixture();
  let counter = Number(manual);
  for (const message of f.messages.get("source")!.slice(after + 1)) {
    for (const [index, slot] of message.metadata.another_one_variables.slots.entries()) {
      slot.changes[0].before = String(counter); slot.changes[0].after = String(counter + (index ? 10 : 1));
      message.metadata.preset_contexts[index].variables.chat.counter = slot.changes[0].after;
    }
    counter++;
  }
  const last = f.messages.get("source")![2];
  f.chats.get("fork").metadata.chat_variables.counter = String(counter);
  f.chats.get("fork").metadata.another_one_applied_variables.changes = structuredClone(last.metadata.another_one_variables.slots[0].changes);
  const boundary = f.messages.get("fork")![0]; boundary.swipe_id = 1; boundary.content = boundary.swipes[1];
  await f.forks.ensure("u", "fork");
  expect(f.chats.get("fork").metadata.chat_variables.counter).toBe(manual);
});

test("manual edits after copying stay protected through every earlier rewind", async () => {
  const f = await fixture();
  f.chats.get("fork").metadata.chat_variables.counter = "2";
  const boundary = f.messages.get("fork")![0]; boundary.swipe_id = 1; boundary.content = boundary.swipes[1];
  await f.forks.ensure("u", "fork");
  expect(f.chats.get("fork").metadata.chat_variables.counter).toBe("2");
});

test("forking before the first generated reply restores the initial state without keeping future variables", async () => {
  const f = await fixture();
  for (const m of f.messages.get("source")!) m.index_in_chat++;
  const user = { id: "prompt", chat_id: "source", role: "user", index_in_chat: 0, content: "Hi", swipes: ["Hi"], swipe_id: 0, metadata: {}, branch_id: null };
  f.messages.get("source")!.unshift(user);
  f.messages.set("fork", [{ ...user, id: "copy-prompt", chat_id: "fork", branch_id: "branch" }]);
  await f.forks.ensure("u", "fork");
  expect(f.chats.get("fork").metadata.chat_variables).toEqual({ counter: "0", character_value: 123 });
  expect(f.chats.get("fork").metadata.another_one_applied_variables).toBeUndefined();
});

test("forks without extension data are not modified", async () => {
  const f = await fixture();
  delete f.chats.get("fork").metadata.another_one_applied_variables;
  for (const m of f.messages.get("fork")!) m.metadata = {};
  await f.forks.ensure("u", "fork"); expect(f.writes()).toBe(0);
});
