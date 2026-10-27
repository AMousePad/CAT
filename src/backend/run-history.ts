import type { SpindleAPI } from "lumiverse-spindle-types";
import { contentHash } from "../generation/preset-context";
import type { MessageVariables } from "../generation/variable-state";
import { MAX_HISTORY, type RunRecord } from "../shared";
import type { Storage } from "./storage";

/** Message data survives exports, copies and eviction from account history. */
export async function restoreRunHistory(api: SpindleAPI, storage: Storage, user: string,
  chat: { id: string; name: string; metadata: Record<string, any> }, messages: Awaited<ReturnType<SpindleAPI["chat"]["getMessages"]>>,
  skip: (runId: string) => boolean = () => false) {
  const candidates = messages.filter(message => message.role === "assistant" && typeof message.metadata?.another_one_run === "string"
    && !skip(message.metadata.another_one_run)).slice(-MAX_HISTORY);
  const history = await storage.history(user, chat.id);
  const sourceHistory = typeof chat.metadata.branched_from === "string" ? await storage.history(user, chat.metadata.branched_from) : [];
  const runs: RunRecord[] = [];
  const names = new Map<string, string>();
  for (const message of candidates) {
    if (!message.metadata || skip(message.metadata.another_one_run as string)) continue;
    const known = history.find(run => run.chatId === chat.id && run.messageId === message.id && run.id === message.metadata!.another_one_run);
    if (known) { runs.push(known); continue; }
    const id = `message:${message.id}`;
    const original = [...history, ...sourceHistory].find(r => r.id === message.metadata!.another_one_run);
    const contexts = message.metadata.preset_contexts as Array<{ preset_id: string; another_one_swipe_id?: string }> | undefined;
    const presets = message.metadata.another_one_presets as string[] | undefined;
    if (!Array.isArray(contexts) && !Array.isArray(presets)) continue;
    const steps = (await Promise.all(message.swipes.map(async (content, index) => {
      if (Array.isArray(contexts) && !contexts[index]) return null;
      const presetId = contexts?.[index]?.preset_id ?? presets?.[index] ?? "";
      const hash = await contentHash(content);
      const expected = original?.steps[index];
      const matches = original?.steps.filter(s => s.presetId === presetId && s.contentHash === hash);
      const swipeId = contexts?.[index]?.another_one_swipe_id;
      const identities = original?.steps.filter(s => s.swipeId === swipeId && s.presetId === presetId);
      const prior = swipeId ? (identities?.length === 1 ? identities[0] : undefined)
        : original?.steps.length === message.swipes.length && expected?.presetId === presetId
          && (!expected.contentHash || expected.contentHash === hash) ? expected : matches?.length === 1 ? matches[0] : undefined;
      const data = message.metadata!.another_one_variables as MessageVariables | undefined;
      const unfinished = !prior && data?.slots.some(s => s.presetId === presetId && !s.contentHash);
      if (!names.has(presetId)) names.set(presetId, prior?.presetName ?? (await api.presets.get(presetId, user))?.name ?? "Deleted preset");
      return { presetId, presetName: names.get(presetId)!, connectionName: prior?.connectionName ?? "Copied reply",
        status: unfinished || prior?.status === "running" || prior?.status === "waiting" ? "stopped" as const : prior?.status ?? "done" as const,
        swipe: index, swipeId: contexts?.[index]?.another_one_swipe_id, contentHash: hash, ...(prior?.error ? { error: prior.error } : {}) };
    }))).filter((step): step is NonNullable<typeof step> => step !== null);
    if (!steps.length) continue;
    const outcome = steps.some(s => s.status === "error") ? "error" : steps.some(s => s.status === "stopped") ? "stopped" : "complete";
    runs.push({ id, chatId: chat.id, chatName: chat.name, messageId: message.id, messageIndex: message.index_in_chat, characterName: message.name, at: original?.at ?? message.send_date * 1000, steps, outcome });
    if (message.metadata.another_one_run !== id) {
      const patch: Parameters<SpindleAPI["chat"]["updateMessage"]>[2] & { metadata_patch: Record<string, unknown> } = { metadata_patch: { another_one_run: id } };
      await api.chat.updateMessage(chat.id, message.id, patch);
    }
  }
  if (!runs.some(run => !history.some(existing => existing.id === run.id && existing.chatId === run.chatId && existing.messageId === run.messageId))) return false;
  await storage.recordMany(user, runs.reverse(), async records => {
    const live = new Set((await api.chat.getMessages(chat.id)).map(message => message.id));
    return records.filter(record => live.has(record.messageId));
  });
  return true;
}
