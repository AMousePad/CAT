import { expect, test } from "bun:test";
import { PRESET_CHANGE_NOTE, usesMultiplePresets, withPresetNote } from "../src/generation/preset-context";
import { findSwipe } from "../src/generation/swipe-selection";
import { contentHash } from "../src/generation/preset-context";
import type { RunRecord } from "../src/shared";

test("the exact note is added once for multiple presets, including persisted older replies", () => {
  expect(usesMultiplePresets([], ["a"])).toBe(false);
  expect(usesMultiplePresets([], ["a", "b"])).toBe(true);
  expect(usesMultiplePresets([{ metadata: { another_one_presets: ["a"] } }], ["b"])).toBe(true);
  expect(usesMultiplePresets([{ metadata: { another_one_presets: ["a"] } }], ["a"])).toBe(false);
  const messages = [{ role: "user" as const, content: "Hello" }];
  expect(withPresetNote(messages, false)).toBe(messages);
  expect(withPresetNote(messages, true)).toEqual([...messages, { role: "system", content: PRESET_CHANGE_NOTE }]);
  expect(messages).toHaveLength(1);
});

test("history selection follows a retained swipe when an earlier swipe was deleted", async () => {
  const run: RunRecord = { id: "run", chatId: "chat", messageId: "reply", chatName: "Chat", at: 0, outcome: "complete",
    steps: ["a", "b"].map((id, index) => ({ presetId: id, presetName: id, connectionName: "Main", status: "done", swipe: index })) };
  run.steps[1].contentHash = await contentHash("B's reply");
  const message = { id: "reply", chat_id: "chat", swipes: ["B's reply"], extra: { spindle_metadata: { another_one_run: "run" } } };
  expect(await findSwipe(run, 1, message)).toBe(0);
  await expect(findSwipe(run, 1, { ...message, swipes: ["Edited reply"] })).rejects.toThrow("edited or deleted");
  await expect(findSwipe(run, 1, { ...message, extra: {} })).rejects.toThrow("no longer available");
});

test("live navigation requires the original slot shape and some streamed text", async () => {
  const run: RunRecord = { id: "run", chatId: "chat", messageId: "reply", chatName: "Chat", at: 0, outcome: "running",
    steps: ["a", "b"].map(id => ({ presetId: id, presetName: id, connectionName: "Main", status: "running" })) };
  const message = { id: "reply", chat_id: "chat", swipes: ["A partial", "B partial"], extra: { spindle_metadata: { another_one_run: "run" } } };
  expect(await findSwipe(run, 1, message)).toBe(1);
  await expect(findSwipe(run, 1, { ...message, swipes: ["B partial"] })).rejects.toThrow("not available yet");
  await expect(findSwipe(run, 1, { ...message, swipes: ["A partial", ""] })).rejects.toThrow("not available yet");
});

test("stable swipe identities survive edits, deletion and duplicate preset content", async () => {
  const run: RunRecord = { id: "run", chatId: "chat", messageId: "reply", chatName: "Chat", at: 0, outcome: "complete",
    steps: ["first", "second"].map(swipeId => ({ swipeId, presetId: "same", presetName: "Same", connectionName: "Main", status: "done" })) };
  for (const step of run.steps) step.contentHash = await contentHash("Original");
  const message = { id: "reply", chat_id: "chat", swipes: ["Edited by a tool"], extra: { spindle_metadata: { another_one_run: "run",
    preset_contexts: [{ preset_id: "same", another_one_swipe_id: "second" }] } } };
  expect(await findSwipe(run, 1, message)).toBe(0);
  await expect(findSwipe(run, 0, message)).rejects.toThrow("no longer available");
  await expect(findSwipe(run, 1, { ...message, swipes: ["Original"], extra: { spindle_metadata: { another_one_run: "run" } } })).rejects.toThrow("no longer available");
});

test("legacy edited swipes use unique saved preset context without guessing between identical profiles", async () => {
  const run: RunRecord = { id: "run", chatId: "chat", messageId: "reply", chatName: "Chat", at: 0, outcome: "complete",
    steps: ["a", "b"].map(presetId => ({ presetId, presetName: presetId, connectionName: "Main", status: "done" })) };
  for (const step of run.steps) step.contentHash = await contentHash("Original");
  const message = { id: "reply", chat_id: "chat", swipes: ["Edited"], extra: { spindle_metadata: { another_one_run: "run", preset_contexts: [{ preset_id: "b" }] } } };
  expect(await findSwipe(run, 1, message)).toBe(0);
  await expect(findSwipe(run, 0, { ...message, swipes: ["Original"] })).rejects.toThrow("edited or deleted");
  run.steps[0].presetId = "b";
  await expect(findSwipe(run, 1, message)).rejects.toThrow("edited or deleted");
});
