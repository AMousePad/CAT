// @bun
// src/shared.ts
var MAX_SWIPES = 20;
var MAX_HISTORY = 20;
function normalizeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const slots = [];
  const ids = new Set;
  for (const entry of Array.isArray(value.slots) ? value.slots.slice(0, MAX_SWIPES) : []) {
    if (!entry || typeof entry !== "object")
      continue;
    const s = entry;
    if (typeof s.id !== "string" || !s.id || s.id.length > 100 || ids.has(s.id))
      continue;
    ids.add(s.id);
    slots.push({
      id: s.id,
      presetId: typeof s.presetId === "string" ? s.presetId.slice(0, 100) : "",
      connectionId: typeof s.connectionId === "string" && s.connectionId ? s.connectionId.slice(0, 100) : null
    });
  }
  return { version: 1, slots, cats: value.cats !== false };
}
function validateSlots(slots, presets, connections) {
  if (!slots.length)
    throw new Error("Add a profile in Settings first.");
  if (slots.length > MAX_SWIPES)
    throw new Error(`Use up to ${MAX_SWIPES} profiles.`);
  for (const slot of slots) {
    if (!presets.some((p) => p.id === slot.presetId))
      throw new Error("Choose a preset for each profile.");
    if (slot.connectionId && !connections.some((c) => c.id === slot.connectionId))
      throw new Error("A selected connection is no longer available.");
  }
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/backend/storage.ts
class Storage {
  api;
  locks = new Map;
  constructor(api) {
    this.api = api;
  }
  async settings(userId) {
    await this.locks.get(userId);
    return normalizeSettings(await this.read("settings.json", userId, null));
  }
  historyPath(chatId) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(chatId))
      throw new Error("Invalid chat ID.");
    return `history/${chatId}.json`;
  }
  async readHistory(userId, chatId) {
    const path = this.historyPath(chatId);
    if (await this.api.exists(path, userId))
      return this.read(path, userId, []);
    const legacy = await this.read("history.json", userId, []);
    const history = legacy.filter((run) => run.chatId === chatId).slice(0, MAX_HISTORY);
    await this.api.setJson(path, history, { userId, indent: 2 });
    return history;
  }
  history(userId, chatId) {
    return this.write(userId, () => this.readHistory(userId, chatId));
  }
  async activation(userId) {
    await this.locks.get(userId);
    return this.read("activation.json", userId, { enabled: false, revision: 0 });
  }
  setActivation(userId, patch) {
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean")
      throw new Error("Enabled must be true or false.");
    if (patch.slotIds != null && (!Array.isArray(patch.slotIds) || !patch.slotIds.length || patch.slotIds.length > MAX_SWIPES || patch.slotIds.some((id) => typeof id !== "string" || !id || id.length > 100) || new Set(patch.slotIds).size !== patch.slotIds.length))
      throw new Error("Choose at least one profile.");
    return this.write(userId, async () => {
      const previous = await this.read("activation.json", userId, { enabled: false, revision: 0 });
      const next = { ...previous, revision: previous.revision + 1, ...patch.enabled === undefined ? {} : { enabled: patch.enabled } };
      if (patch.slotIds === null)
        delete next.slotIds;
      else if (patch.slotIds !== undefined)
        next.slotIds = [...patch.slotIds];
      await this.api.setJson("activation.json", next, { userId, indent: 2 });
      return next;
    });
  }
  async read(path, userId, fallback) {
    if (!await this.api.exists(path, userId))
      return fallback;
    return JSON.parse(await this.api.read(path, userId));
  }
  write(userId, task) {
    const work = (this.locks.get(userId) ?? Promise.resolve()).then(task, task);
    const tail = work.catch(() => {});
    this.locks.set(userId, tail);
    tail.finally(() => {
      if (this.locks.get(userId) === tail)
        this.locks.delete(userId);
    });
    return work;
  }
  save(userId, input) {
    const settings = normalizeSettings(input);
    return this.write(userId, async () => {
      await this.api.setJson("settings.json", settings, { userId, indent: 2 });
      return settings;
    });
  }
  record(userId, run) {
    return this.recordMany(userId, [run]);
  }
  removeMessage(userId, chatId, messageId) {
    return this.write(userId, async () => {
      const history = await this.readHistory(userId, chatId);
      const next = history.filter((run) => run.chatId !== chatId || run.messageId !== messageId);
      if (next.length === history.length)
        return false;
      await this.api.setJson(this.historyPath(chatId), next, { userId, indent: 2 });
      return true;
    });
  }
  reconcileHistory(userId, checked, messages) {
    return this.write(userId, async () => {
      for (const chatId of new Set(checked.map((run) => run.chatId))) {
        const byId = new Map(checked.filter((run) => run.chatId === chatId).map((run) => [run.id, run.messageId]));
        const history = await this.readHistory(userId, chatId);
        const next = history.flatMap((run) => {
          if (!byId.has(run.id) || byId.get(run.id) !== run.messageId)
            return [run];
          const message = messages[run.messageId];
          return message ? [{ ...run, messageIndex: message.index, characterName: message.name }] : [];
        });
        if (JSON.stringify(next) !== JSON.stringify(history))
          await this.api.setJson(this.historyPath(chatId), next, { userId, indent: 2 });
      }
    });
  }
  recordMany(userId, runs, validate) {
    if (runs.some((run) => !run.messageId))
      return Promise.reject(new Error("A swipe entry must belong to a message."));
    if (!runs.length)
      return Promise.resolve();
    return this.write(userId, async () => {
      if (validate)
        runs = await validate(runs);
      for (const chatId of new Set(runs.map((run) => run.chatId))) {
        const incoming = runs.filter((run) => run.chatId === chatId);
        const history = await this.readHistory(userId, chatId);
        const messages = new Set(incoming.map((run) => run.messageId));
        const next = [...incoming, ...history.filter((run) => !messages.has(run.messageId))].slice(0, MAX_HISTORY);
        await this.api.setJson(this.historyPath(chatId), next, { userId, indent: 2 });
      }
    });
  }
}

// src/backend/leases.ts
class Leases {
  now;
  ttl;
  owners = new Map;
  constructor(now = Date.now, ttl = 60000) {
    this.now = now;
    this.ttl = ttl;
  }
  claim(user, session) {
    const owner = this.owners.get(user);
    if (owner && owner.session !== session && this.now() - owner.at < this.ttl)
      return false;
    this.owners.set(user, { session, at: this.now() });
    return true;
  }
  heartbeat(user, session) {
    const owner = this.owners.get(user);
    if (!owner || owner.session !== session || this.now() - owner.at >= this.ttl)
      return false;
    owner.at = this.now();
    return true;
  }
  valid(user, session) {
    const owner = this.owners.get(user);
    return !!owner && owner.session === session && this.now() - owner.at < this.ttl;
  }
  release(user, session) {
    if (this.owners.get(user)?.session !== session)
      return false;
    this.owners.delete(user);
    return true;
  }
}

// src/generation/managed.ts
var managedGenerate = (api) => api.generate;

// src/generation/preset-context.ts
var PRESET_CHANGE_NOTE = "Note: Your instructions have changed, ensure you only generate prose-adjacent items that are **currently** specified. Do not generate structures based on past messages.";
function usesMultiplePresets(messages, presetIds) {
  const used = new Set(presetIds);
  for (const message of messages) {
    const ids = message.metadata?.another_one_presets;
    if (Array.isArray(ids)) {
      for (const id of ids)
        if (typeof id === "string" && id)
          used.add(id);
    }
  }
  return used.size > 1;
}
function withPresetNote(messages, needed) {
  if (!needed)
    return messages;
  return [...messages, { role: "system", content: PRESET_CHANGE_NOTE }];
}
async function contentHash(content) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

