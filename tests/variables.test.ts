import { expect, test } from "bun:test";
import type { SpindleAPI, UserPresetDTO } from "lumiverse-spindle-types";
import { VariableCapture } from "../src/backend/variable-capture";
import { VariableSelection } from "../src/backend/variable-selection";
import { applyVariableSelection, variableChanges, type MessageVariables } from "../src/generation/variable-state";
import { contentHash } from "../src/generation/preset-context";
import { selectedVariables } from "../src/backend/forks";
import { conditionalMetadata } from "./helpers/conditional-metadata";

test("native context distinguishes unchanged and changed slots of the same preset", async () => {
  const message = { id: "reply", content: "Same prose", swipes: ["Same prose", "Same prose"], swipe_id: 1, metadata: {
    another_one_variables: { version: 1, slots: [
      { presetId: "p", local: {}, changes: [] },
      { presetId: "p", local: {}, changes: [{ scope: "chat", key: "count", before: "0", after: "1" }] },
    ] }, preset_contexts: [0, 1].map(count => ({ preset_id: "p", variables: { local: {}, global: {}, chat: { count: String(count) } } })),
  } } as unknown as Parameters<typeof selectedVariables>[0];
  expect((await selectedVariables(message))?.index).toBe(1);
  message.swipe_id = 0;
  expect((await selectedVariables(message))?.index).toBe(0);
});

test("switching variable deltas preserves unrelated edits and does not accumulate alternate swipe counters", () => {
  const before = { global: { mode: "old" }, chat: { count: "0" } };
  const a = variableChanges(before, { local: {}, global: { mode: "a" }, chat: { count: "1" } });
  const b = variableChanges(before, { local: {}, global: { mode: "b" }, chat: { count: "10" } });
  expect(applyVariableSelection({ global: { mode: "a", user: "kept" }, chat: { count: "1" } }, a, b))
    .toEqual({ global: { mode: "b", user: "kept" }, chat: { count: "10" } });
  expect(() => applyVariableSelection({ global: { mode: "a" }, chat: { count: "42" } }, a, b)).toThrow("changed after this reply");
  const special = variableChanges({ global: {}, chat: {} }, { local: {}, global: JSON.parse('{"__proto__":"value","constructor":"saved"}'), chat: {} });
  expect(special.map(c => [c.key, c.before, c.after])).toEqual([["__proto__", null, "value"], ["constructor", null, "saved"]]);
});

test("deletions are reversible when selecting a different swipe", () => {
  const prior = [{ scope: "chat" as const, key: "removed", before: "old", after: null }];
  expect(applyVariableSelection({ global: {}, chat: {} }, prior, [])).toEqual({ global: {}, chat: { removed: "old" } });
});

function captureFixture() {
  const source = { id: "source", name: "Source", provider: "loom", engine: "classic", parameters: { temperature: .5 },
    prompts: { completionSettings: { assistantPrefill: "Prefix" } }, metadata: { promptVariables: { main: { tone: "calm" } } },
    prompt_order: [{ id: "main", name: "Main", content: "Original {{setchatvar::count::1}}", enabled: true, role: "system", position: "pre_history", depth: 0 }],
  } as unknown as UserPresetDTO;
  let metadata: any = { chat_variables: { count: "0" }, macro_variables: { global: { mode: "before" } } };
  const copies = new Map<string, any>();
  const api = {
    presets: { get: async () => structuredClone(source), create: async (input: any) => { const copy = { ...input, id: crypto.randomUUID() }; copies.set(copy.id, copy); return copy; },
      delete: async (id: string) => copies.delete(id) },
    chats: { get: async () => ({ metadata: structuredClone(metadata) }) },
  } as unknown as SpindleAPI;
  const capture = new VariableCapture(api);
  return { source, copies, capture, setMetadata: (value: any) => { metadata = value; } };
}

test("native snapshots use the actual preset without copying or changing it", async () => {
  const f = captureFixture(), original = JSON.stringify(f.source);
  const p = await f.capture.create("user", "chat", "run", "source");
  expect(p.presetId).toBe("source");
  const result = await f.capture.finish("user", "run", "source", p.token, { local: { tone: "calm" }, global: { mode: "after" }, chat: { count: "1" } });
  expect(result.local).toEqual({ tone: "calm" });
  expect(result.changes).toContainEqual({ scope: "chat", key: "count", before: "0", after: "1" });
  expect(f.copies.size).toBe(0); expect(JSON.stringify(f.source)).toBe(original);
});

