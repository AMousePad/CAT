import type { ChatMessageDTO, SpindleAPI } from "lumiverse-spindle-types";
import { ParallelRun, type PreparedPrompt } from "../generation/parallel-run";
import { errorText, validateSlots, type ActivationPatch, type Catalog, type Inspection, type ViewState } from "../shared";
import type { Preparation } from "../types";
import type { Leases } from "./leases";
import type { Storage } from "./storage";
import { contentHash, usesMultiplePresets, withPresetNote } from "../generation/preset-context";
import type { VariableCapture } from "./variable-capture";
import type { VariableSelection } from "./variable-selection";
import type { MessageVariables } from "../generation/variable-state";

interface Parent { generationId: string; chatId: string; generationType?: string; frontendSessionId?: string; characterName?: string; characterId?: string }
interface Owner {
  user: string; session: string; chatId: string; armed: boolean; view: ViewState;
  slots: Preparation["slots"]; catalog: Catalog; parent?: Parent; takingOver?: string;
  configured: Array<Preparation["slots"][number] & { id: string }>; nextIds?: string[];
  preparation?: Preparation; current?: ParallelRun; deadline?: ReturnType<typeof setTimeout>; launching?: string;
  prepared?: Map<number, Promise<{ token: string; presetId: string }>>;
  switching?: boolean; completion?: Promise<void>; navigation?: number;
}