// src/generation/parallel-run.ts
class ParallelRun {
  record;
  prompts;
  driver;
  flushMs;
  abort = new AbortController;
  swipes;
  reasoning;
  deleted = false;
  dirty = false;
  writing;
  timer;
  writeError;
  externallyChanged = false;
  snapshots = new Set;
  finishing = false;
  constructor(record, prompts, driver, flushMs = 120) {
    this.record = record;
    this.prompts = prompts;
    this.driver = driver;
    this.flushMs = flushMs;
    this.swipes = prompts.map(() => "");
    this.reasoning = prompts.map(() => ({ text: null, duration: null }));
  }
  emit() {
    this.driver.changed(structuredClone(this.record));
  }
  flush(final = false) {
    if (this.writing)
      return final ? this.writing.then(() => this.flush(true)) : this.writing;
    const task = Promise.resolve().then(async () => {
      if (this.externallyChanged || !this.dirty && !final)
        return;
      this.dirty = false;
      const snapshot = [...this.swipes];
      const reasoning = this.reasoning.map((value) => ({ ...value }));
      this.snapshots.add(JSON.stringify([snapshot, reasoning]));
      if (this.snapshots.size > 32)
        this.snapshots.delete(this.snapshots.values().next().value);
      try {
        await this.driver.write(snapshot, final, reasoning);
      } catch (error) {
        this.writeError = errorText(error);
        this.abort.abort();
      }
    });
    this.writing = task;
    task.finally(() => {
      if (this.writing === task)
        this.writing = undefined;
    }).catch(() => {});
    return task;
  }
  observeEdit(swipes, extra = {}) {
    if (this.finishing)
      return;
    const texts = Array.isArray(extra.reasoningBySwipe) ? extra.reasoningBySwipe : [];
    const durations = Array.isArray(extra.reasoningDurationBySwipe) ? extra.reasoningDurationBySwipe : [];
    const reasoning = swipes.map((_, index) => ({ text: texts[index] || null, duration: durations[index] ?? null }));
    if (this.snapshots.has(JSON.stringify([swipes, reasoning])))
      return;
    this.externallyChanged = true;
    this.stop("The reply was edited or its swipes changed. Streaming stopped to preserve your changes.");
  }
  stop(detail) {
    this.record.detail = detail ?? this.record.detail ?? "Stopped. Partial replies have been kept.";
    this.abort.abort();
  }
  observeDeletion() {
    this.deleted = true;
    this.externallyChanged = true;
    this.stop("The reply was deleted.");
    this.emit();
  }
  async run() {
    this.dirty = true;
    await this.flush();
    this.timer = setInterval(() => {
      this.flush();
    }, this.flushMs);
    try {
      await Promise.all(this.prompts.map(async (prompt, index) => {
        const step = this.record.steps[index];
        if (this.abort.signal.aborted) {
          step.status = "stopped";
          return;
        }
        step.status = "running";
        this.emit();
        let content = "";
        this.swipes[index] = prompt.prefill || "";
        this.dirty = true;
        let done = false;
        const reasoning = this.reasoning[index];
        let reasoningStartedAt;
        const finishReasoning = () => {
          if (reasoningStartedAt !== undefined && reasoning.duration === null) {
            reasoning.duration = Math.max(1, Math.round(performance.now() - reasoningStartedAt));
          }
        };
        try {
          for await (const chunk of this.driver.stream(prompt, this.abort.signal)) {
            if (this.abort.signal.aborted)
              break;
            if (chunk.type === "reasoning") {
              if (!chunk.token)
                continue;
              reasoningStartedAt ??= performance.now();
              reasoning.text = (reasoning.text || "") + chunk.token;
            }
            if (chunk.type === "token") {
              if (!chunk.token)
                continue;
              finishReasoning();
              content += chunk.token;
            }
            if (chunk.type === "done") {
              content = chunk.content;
              done = true;
              if (chunk.reasoning !== undefined)
                reasoning.text = chunk.reasoning || null;
            }
            this.swipes[index] = (prompt.prefill || "") + content;
            this.dirty = true;
          }
          if (this.abort.signal.aborted)
            step.status = "stopped";
          else if (!done)
            throw new Error("The provider stream ended without a final response.");
          else {
            step.status = "done";
            step.swipe = index;
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError")
            this.stop();
          step.status = this.abort.signal.aborted ? "stopped" : "error";
          if (step.status === "error")
            step.error = errorText(error);
        }
        finishReasoning();
        if (!reasoning.text)
          reasoning.duration = null;
        this.dirty = true;
        this.emit();
      }));
    } finally {
      clearInterval(this.timer);
    }
    await this.flush(true);
    this.finishing = true;
    if (this.driver.finalize) {
      try {
        const saved = await this.driver.finalize();
        this.swipes.splice(0, this.swipes.length, ...saved.swipes);
        this.reasoning.splice(0, this.reasoning.length, ...saved.reasoning);
      } catch (error) {
        this.writeError ??= errorText(error);
        this.abort.abort();
      }
    }
    await Promise.all(this.record.steps.map(async (step, index) => {
      step.swipe = index;
      if (this.swipes[index])
        step.contentHash = await contentHash(this.swipes[index]);
    }));
    this.record.outcome = this.writeError || this.record.steps.some((s) => s.status === "error") ? "error" : this.abort.signal.aborted ? "stopped" : "complete";
    if (this.writeError)
      this.record.detail = `Could not save streamed replies: ${this.writeError}`;
    this.emit();
    return this.record;
  }
}

// src/backend/automation.ts
class Automation {
  api;
  storage;
  leases;
  catalog;
  inspect;
  variables;
  prepareChat;
  owners = new Map;
  arming = new Map;
  active = new Map;
  constructor(api, storage, leases, catalog, inspect, variables, prepareChat) {
    this.api = api;
    this.storage = storage;
    this.leases = leases;
    this.catalog = catalog;
    this.inspect = inspect;
    this.variables = variables;
    this.prepareChat = prepareChat;
    api.on("GENERATION_STARTED", (payload, user) => {
      if (user)
        this.started(payload, user);
    });
    api.on("FRONTEND_SESSION_CLOSED", (raw, user) => {
      if (!user)
        return;
      const { frontendSessionId } = raw;
      if (this.arming.get(user)?.session === frontendSessionId)
        this.arming.delete(user);
      const owner = this.owners.get(user);
      if (owner?.session === frontendSessionId && owner.armed)
        this.disarm(user, frontendSessionId, true, "Browser disconnected. Partial replies saved.");
    });
    api.on("GENERATION_STOPPED", (p, user) => {
      if (user)
        this.stopped(p, user);
    });
    api.on("GENERATION_ENDED", (p, user) => {
      if (!user)
        return;
      const key = `${user}:${p.chatId}`;
      if (this.active.get(key)?.generationId === p.generationId)
        this.active.delete(key);
      const owner = this.owners.get(user);
      if (owner?.parent?.generationId === p.generationId && !owner.current)
        this.fail(owner, "Generation ended before the swipes could start. Enable again.");
    });
    api.on("MESSAGE_SENT", (raw, user) => {
      const p = raw;
      const owner = user && this.owners.get(user);
      if (owner && p.chatId === owner.chatId && p.message?.is_user && (owner.current || owner.preparation)) {
        this.disarm(user, owner.session, true, "A new message stopped the previous swipes.");
      }
    });
    api.on("MESSAGE_EDITED", (raw, user) => {
      const p = raw;
      const run = user ? this.owners.get(user)?.current : undefined;
      if (run && p.message && p.message.id === run.record.messageId)
        run.observeEdit(p.message.swipes, p.message.extra);
    });
    api.on("MESSAGE_SWIPED", (raw, user) => {
      const p = raw;
      const run = user ? this.owners.get(user)?.current : undefined;
      if (p.action !== "navigated" && run && p.message && p.message.id === run.record.messageId)
        run.observeEdit(p.message.swipes, p.message.extra);
    });
    api.on("MESSAGE_DELETED", (raw, user) => {
      const p = raw;
      const owner = user ? this.owners.get(user) : undefined;
      if (owner?.current?.record.messageId === p.messageId)
        owner.current.observeDeletion();
      else if (owner?.view.run?.messageId === p.messageId) {
        owner.view.run = null;
        this.emit(owner, owner.view.phase, owner.view.detail);
      }
    });
    api.registerContextHandler(async (raw, signal) => {
      const context = raw;
      if (context.dryRun || context.generationType !== "normal" || !context.frontendSessionId || signal?.aborted)
        return raw;
      let owner = this.owners.get(context.userId);
      if (!owner?.armed || owner.session !== context.frontendSessionId || owner.chatId !== context.chatId) {
        const activation = await this.storage.activation(context.userId);
        if (!activation.enabled || signal?.aborted)
          return raw;
        const parent = this.active.get(`${context.userId}:${context.chatId}`);
        if (!parent || parent.frontendSessionId !== context.frontendSessionId)
          return raw;
        if (owner?.current || owner?.preparation || owner?.switching)
          throw new Error("Wait for the current swipes to finish or press Stop.");
        if (owner)
          await this.disarm(owner.user, owner.session, false, "Control moved to the browser sending this message.");
        await this.arm(context.userId, context.frontendSessionId, context.chatId, context.connectionId || "", activation.slotIds, parent.generationId);
        owner = this.owners.get(context.userId);
        if (!owner?.armed || signal?.aborted)
          return raw;
        owner.parent = parent;
      }
      if (owner.switching)
        throw new Error("CAT is opening the fork. Wait for it to finish before sending.");
      if (!owner.parent || owner.current || owner.preparation)
        return raw;
      const parent = owner.parent;
      if (!this.leases.heartbeat(owner.user, owner.session)) {
        await this.fail(owner, "The browser connection expired. Enable again.");
        return raw;
      }
      await this.variables?.selection.sync(owner.user, owner.chatId);
      const messages = await api.chat.getMessages(owner.chatId);
      if (signal?.aborted || !owner.armed || this.owners.get(owner.user) !== owner || owner.parent !== parent || owner.current || owner.preparation)
        return raw;
      if (messages.some((m) => Array.isArray(m.extra.attachments) && m.extra.attachments.length)) {
        await this.fail(owner, "This chat has attachments. CAT supports text only, so Lumiverse will generate this reply normally.");
        return raw;
      }
      owner.takingOver = owner.parent.generationId;
      owner.slots = owner.configured.filter((s) => !owner.nextIds || owner.nextIds.includes(s.id));
      owner.preparation = {
        type: "prepare",
        runId: crypto.randomUUID(),
        chatId: owner.chatId,
        name: owner.parent.characterName || "Assistant",
        characterId: owner.parent.characterId,
        personaId: context.personaId,
        slots: owner.slots,
        mixedPresets: usesMultiplePresets(messages, owner.slots.map((s) => s.presetId))
      };
      owner.prepared = new Map;
      this.emit(owner, "preparing", "Preparing swipes\u2026");
      return { ...context, cancelGeneration: true };
    }, 1, { required: true });
    setInterval(() => {
      for (const owner of this.owners.values())
        if ((owner.armed || owner.current) && !this.leases.valid(owner.user, owner.session)) {
          this.fail(owner, "The controlling browser disconnected. Partial replies have been kept.");
        }
    }, 15000).unref?.();
  }
  emit(owner, phase, detail) {
    owner.view = { ...owner.view, phase, detail };
    this.api.sendToFrontend({ type: "view", view: owner.view, armed: owner.armed }, owner.user, { frontendSessionId: owner.session });
  }
  owned(user, session) {
    const owner = this.owners.get(user);
    if (!owner || owner.session !== session)
      throw new Error("Enable CAT in this browser first.");
    return owner;
  }
  release(owner) {
    this.leases.release(owner.user, owner.session);
    if (!owner.current && this.owners.get(owner.user) === owner)
      this.owners.delete(owner.user);
  }
  getRun(user, runId) {
    const owner = this.owners.get(user);
    const run = owner?.current?.record ?? owner?.view.run;
    return run?.id === runId ? structuredClone(run) : undefined;
  }
  isCurrentRun(user, runId) {
    return this.owners.get(user)?.current?.record.id === runId;
  }
  preparePreset(user, session, runId, index) {
    const owner = this.owned(user, session);
    if (!this.variables || !owner.armed || owner.preparation?.runId !== runId || !Number.isInteger(index) || !owner.slots[index] || !owner.prepared)
      throw new Error("These swipes were cancelled.");
    const existing = owner.prepared.get(index);
    if (existing)
      return existing;
    const work = this.variables.capture.create(user, owner.chatId, runId, owner.slots[index].presetId).then(async (value) => {
      if (!owner.armed || owner.preparation?.runId !== runId) {
        await this.variables.capture.cancel(user, runId);
        throw new Error("These swipes were cancelled.");
      }
      const slot = owner.slots[index];
      const result = await managedGenerate(this.api).dryRun({
        chatId: owner.chatId,
        connectionId: slot.connectionId,
        presetId: value.presetId,
        forcePresetId: true,
        includeRequestMessages: true,
        retainResponseContext: true,
        personaId: owner.preparation?.personaId,
        generationType: "normal"
      }, user);
      if (!result.responseContextId || !Array.isArray(result.request_messages))
        throw new Error("Update Lumiverse to a build with managed message generation before using CAT.");
      return { ...value, prompt: {
        connectionId: slot.connectionId,
        captureToken: value.token,
        responseContextId: result.responseContextId,
        variableState: result.variable_state,
        messages: result.request_messages,
        parameters: result.parameters,
        provider: result.provider,
        model: result.model,
        prefill: result.assistantPrefill || ""
      } };
    });
    owner.prepared.set(index, work);
    return work;
  }
  async arm(user, session, chatId, connectionId, nextIds, nativeGenerationId) {
    const previous = this.owners.get(user);
    if (previous?.current || previous?.preparation)
      throw new Error("Wait for the swipes to finish or press Stop.");
    if (this.arming.has(user))
      throw new Error("CAT is already enabling. Wait for it to finish.");
    const attempt = { session };
    this.arming.set(user, attempt);
    try {
      await this.prepareChat?.(user, chatId);
      const [catalog, inspection, council, activation] = await Promise.all([
        this.catalog(user),
        this.inspect(chatId, user),
        this.api.council.getSettings({ userId: user }),
        nativeGenerationId ? this.storage.activation(user) : undefined
      ]);
      if (this.arming.get(user) !== attempt)
        throw new Error("Enabling was cancelled.");
      if (nativeGenerationId && !activation?.enabled)
        throw new Error("CAT was disabled before the swipes could start.");
      validateSlots(catalog.settings.slots, catalog.presets, catalog.connections);
      if (inspection.blockedReason)
        throw new Error(inspection.blockedReason);
      const native = this.active.get(`${user}:${chatId}`);
      if ((inspection.busy || native) && (!nativeGenerationId || native?.generationId !== nativeGenerationId))
        throw new Error("Wait for the current generation to finish.");
      if (council.councilMode && council.members.length)
        throw new Error("Turn off Council to use CAT.");
      const slots = catalog.settings.slots.map((s) => ({ id: s.id, presetId: s.presetId, connectionId: s.connectionId || connectionId }));
      this.validateNextIds(slots, nextIds);
      if (slots.some((s) => !catalog.connections.some((c) => c.id === s.connectionId)))
        throw new Error("Select an active connection or choose one for each swipe.");
      const latest = this.owners.get(user);
      if (latest?.current || latest?.preparation)
        throw new Error("Swipes are already generating. Press Stop first.");
      if (!this.leases.claim(user, session))
        throw new Error("Another browser controls CAT. Disable it there first.");
      const owner = {
        user,
        session,
        chatId,
        armed: true,
        slots,
        configured: slots,
        nextIds,
        catalog,
        view: { phase: "ready", detail: "Enabled. Send a message to generate swipes.", run: null }
      };
      this.owners.set(user, owner);
      this.emit(owner, "ready", owner.view.detail);
      return owner.view;
    } finally {
      if (this.arming.get(user) === attempt)
        this.arming.delete(user);
    }
  }
  async setActivation(user, patch) {
    if (patch.slotIds)
      this.validateNextIds((await this.storage.settings(user)).slots, patch.slotIds);
    const activation = await this.storage.setActivation(user, patch);
    const owner = this.owners.get(user);
    if (!activation.enabled) {
      this.arming.delete(user);
      if (owner)
        await this.disarm(user, owner.session);
    } else if (owner?.armed)
      owner.nextIds = activation.slotIds;
    this.api.sendToFrontend({ type: "activation", activation }, user);
    return activation;
  }
  validateNextIds(slots, ids) {
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > slots.length || new Set(ids).size !== ids.length || ids.some((id) => !slots.some((s) => s.id === id))))
      throw new Error("Choose at least one configured profile for the next generation.");
  }
  async followFork(user, session, chatId) {
    const owner = this.owned(user, session);
    const navigation = owner.navigation = (owner.navigation ?? 0) + 1;
    if (!owner.armed || !this.leases.valid(user, session))
      return null;
    owner.switching = true;
    const chat = await this.api.chats.get(chatId, user);
    if (owner.navigation !== navigation)
      return null;
    if (!chat || chat.metadata.branched_from !== owner.chatId) {
      owner.switching = false;
      return null;
    }
    const runId = owner.preparation?.runId;
    clearTimeout(owner.deadline);
    owner.preparation = undefined;
    owner.parent = undefined;
    owner.takingOver = undefined;
    try {
      if (runId)
        await this.cancelPreparation(owner, runId);
      owner.current?.stop("Opened a fork. Partial replies have been kept in the original chat.");
      await owner.completion;
      await this.prepareChat?.(user, chatId);
      const inspection = await this.inspect(chatId, user);
      if (inspection.blockedReason || inspection.busy)
        throw new Error(inspection.blockedReason || "Wait for this chat's generation to finish.");
      const history = await this.storage.history(user, chatId);
      if (!owner.armed || owner.navigation !== navigation || this.owners.get(user) !== owner || !this.leases.valid(user, session))
        return null;
      owner.chatId = chatId;
      owner.view = {
        phase: "ready",
        detail: "Enabled. Send a message to generate swipes.",
        run: history.find((run) => run.chatId === chatId) ?? null
      };
      this.emit(owner, "ready", owner.view.detail);
      return owner.view;
    } finally {
      if (owner.navigation === navigation)
        owner.switching = false;
    }
  }
  started(p, user) {
    this.active.set(`${user}:${p.chatId}`, p);
    const owner = this.owners.get(user);
    if (p.renderMode === "persisted-message" && owner?.current && owner.current.record.messageId === p.targetMessageId) {
      owner.managedId = p.generationId;
      return;
    }
    if (!owner?.armed || owner.switching || p.chatId !== owner.chatId)
      return;
    if (p.frontendSessionId !== owner.session && p.generationType === "normal" && !owner.current && !owner.preparation)
      return;
    if (p.frontendSessionId !== owner.session || p.generationType !== "normal" || owner.current || owner.preparation) {
      this.disarm(user, owner.session, true, "Another generation stopped these swipes.");
      return;
    }
    owner.parent = p;
  }
  async stopped(p, user) {
    if (this.active.get(`${user}:${p.chatId}`)?.generationId === p.generationId)
      this.active.delete(`${user}:${p.chatId}`);
    const owner = this.owners.get(user);
    if (owner?.managedId === p.generationId) {
      owner.current?.stop();
      return;
    }
    if (!owner || owner.parent?.generationId !== p.generationId)
      return;
    owner.parent = undefined;
    if (owner.armed && owner.takingOver === p.generationId && owner.preparation) {
      owner.takingOver = undefined;
      owner.deadline = setTimeout(() => {
        this.fail(owner, "Prompt preparation did not finish. Enable again to retry.");
      }, 120000);
      this.api.sendToFrontend(owner.preparation, user, { frontendSessionId: owner.session });
    } else
      await this.disarm(user, owner.session, true, "Stopped before generating swipes.");
  }
  async launch(user, session, runId, messageId, prompts) {
    const owner = this.owned(user, session);
    if (!owner.armed || owner.preparation?.runId !== runId || owner.current || owner.launching)
      throw new Error("These swipes were cancelled or already started.");
    if (!Array.isArray(prompts) || prompts.length !== owner.slots.length || prompts.some((p, i) => !p || p.connectionId !== owner.slots[i].connectionId || typeof p.provider !== "string" || typeof p.model !== "string" || !p.parameters || typeof p.parameters !== "object" || Array.isArray(p.parameters) || !Array.isArray(p.messages) || !p.messages.length))
      throw new Error("The prepared requests do not match your profiles. Enable again to retry.");
    owner.launching = runId;
    let chatName;
    let messageIndex;
    let characterName;
    let variableState;
    const swipeIds = owner.slots.map(() => crypto.randomUUID());
    try {
      const messages = await this.api.chat.getMessages(owner.chatId);
      const last = messages.at(-1);
      if (last?.id !== messageId || last.role !== "assistant" || last.content || last.metadata?.another_one_run !== runId)
        throw new Error("The conversation changed before streaming could start.");
      messageIndex = last.index_in_chat;
      characterName = last.name;
      const inspection = await this.inspect(owner.chatId, user);
      if (inspection.blockedReason || inspection.busy)
        throw new Error(inspection.blockedReason || "Another generation started before streaming could begin.");
      chatName = inspection.chatName;
      if (!owner.armed || owner.preparation?.runId !== runId || !this.leases.valid(user, session))
        throw new Error("Cancelled before generating swipes.");
      if (this.variables) {
        variableState = { version: 1, slots: await Promise.all(prompts.map(async (prompt, index) => {
          const prepared = await owner.prepared?.get(index);
          if (!prepared || prompt.captureToken !== prepared.token)
            throw new Error("This request has no captured variable state.");
          return { ...await this.variables.capture.finish(user, runId, owner.slots[index].presetId, prepared.token, prompt.variableState), swipeId: swipeIds[index] };
        })) };
        if (JSON.stringify(variableState).length > 2000000)
          throw new Error("The combined variable state is too large to save.");
      }
      if (!owner.armed || owner.preparation?.runId !== runId || !this.leases.valid(user, session))
        throw new Error("Cancelled before generating swipes.");
    } finally {
      owner.launching = undefined;
    }
    const mixedPresets = owner.preparation.mixedPresets === true;
    clearTimeout(owner.deadline);
    owner.preparation = undefined;
    let firstWrite = true;
    const run = new ParallelRun({
      id: runId,
      chatId: owner.chatId,
      chatName,
      messageId,
      messageIndex,
      characterName,
      at: Date.now(),
      outcome: "running",
      steps: owner.slots.map((s, i) => ({
        swipeId: swipeIds[i],
        presetId: s.presetId,
        presetName: owner.catalog.presets.find((p) => p.id === s.presetId).name,
        connectionName: owner.catalog.connections.find((c) => c.id === s.connectionId).name,
        status: "waiting"
      }))
    }, prompts, {
      stream: (prompt, signal) => {
        const { model, ...parameters } = prompt.parameters;
        const request = {
          type: "raw",
          userId: user,
          connection_id: prompt.connectionId,
          provider: prompt.provider,
          model: typeof model === "string" && model.trim() ? model.trim() : prompt.model,
          messages: withPresetNote(prompt.messages, mixedPresets),
          parameters,
          signal,
          sessionId: owner.managedId,
          swipeIndex: prompts.indexOf(prompt)
        };
        return this.api.generate.rawStream(request);
      },
      write: async (swipes, final, reasoning) => {
        if (final && variableState)
          await Promise.all(variableState.slots.map(async (slot, i) => {
            slot.contentHash = await contentHash(swipes[i]);
          }));
        const patch = {
          swipes,
          swipe_reasoning: reasoning,
          skipChunkRebuild: true,
          ...firstWrite || final ? { metadata_patch: {
            another_one_run: runId,
            another_one_presets: owner.slots.map((s) => s.presetId),
            preset_contexts: owner.slots.map((slot, i) => ({
              preset_id: slot.presetId,
              another_one_swipe_id: swipeIds[i],
              ...variableState ? { variables: variableState.slots[i].snapshot } : {}
            })),
            ...variableState ? {
              another_one_variables: { ...variableState, slots: variableState.slots.map(({ snapshot: _, before: _before, revision: _revision, ...slot }) => slot) }
            } : {}
          } } : {}
        };
        await this.api.chat.updateMessage(owner.chatId, messageId, patch);
        if (firstWrite) {
          if (prompts.some((prompt) => !prompt.responseContextId))
            throw new Error("The prepared response context is missing.");
          const session = await managedGenerate(this.api).beginMessage({
            chatId: owner.chatId,
            messageId,
            responseContextIds: prompts.map((prompt) => prompt.responseContextId),
            userId: user,
            frontendSessionId: owner.session
          });
          owner.managedId = session.id;
          run.abort.signal.addEventListener("abort", () => {
            managedGenerate(this.api).abortMessage(session.id).catch(() => {});
          }, { once: true });
          if (run.abort.signal.aborted)
            await managedGenerate(this.api).abortMessage(session.id);
        }
        firstWrite = false;
      },
      finalize: async () => {
        if (owner.managedId) {
          const result = await managedGenerate(this.api).finishMessage(owner.managedId);
          if (!result.completed)
            run.stop();
        }
        const saved = (await this.api.chat.getMessages(owner.chatId)).find((message) => message.id === messageId);
        if (!saved) {
          run.observeDeletion();
          return { swipes: run.swipes, reasoning: run.reasoning };
        }
        try {
          await this.api.memories.chatMemory.warm(owner.chatId, { userId: user, force: true });
        } catch (error) {
          run.record.detail = `Replies saved; chat memory refresh failed: ${errorText(error)}`;
        }
        return { swipes: saved.swipes, reasoning: saved.swipes.map((_, index) => ({
          text: saved.extra.reasoningBySwipe?.[index] ?? null,
          duration: saved.extra.reasoningDurationBySwipe?.[index] ?? null
        })) };
      },
      changed: (record) => {
        owner.view.run = run.deleted ? null : record;
        this.emit(owner, "running", `Generating swipes. ${record.steps.filter((s) => s.status === "done").length} of ${record.steps.length} finished.`);
      }
    });
    owner.current = run;
    owner.completion = run.run().then(async (record) => {
      if (!run.deleted)
        await this.storage.record(user, record);
      owner.current = undefined;
      owner.managedId = undefined;
      if (owner.switching)
        return;
      if (record.outcome === "complete" && owner.armed)
        this.emit(owner, "ready", `${record.steps.length} ${record.steps.length === 1 ? "swipe" : "swipes"} finished.`);
      else {
        owner.armed = false;
        this.release(owner);
        this.emit(owner, record.outcome === "error" ? "error" : "off", record.detail || "Finished. See each swipe's status below.");
      }
    }).catch((error) => {
      owner.current = undefined;
      this.fail(owner, errorText(error));
    });
    return true;
  }
  async fail(owner, detail) {
    const runId = owner.preparation?.runId;
    owner.armed = false;
    clearTimeout(owner.deadline);
    owner.preparation = undefined;
    owner.takingOver = undefined;
    owner.parent = undefined;
    owner.current?.stop(detail);
    this.release(owner);
    this.emit(owner, "error", detail);
    if (runId)
      await this.cancelPreparation(owner, runId);
  }
  async preparationFailed(user, session, runId, error, chatId, messageId) {
    const owner = this.owners.get(user);
    if (owner?.session === session && owner.preparation?.runId === runId)
      await this.fail(owner, error);
    if (await this.api.chats.get(chatId, user)) {
      const message = (await this.api.chat.getMessages(chatId)).find((m) => m.metadata?.another_one_run === runId && (!messageId || m.id === messageId));
      if (message?.metadata?.another_one_run === runId && !message.metadata.another_one_presets && !message.content && !message.swipes.some(Boolean) && !message.extra?.reasoning && !(Array.isArray(message.extra?.reasoningBySwipe) && message.extra.reasoningBySwipe.some(Boolean)) && !(Array.isArray(message.extra?.attachments) && message.extra.attachments.length))
        await this.api.chat.deleteMessage(chatId, message.id);
    }
    return true;
  }
  async disarm(user, session, stop = false, detail) {
    detail ??= stop ? "Stopped. Partial replies saved." : "Disabled";
    if (this.arming.get(user)?.session === session) {
      this.arming.delete(user);
      if (this.owners.get(user)?.session !== session)
        return { phase: "off", detail, run: null };
    }
    const owner = this.owned(user, session);
    owner.navigation = (owner.navigation ?? 0) + 1;
    owner.switching = false;
    const runId = owner.preparation?.runId;
    owner.armed = false;
    clearTimeout(owner.deadline);
    owner.preparation = undefined;
    owner.takingOver = undefined;
    owner.parent = undefined;
    if (stop)
      owner.current?.stop(detail);
    if (!owner.current)
      this.release(owner);
    this.emit(owner, owner.current ? "running" : "off", owner.current && !stop ? "Disabled. Current swipes will finish." : detail);
    if (runId)
      await this.cancelPreparation(owner, runId);
    return owner.view;
  }
  async cancelPreparation(owner, runId) {
    try {
      await this.variables?.capture.cancel(owner.user, runId);
    } catch (error) {
      this.emit(owner, "error", `Could not cancel prompt preparation: ${errorText(error)}`);
    }
  }
}

