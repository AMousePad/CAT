import type { SpindleAPI } from "lumiverse-spindle-types";
import { contentHash } from "../generation/preset-context";
import { applyVariableSelection, persistentVariables, variableChanges, type AppliedVariables, type MessageVariables, type VariableChange, type VariableSnapshot } from "../generation/variable-state";
import { restoreRunHistory } from "./run-history";
import type { Storage } from "./storage";
import { compareChatMetadata } from "./chat-metadata";

const keyedChanges = (changes: VariableChange[]) => new Map(changes.map(change => [`${change.scope}:${change.key}`, change]));
const variableValue = (state: Pick<VariableSnapshot, "global" | "chat">, change: VariableChange) =>
  Object.hasOwn(state[change.scope] ?? {}, change.key) ? state[change.scope][change.key] : null;

function capturedValues(data: MessageVariables) {
  const baseline = keyedChanges(data.slots.flatMap(slot => slot.changes));
  const values = new Map([...baseline.keys()].map(key => [key, new Set<string | null>()]));
  for (const slot of data.slots) {
    const changes = keyedChanges(slot.changes);
    for (const [key, change] of baseline) values.get(key)!.add(changes.has(key) ? changes.get(key)!.after : change.before);
  }
  return values;
}

/** Native preset contexts retain variable identity when swipe text is edited. */
export async function selectedVariables(message: Awaited<ReturnType<SpindleAPI["chat"]["getMessages"]>>[number]) {
  const data = message.metadata?.another_one_variables as MessageVariables | undefined;
  if (data?.version !== 1 || !Array.isArray(data.slots)) return;
  const contexts = message.metadata?.preset_contexts as Array<{ preset_id: string; another_one_swipe_id?: string; variables?: VariableSnapshot } | null> | undefined;
  const context = contexts?.[message.swipe_id];
  if (Array.isArray(contexts) && !context) return;
  let index = message.swipe_id;
  let slot = data.slots[index];
  if (context?.another_one_swipe_id) {
    const matches = data.slots.flatMap((value, i) => value.swipeId === context.another_one_swipe_id && value.presetId === context.preset_id ? [i] : []);
    if (matches.length !== 1) throw new Error("This swipe's original variable state is no longer available.");
    index = matches[0]; slot = data.slots[index];
  } else if (context?.variables) {
    const snapshot = context.variables;
    const baseline = keyedChanges(data.slots.flatMap(value => value.changes));
    const matches = data.slots.flatMap((value, i) => {
      const changes = keyedChanges(value.changes);
      return value.presetId === context.preset_id && Object.keys(value.local).length === Object.keys(snapshot.local ?? {}).length &&
        Object.entries(value.local).every(([key, entry]) => snapshot.local?.[key] === entry) &&
        [...baseline].every(([key, change]) => variableValue(snapshot, change) === (changes.has(key) ? changes.get(key)!.after : change.before)) ? [i] : [];
    });
    if (!matches.length || !matches.every(i => JSON.stringify(data.slots[i].changes) === JSON.stringify(data.slots[matches[0]].changes)))
      throw new Error("This swipe's preset context does not identify its original variable state safely.");
    index = matches.includes(index) ? index : matches[0]; slot = data.slots[index];
  } else if (data.slots.length !== message.swipes.length || (slot?.contentHash && slot.contentHash !== await contentHash(message.content))) {
    const hash = await contentHash(message.content);
    const matches = data.slots.flatMap((value, i) => value.contentHash === hash ? [i] : []);
    if (matches.length !== 1) throw new Error("This swipe was edited. Its original variable state cannot be selected safely.");
    index = matches[0]; slot = data.slots[index];
  }
  return slot ? { slot, index } : undefined;
}

async function variablesBefore(message: Parameters<typeof selectedVariables>[0]) {
  const selected = await selectedVariables(message);
  const contexts = message.metadata?.preset_contexts as Array<{ variables?: VariableSnapshot } | null> | undefined;
  const snapshot = contexts?.[message.swipe_id]?.variables ?? selected?.slot.snapshot;
  if (!snapshot?.global || !snapshot.chat || !selected) throw new Error("This fork's earlier variable state is unavailable. Its variables have not been changed.");
  return applyVariableSelection(snapshot, selected.slot.changes, []);
}