test("capture rejects missing native state, mismatched owners and changed starting variables", async () => {
  const f = captureFixture();
  const p = await f.capture.create("user", "chat", "run", "source");
  await expect(f.capture.finish("user", "run", "source", p.token)).rejects.toThrow("Update Lumiverse");
  expect(f.copies.size).toBe(0);
  const next = await f.capture.create("user", "chat", "run2", "source");
  await expect(f.capture.finish("other-user", "run2", "source", next.token)).rejects.toThrow("does not match");
  f.setMetadata({ chat_variables: { count: "42" }, macro_variables: { global: { mode: "before" } } });
  await expect(f.capture.finish("user", "run2", "source", next.token, { local: {}, global: { mode: "before" }, chat: { count: "1" } })).rejects.toThrow("changed while prompts");
  expect(f.copies.size).toBe(0);
});

test("selected persistent state survives reload, handles deleted earlier swipes, and leaves older replies alone", async () => {
  const data: MessageVariables = { version: 1, slots: [
    { presetId: "a", local: {}, changes: [{ scope: "chat", key: "count", before: "0", after: "1" }], contentHash: await contentHash("A") },
    { presetId: "b", local: {}, changes: [{ scope: "chat", key: "count", before: "0", after: "10" }], contentHash: await contentHash("B") },
  ] };
  let metadata: any = { title_setting: "keep", chat_variables: { count: "0", other: 123 }, macro_variables: { local: { kept: "yes" } } };
  const contexts = data.slots.map(slot => ({ preset_id: slot.presetId, variables: { local: slot.local, global: {}, chat: { count: slot.changes[0].after! } } }));
  const message = { id: "reply", role: "assistant", content: "A", swipes: ["A", "B"], swipe_id: 0, metadata: { another_one_variables: data, preset_contexts: contexts as (typeof contexts[number] | null)[] } };
  let messages: any[] = [message];
  let writes = 0;
  const api = { on: () => () => {}, log: { error: () => {} }, chat: { getMessages: async () => structuredClone(messages) },
    chats: { get: async () => ({ metadata: structuredClone(metadata) }), compareAndSetMetadata: async (_c: string, patch: any) => {
      const chat = { metadata }; const result = conditionalMetadata(chat, messages, patch);
      if (result) { metadata = chat.metadata; writes++; } return result;
    } },
  } as unknown as SpindleAPI;
  const manager = new VariableSelection(api);
  await manager.sync("user", "chat"); expect(metadata.chat_variables.count).toBe("1");
  message.swipe_id = 1; message.content = "B";
  await manager.sync("user", "chat"); expect(metadata.chat_variables.count).toBe("10");
  expect(metadata.title_setting).toBe("keep"); expect(metadata.chat_variables.other).toBe(123);
  expect(metadata.macro_variables.local).toEqual({ kept: "yes" });
  const reload = new VariableSelection(api), count = writes;
  await reload.sync("user", "chat"); expect(writes).toBe(count);
  message.swipes[1] = message.content = "A";
  await reload.sync("user", "chat"); expect(writes).toBe(count);
  message.swipes = ["A"]; message.swipe_id = 0; message.metadata.preset_contexts.shift();
  await reload.sync("user", "chat"); expect(metadata.chat_variables.count).toBe("10"); expect(writes).toBe(count);
  message.swipes.push("Native reply"); message.swipe_id = 1; message.content = "Native reply"; message.metadata.preset_contexts.push(null);
  await reload.sync("user", "chat"); expect(writes).toBe(count);
  message.swipes = ["B"]; message.content = "B"; message.swipe_id = 0; message.metadata.preset_contexts.pop();
  await reload.sync("user", "chat"); expect(metadata.chat_variables.count).toBe("10");
  messages = [message, { id: "newer", role: "assistant", metadata: {} }];
  message.content = "A";
  await reload.sync("user", "chat"); expect(metadata.chat_variables.count).toBe("10");
  messages = [];
  await reload.sync("user", "chat"); expect(metadata.chat_variables.count).toBe("0");
  expect(metadata.another_one_applied_variables).toBeUndefined();
});