// src/backend/inspection.ts
async function inspectChat(api, active, chatId, userId) {
  const chat = await api.chats.get(chatId, userId);
  if (!chat)
    throw new Error("This chat is no longer available.");
  const m = chat.metadata;
  const blockedReason = m.group ? "Group chats are not supported yet. Open a single-character chat." : m.multiplayer ? "Multiplayer rooms are not supported yet. Open a private chat." : m.temporary && m.no_preset ? "This chat has presets disabled. Enable presets first." : undefined;
  return { chatId, chatName: chat.name, blockedReason, busy: active.has(`${userId}:${chatId}`) };
}

// src/generation/swipe-selection.ts
async function findSwipe(run, stepIndex, message) {
  const step = run.steps[stepIndex];
  if (!step || message.id !== run.messageId || message.chat_id !== run.chatId || message.extra?.spindle_metadata?.another_one_run !== run.id) {
    throw new Error("This reply is no longer available.");
  }
  const expected = step.swipe ?? stepIndex;
  const contexts = message.extra.spindle_metadata.preset_contexts;
  if (step.swipeId) {
    const matches = Array.isArray(contexts) ? contexts.flatMap((context, i) => context?.another_one_swipe_id === step.swipeId && context.preset_id === step.presetId && i < message.swipes.length ? [i] : []) : [];
    if (matches.length === 1)
      return matches[0];
    throw new Error("This swipe is no longer available.");
  }
  if (step.contentHash) {
    const hashes = await Promise.all(message.swipes.map((s) => typeof s === "string" ? contentHash(s) : null));
    const samePreset = (i) => !Array.isArray(contexts) || contexts[i]?.preset_id === step.presetId;
    if (message.swipes.length === run.steps.length && samePreset(expected) && hashes[expected] === step.contentHash)
      return expected;
    const matches = hashes.flatMap((hash, index) => samePreset(index) && hash === step.contentHash ? [index] : []);
    if (matches.length === 1)
      return matches[0];
    if (Array.isArray(contexts) && run.steps.filter((s) => s.presetId === step.presetId).length === 1) {
      const candidates = contexts.flatMap((context, i) => context?.preset_id === step.presetId && i < message.swipes.length ? [i] : []);
      if (candidates.length === 1)
        return candidates[0];
    }
    throw new Error("This swipe was edited or deleted. Open it using the chat's swipe arrows.");
  }
  if (message.swipes.length === run.steps.length && typeof message.swipes[expected] === "string" && message.swipes[expected])
    return expected;
  throw new Error("This swipe is not available yet.");
}

