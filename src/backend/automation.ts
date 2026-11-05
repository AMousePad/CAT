import type { ChatMessageDTO, SpindleAPI } from "lumiverse-spindle-types";
import { ParallelRun, type PreparedPrompt } from "../generation/parallel-run";
import { errorText, validateSlots, type ActivationPatch, type Catalog, type Inspection, type ViewState } from "../shared";
import type { Preparation } from "../types";
import type { Leases } from "./leases";
import { LumiCacheLink } from "./lumicache";
import type { Storage } from "./storage";
import { contentHash, usesMultiplePresets, withPresetNote } from "../generation/preset-context";
import type { VariableCapture } from "./variable-capture";
import type { VariableSelection } from "./variable-selection";
import type { MessageVariables } from "../generation/variable-state";

interface Parent { renderMode?: string; targetMessageId?: string; generationId: string; chatId: string; generationType?: string; frontendSessionId?: string; characterName?: string; characterId?: string }
interface Owner {
  user: string; session: string; chatId: string; armed: boolean; view: ViewState;
  slots: Array<Preparation["slots"][number] & { id: string }>; catalog: Catalog; parent?: Parent; takingOver?: string;
  configured: Array<Preparation["slots"][number] & { id: string }>; nextIds?: string[];
  preparation?: Preparation; current?: ParallelRun; deadline?: ReturnType<typeof setTimeout>; launching?: string;
  prepared?: Map<number, Promise<{ token: string; presetId: string; prompt: PreparedPrompt }>>;
  managedId?: string;
  detached?: boolean;
  switching?: boolean; completion?: Promise<void>; navigation?: number;
}

const streamModel = (prompt: PreparedPrompt) => {
  const model = prompt.parameters.model;
  return typeof model === "string" && model.trim() ? model.trim() : prompt.model;
};

