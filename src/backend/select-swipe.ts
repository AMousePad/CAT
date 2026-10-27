import type { SpindleAPI } from "lumiverse-spindle-types";
import type { RunRecord } from "../shared";
import { findSwipe } from "../generation/swipe-selection";

export async function selectSwipe(api: SpindleAPI, run: RunRecord, stepIndex: number, applyVariables?: () => Promise<void>): Promise<void> {
  if (!run.messageId || !Number.isInteger(stepIndex) || !run.steps[stepIndex]) throw new Error("This swipe is no longer available.");
  const messages = await api.chat.getMessages(run.chatId);
  const message = messages.find(m => m.id === run.messageId);
  if (!message) throw new Error("This reply was deleted.");
  if (messages.at(-1)?.id !== message.id) throw new Error("Only the latest reply's swipes can be selected.");
  const swipe = await findSwipe(run, stepIndex, { ...message, extra: { ...message.extra, spindle_metadata: message.metadata } });
  await api.chat.updateMessage(run.chatId, run.messageId, { swipe_id: swipe });
  await applyVariables?.();
}