// src/backend/select-swipe.ts
async function selectSwipe(api, run, stepIndex, applyVariables) {
  if (!run.messageId || !Number.isInteger(stepIndex) || !run.steps[stepIndex])
    throw new Error("This swipe is no longer available.");
  const messages = await api.chat.getMessages(run.chatId);
  const message = messages.find((m) => m.id === run.messageId);
  if (!message)
    throw new Error("This reply was deleted.");
  if (messages.at(-1)?.id !== message.id)
    throw new Error("Only the latest reply's swipes can be selected.");
  const swipe = await findSwipe(run, stepIndex, { ...message, extra: { ...message.extra, spindle_metadata: message.metadata } });
  await api.chat.updateMessage(run.chatId, run.messageId, { swipe_id: swipe });
  await applyVariables?.();
}

// src/generation/variable-state.ts
function variableMap(value) {
  return Object.fromEntries(value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value).map(([key, entry]) => [key, String(entry)]) : []);
}
function persistentVariables(metadata) {
  return { global: variableMap(metadata.macro_variables?.global), chat: variableMap(metadata.chat_variables) };
}
function variableChanges(before, after) {
  const value = (map, key) => Object.hasOwn(map, key) ? map[key] : null;
  return ["global", "chat"].flatMap((scope) => Array.from(new Set([...Object.keys(before[scope]), ...Object.keys(after[scope])])).filter((key) => value(before[scope], key) !== value(after[scope], key)).map((key) => ({ scope, key, before: value(before[scope], key), after: value(after[scope], key) })));
}
function applyVariableSelection(current, prior, next) {
  const maps = { global: new Map(Object.entries(current.global)), chat: new Map(Object.entries(current.chat)) };
  const put = (change, value) => value === null ? maps[change.scope].delete(change.key) : maps[change.scope].set(change.key, value);
  for (const change of prior)
    if ((maps[change.scope].get(change.key) ?? null) === change.after)
      put(change, change.before);
  for (const change of next) {
    const value = maps[change.scope].get(change.key) ?? null;
    if (value !== change.before && value !== change.after)
      throw new Error(`Variable \u201C${change.key}\u201D changed after this reply. Its value has been kept.`);
    put(change, change.after);
  }
  return { global: Object.fromEntries(maps.global), chat: Object.fromEntries(maps.chat) };
}

