import type { SpindleAPI } from "lumiverse-spindle-types";
import { MAX_HISTORY, MAX_SWIPES, normalizeSettings, type Settings, type RunRecord, type Activation, type ActivationPatch, type MessageSummary } from "../shared";

export class Storage {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private api: SpindleAPI["userStorage"]) {}
  async settings(userId: string): Promise<Settings> {
    await this.locks.get(userId);
    return normalizeSettings(await this.read("settings.json", userId, null));
  }
  history(userId: string): Promise<RunRecord[]> { return this.read("history.json", userId, []); }
  async activation(userId: string): Promise<Activation> {
    await this.locks.get(userId);
    return this.read("activation.json", userId, { enabled: false, revision: 0 });
  }
  setActivation(userId: string, patch: ActivationPatch): Promise<Activation> {
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("Enabled must be true or false.");
    if (patch.slotIds != null && (!Array.isArray(patch.slotIds) || !patch.slotIds.length || patch.slotIds.length > MAX_SWIPES
      || patch.slotIds.some(id => typeof id !== "string" || !id || id.length > 100) || new Set(patch.slotIds).size !== patch.slotIds.length))
      throw new Error("Choose at least one profile.");
    return this.write(userId, async () => {
      const previous = await this.read<Activation>("activation.json", userId, { enabled: false, revision: 0 });
      const next = { ...previous, revision: previous.revision + 1, ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }) };
      if (patch.slotIds === null) delete next.slotIds;
      else if (patch.slotIds !== undefined) next.slotIds = [...patch.slotIds];
      await this.api.setJson("activation.json", next, { userId, indent: 2 });
      return next;
    });
  }
  private async read<T>(path: string, userId: string, fallback: T): Promise<T> {
    if (!await this.api.exists(path, userId)) return fallback;
    return JSON.parse(await this.api.read(path, userId)) as T;
  }
  private write<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const work = (this.locks.get(userId) ?? Promise.resolve()).then(task, task);
    const tail = work.catch(() => {});
    this.locks.set(userId, tail);
    void tail.finally(() => { if (this.locks.get(userId) === tail) this.locks.delete(userId); });
    return work;
  }
  save(userId: string, input: unknown): Promise<Settings> {
    const settings = normalizeSettings(input);
    return this.write(userId, async () => { await this.api.setJson("settings.json", settings, { userId, indent: 2 }); return settings; });
  }
  record(userId: string, run: RunRecord): Promise<void> {
    return this.recordMany(userId, [run]);
  }
  removeMessage(userId: string, chatId: string, messageId: string): Promise<boolean> {
    return this.write(userId, async () => {
      const history = await this.history(userId);
      const next = history.filter(run => run.chatId !== chatId || run.messageId !== messageId);
      if (next.length === history.length) return false;
      await this.api.setJson("history.json", next, { userId, indent: 2 });
      return true;
    });
  }
  reconcileHistory(userId: string, checked: readonly RunRecord[], messages: Record<string, MessageSummary | null>): Promise<void> {
    const byId = new Map(checked.map(run => [run.id, run.messageId]));
    return this.write(userId, async () => {
      const history = await this.history(userId);
      // Only reconcile the entries read before fetching messages. A new run may
      // have finished while that request was in flight.
      const next = history.flatMap(run => {
        if (!byId.has(run.id) || byId.get(run.id) !== run.messageId) return [run];
        const message = messages[run.messageId];
        return message ? [{ ...run, messageIndex: message.index, characterName: message.name }] : [];
      });
      if (JSON.stringify(next) !== JSON.stringify(history)) await this.api.setJson("history.json", next, { userId, indent: 2 });
    });
  }
  recordMany(userId: string, runs: RunRecord[]): Promise<void> {
    if (runs.some(run => !run.messageId)) return Promise.reject(new Error("A swipe entry must belong to a message."));
    if (!runs.length) return Promise.resolve();
    return this.write(userId, async () => {
      const history = await this.history(userId);
      const ids = new Set(runs.map(r => r.id));
      const next = [...runs, ...history.filter(r => !ids.has(r.id))].slice(0, MAX_HISTORY);
      await this.api.setJson("history.json", next, { userId, indent: 2 });
    });
  }
}