test("cancel removes only its run's prepared state", async () => {
  const f = captureFixture();
  const first = await f.capture.create("user", "chat", "first", "source");
  const other = await f.capture.create("user", "chat", "other", "source");
  await f.capture.cancel("user", "first");
  const state = { local: {}, global: { mode: "before" }, chat: { count: "0" } };
  await expect(f.capture.finish("user", "first", "source", first.token, state)).rejects.toThrow("does not match");
  expect((await f.capture.finish("user", "other", "source", other.token, state)).changes).toEqual([]);
  expect(f.copies.size).toBe(0);
});

test("variable writes recompute after concurrent metadata, selection and message changes", async () => {
  for (const race of ["metadata", "selection", "deletion", "new-message", "busy"]) {
    const chat: any = { metadata: { chat_variables: { count: "0" } } };
    const messages: any[] = [{ id: "reply", role: "assistant", content: "A", swipe_id: 0, swipes: ["A", "B"], metadata: {
      another_one_variables: { version: 1, slots: ["1", "10"].map((after, i) => ({ presetId: `p${i}`, local: {},
        swipeId: `s${i}`, changes: [{ scope: "chat", key: "count", before: "0", after }] })) },
      preset_contexts: [0, 1].map(i => ({ preset_id: `p${i}`, another_one_swipe_id: `s${i}` })),
    } }];
    let attempts = 0;
    const api = { on: () => () => {}, chat: { getMessages: async () => structuredClone(messages) },
      chats: { get: async () => structuredClone(chat), compareAndSetMetadata: async (_id: string, input: any) => {
        if (++attempts === 1 || race === "busy") {
          if (race === "metadata" || race === "busy") chat.metadata.external = attempts;
          if (race === "selection") { messages[0].swipe_id = 1; messages[0].content = "B"; }
          if (race === "deletion") messages.splice(0);
          if (race === "new-message") messages.push({ id: "new", role: "assistant", swipe_id: 0, swipes: ["Native"], metadata: {} });
        }
        return conditionalMetadata(chat, messages, input);
      } },
    } as unknown as SpindleAPI;
    const manager = new VariableSelection(api);
    if (race === "busy") {
      await expect(manager.sync("user", "chat")).rejects.toThrow("kept changing");
      expect(attempts).toBe(5); expect(chat.metadata.chat_variables.count).toBe("0");
    } else {
      await manager.sync("user", "chat");
      expect(chat.metadata.chat_variables.count).toBe(race === "metadata" ? "1" : race === "selection" ? "10" : "0");
      if (race === "metadata") expect(chat.metadata.external).toBe(1);
      if (race === "selection") expect(chat.metadata.another_one_applied_variables.slot).toBe(1);
      if (race === "deletion" || race === "new-message") expect(chat.metadata.another_one_applied_variables).toBeUndefined();
    }
  }
});

test("sealed presets prepare directly, preserving their content and provenance", async () => {
  for (const origin of ["lumihub", "illarin", "legacy-illarin"]) {
    const f = captureFixture();
    Object.assign(f.source.prompt_order[0], { sealed: true, sealedKey: "private", sealedOriginPresetId: "hub-source",
      sealedOriginVersion: "v1", sealedSha256: "abc", ...(origin === "legacy-illarin" ? {} : { sealedSource: origin }) });
    Object.assign(f.source.metadata, { _lumiverse_install_source: origin === "lumihub" ? "lumihub" : "illarin",
      _lumiverse_lumihub_id: "hub-source", _lumiverse_sealed_preset: { version: "v1", blocks: [{ key: "private", sha256: "abc" }] } });
    const original = JSON.stringify(f.source);
    const p = await f.capture.create("user", "chat", origin, "source");
    expect(p.presetId).toBe("source");
    const result = await f.capture.finish("user", origin, "source", p.token, { local: { tone: "calm" }, global: { mode: "after" }, chat: { count: "1" } });
    expect(result.local).toEqual({ tone: "calm" });
    expect(result.changes).toContainEqual({ scope: "chat", key: "count", before: "0", after: "1" });
    expect(JSON.stringify(f.source)).toBe(original);
    expect(f.copies.size).toBe(0);
  }
});

test("LumiRealm presets fail before creating a copy", async () => {
  for (const metadata of [{ source: "risupreset" }, { lumirealm: { defaultVariables: "count=0" } }]) {
    const f = captureFixture(); Object.assign(f.source.metadata, metadata);
    await expect(f.capture.create("user", "chat", "run", "source")).rejects.toThrow("LumiRealm presets are not supported");
    expect(f.copies.size).toBe(0);
  }
});