// src/backend/preset-support.ts
function isLumiRealmPreset(preset) {
  return preset.metadata.source === "risupreset" || preset.metadata.lumirealm != null;
}
async function listSourcePresets(api, userId) {
  const sources = [];
  const obsolete = [];
  for (let offset = 0;; ) {
    const page = await api.list({ userId, limit: 100, offset });
    for (const preset of page.data) {
      const marker = preset.metadata.another_one;
      if (marker?.kind === "controller" || marker?.kind === "preparation") {
        if (marker.kind === "controller" || !marker.createdAt || Date.now() - marker.createdAt > 120000)
          obsolete.push(preset.id);
      } else if (!isLumiRealmPreset(preset))
        sources.push({ id: preset.id, name: preset.name });
    }
    offset += page.data.length;
    if (!page.data.length || offset >= page.total)
      break;
  }
  for (const id of obsolete)
    await api.delete(id, userId);
  return sources;
}

// src/backend/variable-capture.ts
class VariableCapture {
  api;
  captures = new Map;
  constructor(api) {
    this.api = api;
  }
  async create(user, chatId, runId, sourceId) {
    const [source, chat] = await Promise.all([this.api.presets.get(sourceId, user), this.api.chats.get(chatId, user)]);
    if (!source || !chat)
      throw new Error("The preset or chat is no longer available.");
    if (isLumiRealmPreset(source))
      throw new Error("LumiRealm presets are not supported. Choose a native Lumiverse preset.");
    const token = crypto.randomUUID();
    this.captures.set(token, { user, chatId, runId, sourceId, before: persistentVariables(chat.metadata), revision: chat.variable_revision ?? null });
    return { token, presetId: sourceId };
  }
  async finish(user, runId, sourceId, token, state) {
    const capture = this.captures.get(token);
    if (!capture || capture.user !== user || capture.runId !== runId || capture.sourceId !== sourceId)
      throw new Error("The prepared request does not match this profile.");
    try {
      if (!state || [state.local, state.global, state.chat].some((map) => !map || typeof map !== "object" || Array.isArray(map))) {
        throw new Error("Update Lumiverse to the version with native preset contexts and dry-run variable snapshots. No requests were sent.");
      }
      if (JSON.stringify(state).length > 1e6)
        throw new Error("The preset's variable state is too large to save.");
      const snapshot = {
        local: variableMap(state.local),
        global: variableMap(state.global),
        chat: variableMap(state.chat),
        ...state.prompt_defaults ? { prompt_defaults: variableMap(state.prompt_defaults) } : {},
        ...state.prompt_selections ? { prompt_selections: Object.fromEntries(Object.entries(state.prompt_selections).filter((entry) => Array.isArray(entry[1]) && entry[1].every((v) => typeof v === "string"))) } : {}
      };
      const chat = await this.api.chats.get(capture.chatId, user);
      const latest = chat && persistentVariables(chat.metadata);
      if (!latest || variableChanges(capture.before, { local: {}, ...latest }).length || (chat.variable_revision ?? null) !== capture.revision)
        throw new Error("Chat variables changed while prompts were preparing. Send again to use the updated values.");
      return { presetId: sourceId, changes: variableChanges(capture.before, snapshot), local: snapshot.local, snapshot, before: capture.before, revision: capture.revision };
    } finally {
      this.captures.delete(token);
    }
  }
  async cancel(user, runId) {
    for (const [token, capture] of this.captures)
      if (capture.user === user && capture.runId === runId)
        this.captures.delete(token);
  }
}

