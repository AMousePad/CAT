import type { SpindleAPI } from "lumiverse-spindle-types";
import { contentHash } from "../generation/preset-context";
import type { MessageVariables } from "../generation/variable-state";
import type { RunRecord } from "../shared";

/** Upgrade saved CAT replies without changing their text or source regexes. */
export async function restoreMessageContexts(api: SpindleAPI, chatId: string, history: readonly RunRecord[]) {
  const messages = await api.chat.getMessages(chatId);
  for (const message of messages) {
    const metadata = message.metadata;
    if (message.role !== "assistant" || !metadata?.another_one_run || Array.isArray(metadata.preset_contexts)) continue;
    const data = metadata.another_one_variables as MessageVariables | undefined;
    const ids = metadata.another_one_presets;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) continue;
    const contexts = await Promise.all(message.swipes.map(async (content, index) => {
      const hash = await contentHash(content);
      const matches = data?.slots?.filter(slot => slot.contentHash === hash);
      const slot = matches?.length === 1 ? matches[0] : data?.slots?.length === message.swipes.length ? data.slots[index] : undefined;
      const presetId = slot?.presetId ?? (ids.length === message.swipes.length ? ids[index] : undefined);
      return presetId ? { preset_id: presetId, ...(slot ? { variables: slot.snapshot ?? { local: slot.local } } : {}) } : null;
    }));
    if (contexts.some(Boolean)) await api.chat.updateMessage(chatId, message.id, { metadata: { ...metadata, preset_contexts: contexts } });
  }
  const summaries = new Map(messages.map(message => [message.id, { index: message.index_in_chat, name: message.name }]));
  // A missing reply is distinct from a history entry that has not been checked yet.
  return Object.fromEntries(history.filter(run => run.chatId === chatId && run.messageId)
    .map(run => [run.messageId, summaries.get(run.messageId) ?? null]));
}