export class Automation {
  private owners = new Map<string, Owner>();
  private arming = new Map<string, { session: string }>();
  private active = new Map<string, Parent>();
  constructor(private api: SpindleAPI, private storage: Storage, private leases: Leases,
    private catalog: (user: string) => Promise<Catalog>, private inspect: (chat: string, user: string) => Promise<Inspection>,
    private variables?: { capture: VariableCapture; selection: VariableSelection },
    private prepareChat?: (user: string, chatId: string) => Promise<void>) {
    api.on("GENERATION_STARTED", (payload, user) => { if (user) this.started(payload as Parent, user); });
    api.on("FRONTEND_SESSION_CLOSED", (raw, user) => {
      if (!user) return;
      const { frontendSessionId } = raw as { frontendSessionId: string };
      if (this.arming.get(user)?.session === frontendSessionId) this.arming.delete(user);
      const owner = this.owners.get(user);
      if (owner?.session === frontendSessionId && owner.armed)
        void this.disarm(user, frontendSessionId, true, "Browser disconnected. Partial replies saved.");
    });
    api.on("GENERATION_STOPPED", (p, user) => { if (user) void this.stopped(p, user); });
    api.on("GENERATION_ENDED", (p, user) => {
      if (!user) return;
      const key = `${user}:${p.chatId}`;
      if (this.active.get(key)?.generationId === p.generationId) this.active.delete(key);
      const owner = this.owners.get(user);
      if (owner?.parent?.generationId === p.generationId && !owner.current) void this.fail(owner, "Generation ended before the swipes could start. Enable again.");
    });
    api.on("MESSAGE_SENT", (raw, user) => {
      const p = raw as { chatId: string; message?: { is_user: boolean } };
      const owner = user && this.owners.get(user);
      if (owner && p.chatId === owner.chatId && p.message?.is_user && (owner.current || owner.preparation)) {
        void this.disarm(user!, owner.session, true, "A new message stopped the previous swipes.");
      }
    });
    api.on("MESSAGE_EDITED", (raw, user) => {
      const p = raw as { message?: ChatMessageDTO };
      const run = user ? this.owners.get(user)?.current : undefined;
      if (run && p.message && p.message.id === run.record.messageId) run.observeEdit(p.message.swipes, p.message.extra);
    });
    api.on("MESSAGE_SWIPED", (raw, user) => {
      const p = raw as { action: string; message?: ChatMessageDTO };
      const run = user ? this.owners.get(user)?.current : undefined;
      // Navigation only changes the displayed index, which our writer preserves.
      if (p.action !== "navigated" && run && p.message && p.message.id === run.record.messageId) run.observeEdit(p.message.swipes, p.message.extra);
    });
    api.on("MESSAGE_DELETED", (raw, user) => {
      const p = raw as { messageId: string };
      const owner = user ? this.owners.get(user) : undefined;
      if (owner?.current?.record.messageId === p.messageId) owner.current.observeDeletion();
      else if (owner?.view.run?.messageId === p.messageId) {
        owner.view.run = null; this.emit(owner, owner.view.phase, owner.view.detail);
      }
    });
    api.registerContextHandler(async (raw, signal) => {
      const context = raw as { userId: string; chatId: string; frontendSessionId?: string; connectionId?: string; generationType: string; dryRun: boolean; personaId?: string };
      if (context.dryRun || context.generationType !== "normal" || !context.frontendSessionId || signal?.aborted) return raw;
      let owner = this.owners.get(context.userId);
      if (!owner?.armed || owner.session !== context.frontendSessionId || owner.chatId !== context.chatId) {
        const activation = await this.storage.activation(context.userId);
        if (!activation.enabled || signal?.aborted) return raw;
        const parent = this.active.get(`${context.userId}:${context.chatId}`);
        if (!parent || parent.frontendSessionId !== context.frontendSessionId) return raw;
        if (owner?.current || owner?.preparation || owner?.switching) throw new Error("Wait for the current swipes to finish or press Stop.");
        if (owner) await this.disarm(owner.user, owner.session, false, "Control moved to the browser sending this message.");
        await this.arm(context.userId, context.frontendSessionId, context.chatId, context.connectionId || "", activation.slotIds, parent.generationId);
        owner = this.owners.get(context.userId);
        if (!owner?.armed || signal?.aborted) return raw;
        owner.parent = parent;
      }
      if (owner.switching) throw new Error("CAT is opening the fork. Wait for it to finish before sending.");
      if (!owner.parent || owner.current || owner.preparation) return raw;
      const parent = owner.parent;
      if (!this.leases.heartbeat(owner.user, owner.session)) { await this.fail(owner, "The browser connection expired. Enable again."); return raw; }
      await this.variables?.selection.sync(owner.user, owner.chatId);
      const messages = await api.chat.getMessages(owner.chatId);
      if (signal?.aborted || !owner.armed || this.owners.get(owner.user) !== owner || owner.parent !== parent || owner.current || owner.preparation) return raw;
      if (messages.some(m => Array.isArray(m.extra.attachments) && m.extra.attachments.length)) {
        await this.fail(owner, "This chat has attachments. CAT supports text only, so Lumiverse will generate this reply normally."); return raw;
      }
      owner.takingOver = owner.parent.generationId;
      owner.slots = owner.configured.filter(s => !owner.nextIds || owner.nextIds.includes(s.id));
      owner.preparation = { type: "prepare", runId: crypto.randomUUID(), chatId: owner.chatId,
        name: owner.parent.characterName || "Assistant", characterId: owner.parent.characterId, personaId: context.personaId, slots: owner.slots,
        mixedPresets: usesMultiplePresets(messages, owner.slots.map(s => s.presetId)) };
      owner.prepared = new Map();
      this.emit(owner, "preparing", "Preparing swipes…");
      return { ...context, cancelGeneration: true };
    }, 1, { required: true });
    setInterval(() => {
      for (const owner of this.owners.values()) if ((owner.armed || owner.current) && !this.leases.valid(owner.user, owner.session)) {
        void this.fail(owner, "The controlling browser disconnected. Partial replies have been kept.");
      }
    }, 15_000).unref?.();
  }
  private emit(owner: Owner, phase: ViewState["phase"], detail: string) {
    owner.view = { ...owner.view, phase, detail };
    this.api.sendToFrontend({ type: "view", view: owner.view, armed: owner.armed }, owner.user, { frontendSessionId: owner.session });
  }
  private owned(user: string, session: string): Owner {
    const owner = this.owners.get(user);
    if (!owner || owner.session !== session) throw new Error("Enable CAT in this browser first.");
    return owner;
  }
  private release(owner: Owner) {
    this.leases.release(owner.user, owner.session);
    if (!owner.current && this.owners.get(owner.user) === owner) this.owners.delete(owner.user);
  }
  getRun(user: string, runId: string) {
    const owner = this.owners.get(user);
    const run = owner?.current?.record ?? owner?.view.run;
    return run?.id === runId ? structuredClone(run) : undefined;
  }
  isCurrentRun(user: string, runId: string) {
    return this.owners.get(user)?.current?.record.id === runId;
  }
  preparePreset(user: string, session: string, runId: string, index: number) {
    const owner = this.owned(user, session);
    if (!this.variables || !owner.armed || owner.preparation?.runId !== runId || !Number.isInteger(index) || !owner.slots[index] || !owner.prepared) throw new Error("These swipes were cancelled.");
    const existing = owner.prepared.get(index);
    if (existing) return existing;
    const work = this.variables.capture.create(user, owner.chatId, runId, owner.slots[index].presetId).then(async value => {
      if (!owner.armed || owner.preparation?.runId !== runId) {
        await this.variables!.capture.cancel(user, runId); throw new Error("These swipes were cancelled.");
      }
      return value;
    });
    owner.prepared.set(index, work);
    return work;
  }
  async arm(user: string, session: string, chatId: string, connectionId: string, nextIds?: string[], nativeGenerationId?: string): Promise<ViewState> {
    const previous = this.owners.get(user);
    if (previous?.current || previous?.preparation) throw new Error("Wait for the swipes to finish or press Stop.");
    if (this.arming.has(user)) throw new Error("CAT is already enabling. Wait for it to finish.");
    const attempt = { session };
    this.arming.set(user, attempt);
    try {
      await this.prepareChat?.(user, chatId);
      const [catalog, inspection, council, activation] = await Promise.all([this.catalog(user), this.inspect(chatId, user), this.api.council.getSettings({ userId: user }),
        nativeGenerationId ? this.storage.activation(user) : undefined]);
      if (this.arming.get(user) !== attempt) throw new Error("Enabling was cancelled.");
      if (nativeGenerationId && !activation?.enabled) throw new Error("CAT was disabled before the swipes could start.");
      validateSlots(catalog.settings.slots, catalog.presets, catalog.connections);
      if (inspection.blockedReason) throw new Error(inspection.blockedReason);
      const native = this.active.get(`${user}:${chatId}`);
      if ((inspection.busy || native) && (!nativeGenerationId || native?.generationId !== nativeGenerationId)) throw new Error("Wait for the current generation to finish.");
      if (council.councilMode && council.members.length) throw new Error("Turn off Council to use CAT.");
      const slots = catalog.settings.slots.map(s => ({ id: s.id, presetId: s.presetId, connectionId: s.connectionId || connectionId }));
      this.validateNextIds(slots, nextIds);
      if (slots.some(s => !catalog.connections.some(c => c.id === s.connectionId))) throw new Error("Select an active connection or choose one for each swipe.");
      const latest = this.owners.get(user);
      if (latest?.current || latest?.preparation) throw new Error("Swipes are already generating. Press Stop first.");
      if (!this.leases.claim(user, session)) throw new Error("Another browser controls CAT. Disable it there first.");
      const owner: Owner = { user, session, chatId, armed: true, slots, configured: slots, nextIds, catalog,
        view: { phase: "ready", detail: "Enabled. Send a message to generate swipes.", run: null } };
      this.owners.set(user, owner); this.emit(owner, "ready", owner.view.detail); return owner.view;
    } finally { if (this.arming.get(user) === attempt) this.arming.delete(user); }
  }
  async setActivation(user: string, patch: ActivationPatch) {
    if (patch.slotIds) this.validateNextIds((await this.storage.settings(user)).slots, patch.slotIds);
    const activation = await this.storage.setActivation(user, patch);
    const owner = this.owners.get(user);
    if (!activation.enabled) {
      this.arming.delete(user);
      if (owner) await this.disarm(user, owner.session);
    } else if (owner?.armed) owner.nextIds = activation.slotIds;
    this.api.sendToFrontend({ type: "activation", activation }, user);
    return activation;
  }
  private validateNextIds(slots: { id: string }[], ids?: string[]) {
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > slots.length || new Set(ids).size !== ids.length || ids.some(id => !slots.some(s => s.id === id))))
      throw new Error("Choose at least one configured profile for the next generation.");
  }
  async followFork(user: string, session: string, chatId: string): Promise<ViewState | null> {
    const owner = this.owned(user, session);
    const navigation = owner.navigation = (owner.navigation ?? 0) + 1;
    if (!owner.armed || !this.leases.valid(user, session)) return null;
    owner.switching = true;
    const chat = await this.api.chats.get(chatId, user);
    if (owner.navigation !== navigation) return null;
    if (!chat || chat.metadata.branched_from !== owner.chatId) { owner.switching = false; return null; }
    const runId = owner.preparation?.runId;
    clearTimeout(owner.deadline); owner.preparation = undefined; owner.parent = undefined; owner.takingOver = undefined;
    try {
      if (runId) await this.cancelPreparation(owner, runId);
      owner.current?.stop("Opened a fork. Partial replies have been kept in the original chat.");
      await owner.completion;
      await this.prepareChat?.(user, chatId);
      const inspection = await this.inspect(chatId, user);
      if (inspection.blockedReason || inspection.busy) throw new Error(inspection.blockedReason || "Wait for this chat's generation to finish.");
      const history = await this.storage.history(user, chatId);
      if (!owner.armed || owner.navigation !== navigation || this.owners.get(user) !== owner || !this.leases.valid(user, session)) return null;
      owner.chatId = chatId;
      owner.view = { phase: "ready", detail: "Enabled. Send a message to generate swipes.",
        run: history.find(run => run.chatId === chatId) ?? null };
      this.emit(owner, "ready", owner.view.detail);
      return owner.view;
    } finally { if (owner.navigation === navigation) owner.switching = false; }
  }
  private started(p: Parent, user: string) {
    this.active.set(`${user}:${p.chatId}`, p);
    const owner = this.owners.get(user);
    if (!owner?.armed || owner.switching || p.chatId !== owner.chatId) return;
    if (p.frontendSessionId !== owner.session && p.generationType === "normal" && !owner.current && !owner.preparation) return;
    if (p.frontendSessionId !== owner.session || p.generationType !== "normal" || owner.current || owner.preparation) {
      void this.disarm(user, owner.session, true, "Another generation stopped these swipes."); return;
    }
    owner.parent = p;
  }
  private async stopped(p: { generationId: string; chatId: string }, user: string) {
    if (this.active.get(`${user}:${p.chatId}`)?.generationId === p.generationId) this.active.delete(`${user}:${p.chatId}`);
    const owner = this.owners.get(user);
    if (!owner || owner.parent?.generationId !== p.generationId) return;
    owner.parent = undefined;
    if (owner.armed && owner.takingOver === p.generationId && owner.preparation) {
      owner.takingOver = undefined;
      owner.deadline = setTimeout(() => { void this.fail(owner, "Prompt preparation did not finish. Enable again to retry."); }, 120_000);
      this.api.sendToFrontend(owner.preparation, user, { frontendSessionId: owner.session });
    } else await this.disarm(user, owner.session, true, "Stopped before generating swipes.");
  }
  async launch(user: string, session: string, runId: string, messageId: string, prompts: PreparedPrompt[]): Promise<boolean> {
    const owner = this.owned(user, session);
    if (!owner.armed || owner.preparation?.runId !== runId || owner.current || owner.launching) throw new Error("These swipes were cancelled or already started.");
    if (!Array.isArray(prompts) || prompts.length !== owner.slots.length || prompts.some((p, i) => !p || p.connectionId !== owner.slots[i].connectionId || typeof p.provider !== "string" || typeof p.model !== "string" || !p.parameters || typeof p.parameters !== "object" || Array.isArray(p.parameters) || !Array.isArray(p.messages) || !p.messages.length)) throw new Error("The prepared requests do not match your profiles. Enable again to retry.");
    owner.launching = runId;
    let chatName: string;
    let messageIndex: number;
    let characterName: string;
    let variableState: MessageVariables | undefined;
    const swipeIds = owner.slots.map(() => crypto.randomUUID());
    try {
      const messages = await this.api.chat.getMessages(owner.chatId);
      const last = messages.at(-1);
      if (last?.id !== messageId || last.role !== "assistant" || last.content || last.metadata?.another_one_run !== runId) throw new Error("The conversation changed before streaming could start.");
      messageIndex = last.index_in_chat;
      characterName = last.name;
      const inspection = await this.inspect(owner.chatId, user);
      if (inspection.blockedReason || inspection.busy) throw new Error(inspection.blockedReason || "Another generation started before streaming could begin.");
      chatName = inspection.chatName;
      if (!owner.armed || owner.preparation?.runId !== runId || !this.leases.valid(user, session)) throw new Error("Cancelled before generating swipes.");
      if (this.variables) {
        variableState = { version: 1, slots: await Promise.all(prompts.map(async (prompt, index) => {
          const prepared = await owner.prepared?.get(index);
          if (!prepared || prompt.captureToken !== prepared.token) throw new Error("This request has no captured variable state.");
          return { ...(await this.variables!.capture.finish(user, runId, owner.slots[index].presetId, prepared.token, prompt.variableState)), swipeId: swipeIds[index] };
        })) };
        if (JSON.stringify(variableState).length > 2_000_000) throw new Error("The combined variable state is too large to save.");
      }
      if (!owner.armed || owner.preparation?.runId !== runId || !this.leases.valid(user, session)) throw new Error("Cancelled before generating swipes.");
    } finally { owner.launching = undefined; }
    const mixedPresets = owner.preparation.mixedPresets === true;
    clearTimeout(owner.deadline); owner.preparation = undefined;
    let firstWrite = true;
    const run = new ParallelRun({ id: runId, chatId: owner.chatId, chatName, messageId, messageIndex, characterName, at: Date.now(), outcome: "running",
      steps: owner.slots.map((s, i) => ({ swipeId: swipeIds[i], presetId: s.presetId, presetName: owner.catalog.presets.find(p => p.id === s.presetId)!.name,
        connectionName: owner.catalog.connections.find(c => c.id === s.connectionId)!.name, status: "waiting" })) }, prompts, {
      stream: (prompt, signal) => {
        // The prompt is already assembled. Quiet generation would merge the connection's bound preset again.
        const { model, ...parameters } = prompt.parameters;
        const request = { type: "raw" as const, userId: user, connection_id: prompt.connectionId, provider: prompt.provider,
          model: typeof model === "string" && model.trim() ? model.trim() : prompt.model,
          messages: withPresetNote(prompt.messages, mixedPresets), parameters, signal };
        return this.api.generate.rawStream(request);
      },
      write: async (swipes, final, reasoning) => {
        if (final && variableState) await Promise.all(variableState.slots.map(async (slot, i) => { slot.contentHash = await contentHash(swipes[i]); }));
        const patch = { swipes, swipe_reasoning: reasoning, skipChunkRebuild: true,
          ...(firstWrite || final ? { metadata_patch: { another_one_run: runId, another_one_presets: owner.slots.map(s => s.presetId),
            preset_contexts: owner.slots.map((slot, i) => ({ preset_id: slot.presetId, another_one_swipe_id: swipeIds[i],
              ...(variableState ? { variables: variableState.slots[i].snapshot } : {}) })),
            ...(variableState ? {
              another_one_variables: { ...variableState, slots: variableState.slots.map(({ snapshot: _, ...slot }) => slot) },
            } : {}) } } : {}) };
        await this.api.chat.updateMessage(owner.chatId, messageId, patch);
        if (firstWrite || final) await this.variables?.selection.sync(user, owner.chatId);
        firstWrite = false;
        // The final snapshot may equal the last partial write. Explicitly warm
        // once so memory chunks do not remain indexed from an earlier token.
        if (final) {
          try { await this.api.memories.chatMemory.warm(owner.chatId, { userId: user, force: true }); }
          catch (error) { run.record.detail = `Replies saved; chat memory refresh failed: ${errorText(error)}`; }
        }
      },
      changed: record => { owner.view.run = run.deleted ? null : record; this.emit(owner, "running", `Generating swipes. ${record.steps.filter(s => s.status === "done").length} of ${record.steps.length} finished.`); },
    });
    owner.current = run;
    owner.completion = run.run().then(async record => {
      if (!run.deleted) await this.storage.record(user, record);
      owner.current = undefined;
      if (owner.switching) return;
      if (record.outcome === "complete" && owner.armed) this.emit(owner, "ready", `${record.steps.length} ${record.steps.length === 1 ? "swipe" : "swipes"} finished.`);
      else { owner.armed = false; this.release(owner); this.emit(owner, record.outcome === "error" ? "error" : "off", record.detail || "Finished. See each swipe's status below."); }
    }).catch(error => { owner.current = undefined; void this.fail(owner, errorText(error)); });
    return true;
  }
  async fail(owner: Owner, detail: string) {
    const runId = owner.preparation?.runId;
    owner.armed = false; clearTimeout(owner.deadline); owner.preparation = undefined; owner.takingOver = undefined; owner.parent = undefined;
    owner.current?.stop(detail); this.release(owner); this.emit(owner, "error", detail);
    if (runId) await this.cancelPreparation(owner, runId);
  }
  async preparationFailed(user: string, session: string, runId: string, error: string, chatId: string, messageId?: string) {
    const owner = this.owners.get(user);
    if (owner?.session === session && owner.preparation?.runId === runId) await this.fail(owner, error);
    if (await this.api.chats.get(chatId, user)) {
      const message = (await this.api.chat.getMessages(chatId)).find(m => m.metadata?.another_one_run === runId && (!messageId || m.id === messageId));
      // A reply acknowledged after cancellation is still ours to remove, unless
      // streaming or a user edit has already given it content or context.
      if (message?.metadata?.another_one_run === runId && !message.metadata.another_one_presets &&
        !message.content && !message.swipes.some(Boolean) && !message.extra?.reasoning &&
        !(Array.isArray(message.extra?.reasoningBySwipe) && message.extra.reasoningBySwipe.some(Boolean)) &&
        !(Array.isArray(message.extra?.attachments) && message.extra.attachments.length))
        await this.api.chat.deleteMessage(chatId, message.id);
    }
    return true;
  }
  async disarm(user: string, session: string, stop = false, detail?: string): Promise<ViewState> {
    detail ??= stop ? "Stopped. Partial replies saved." : "Disabled";
    if (this.arming.get(user)?.session === session) {
      this.arming.delete(user);
      if (this.owners.get(user)?.session !== session) return { phase: "off", detail, run: null };
    }
    const owner = this.owned(user, session);
    owner.navigation = (owner.navigation ?? 0) + 1; owner.switching = false;
    const runId = owner.preparation?.runId;
    owner.armed = false; clearTimeout(owner.deadline); owner.preparation = undefined; owner.takingOver = undefined; owner.parent = undefined;
    if (stop) owner.current?.stop(detail);
    if (!owner.current) this.release(owner);
    this.emit(owner, owner.current ? "running" : "off", owner.current && !stop ? "Disabled. Current swipes will finish." : detail);
    if (runId) await this.cancelPreparation(owner, runId);
    return owner.view;
  }
  private async cancelPreparation(owner: Owner, runId: string) {
    try { await this.variables?.capture.cancel(owner.user, runId); }
    catch (error) { this.emit(owner, "error", `Could not cancel prompt preparation: ${errorText(error)}`); }
  }
}