// src/backend/run-history.ts
async function restoreRunHistory(api, storage, user, chat, messages, skip = () => false) {
  const candidates = messages.filter((message) => message.role === "assistant" && typeof message.metadata?.another_one_run === "string" && !skip(message.metadata.another_one_run)).slice(-MAX_HISTORY);
  const history = await storage.history(user, chat.id);
  const sourceHistory = typeof chat.metadata.branched_from === "string" ? await storage.history(user, chat.metadata.branched_from) : [];
  const runs = [];
  const names = new Map;
  for (const message of candidates) {
    if (!message.metadata || skip(message.metadata.another_one_run))
      continue;
    const known = history.find((run) => run.chatId === chat.id && run.messageId === message.id && run.id === message.metadata.another_one_run);
    if (known) {
      runs.push(known);
      continue;
    }
    const id = `message:${message.id}`;
    const original = [...history, ...sourceHistory].find((r) => r.id === message.metadata.another_one_run);
    const contexts = message.metadata.preset_contexts;
    const presets = message.metadata.another_one_presets;
    if (!Array.isArray(contexts) && !Array.isArray(presets))
      continue;
    const steps = (await Promise.all(message.swipes.map(async (content, index) => {
      if (Array.isArray(contexts) && !contexts[index])
        return null;
      const presetId = contexts?.[index]?.preset_id ?? presets?.[index] ?? "";
      const hash = await contentHash(content);
      const expected = original?.steps[index];
      const matches = original?.steps.filter((s) => s.presetId === presetId && s.contentHash === hash);
      const swipeId = contexts?.[index]?.another_one_swipe_id;
      const identities = original?.steps.filter((s) => s.swipeId === swipeId && s.presetId === presetId);
      const prior = swipeId ? identities?.length === 1 ? identities[0] : undefined : original?.steps.length === message.swipes.length && expected?.presetId === presetId && (!expected.contentHash || expected.contentHash === hash) ? expected : matches?.length === 1 ? matches[0] : undefined;
      const data = message.metadata.another_one_variables;
      const unfinished = !prior && data?.slots.some((s) => s.presetId === presetId && !s.contentHash);
      if (!names.has(presetId))
        names.set(presetId, prior?.presetName ?? (await api.presets.get(presetId, user))?.name ?? "Deleted preset");
      return {
        presetId,
        presetName: names.get(presetId),
        connectionName: prior?.connectionName ?? "Copied reply",
        status: unfinished || prior?.status === "running" || prior?.status === "waiting" ? "stopped" : prior?.status ?? "done",
        swipe: index,
        swipeId: contexts?.[index]?.another_one_swipe_id,
        contentHash: hash,
        ...prior?.error ? { error: prior.error } : {}
      };
    }))).filter((step) => step !== null);
    if (!steps.length)
      continue;
    const outcome = steps.some((s) => s.status === "error") ? "error" : steps.some((s) => s.status === "stopped") ? "stopped" : "complete";
    runs.push({ id, chatId: chat.id, chatName: chat.name, messageId: message.id, messageIndex: message.index_in_chat, characterName: message.name, at: original?.at ?? message.send_date * 1000, steps, outcome });
    if (message.metadata.another_one_run !== id) {
      const patch = { metadata_patch: { another_one_run: id } };
      await api.chat.updateMessage(chat.id, message.id, patch);
    }
  }
  if (!runs.some((run) => !history.some((existing) => existing.id === run.id && existing.chatId === run.chatId && existing.messageId === run.messageId)))
    return false;
  await storage.recordMany(user, runs.reverse(), async (records) => {
    const live = new Set((await api.chat.getMessages(chat.id)).map((message) => message.id));
    return records.filter((record) => live.has(record.messageId));
  });
  return true;
}

// src/backend/chat-metadata.ts
async function compareChatMetadata(api, user, chatId, expected, metadata, messages, target) {
  const chats = api.chats;
  return await chats.compareAndSetMetadata(chatId, {
    expected_metadata: expected,
    metadata,
    expected_last_message_id: messages.at(-1)?.id ?? null,
    ...target ? { expected_message: { id: target.id, swipe_id: target.swipe_id, swipes: target.swipes, metadata: target.metadata ?? {} } } : {}
  }, user) !== null;
}

// src/backend/forks.ts
var keyedChanges = (changes) => new Map(changes.map((change) => [`${change.scope}:${change.key}`, change]));
var variableValue = (state, change) => Object.hasOwn(state[change.scope] ?? {}, change.key) ? state[change.scope][change.key] : null;
function capturedValues(data) {
  const baseline = keyedChanges(data.slots.flatMap((slot) => slot.changes));
  const values = new Map([...baseline.keys()].map((key) => [key, new Set]));
  for (const slot of data.slots) {
    const changes = keyedChanges(slot.changes);
    for (const [key, change] of baseline)
      values.get(key).add(changes.has(key) ? changes.get(key).after : change.before);
  }
  return values;
}
async function selectedVariables(message) {
  const data = message.metadata?.another_one_variables;
  if (data?.version !== 1 || !Array.isArray(data.slots))
    return;
  const contexts = message.metadata?.preset_contexts;
  const context = contexts?.[message.swipe_id];
  if (Array.isArray(contexts) && !context)
    return;
  let index = message.swipe_id;
  let slot = data.slots[index];
  if (context?.another_one_swipe_id) {
    const matches = data.slots.flatMap((value, i) => value.swipeId === context.another_one_swipe_id && value.presetId === context.preset_id ? [i] : []);
    if (matches.length !== 1)
      throw new Error("This swipe's original variable state is no longer available.");
    index = matches[0];
    slot = data.slots[index];
  } else if (context?.variables) {
    const snapshot = context.variables;
    const baseline = keyedChanges(data.slots.flatMap((value) => value.changes));
    const matches = data.slots.flatMap((value, i) => {
      const changes = keyedChanges(value.changes);
      return value.presetId === context.preset_id && Object.keys(value.local).length === Object.keys(snapshot.local ?? {}).length && Object.entries(value.local).every(([key, entry]) => snapshot.local?.[key] === entry) && [...baseline].every(([key, change]) => variableValue(snapshot, change) === (changes.has(key) ? changes.get(key).after : change.before)) ? [i] : [];
    });
    if (!matches.length || !matches.every((i) => JSON.stringify(data.slots[i].changes) === JSON.stringify(data.slots[matches[0]].changes)))
      throw new Error("This swipe's preset context does not identify its original variable state safely.");
    index = matches.includes(index) ? index : matches[0];
    slot = data.slots[index];
  } else if (data.slots.length !== message.swipes.length || slot?.contentHash && slot.contentHash !== await contentHash(message.content)) {
    const hash = await contentHash(message.content);
    const matches = data.slots.flatMap((value, i) => value.contentHash === hash ? [i] : []);
    if (matches.length !== 1)
      throw new Error("This swipe was edited. Its original variable state cannot be selected safely.");
    index = matches[0];
    slot = data.slots[index];
  }
  return slot ? { slot, index } : undefined;
}
async function variablesBefore(message) {
  const selected = await selectedVariables(message);
  const contexts = message.metadata?.preset_contexts;
  const snapshot = contexts?.[message.swipe_id]?.variables ?? selected?.slot.snapshot;
  if (!snapshot?.global || !snapshot.chat || !selected)
    throw new Error("This fork's earlier variable state is unavailable. Its variables have not been changed.");
  return applyVariableSelection(snapshot, selected.slot.changes, []);
}