/** Initialize each fork once. Copies never share mutable state with their source. */
export class Forks {
  private pending = new Map<string, Promise<void>>();
  constructor(private api: SpindleAPI, private storage: Storage) {
    api.on("CHAT_FORKED", (event, user) => {
      if (user) void this.ensure(user, event.forkedChatId).catch(error => {
        api.log.error(`Could not prepare fork: ${String(error)}`);
        api.sendToFrontend({ type: "variableError", error: "Could not prepare this fork. Enable CAT to retry." }, user);
      });
    });
  }
  ensure(user: string, chatId: string): Promise<void> {
    const key = `${user}:${chatId}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = this.initialize(user, chatId);
    this.pending.set(key, work);
    void work.finally(() => { if (this.pending.get(key) === work) this.pending.delete(key); }).catch(() => {});
    return work;
  }
  private async initialize(user: string, chatId: string) {
    const chat = await this.api.chats.get(chatId, user);
    if (!chat || typeof chat.metadata.branched_from !== "string" || chat.metadata.another_one_fork === chatId) return;
    const messages = await this.api.chat.getMessages(chatId);
    const branchId = messages[0]?.branch_id;
    if (branchId) await restoreRunHistory(this.api, this.storage, user, chat, messages.filter(m => m.branch_id === branchId));
    if (messages.some(m => Array.isArray(m.extra?.variableStateBySwipe) && m.extra.variableStateBySwipe.some(Boolean))) return;
    for (let attempt = 0; attempt < 5; attempt++) if (await this.initializeVariables(user, chatId)) return;
    throw new Error("The fork kept changing while restoring its variables. Try again.");
  }
  private async initializeVariables(user: string, chatId: string) {
    const chat = await this.api.chats.get(chatId, user);
    if (!chat || typeof chat.metadata.branched_from !== "string" || chat.metadata.another_one_fork === chatId) return true;
    const messages = await this.api.chat.getMessages(chatId);
    if (!chat.metadata.another_one_applied_variables && !messages.some(m => m.metadata?.another_one_run)) return true;
    const branchId = messages[0]?.branch_id;
    if (!branchId) return true;
    const copied = messages.filter(m => m.branch_id === branchId);
    const source = await this.api.chats.get(chat.metadata.branched_from, user);
    const sourceMessages = source ? await this.api.chat.getMessages(source.id) : [];
    const sourceByIndex = new Map(sourceMessages.map(m => [m.index_in_chat, m]));
    const idMap = new Map(copied.flatMap(m => {
      const original = sourceByIndex.get(m.index_in_chat);
      return original ? [[original.id, m.id] as const] : [];
    }));
    const applied = chat.metadata.another_one_applied_variables as (AppliedVariables & { slot: number }) | undefined;
    let nextApplied = applied && idMap.has(applied.messageId) ? { ...applied, messageId: idMap.get(applied.messageId)! } : applied;
    let values = persistentVariables(chat.metadata);
    // Existing forks with new replies have already advanced independently.
    // Never rewind them just because this version has not seen them before.
    if (messages.length === copied.length) {
      const forkIndex = copied.at(-1)!.index_in_chat;
      const appliedIndex = sourceMessages.find(m => m.id === applied?.messageId)?.index_in_chat ?? forkIndex;
      let historical: Pick<VariableSnapshot, "global" | "chat"> | undefined;
      const preserved = new Set<string>();
      // Undo only our writes after the fork point, in reverse order. This also
      // removes variables introduced later and preserves other extensions' state.
      for (const message of [...sourceMessages].reverse()) {
        if (message.index_in_chat <= forkIndex) break;
        if (message.index_in_chat > appliedIndex) continue;
        const data = message.metadata?.another_one_variables as MessageVariables | undefined;
        if (!data) continue;
        const baseline = keyedChanges(data.slots.flatMap(slot => slot.changes));
        const written = capturedValues(data);
        if (historical) for (const [key, change] of baseline)
          if (!written.get(key)!.has(variableValue(historical, change))) preserved.add(key);
        const changes = message.id === applied?.messageId ? applied.changes : historical && [...baseline]
          .map(([, change]) => ({ ...change, after: variableValue(historical!, change) }));
        if (!changes) throw new Error("This fork's earlier variable state is unavailable. Its variables have not been changed.");
        for (const [key, change] of keyedChanges(changes)) if (variableValue(values, change) !== change.after) preserved.add(key);
        values = applyVariableSelection(values, [...keyedChanges(changes)].filter(([key]) => !preserved.has(key)).map(([, change]) => change), []);
        historical = await variablesBefore(message);
      }
      if (applied && !idMap.has(applied.messageId)) {
        const last = [...copied].reverse().find(m => m.metadata?.another_one_variables);
        const selected = last && await selectedVariables(last);
        if (last && selected) {
          if (!historical) throw new Error("This fork's earlier variable state is unavailable. Its variables have not been changed.");
          // The next reply's snapshot records the state used before it generated,
          // even when an older reply now displays a different swipe.
          const data = last.metadata!.another_one_variables as MessageVariables;
          const baseline = keyedChanges(data.slots.flatMap(slot => slot.changes));
          const chosen = keyedChanges(selected.slot.changes);
          const written = capturedValues(data);
          const changes = [...baseline].filter(([key, change]) => !preserved.has(key) && written.get(key)!.has(variableValue(historical!, change))).map(([key, change]) => ({ ...change,
            before: variableValue(historical!, change), after: chosen.has(key) ? chosen.get(key)!.after : change.before }))
            .filter(change => variableValue(values, change) === change.before);
          values = applyVariableSelection(values, [], changes);
        }
        nextApplied = selected ? { messageId: last!.id, slot: selected.index, changes: selected.slot.changes } : undefined;
      }
    }
    const latestMetadata = chat.metadata as Record<string, any>;
    const maps = { global: new Map(Object.entries(latestMetadata.macro_variables?.global || {})), chat: new Map(Object.entries(latestMetadata.chat_variables || {})) };
    const current = persistentVariables(latestMetadata);
    for (const change of variableChanges(persistentVariables(chat.metadata), { local: {}, ...values })) {
      if ((current[change.scope][change.key] ?? null) !== change.before) continue;
      if (change.after === null) maps[change.scope].delete(change.key);
      else maps[change.scope].set(change.key, change.after);
    }
    const metadata = { ...latestMetadata, macro_variables: { ...latestMetadata.macro_variables, global: Object.fromEntries(maps.global) },
      chat_variables: Object.fromEntries(maps.chat), another_one_applied_variables: nextApplied, another_one_fork: chatId };
    if (!nextApplied) delete metadata.another_one_applied_variables;
    const target = [...messages].reverse().find(m => m.role === "assistant");
    if (!await compareChatMetadata(this.api, user, chatId, chat.metadata, metadata, messages, target)) return false;
    this.api.sendToFrontend({ type: "historyChanged" }, user);
    return true;
  }
}
