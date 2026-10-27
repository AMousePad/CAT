import type { RunRecord } from "../shared";
import { contentHash } from "./preset-context";

export async function findSwipe(run: RunRecord, stepIndex: number,
  message: { id: string; chat_id: string; swipes: (string | null)[]; extra: Record<string, any> }): Promise<number> {
  const step = run.steps[stepIndex];
  if (!step || message.id !== run.messageId || message.chat_id !== run.chatId || message.extra?.spindle_metadata?.another_one_run !== run.id) {
    throw new Error("This reply is no longer available.");
  }
  const expected = step.swipe ?? stepIndex;
  const contexts = message.extra.spindle_metadata.preset_contexts;
  if (step.swipeId) {
    const matches = Array.isArray(contexts) ? contexts.flatMap((context, i) =>
      context?.another_one_swipe_id === step.swipeId && context.preset_id === step.presetId && i < message.swipes.length ? [i] : []) : [];
    if (matches.length === 1) return matches[0];
    throw new Error("This swipe is no longer available.");
  }
  if (step.contentHash) {
    const hashes = await Promise.all(message.swipes.map(s => typeof s === "string" ? contentHash(s) : null));
    const samePreset = (i: number) => !Array.isArray(contexts) || contexts[i]?.preset_id === step.presetId;
    if (message.swipes.length === run.steps.length && samePreset(expected) && hashes[expected] === step.contentHash) return expected;
    const matches = hashes.flatMap((hash, index) => samePreset(index) && hash === step.contentHash ? [index] : []);
    if (matches.length === 1) return matches[0];
    if (Array.isArray(contexts) && run.steps.filter(s => s.presetId === step.presetId).length === 1) {
      const candidates = contexts.flatMap((context, i) => context?.preset_id === step.presetId && i < message.swipes.length ? [i] : []);
      if (candidates.length === 1) return candidates[0];
    }
    throw new Error("This swipe was edited or deleted. Open it using the chat's swipe arrows.");
  }
  // Live streams have fixed slots. A structural edit stops the run. Never
  // interpret an old index as the same swipe after the array changes shape.
  if (message.swipes.length === run.steps.length && typeof message.swipes[expected] === "string" && message.swipes[expected]) return expected;
  throw new Error("This swipe is not available yet.");
}