class Forks {
  api;
  storage;
  pending = new Map;
  constructor(api, storage) {
    this.api = api;
    this.storage = storage;
    api.on("CHAT_FORKED", (event, user) => {
      if (user)
        this.ensure(user, event.forkedChatId).catch((error) => {
          api.log.error(`Could not prepare fork: ${String(error)}`);
          api.sendToFrontend({ type: "variableError", error: "Could not prepare this fork. Enable CAT to retry." }, user);
        });
    });
  }
  ensure(user, chatId) {
    const key = `${user}:${chatId}`;
    const existing = this.pending.get(key);
    if (existing)
      return existing;
    const work = this.initialize(user, chatId);
    this.pending.set(key, work);
    work.finally(() => {
      if (this.pending.get(key) === work)
        this.pending.delete(key);
    }).catch(() => {});
    return work;
  }
  async initialize(user, chatId) {
    const chat = await this.api.chats.get(chatId, user);
    if (!chat || typeof chat.metadata.branched_from !== "string" || chat.metadata.another_one_fork === chatId)
      return;
    const messages = await this.api.chat.getMessages(chatId);
    const branchId = messages[0]?.branch_id;
    if (branchId)
      await restoreRunHistory(this.api, this.storage, user, chat, messages.filter((m) => m.branch_id === branchId));
    if (messages.some((m) => Array.isArray(m.extra?.variableStateBySwipe) && m.extra.variableStateBySwipe.some(Boolean)))
      return;
    for (let attempt = 0;attempt < 5; attempt++)
      if (await this.initializeVariables(user, chatId))
        return;
    throw new Error("The fork kept changing while restoring its variables. Try again.");
  }
  async initializeVariables(user, chatId) {
    const chat = await this.api.chats.get(chatId, user);
    if (!chat || typeof chat.metadata.branched_from !== "string" || chat.metadata.another_one_fork === chatId)
      return true;
    const messages = await this.api.chat.getMessages(chatId);
    if (!chat.metadata.another_one_applied_variables && !messages.some((m) => m.metadata?.another_one_run))
      return true;
    const branchId = messages[0]?.branch_id;
    if (!branchId)
      return true;
    const copied = messages.filter((m) => m.branch_id === branchId);
    const source = await this.api.chats.get(chat.metadata.branched_from, user);
    const sourceMessages = source ? await this.api.chat.getMessages(source.id) : [];
    const sourceByIndex = new Map(sourceMessages.map((m) => [m.index_in_chat, m]));
    const idMap = new Map(copied.flatMap((m) => {
      const original = sourceByIndex.get(m.index_in_chat);
      return original ? [[original.id, m.id]] : [];
    }));
    const applied = chat.metadata.another_one_applied_variables;
    let nextApplied = applied && idMap.has(applied.messageId) ? { ...applied, messageId: idMap.get(applied.messageId) } : applied;
    let values = persistentVariables(chat.metadata);
    if (messages.length === copied.length) {
      const forkIndex = copied.at(-1).index_in_chat;
      const appliedIndex = sourceMessages.find((m) => m.id === applied?.messageId)?.index_in_chat ?? forkIndex;
      let historical;
      const preserved = new Set;
      for (const message of [...sourceMessages].reverse()) {
        if (message.index_in_chat <= forkIndex)
          break;
        if (message.index_in_chat > appliedIndex)
          continue;
        const data = message.metadata?.another_one_variables;
        if (!data)
          continue;
        const baseline = keyedChanges(data.slots.flatMap((slot) => slot.changes));
        const written = capturedValues(data);
        if (historical) {
          for (const [key, change] of baseline)
            if (!written.get(key).has(variableValue(historical, change)))
              preserved.add(key);
        }
        const changes = message.id === applied?.messageId ? applied.changes : historical && [...baseline].map(([, change]) => ({ ...change, after: variableValue(historical, change) }));
        if (!changes)
          throw new Error("This fork's earlier variable state is unavailable. Its variables have not been changed.");
        for (const [key, change] of keyedChanges(changes))
          if (variableValue(values, change) !== change.after)
            preserved.add(key);
        values = applyVariableSelection(values, [...keyedChanges(changes)].filter(([key]) => !preserved.has(key)).map(([, change]) => change), []);
        historical = await variablesBefore(message);
      }
      if (applied && !idMap.has(applied.messageId)) {
        const last = [...copied].reverse().find((m) => m.metadata?.another_one_variables);
        const selected = last && await selectedVariables(last);
        if (last && selected) {
          if (!historical)
            throw new Error("This fork's earlier variable state is unavailable. Its variables have not been changed.");
          const data = last.metadata.another_one_variables;
          const baseline = keyedChanges(data.slots.flatMap((slot) => slot.changes));
          const chosen = keyedChanges(selected.slot.changes);
          const written = capturedValues(data);
          const changes = [...baseline].filter(([key, change]) => !preserved.has(key) && written.get(key).has(variableValue(historical, change))).map(([key, change]) => ({
            ...change,
            before: variableValue(historical, change),
            after: chosen.has(key) ? chosen.get(key).after : change.before
          })).filter((change) => variableValue(values, change) === change.before);
          values = applyVariableSelection(values, [], changes);
        }
        nextApplied = selected ? { messageId: last.id, slot: selected.index, changes: selected.slot.changes } : undefined;
      }
    }
    const latestMetadata = chat.metadata;
    const maps = { global: new Map(Object.entries(latestMetadata.macro_variables?.global || {})), chat: new Map(Object.entries(latestMetadata.chat_variables || {})) };
    const current = persistentVariables(latestMetadata);
    for (const change of variableChanges(persistentVariables(chat.metadata), { local: {}, ...values })) {
      if ((current[change.scope][change.key] ?? null) !== change.before)
        continue;
      if (change.after === null)
        maps[change.scope].delete(change.key);
      else
        maps[change.scope].set(change.key, change.after);
    }
    const metadata = {
      ...latestMetadata,
      macro_variables: { ...latestMetadata.macro_variables, global: Object.fromEntries(maps.global) },
      chat_variables: Object.fromEntries(maps.chat),
      another_one_applied_variables: nextApplied,
      another_one_fork: chatId
    };
    if (!nextApplied)
      delete metadata.another_one_applied_variables;
    const target = [...messages].reverse().find((m) => m.role === "assistant");
    if (!await compareChatMetadata(this.api, user, chatId, chat.metadata, metadata, messages, target))
      return false;
    this.api.sendToFrontend({ type: "historyChanged" }, user);
    return true;
  }
}

// src/backend/variable-selection.ts
class VariableSelection {
  api;
  prepareChat;
  chains = new Map;
  observed = new Map;
  constructor(api, prepareChat) {
    this.api = api;
    this.prepareChat = prepareChat;
    for (const event of ["MESSAGE_SWIPED", "SWIPE_EDITED", "MESSAGE_DELETED"])
      api.on(event, (raw, user) => {
        const p = raw;
        if (!user || !p.chatId)
          return;
        const key = `${user}:${p.chatId}`;
        const identity = p.message ? `${p.message.id}:${p.message.swipe_id}:${p.message.swipes.length}` : `deleted:${p.messageId}`;
        if (this.observed.get(key) === identity)
          return;
        this.remember(key, identity);
        this.sync(user, p.chatId).catch((error) => {
          api.log.error(`Could not apply swipe variables: ${String(error)}`);
          api.sendToFrontend({ type: "variableError", error: error instanceof Error ? error.message : String(error) }, user);
        });
      });
  }
  remember(key, identity) {
    this.observed.delete(key);
    this.observed.set(key, identity);
    if (this.observed.size > 256)
      this.observed.delete(this.observed.keys().next().value);
  }
  sync(user, chatId) {
    const key = `${user}:${chatId}`;
    const work = (this.chains.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      await this.prepareChat?.(user, chatId);
      for (let attempt = 0;attempt < 5; attempt++)
        if (await this.apply(user, chatId))
          return;
      throw new Error("The chat kept changing while applying swipe variables. Try again.");
    });
    this.chains.set(key, work);
    work.finally(() => {
      if (this.chains.get(key) === work)
        this.chains.delete(key);
    }).catch(() => {});
    return work;
  }
  async apply(user, chatId) {
    const messages = await this.api.chat.getMessages(chatId);
    const target = [...messages].reverse().find((m) => m.role === "assistant");
    if (target && Array.isArray(target.extra?.variableStateBySwipe) && target.extra.variableStateBySwipe[target.swipe_id])
      return true;
    const selected = target && await selectedVariables(target);
    const chat = await this.api.chats.get(chatId, user);
    if (!chat)
      return true;
    const applied = chat.metadata.another_one_applied_variables;
    if (!target || !selected) {
      if (applied && !messages.some((m) => m.id === applied.messageId)) {
        return this.save(user, chatId, chat.metadata, applyVariableSelection(persistentVariables(chat.metadata), applied.changes, []), messages, target);
      }
      return true;
    }
    const { slot, index } = selected;
    if (applied?.messageId === target.id && applied.slot === index)
      return true;
    const previousMessageId = applied?.messageId;
    const prior = previousMessageId === target.id || previousMessageId && !messages.some((m) => m.id === previousMessageId) ? applied?.changes || [] : [];
    const current = persistentVariables(chat.metadata);
    const values = applyVariableSelection(current, prior, slot.changes);
    if (!await this.save(user, chatId, chat.metadata, values, messages, target, { messageId: target.id, slot: index, changes: slot.changes }))
      return false;
    this.remember(`${user}:${chatId}`, `${target.id}:${target.swipe_id}:${target.swipes.length}`);
    return true;
  }
  async save(user, chatId, metadata, values, messages, target, applied) {
    const current = persistentVariables(metadata);
    const maps = { global: new Map(Object.entries(metadata.macro_variables?.global || {})), chat: new Map(Object.entries(metadata.chat_variables || {})) };
    for (const change of variableChanges(current, { local: {}, ...values })) {
      if (change.after === null)
        maps[change.scope].delete(change.key);
      else
        maps[change.scope].set(change.key, change.after);
    }
    const next = {
      ...metadata,
      macro_variables: { ...metadata.macro_variables, global: Object.fromEntries(maps.global) },
      chat_variables: Object.fromEntries(maps.chat),
      another_one_applied_variables: applied
    };
    if (!applied)
      delete next.another_one_applied_variables;
    return compareChatMetadata(this.api, user, chatId, metadata, next, messages, target);
  }
}