export class Automation {
  private owners = new Map<string, Owner>();
  private arming = new Map<string, { session: string; chatId: string; background: boolean; detached: boolean }>();
  private active = new Map<string, Parent>();
  private cache?: LumiCacheLink;
  constructor(private api: SpindleAPI, private storage: Storage, private leases: Leases,
    private catalog: (user: string) => Promise<Catalog>, private inspect: (chat: string, user: string) => Promise<Inspection>,
    private variables?: { capture: VariableCapture; selection: VariableSelection },
    private prepareChat?: (user: string, chatId: string) => Promise<void>) {
    if (api.rpcPool) this.cache = new LumiCacheLink(api);
    api.on("GENERATION_STARTED", (payload, user) => { if (user) this.started(payload as Parent, user); });
    api.on("FRONTEND_SESSION_CLOSED", (raw, user) => {
      if (!user) return;
      const { frontendSessionId } = raw as { frontendSessionId: string };
      const attempt = this.arming.get(user);
      if (attempt?.session === frontendSessionId) {
        if (attempt.background) attempt.detached = true;
        else this.arming.delete(user);
      }
      const owner = this.owners.get(user);
      if (owner?.session === frontendSessionId) this.detach(owner);
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
      if (!owner.detached) this.leases.claim(owner.user, owner.session);
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
        this.detach(owner);
      }
    }, 15_000).unref?.();
  }
  private emit(owner: Owner, phase: ViewState["phase"], detail: string) {
    owner.view = { ...owner.view, phase, detail };
    if (owner.detached) return;
    this.api.sendToFrontend({ type: "view", chatId: owner.chatId, view: owner.view, armed: owner.armed }, owner.user, { frontendSessionId: owner.session });
  }
  private detach(owner: Owner) {
    owner.detached = true;
    this.leases.release(owner.user, owner.session);
    if (!owner.parent && !owner.preparation && !owner.current) {
      owner.armed = false; this.release(owner, owner.view.phase === "error");
    }
  }
  resume(user: string, session: string, chatId?: string) {
    const attempt = this.arming.get(user);
    if (attempt?.background && attempt.chatId === chatId && (attempt.detached || attempt.session === session)) {
      attempt.session = session; attempt.detached = false;
    }
    const owner = this.owners.get(user);
    if (!owner || owner.chatId !== chatId || (owner.session !== session && !owner.detached && this.leases.valid(user, owner.session))) return;
    this.leases.release(user, owner.session);
    owner.session = session; owner.detached = false; this.leases.claim(user, session);
    this.emit(owner, owner.view.phase, owner.view.detail);
  }
  heartbeat(user: string, session: string) {
    const owner = this.owners.get(user);
    if (!owner || owner.session !== session) return false;
    this.resume(user, session, owner.chatId);
    return true;
  }
  private owned(user: string, session: string): Owner {
    const owner = this.owners.get(user);
    if (!owner || owner.session !== session) throw new Error("Enable CAT in this browser first.");
    return owner;
  }
  private release(owner: Owner, preserveView = false) {
    this.leases.release(owner.user, owner.session);
    if (!preserveView && !owner.current && this.owners.get(owner.user) === owner) this.owners.delete(owner.user);
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
      const slot = owner.slots[index];
      const result = await this.api.generate.dryRun({ chatId: owner.chatId, connectionId: slot.connectionId,
        presetId: value.presetId, forcePresetId: true, includeRequestMessages: true, retainResponseContext: true,
        personaId: owner.preparation?.personaId, generationType: "normal" }, user);
      if (!result.responseContextId || !Array.isArray(result.request_messages)) throw new Error("Update Lumiverse to a build with managed message generation before using CAT.");
      return { ...value, prompt: { connectionId: slot.connectionId, captureToken: value.token, responseContextId: result.responseContextId,
        variableState: result.variable_state, messages: result.request_messages, parameters: result.parameters, provider: result.provider, model: result.model, prefill: result.assistantPrefill || "" } };
    });
    owner.prepared.set(index, work);
    return work;
  }
  async arm(user: string, session: string, chatId: string, connectionId: string, nextIds?: string[], nativeGenerationId?: string): Promise<ViewState> {
    const previous = this.owners.get(user);
    if (previous?.current || previous?.preparation) throw new Error("Wait for the swipes to finish or press Stop.");
    if (this.arming.has(user)) throw new Error("CAT is already enabling. Wait for it to finish.");
    const attempt = { session, chatId, background: !!nativeGenerationId, detached: false };
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
      if (!this.leases.claim(user, attempt.session)) throw new Error("Another browser controls CAT. Disable it there first.");
      const owner: Owner = { user, session: attempt.session, chatId, armed: true, slots, configured: slots, nextIds, catalog, detached: attempt.detached,
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
    if (p.renderMode === "persisted-message" && owner?.current && owner.current.record.messageId === p.targetMessageId) {
      owner.managedId = p.generationId; return;
    }
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
    if (owner?.managedId === p.generationId) { owner.current?.stop(); return; }
    if (!owner || owner.parent?.generationId !== p.generationId) return;
    owner.parent = undefined;
    if (owner.armed && owner.takingOver === p.generationId && owner.preparation) {
      owner.takingOver = undefined;
      this.armDeadline(owner);
      await this.prepare(owner, owner.preparation);
    } else await this.disarm(user, owner.session, true, "Stopped before generating swipes.");
  }
  private armDeadline(owner: Owner) {
    clearTimeout(owner.deadline);
    owner.deadline = setTimeout(() => { void this.fail(owner, "Prompt preparation did not finish. Enable again to retry."); }, 120_000);
  }
  /** One profile at a time, so LumiCache only ever shows one review. */
  private async checkCache(owner: Owner, preparation: Preparation, prompts: PreparedPrompt[]) {
    if (!this.cache) return;
    // A person may take minutes to answer a review.
    clearTimeout(owner.deadline);
    for (const [index, prompt] of prompts.entries()) {
      const slot = owner.slots[index];
      const id = crypto.randomUUID();
      const messages = await this.cache.check({ id, userId: owner.user, chatId: preparation.chatId, slotId: slot.id,
        label: `CAT ${owner.catalog.presets.find(preset => preset.id === slot.presetId)?.name ?? slot.presetId}`,
        connectionId: prompt.connectionId, model: streamModel(prompt), session: owner.session,
        messages: withPresetNote(prompt.messages, preparation.mixedPresets === true) }, () => owner.preparation !== preparation);
      if (!messages) break;
      prompt.messages = messages; prompt.cacheCheckId = id;
    }
    this.armDeadline(owner);
  }
  private finishCache(owner: Owner, prompts: PreparedPrompt[], done: (index: number) => boolean) {
    const reports = prompts.flatMap((prompt, index) => prompt.cacheCheckId ? [this.cache!.finish(prompt.cacheCheckId, owner.user, done(index))] : []);
    return Promise.all(reports);
  }
  private async prepare(owner: Owner, preparation: Preparation) {
    let messageId: string | undefined;
    let checked: PreparedPrompt[] = [];
    try {
      const prompts = await Promise.all(preparation.slots.map(async (_, index) =>
        (await this.preparePreset(owner.user, owner.session, preparation.runId, index)).prompt));
      if (owner.preparation !== preparation) return;
      checked = prompts;
      await this.checkCache(owner, preparation, prompts);
      if (owner.preparation !== preparation) { await this.finishCache(owner, prompts, () => false); return; }
      messageId = (await this.api.chat.appendMessage(preparation.chatId, {
        role: "assistant", content: "", name: preparation.name, characterId: preparation.characterId,
        metadata: { another_one_run: preparation.runId },
      })).id;
      if (owner.preparation !== preparation) throw new Error("Stopped before generating swipes.");
      await this.launch(owner.user, owner.session, preparation.runId, messageId, prompts);
    } catch (error) {
      await this.preparationFailed(owner.user, owner.session, preparation.runId, errorText(error), preparation.chatId, messageId);
      await this.finishCache(owner, checked, () => false).catch(reason => this.emit(owner, "error", `Could not update LumiCache: ${errorText(reason)}`));
    }
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
      if (!owner.armed || owner.preparation?.runId !== runId) throw new Error("Cancelled before generating swipes.");
      if (this.variables) {
        variableState = { version: 1, slots: await Promise.all(prompts.map(async (prompt, index) => {
          const prepared = await owner.prepared?.get(index);
          if (!prepared || prompt.captureToken !== prepared.token) throw new Error("This request has no captured variable state.");
          return { ...(await this.variables!.capture.finish(user, runId, owner.slots[index].presetId, prepared.token, prompt.variableState)), swipeId: swipeIds[index] };
        })) };
        if (JSON.stringify(variableState).length > 2_000_000) throw new Error("The combined variable state is too large to save.");
      }
      if (!owner.armed || owner.preparation?.runId !== runId) throw new Error("Cancelled before generating swipes.");
    } finally { owner.launching = undefined; }
    const mixedPresets = owner.preparation.mixedPresets === true;
    clearTimeout(owner.deadline); owner.preparation = undefined;
    let firstWrite = true;
    const run: ParallelRun = new ParallelRun({ id: runId, chatId: owner.chatId, chatName, messageId, messageIndex, characterName, at: Date.now(), outcome: "running",
      steps: owner.slots.map((s, i) => ({ swipeId: swipeIds[i], presetId: s.presetId, presetName: owner.catalog.presets.find(p => p.id === s.presetId)!.name,
        connectionName: owner.catalog.connections.find(c => c.id === s.connectionId)!.name, status: "waiting" })) }, prompts, {
      stream: (prompt, signal) => {
        // The prompt is already assembled. Quiet generation would merge the connection's bound preset again.
        const { model: _model, ...parameters } = prompt.parameters;
        const request = { type: "raw" as const, userId: user, connection_id: prompt.connectionId, provider: prompt.provider,
          model: streamModel(prompt),
          messages: prompt.cacheCheckId ? prompt.messages : withPresetNote(prompt.messages, mixedPresets), parameters, signal, sessionId: owner.managedId, swipeIndex: prompts.indexOf(prompt) };
        return this.api.generate.rawStream(request);
      },
      write: async (swipes, final, reasoning) => {
        if (final && variableState) await Promise.all(variableState.slots.map(async (slot, i) => { slot.contentHash = await contentHash(swipes[i]); }));
        const patch = { swipes, swipe_reasoning: reasoning, skipChunkRebuild: true,
          ...(firstWrite || final ? { metadata_patch: { another_one_run: runId, another_one_presets: owner.slots.map(s => s.presetId),
            preset_contexts: owner.slots.map((slot, i) => ({ preset_id: slot.presetId, another_one_swipe_id: swipeIds[i],
              ...(variableState ? { variables: variableState.slots[i].snapshot } : {}) })),
            ...(variableState ? {
              another_one_variables: { ...variableState, slots: variableState.slots.map(({ snapshot: _, before: _before, revision: _revision, ...slot }) => slot) },
            } : {}) } } : {}) };
        await this.api.chat.updateMessage(owner.chatId, messageId, patch);
        if (firstWrite) {
          if (prompts.some(prompt => !prompt.responseContextId)) throw new Error("The prepared response context is missing.");
          const session = await this.api.generate.beginMessage({ chatId: owner.chatId, messageId,
            responseContextIds: prompts.map(prompt => prompt.responseContextId!), userId: user });
          owner.managedId = session.id;
          run.abort.signal.addEventListener("abort", () => { void this.api.generate.abortMessage(session.id).catch(() => {}); }, { once: true });
          if (run.abort.signal.aborted) await this.api.generate.abortMessage(session.id);
        }
        firstWrite = false;
      },
      finalize: async () => {
        if (owner.managedId) {
          const result = await this.api.generate.finishMessage(owner.managedId);
          if (!result.completed) run.stop();
        }
        const saved = (await this.api.chat.getMessages(owner.chatId)).find(message => message.id === messageId);
        if (!saved) { run.observeDeletion(); return { swipes: run.swipes, reasoning: run.reasoning }; }
        try { await this.api.memories.chatMemory.warm(owner.chatId, { userId: user, force: true }); }
        catch (error) { run.record.detail = `Replies saved; chat memory refresh failed: ${errorText(error)}`; }
        return { swipes: saved.swipes, reasoning: saved.swipes.map((_, index) => ({
          text: (saved.extra.reasoningBySwipe as Array<string | null> | undefined)?.[index] ?? null,
          duration: (saved.extra.reasoningDurationBySwipe as Array<number | null> | undefined)?.[index] ?? null,
        })) };
      },
      changed: record => { owner.view.run = run.deleted ? null : record; this.emit(owner, "running", `Generating swipes. ${record.steps.filter(s => s.status === "done").length} of ${record.steps.length} finished.`); },
    });
    owner.current = run;
    owner.completion = run.run().then(async record => {
      await this.finishCache(owner, prompts, index => record.steps[index]?.status === "done");
      if (!run.deleted) await this.storage.record(user, record);
      owner.current = undefined; owner.managedId = undefined;
      if (owner.detached) owner.armed = false;
      if (owner.switching) return;
      if (record.outcome === "complete" && owner.armed) this.emit(owner, "ready", `${record.steps.length} ${record.steps.length === 1 ? "swipe" : "swipes"} finished.`);
      else { owner.armed = false; this.release(owner); this.emit(owner, record.outcome === "error" ? "error" : "off", record.detail || "Finished. See each swipe's status below."); }
    }).catch(error => { owner.current = undefined; void this.fail(owner, errorText(error)); });
    return true;
  }
  async fail(owner: Owner, detail: string) {
    const runId = owner.preparation?.runId;
    owner.armed = false; clearTimeout(owner.deadline); owner.preparation = undefined; owner.takingOver = undefined; owner.parent = undefined;
    owner.prepared = undefined;
    owner.current?.stop(detail); this.release(owner, owner.detached === true); this.emit(owner, "error", detail);
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
