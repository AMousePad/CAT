import type { SpindleAPI } from "lumiverse-spindle-types";
import { applyVariableSelection, persistentVariables, variableChanges, type AppliedVariables } from "../generation/variable-state";
import { selectedVariables } from "./forks";

export class VariableSelection {
  private chains = new Map<string, Promise<unknown>>();
  private observed = new Map<string, string>();
  constructor(private api: SpindleAPI, private prepareChat?: (user: string, chatId: string) => Promise<void>) {
    for (const event of ["MESSAGE_SWIPED", "SWIPE_EDITED", "MESSAGE_DELETED"] as const) api.on(event, (raw, user) => {
      const p = raw as { chatId: string; messageId?: string; message?: { id: string; swipe_id: number; swipes: string[] } };
      if (!user || !p.chatId) return;
      const key = `${user}:${p.chatId}`;
      const identity = p.message ? `${p.message.id}:${p.message.swipe_id}:${p.message.swipes.length}` : `deleted:${p.messageId}`;
      if (this.observed.get(key) === identity) return;
      this.remember(key, identity);
      void this.sync(user, p.chatId).catch(error => {
        api.log.error(`Could not apply swipe variables: ${String(error)}`);
        api.sendToFrontend({ type: "variableError", error: error instanceof Error ? error.message : String(error) }, user);
      });
    });
  }
  private remember(key: string, identity: string) {
    this.observed.delete(key); this.observed.set(key, identity);
    if (this.observed.size > 256) this.observed.delete(this.observed.keys().next().value!);
  }
  sync(user: string, chatId: string): Promise<void> {
    const key = `${user}:${chatId}`;
    const work = (this.chains.get(key) || Promise.resolve()).catch(() => {}).then(() => this.apply(user, chatId));
    this.chains.set(key, work);
    void work.finally(() => { if (this.chains.get(key) === work) this.chains.delete(key); }).catch(() => {});
    return work;
  }
  private async apply(user: string, chatId: string) {
    await this.prepareChat?.(user, chatId);
    const messages = await this.api.chat.getMessages(chatId);
    const target = [...messages].reverse().find(m => m.role === "assistant");
    const selected = target && await selectedVariables(target);
    const chat = await this.api.chats.get(chatId, user);
    if (!chat) return;
    const applied = chat.metadata.another_one_applied_variables as (AppliedVariables & { slot: number }) | undefined;
    if (!target || !selected) {
      if (applied && !messages.some(m => m.id === applied.messageId)) {
        await this.save(user, chatId, chat.metadata, applyVariableSelection(persistentVariables(chat.metadata), applied.changes, []));
      }
      return;
    }
    const { slot, index } = selected;
    if (applied?.messageId === target.id && applied.slot === index) return;
    const previousMessageId = applied?.messageId;
    const prior = previousMessageId === target.id || (previousMessageId && !messages.some(m => m.id === previousMessageId)) ? applied?.changes || [] : [];
    const current = persistentVariables(chat.metadata);
    const values = applyVariableSelection(current, prior, slot.changes);
    await this.save(user, chatId, chat.metadata, values, { messageId: target.id, slot: index, changes: slot.changes });
    this.remember(`${user}:${chatId}`, `${target.id}:${target.swipe_id}:${target.swipes.length}`);
  }
  private async save(user: string, chatId: string, metadata: Record<string, any>,
    values: ReturnType<typeof persistentVariables>, applied?: AppliedVariables & { slot: number }) {
    const current = persistentVariables(metadata);
    const maps = { global: new Map(Object.entries(metadata.macro_variables?.global || {})), chat: new Map(Object.entries(metadata.chat_variables || {})) };
    for (const change of variableChanges(current, { local: {}, ...values })) {
      if (change.after === null) maps[change.scope].delete(change.key);
      else maps[change.scope].set(change.key, change.after);
    }
    const next = { ...metadata,
      macro_variables: { ...metadata.macro_variables, global: Object.fromEntries(maps.global) },
      chat_variables: Object.fromEntries(maps.chat),
      another_one_applied_variables: applied,
    };
    if (!applied) delete next.another_one_applied_variables;
    await this.api.chats.update(chatId, { metadata: next }, user);
  }
}