// src/backend/message-contexts.ts
async function restoreMessageContexts(api, chatId, history) {
  const messages = await api.chat.getMessages(chatId);
  for (const message of messages) {
    const metadata = message.metadata;
    if (message.role !== "assistant" || !metadata?.another_one_run || Array.isArray(metadata.preset_contexts))
      continue;
    const data = metadata.another_one_variables;
    const ids = metadata.another_one_presets;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
      continue;
    const contexts = await Promise.all(message.swipes.map(async (content, index) => {
      const hash = await contentHash(content);
      const matches = data?.slots?.filter((slot) => slot.contentHash === hash);
      const slot = matches?.length === 1 ? matches[0] : data?.slots?.length === message.swipes.length ? data.slots[index] : undefined;
      const presetId = slot?.presetId ?? (ids.length === message.swipes.length ? ids[index] : undefined);
      return presetId ? { preset_id: presetId, ...slot ? { variables: slot.snapshot ?? { local: slot.local } } : {} } : null;
    }));
    if (contexts.some(Boolean))
      await api.chat.updateMessage(chatId, message.id, { metadata: { ...metadata, preset_contexts: contexts } });
  }
  const summaries = new Map(messages.map((message) => [message.id, { index: message.index_in_chat, name: message.name }]));
  return Object.fromEntries(history.filter((run) => run.chatId === chatId && run.messageId).map((run) => [run.messageId, summaries.get(run.messageId) ?? null]));
}

// src/backend/index.ts
var storage = new Storage(spindle.userStorage);
var leases = new Leases;
var variableCapture = new VariableCapture(spindle);
var forks = new Forks(spindle, storage);
var variableSelection = new VariableSelection(spindle, (user, chat) => forks.ensure(user, chat));
var active = new Map;
spindle.on("GENERATION_STARTED", (p, user) => {
  if (user)
    active.set(`${user}:${p.chatId}`, p.generationId);
});
for (const event of ["GENERATION_ENDED", "GENERATION_STOPPED"])
  spindle.on(event, (payload, user) => {
    const p = payload;
    const key = `${user}:${p.chatId}`;
    if (active.get(key) === p.generationId)
      active.delete(key);
  });
async function loadCatalog(userId, chatId) {
  if (!spindle.host.capabilities["generation-message-sessions-v1"])
    throw new Error("Update Lumiverse to a build with managed message generation before enabling CAT.");
  if (!spindle.host.capabilities["message-preset-context-v1"])
    throw new Error("CAT requires a Lumiverse build with per-swipe preset support. Update Lumiverse before enabling CAT.");
  if (!spindle.host.capabilities["chat-swipe-reasoning-v1"])
    throw new Error("Update Lumiverse to a build with per-swipe reasoning support before enabling CAT.");
  if (!spindle.host.capabilities["chat-metadata-patch-v1"])
    throw new Error("Update Lumiverse to a build with message metadata patch support before enabling CAT.");
  if (!spindle.host.capabilities["generation-request-messages-v1"])
    throw new Error("Update Lumiverse to a build with prepared request messages before enabling CAT.");
  if (!spindle.host.capabilities["chat-conditional-metadata-v1"])
    throw new Error("Update Lumiverse to a build with conditional chat metadata updates before enabling CAT.");
  if (!spindle.host.capabilities["chat-swipe-variables-v1"])
    throw new Error("Update Lumiverse to a build with per-swipe variable support before enabling CAT.");
  const presets = await listSourcePresets(spindle.presets, userId);
  const [settings, connections, history, activation] = await Promise.all([storage.settings(userId), spindle.connections.list(userId), chatId ? storage.history(userId, chatId) : [], storage.activation(userId)]);
  return { settings, history, activation, presets, connections: connections.map((c) => ({ id: c.id, name: c.name, model: c.model })) };
}
var automation = new Automation(spindle, storage, leases, loadCatalog, (chatId, userId) => inspectChat(spindle, active, chatId, userId), { capture: variableCapture, selection: variableSelection }, (user, chat) => forks.ensure(user, chat));
spindle.on("MESSAGE_DELETED", (raw, userId) => {
  if (!userId)
    return;
  const event = raw;
  storage.removeMessage(userId, event.chatId, event.messageId).then((changed) => {
    if (changed)
      spindle.sendToFrontend({ type: "historyChanged" }, userId);
  }).catch((error) => spindle.log.error(`Could not remove swipe history: ${errorText(error)}`));
});
spindle.onFrontendMessage(async (raw, userId, session) => {
  if (!raw || typeof raw !== "object")
    return;
  const msg = raw;
  if (msg.type !== "request" || typeof msg.id !== "string" || msg.id.length > 100 || !session)
    return;
  const input = msg.input && typeof msg.input === "object" ? msg.input : {};
  try {
    let value;
    switch (msg.operation) {
      case "load":
        value = await loadCatalog(userId, typeof input.chatId === "string" ? input.chatId : undefined);
        break;
      case "activation":
        value = await automation.setActivation(userId, input);
        break;
      case "preparePreset":
        value = await automation.preparePreset(userId, session, String(input.runId), Number(input.stepIndex));
        break;
      case "save":
        value = await storage.save(userId, input.settings);
        break;
      case "heartbeat":
        value = leases.heartbeat(userId, session);
        break;
      case "arm":
        if (typeof input.chatId !== "string" || typeof input.connectionId !== "string")
          throw new Error("A chat and connection are required.");
        value = await automation.arm(userId, session, input.chatId, input.connectionId, input.slotIds);
        break;
      case "followFork":
        if (typeof input.chatId !== "string")
          throw new Error("Open a chat first.");
        value = await automation.followFork(userId, session, input.chatId);
        break;
      case "restoreContexts": {
        if (typeof input.chatId !== "string")
          throw new Error("Open a chat first.");
        await forks.ensure(userId, input.chatId);
        const chat = await spindle.chats.get(input.chatId, userId);
        if (!chat)
          throw new Error("This chat no longer exists.");
        await restoreRunHistory(spindle, storage, userId, chat, await spindle.chat.getMessages(input.chatId), (runId) => automation.isCurrentRun(userId, runId));
        const checked = await storage.history(userId, input.chatId);
        const messages = await restoreMessageContexts(spindle, input.chatId, checked);
        await storage.reconcileHistory(userId, checked, messages);
        value = { messages, history: await storage.history(userId, input.chatId) };
        break;
      }
      case "disarm":
        value = await automation.disarm(userId, session, input.stop === true);
        break;
      case "launch":
        value = await automation.launch(userId, session, String(input.runId), String(input.messageId), input.prompts);
        break;
      case "preparationFailed":
        value = await automation.preparationFailed(userId, session, String(input.runId), String(input.error), String(input.chatId), typeof input.messageId === "string" ? input.messageId : undefined);
        break;
      case "selectSwipe": {
        const runId = String(input.runId);
        if (typeof input.chatId !== "string")
          throw new Error("A chat is required.");
        const run = automation.getRun(userId, runId) || (await storage.history(userId, input.chatId)).find((r) => r.id === runId);
        if (!run || run.chatId !== input.chatId)
          throw new Error("This run is no longer available.");
        await selectSwipe(spindle, run, Number(input.stepIndex), () => variableSelection.sync(userId, run.chatId));
        value = true;
        break;
      }
      default:
        throw new Error("Unknown CAT operation.");
    }
    spindle.sendToFrontend({ type: "reply", id: msg.id, value }, userId, { frontendSessionId: session });
  } catch (error) {
    spindle.sendToFrontend({ type: "reply", id: msg.id, error: errorText(error) }, userId, { frontendSessionId: session });
  }
});
