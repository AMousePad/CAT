// src/generation/host.ts
function hostDriver(ctx, settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const surfaces = ctx.host.surfaces;
  const connections = ctx.connections;
  const state = ctx.state;
  if (!surfaces || !connections?.getActive || !state || !ctx.frontendSessionId)
    throw new Error("Update Lumiverse: CAT requires host actions, connection profiles, and frontend session routing.");
  const driver = {
    chatId: () => state.get("chat.active").chatId,
    connectionId: () => connections.getActive().activeProfileId,
    async openChat(chatId) {
      if (driver.chatId() === chatId)
        return;
      await surfaces.invoke({ kind: "route", id: "/chat/:chatId" }, { chatId });
      for (let attempt = 0;attempt < 100; attempt++) {
        if (driver.chatId() === chatId)
          return;
        await settle(50);
      }
      throw new Error("Lumiverse did not open this chat.");
    }
  };
  return driver;
}

// src/shared.ts
var MAX_SWIPES = 20;
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/generation/session.ts
async function hostRequest(path, body, signal) {
  const response = await fetch(`/api/v1/${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || `Lumiverse returned ${response.status}.`);
  return value;
}

class Session {
  ctx;
  bridge;
  changed;
  view = { phase: "off", detail: "Disabled", run: null };
  armed = false;
  chatId = null;
  heartbeat;
  preparing;
  preparation;
  unsubscribe;
  disposed = false;
  driver;
  changingChat = false;
  navigation = 0;
  viewRevision = 0;
  constructor(ctx, bridge, changed) {
    this.ctx = ctx;
    this.bridge = bridge;
    this.changed = changed;
    this.driver = hostDriver(ctx);
    this.unsubscribe = ctx.onBackendMessage((raw) => {
      const message = raw;
      if (message.type === "view" && message.view) {
        if (this.changingChat)
          return;
        this.viewRevision++;
        this.armed = message.armed === true;
        this.view = message.view;
        if (this.armed) {
          this.chatId = this.driver.chatId();
          this.startHeartbeat();
        }
        if (!this.armed && this.view.phase !== "running") {
          this.preparing?.abort();
          clearInterval(this.heartbeat);
          this.heartbeat = undefined;
        }
        this.changed(this.view);
      } else if (message.type === "prepare")
        this.preparation = this.prepare(raw);
    });
  }
  get generatingChatId() {
    if (this.disposed || this.changingChat || this.driver.chatId() !== this.chatId)
      return null;
    return this.view.phase === "running" || this.view.phase === "stopping" || this.armed && this.view.phase === "preparing" ? this.chatId : null;
  }
  startHeartbeat() {
    if (this.heartbeat || this.disposed)
      return;
    this.heartbeat = setInterval(() => {
      this.bridge.call("heartbeat", {}).then((ok) => {
        if (!ok && this.enabled)
          this.disable("Control was lost.", true);
      }).catch((error) => {
        this.preparing?.abort();
        this.showError(error);
      });
    }, 15000);
  }
  disconnected() {
    this.navigation++;
    this.changingChat = false;
    this.armed = false;
    this.preparing?.abort();
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.view = { phase: "off", detail: "Disconnected. Waiting to reconnect.", run: null };
    this.changed(this.view);
  }
  messageDeleted(chatId, messageId) {
    if (this.view.run?.chatId !== chatId || this.view.run.messageId !== messageId)
      return;
    this.viewRevision++;
    this.view = { ...this.view, run: null };
    this.changed(this.view);
  }
  get enabled() {
    return this.armed || ["preparing", "running", "stopping"].includes(this.view.phase);
  }
  async openSwipe(run, stepIndex) {
    if (!run.messageId || !run.steps[stepIndex])
      return;
    if (this.disposed)
      return;
    if (this.enabled && this.driver.chatId() !== run.chatId)
      await this.disable("Chat changed.", true);
    await this.driver.openChat(run.chatId);
    if (this.disposed || this.driver.chatId() !== run.chatId)
      return;
    await this.bridge.call("selectSwipe", { chatId: run.chatId, runId: run.id, stepIndex });
    if (this.disposed || this.driver.chatId() !== run.chatId)
      return;
    this.ctx.dom.findMessageElement(run.messageId)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  showError(error) {
    if (!this.disposed) {
      this.view = { ...this.view, phase: "error", detail: errorText(error) };
      this.changed(this.view);
    }
  }
  async enable(catalog, slotIds) {
    if (this.enabled || this.disposed)
      return;
    const navigation = ++this.navigation;
    this.chatId = this.driver.chatId();
    const chatId = this.chatId;
    if (!chatId) {
      this.showError(new Error("Open a chat first."));
      return;
    }
    const connectionId = this.driver.connectionId() || catalog.settings.slots[0]?.connectionId || "";
    let armRequested = false;
    try {
      if (!this.ctx.host.capabilities["message-preset-context-v1"])
        throw new Error("Update Lumiverse to use per-swipe presets and variables with CAT.");
      this.view = { ...this.view, phase: "preparing", detail: "Enabling parallel swipes…" };
      this.changed(this.view);
      if (this.disposed || this.driver.chatId() !== chatId)
        throw new Error("Chat changed while enabling.");
      armRequested = true;
      const view = await this.bridge.call("arm", { chatId, connectionId, slotIds });
      if (this.disposed || navigation !== this.navigation || this.driver.chatId() !== chatId)
        return;
      this.view = view;
      this.armed = true;
      this.changed(this.view);
      this.startHeartbeat();
    } catch (error) {
      if (navigation !== this.navigation)
        return;
      if (armRequested)
        this.bridge.call("disarm", { stop: true }).catch(() => {});
      this.showError(error);
    }
  }
  async prepare(message) {
    if (!this.armed || message.chatId !== this.chatId || this.driver.chatId() !== this.chatId)
      return;
    this.preparing?.abort();
    const abort = new AbortController;
    this.preparing = abort;
    let messageId;
    let creatingReply = false;
    let launched = false;
    let failure = "Stopped before generating swipes.";
    try {
      const prompts = await Promise.all(message.slots.map(async (slot, stepIndex) => {
        const prepared = await this.bridge.call("preparePreset", { runId: message.runId, stepIndex });
        if (abort.signal.aborted)
          throw new Error("Cancelled while preparing swipes.");
        const value = await hostRequest("generate/dry-run", {
          chat_id: message.chatId,
          connection_id: slot.connectionId,
          preset_id: prepared.presetId,
          force_preset_id: true,
          include_request_messages: true,
          persona_id: message.personaId,
          generation_type: "normal"
        }, abort.signal);
        if (!Array.isArray(value.request_messages))
          throw new Error("Update Lumiverse to a build with prepared request messages before using CAT.");
        return {
          connectionId: slot.connectionId,
          captureToken: prepared.token,
          variableState: value.variable_state,
          messages: value.request_messages,
          parameters: value.parameters,
          provider: value.provider,
          model: value.model,
          prefill: value.assistantPrefill || ""
        };
      }));
      if (abort.signal.aborted || !this.armed || this.driver.chatId() !== message.chatId)
        return;
      creatingReply = true;
      const reply = await hostRequest(`chats/${encodeURIComponent(message.chatId)}/messages`, {
        is_user: false,
        name: message.name,
        content: "",
        extra: { ...message.characterId ? { character_id: message.characterId } : {}, spindle_metadata: { another_one_run: message.runId } }
      }, AbortSignal.timeout(20000));
      messageId = reply.id;
      if (abort.signal.aborted)
        return;
      await this.bridge.call("launch", { runId: message.runId, messageId: reply.id, prompts });
      launched = true;
    } catch (error) {
      failure = errorText(error);
    } finally {
      if (!launched && (creatingReply || !abort.signal.aborted)) {
        try {
          await this.bridge.call("preparationFailed", { runId: message.runId, error: failure, chatId: message.chatId, messageId });
        } catch (error) {
          this.showError(error);
        }
      }
      if (this.preparing === abort)
        this.preparing = undefined;
    }
  }
  async disable(_detail, stop = false) {
    this.navigation++;
    this.changingChat = false;
    this.preparing?.abort();
    this.armed = false;
    const revision = this.viewRevision;
    try {
      const view = await this.bridge.call("disarm", { stop });
      if (revision === this.viewRevision) {
        this.view = view;
        this.changed(this.view);
      }
    } catch (error) {
      this.showError(error);
    }
    if (this.view.phase !== "running") {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
  async chatChanged() {
    const chatId = this.driver.chatId();
    if (!this.enabled)
      return;
    if (chatId === this.chatId) {
      if (this.changingChat)
        await this.disable("Chat changed.", true);
      return;
    }
    if (!this.armed) {
      await this.disable("Chat changed.", true);
      return;
    }
    if (!chatId) {
      await this.disable("Chat changed.", true);
      return;
    }
    const navigation = ++this.navigation;
    this.changingChat = true;
    this.preparing?.abort();
    this.view = { ...this.view, phase: "preparing", detail: "Opening chat…" };
    this.changed(this.view);
    try {
      const view = await this.bridge.call("followFork", { chatId });
      if (this.disposed || navigation !== this.navigation || this.driver.chatId() !== chatId)
        return;
      this.changingChat = false;
      if (!view) {
        await this.disable("Chat changed.", true);
        return;
      }
      this.chatId = chatId;
      this.view = view;
      this.armed = true;
      this.changed(this.view);
    } catch (error) {
      if (navigation !== this.navigation || this.disposed)
        return;
      await this.disable("Could not open fork.", true);
      this.showError(error);
    } finally {
      if (navigation === this.navigation)
        this.changingChat = false;
    }
  }
  async dispose() {
    this.disposed = true;
    clearInterval(this.heartbeat);
    this.unsubscribe();
    this.preparing?.abort();
    if (this.enabled)
      await this.disable("Extension unloaded.", true);
    await this.preparation;
  }
}

// src/ui/id.ts
function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// src/ui/bridge.ts
class Bridge {
  ctx;
  pending = new Map;
  unsubscribe;
  disposed = false;
  constructor(ctx) {
    this.ctx = ctx;
    this.unsubscribe = ctx.onBackendMessage((raw) => {
      const message = raw;
      if (message?.type !== "reply")
        return;
      const request = this.pending.get(message.id);
      if (!request)
        return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error)
        request.reject(new Error(message.error));
      else
        request.resolve(message.value);
    });
  }
  call(operation, input) {
    if (this.disposed)
      return Promise.reject(new Error("Extension unloaded."));
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CAT's backend did not respond. Check the connection and extension permissions."));
      }, 20000);
      this.pending.set(id, { resolve: (value) => resolve(value), reject, timer });
      try {
        this.ctx.sendToBackend({ type: "request", id, operation, input });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  dispose() {
    this.disposed = true;
    this.unsubscribe();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Extension unloaded."));
    }
    this.pending.clear();
  }
}

// src/ui/icons.ts
/*! Icon creators, source links, licenses and modifications: CREDITS.md. */
var CAT_ICON_POOL = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12.560000000000002 -2.5600000000000023 133.12 133.12" width="24" height="24" preserveAspectRatio="xMidYMid meet"><image width="108" height="128" href="data:image/png;base64,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"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-15.560000000000002 -2.5600000000000023 133.12 133.12" width="24" height="24" preserveAspectRatio="xMidYMid meet"><image width="102" height="128" href="data:image/png;base64,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"/></svg>',
  `<svg viewBox="-23.978669 -23.998873 1248.015107 1248.015107" xmlns="http://www.w3.org/2000/svg" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m220.72 0.011719c-8.6484-0.24609-17.008 3.9258-23.195 11.57-6.1836 7.6406-9.6758 18.113-9.6797 29.051v329.68c-17.469 39.125-26.492 80.859-26.594 123 0.14062 48.504 12.105 96.398 35.059 140.34-14.008 4.2578-28.23 9.9414-41.469 16.016-33.07 15.184-60.062 32.375-60.062 32.375l7.0859 11.254s26.398-16.75 58.508-31.477c13.629-6.2539 28.246-12.012 42.152-16.066 4.9961 8.6445 10.41 17.09 16.23 25.312-16.875 4.3086-34.484 11.242-50.652 18.645-33.07 15.184-60.062 32.348-60.062 32.348l7.0859 11.254s26.398-16.711 58.508-31.453c16.055-7.3633 33.523-14.211 49.527-18.176 1.5547-0.39063 2.9922-0.60547 4.5234-0.93359 6.6562 8.6367 13.762 16.988 21.297 25.027-5.1406 0.70703-10.344 1.6406-15.688 2.9688-17.254 4.2812-35.355 11.395-51.891 18.984-33.07 15.184-60.062 32.336-60.062 32.336l7.0859 11.254s26.398-16.723 58.508-31.453c16.055-7.3633 33.523-14.211 49.527-18.176 8.9688-2.2227 17.344-3.3477 24.77-3.4375h0.003906c6.6211 6.3086 13.516 12.379 20.668 18.207-18.059 35.852-27.492 75.105-27.605 114.89 0 43.355 11.07 86.059 32.246 124.41 21.18 38.348 51.828 71.184 89.293 95.668-23.438 21.027-33.211 48.074-26.23 72.578 5.7617 20.07 22.258 36.578 45.867 45.891 23.605 9.3125 52.387 10.668 80.004 3.7695 22.5-5.6562 42.855-16.457 58.016-30.781 15.168 14.328 35.535 25.129 58.043 30.781 27.613 6.8984 56.391 5.5469 79.996-3.7617 23.605-9.3086 40.105-25.809 45.875-45.871 7.0273-24.598-2.832-51.75-26.434-72.812 28.57-18.559 53.289-42.02 72.895-69.191 22.801 10.699 45.031 28.672 67.68 46.801 56.086 44.895 130.61 57.223 187.68 22.445 57.07-34.773 86.766-105.56 86.035-192.97 0.078125-14.414-5.6641-28.246-15.918-38.348-10.254-10.098-24.145-15.609-38.516-15.27-14.094 0.32812-27.484 6.2539-37.223 16.48-9.7422 10.227-15.035 23.91-14.715 38.047 0.51953 63.41-19.82 91.719-34.902 100.91-15.082 9.1953-34.863 10.332-66.09-14.664-20.742-16.598-50.262-42.707-90.781-60.984 3.7344-17.484 5.625-35.281 5.6367-53.125-0.09375-39.762-9.5-78.996-27.527-114.84 7.0469-5.8477 13.84-11.938 20.359-18.258 7.4922 0.14062 15.93 1.1992 24.984 3.4375 16.004 3.9648 33.473 10.812 49.527 18.176 32.109 14.742 58.508 31.453 58.508 31.453l7.1133-11.254s-27.031-17.168-60.09-32.336c-16.535-7.5898-34.598-14.703-51.867-18.984-5.1914-1.2891-10.281-2.2109-15.297-2.918h0.007812c7.5156-8.0312 14.602-16.375 21.242-25 1.4023 0.30469 2.7266 0.50391 4.1562 0.84766 16.004 3.9648 33.461 10.812 49.527 18.176 32.109 14.742 58.508 31.453 58.508 31.453l7.1133-11.254s-27.031-17.168-60.09-32.348c-16.23-7.4531-33.93-14.426-50.906-18.719v-0.003907c5.832-8.2227 11.254-16.668 16.258-25.316 13.984 4.0664 28.688 9.8516 42.402 16.145 32.109 14.742 58.508 31.477 58.508 31.477l7.1133-11.254s-27.031-17.191-60.09-32.375c-13.25-6.0742-27.461-11.762-41.469-16.016h0.003906c22.961-43.938 34.934-91.828 35.082-140.34-0.050782-42.258-9.0742-84.121-26.59-123.36v-329.3c-0.007813-10.941-3.5-21.418-9.6914-29.062-6.1914-7.6484-14.559-11.812-23.211-11.559-5.3867 0.15234-10.656 2.0156-15.324 5.4141l-221.47 161.7v0.003906c-24.996-4.6992-50.469-7.082-76.012-7.1094-25.449 0.125-50.812 2.5859-75.703 7.3438l-221.8-161.93c-4.668-3.3984-9.9375-5.2617-15.324-5.418m7.0117 79.984 75.551 151.48c-29.027 20.48-54.488 44.711-75.543 71.902v-223.38m611.62 0v223.88-0.003906c-21.078-27.273-46.586-51.574-75.676-72.109l75.676-151.71m-497.18 373.38c13.16-0.25391 26.613 1.2266 39.914 4.5078 53.117 13.199 93.359 53.09 98.211 101.02l0.003907 0.003906c0.30078 2.9414-0.52344 5.8828-2.3125 8.2305-29.746 38.957-85.453 54.82-138.64 41.695-53.117-13.199-93.387-53.09-98.234-101.02v0.003907c-0.30469-2.9375 0.52344-5.8828 2.3086-8.2305 22.32-29.23 59.23-45.449 98.742-46.195zm382.74 0c39.5 0.74609 76.422 16.965 98.742 46.195v0.003906c1.7852 2.3477 2.6133 5.2891 2.3086 8.2266-4.8633 47.926-45.133 87.816-98.234 101.02-53.191 13.125-108.9-2.7266-138.64-41.695-1.7891-2.3477-2.6133-5.293-2.3125-8.2305 4.8633-47.926 45.105-87.816 98.211-101.02 13.301-3.2852 26.742-4.7617 39.914-4.5078zm-331 26.641v0.003906c-8.8164 0-17.27 4.2148-23.504 11.715-6.2344 7.5039-9.7383 17.68-9.7383 28.289 0.003906 10.605 3.5039 20.781 9.7383 28.281 6.2344 7.5039 14.688 11.715 23.504 11.715s17.27-4.2109 23.504-11.715c6.2344-7.5 9.7383-17.676 9.7383-28.281 0-10.609-3.5039-20.785-9.7383-28.289-6.2305-7.5-14.688-11.715-23.504-11.715m279.25 0c-8.8125 0-17.27 4.2148-23.504 11.719-6.2344 7.5-9.7344 17.676-9.7344 28.285 0 10.605 3.5039 20.781 9.7344 28.281 6.2344 7.5 14.691 11.715 23.504 11.715 8.8125-0.007813 17.262-4.2266 23.488-11.727 6.2305-7.5 9.7266-17.668 9.7266-28.27 0-10.605-3.4961-20.777-9.7266-28.277-6.2266-7.5-14.676-11.719-23.488-11.727m-139.61 159.97c10.578 0 20.727 2.8086 28.207 7.8086 7.4805 5.0039 11.684 11.785 11.684 18.855 0 7.0742-4.2031 13.855-11.684 18.855-7.4805 5.0039-17.625 7.8125-28.207 7.8125-10.578 0-20.723-2.8086-28.203-7.8086-7.4805-5.0039-11.684-11.785-11.684-18.859 0-7.0703 4.2031-13.852 11.684-18.855 7.4805-5 17.625-7.8086 28.203-7.8086"></path>
</svg>
`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2.000585 2.15599 93.60054 93.60054" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path d="M22.817,16.233c0,0,6.777-0.587,10.47,4.184c1.783-4.376,9.372-7.462,12.192-6.452c0.646-7.75,3.551-10.009,3.551-10.009  s8.557,2.421,8.557,10.817c7.323,4.027,12.522,19.038,0.246,26.993c0.603,12.39,16.294,13.252,16.307,27.079  c0.016,14.542-20.442,16.231-18.074,15.992c-6.66,7.871-19.597,12.481-30.504,6.15c-13.13-7.616-12.671-26.155-3.173-24.694  c9.783,1.505-1.364,9.782,4.977,16.827c3.09,3.431,13.413,8.247,23.198,1.72c0,0-16.676,0.29-16.676-13.774  s12.529-12.473,9.955-24.948C28.43,47.656,25.975,35.529,27.194,31.133C19.898,26.361,22.817,16.233,22.817,16.233z"></path></svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2.24502 -3.227019 104.001039 104.001039" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><g><polygon points="25.467,55.542 28.397,72.02 20.597,76.705 20.597,93.737 14.164,93.737 14.164,70.111 \t"></polygon><polygon points="83.154,65.604 79.352,74.89 92.137,93.737 98.688,93.737 \t"></polygon><path d="M99.756,42.458H22.659c-7.491-0.615-13.381-6.884-13.381-14.534c0-8.052,6.523-14.581,14.571-14.591\r \t\tc0.007,0,0.013,0.001,0.021,0.001c0.006,0,0.012-0.001,0.019-0.001c2.622-0.01,4.746-2.139,4.746-4.764\r \t\tc0-2.573-2.044-4.668-4.597-4.757c-0.055-0.001-0.111-0.002-0.167-0.002c-0.057,0-0.114,0-0.167,0.001\r \t\tC10.462,3.9-0.245,14.661-0.245,27.922c0,13.316,10.797,24.112,24.114,24.112h1.738L41.52,93.737h6.508l-5.312-17.032l9.792-11.1\r \t\th13.188v28.132h6.44V76.705l15.578-19.314c1.065,0.616,2.302,0.971,3.62,0.971c3.999,0,7.241-3.242,7.241-7.241\r \t\tc0-1.874-0.709-3.581-1.878-4.867L99.756,42.458z"></path><polyline points="25.607,52.034 41.52,93.737 48.028,93.737 42.716,76.705 \t"></polyline></g></svg>\n',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.158337 -1.12734 92.317678 92.317678" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><g><path fill="currentColor" d="M56.462,0.648H33.539c-15.843,0-28.733,17.605-28.733,39.242c0,11.672,3.747,22.65,10.281,30.12   c0.025,0.029,0.063,0.039,0.088,0.065v17.436c0,1.053,0.853,1.904,1.903,1.904h23.079h32.701c1.051,0,1.903-0.852,1.903-1.904   v-17.39c6.368-7.201,10.434-18.08,10.434-30.231C85.194,18.253,72.306,0.648,56.462,0.648z M58.183,34.872l-1.668-2.344   c-0.2-0.278-0.533-0.426-0.875-0.393c-0.343,0.036-0.638,0.252-0.774,0.567c-0.133,0.308-1.304,3.039-1.586,4.11   c-0.524,2-0.798,6.012,1.663,7.595c-0.346,0.557-1.201,1.563-1.973,2.471c-2.39,2.813-6.384,7.517-9.246,13.954   c-1.06-0.171-2.052-0.502-3.097-1.017c-2.906-1.429-2.899-6.808-2.708-7.646c0.057-0.243,0.329-0.561,0.726-0.679   c0.374-0.108,0.726-0.003,1.054,0.314c0.855,0.836,2.331,0.964,3.281,0.285c0.657-0.469,1.139-1.438,0.518-2.74   c-0.364-0.764-1.778-2.124-3.653-2.612c-1.538-0.406-3.05-0.124-4.373,0.81c-1.256,0.885-2.077,2.544-2.369,4.589   c-1.001-3.818-1.57-7.932-1.57-12.246c0-13.659,5.472-25.515,13.457-31.428C52.137,13.763,57.034,23.71,58.183,34.872z M70.6,35.79   c0.121,0.344-0.12,1.036-1.02,1.436c-0.333,0.144-0.708,0.354-1.125,0.61c-0.001-0.003,0-0.007-0.001-0.01   c-0.2-0.708-0.635-1.266-1.213-1.626c0.541-0.252,1.109-0.485,1.73-0.649C69.814,35.327,70.472,35.422,70.6,35.79z M34.93,54.938   c-0.254-2.665,0.39-4.956,1.637-5.835c0.847-0.6,1.768-0.783,2.745-0.54c1.395,0.344,2.35,1.373,2.468,1.605   c0.106,0.224,0.108,0.348,0.105,0.364c-0.02,0.022-0.122,0.078-0.293,0.085c-0.241,0.007-0.446-0.059-0.565-0.177   c-0.82-0.8-1.887-1.082-2.917-0.777c-1.016,0.299-1.819,1.111-2.043,2.075c-0.334,1.455-0.243,7.834,3.72,9.784   c2.25,1.108,4.366,1.498,7.067,1.292c0.523-0.04,0.918-0.495,0.878-1.02c-0.039-0.524-0.538-0.908-1.02-0.879   c-0.331,0.026-0.649,0.039-0.957,0.046c2.718-5.851,6.277-10.043,8.665-12.853c1.896-2.232,2.762-3.251,2.54-4.254   c-0.09-0.413-0.362-0.744-0.767-0.931c-1.72-0.793-1.466-4.137-1.072-5.631c0.118-0.456,0.483-1.399,0.836-2.268l1.433,2.012   c0.179,0.25,0.467,0.4,0.773,0.4l3.207,0.007h0.002c0.375,0,0.716-0.223,0.869-0.567l1.543-3.468   c0.589,2.498,1.309,3.924,2.15,4.248c0.49,0.187,0.625,0.462,0.687,0.682c0.402,1.423-1.313,4.393-2.489,5.927   c-0.312,0.406-0.244,0.99,0.152,1.314c0.396,0.325,0.98,0.279,1.318-0.108c0.063-0.072,6.479-7.323,11.433-8.883   c1.139-0.357,1.993-0.161,2.279,0.531c0.233,0.567,0.05,1.37-0.662,1.737c-8.645,4.474-24.307,21.499-28.346,37.053   c-0.311,0.036-1.039-0.105-1.568-0.59c-0.451-0.413-0.564-0.915-0.346-1.528c1.066-2.999,2.347-9.272,2.4-9.538   c0.068-0.341-0.054-0.691-0.319-0.918c-0.174-0.147-0.394-0.223-0.614-0.223c-0.115,0-0.231,0.02-0.344,0.063   c-0.047,0.02-4.887,1.835-10.029-0.495C36.538,61.347,35.189,57.676,34.93,54.938z M45.35,65.771   c-0.134,0.377-0.277,0.764-0.423,1.145c-0.266,0.698-0.516,1.36-0.675,1.927c-0.218,0.777-0.303,1.229-0.339,1.573   c-0.341-0.281-0.691-0.547-1.021-0.852c0.141-1.236,0.349-1.879,0.849-3.387l0.151-0.459C44.398,65.759,44.886,65.778,45.35,65.771   z M46.084,69.357c0.146-0.518,0.379-1.127,0.621-1.764c0.251-0.658,0.484-1.32,0.688-1.979c0.442-0.063,0.859-0.131,1.211-0.206   c-0.201,0.924-0.482,2.17-0.793,3.441c-0.645,0.643-1.314,1.242-2.008,1.806C45.82,70.436,45.879,70.089,46.084,69.357z    M17.951,67.506c-5.936-6.785-9.34-16.852-9.34-27.616c0-19.539,11.182-35.437,24.928-35.437h10.591   c-9.688,6.313-16.401,19.824-16.401,35.437c0,10.823,3.226,20.64,8.432,27.747H18.024C17.995,67.594,17.985,67.545,17.951,67.506z    M38.254,85.609H18.98V71.442h19.274V85.609z M38.437,64.261c0.092,0.046,0.169,0.111,0.264,0.154   c1.123,0.508,2.221,0.832,3.273,1.042l-0.04,0.121c-0.323,0.974-0.533,1.619-0.687,2.288   C40.247,66.765,39.308,65.562,38.437,64.261z M70.955,85.609H42.059V74.393c0.226,0.141,0.467,0.259,0.733,0.312   c0.121,0.025,0.25,0.039,0.385,0.039c0.033,0,0.069-0.017,0.104-0.017c3.951,2.804,8.429,4.409,13.182,4.409   c5.284,0,10.235-1.966,14.493-5.379V85.609z"></path></g></svg>\n',
  `<svg viewBox="125.591821 170.779947 858.427197 858.427197" xmlns="http://www.w3.org/2000/svg" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m830.89 201.68c-17.953-2.2344-94.23 206.41-94.23 206.41l-258.02-8.9844s-62.82-197.45-98.73-197.45c-35.895 0-49.363 385.91-237.81 619.23 186.21 302.89 751.59 143.61 812.18 62.836 60.57-80.777-105.45-679.82-123.39-682.05zm-406.09 637.18c-60.719 0-106.25-66.238-106.25-136.86 0-70.637 47.371-161.55 108.09-161.55s108.09 97.648 108.09 168.27c0 70.637-49.215 130.14-109.93 130.14zm329.65 0c-60.703 0-106.23-66.238-106.23-136.86 0-70.637 47.371-161.55 108.07-161.55 60.719 0 108.09 97.648 108.09 168.27 0.003906 70.637-49.211 130.14-109.93 130.14z"></path>
 <path d="m450.91 690.59c0 79.793-9.6836 144.48-21.629 144.48-11.945 0-21.629-64.688-21.629-144.48 0-79.797 9.6836-144.48 21.629-144.48 11.945 0 21.629 64.684 21.629 144.48z"></path>
 <path d="m776.23 690.59c0 79.793-9.6836 144.48-21.629 144.48-11.945 0-21.629-64.688-21.629-144.48 0-79.797 9.6836-144.48 21.629-144.48 11.945 0 21.629 64.684 21.629 144.48z"></path>
</svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="6.84 6.839075 86.32 86.32" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><g><path d="M50,34.333c-2.46,0-4.851,0.206-7.149,0.583C38.426,28.621,28.26,18.673,23.5,21c-4.656,2.276-3.398,17.485-0.863,24.764   C19.926,49.065,18.337,53,18.339,58H11c-1.381,0-2.5,1.297-2.5,3s1.119,3,2.5,3h8.548c0.373,0,0.822,1.338,1.353,2.215l-9.368,2.85   c-1.42,0.471-2.163,1.958-1.628,3.575c0.535,1.617,2.093,2.402,3.513,1.934c0.48-0.16,11.135-3.691,11.589-3.908   c5.794,5.287,14.832,8.678,24.993,8.678s19.198-3.402,24.992-8.689c0.455,0.217,11.109,3.73,11.59,3.891   c1.42,0.469,2.979-0.349,3.514-1.966c0.534-1.617-0.209-3.169-1.629-3.64L79.1,66.215C79.631,65.338,80.08,64,80.452,64H89   c1.381,0,2.5-1.297,2.5-3s-1.119-3-2.5-3h-7.34c0.003-5-1.586-8.935-4.297-12.236c2.535-7.278,3.793-22.362-0.863-24.639   c-4.76-2.327-14.926,7.558-19.352,13.854C54.851,34.601,52.46,34.333,50,34.333z M35.724,60.11c-2.754,0-4.986-2.232-4.986-4.986   c0-2.752,2.232-4.984,4.986-4.984c2.753,0,4.984,2.232,4.984,4.984C40.708,57.878,38.477,60.11,35.724,60.11z M59.291,55.124   c0-2.752,2.232-4.984,4.986-4.984c2.753,0,4.984,2.232,4.984,4.984c0,2.754-2.231,4.986-4.984,4.986   C61.523,60.11,59.291,57.878,59.291,55.124z"></path></g></svg>\n',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="16.693245 16.667514 66.613511 66.613511" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><circle cx="40" cy="48" r="4"></circle><circle cx="60" cy="48" r="4"></circle><path d="M22,70v2A10,10,0,0,0,32,82h4A10,10,0,0,0,46,72h8A10,10,0,0,0,64,82h4A10,10,0,0,0,78,72V70a12,12,0,0,0-.25-2.43A12.91,12.91,0,0,0,81,59c0-25.71-3.53-33.71-6.6-37.8a8,8,0,0,0-10-2.36A28.88,28.88,0,0,0,57.29,24a26,26,0,0,0-14.59,0,28.87,28.87,0,0,0-7.13-5.2,8,8,0,0,0-10,2.36C22.53,25.3,19,33.3,19,59a12.91,12.91,0,0,0,3.25,8.57A12,12,0,0,0,22,70Zm16,2a2,2,0,0,1-2,2H32a2,2,0,0,1-2-2V70a4,4,0,0,1,8,0Zm32,0a2,2,0,0,1-2,2H64a2,2,0,0,1-2-2V70a4,4,0,0,1,8,0ZM32,26s6,3,8,8a18.17,18.17,0,0,1,20,0c2-5,8-8,8-8,1.21,1.62,5,7,5,33a4.89,4.89,0,0,1-.15,1.16A12,12,0,0,0,55.62,64H44.38a12,12,0,0,0-17.23-3.84A4.89,4.89,0,0,1,27,59C27,33,30.79,27.62,32,26Z"></path></svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.481389 -1.480449 102.960674 102.960674" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path fill="currentColor" d="M99.349,44.486c-0.356-0.866-1.287-1.276-2.146-1.478c-1.298-0.305-2.678-0.272-3.997-0.173  c-1.674,0.132-3.334,0.406-4.977,0.744c-0.885,0.183-1.766,0.375-2.637,0.598c-0.407,0.11-0.818,0.21-1.213,0.351  c-0.241,0.082-1.061,0.329-1.235,0.337c-0.06,0,0.146-2.782,0.178-3.023c0.096-0.789,0.275-1.569,0.355-2.358  c0.132-1.354,0.429-2.554,1.031-3.781c1.208-2.463,3.396-4.565,6.129-5.181c0.694-0.155,1.774-0.342,2.186-1.008  c0.207-0.329,0.255-0.757,0.438-1.104c0.207-0.401,0.499-0.762,0.665-1.186c0.528-1.382-0.036-2.996-1.122-3.941  c-1.035-0.898-2.095-1.172-2.256-2.731c-0.115-1.149-1.543-1.807-2.446-2.263c-0.514-0.26-1.048-0.483-1.59-0.674  c0.208-0.913,0.322-1.839,0.565-2.747c0.107-0.388,0.145-2.216-0.433-2.375c-0.842-0.234-2.06,1.66-2.442,2.161  c-0.512,0.675-1.018,1.382-1.51,2.085c-0.218-0.079-0.429-0.173-0.625-0.315c-1.211-0.89-1.376-2.642-1.605-4.009  c-0.174-1.045-0.349-2.641-1.424-3.179c-1.249-0.621-1.847,0.853-2.302,1.814c-0.77,1.624-1.306,3.262-1.88,4.967  c-0.349,1.035-0.421,2.13-0.789,3.16c-1.295,3.626-3.702,6.682-5.13,10.234c-1.13,2.81-1.866,6.523-4.493,8.375  c-2.365,1.67-5.556,1.181-8.114,2.421c-7.554,3.667-13.783,8.944-17.835,16.36c-3.246,5.938-4.158,14.417-5.057,21.053  c-0.268,2.003-0.049,4.083-1.57,5.669c-1.528,1.593-6.19,2.239-8.289,2.317c-9.535,0.342-18.92-7.064-19.104-16.865  c-0.028-1.46,0.343-3.873-1.308-4.607c-1.514-0.67-2.445,1.428-2.672,2.581c-0.311,1.569-0.201,3.293-0.024,4.871  c0.385,3.485,1.543,7.156,3.6,10.021c1.596,2.226,3.749,4.421,6.07,5.88c9.163,5.77,21.053,2.472,31.134,2.612  c7.679,0.11,15.351,0.415,23.029,0.434c1.617,0.006,4.929,0.725,5.17-1.709c0.349-3.467-4.657-4.192-7.056-4.164  c-2.338,0.031-3.37-0.59-2.313-2.796c1.298-2.701,1.652-4.639,1.45-7.7c-0.063-0.953,0.628-3.616,1.716-5.56l1.031-1.491  c1.005-1.318,2.07-2.586,3.19-3.803c0.157,1.258,0.604,2.466,0.741,3.712c0.351,3.237,0.647,6.518,1.201,9.733  c0.687,3.999,2.469,8.14,5.079,11.236c1.264,1.501,2.887,2.701,4.931,2.478c1.83-0.201,2.308-1.404,1.824-3.17  c-0.632-2.299-2.391-4.178-3.462-6.258c-1.063-2.075-1.761-4.428-2.133-6.723c-0.745-4.579-0.152-9.41,1.837-13.609  c1.002-2.121,2.366-4.032,3.534-6.058c0.161-0.278,0.579-0.885,0.873-1.463l-0.003,0.008c0,0,0.006-0.008,0.006-0.014  c0.123-0.236,0.228-0.474,0.277-0.679c4.312-1.966,8.898-3.27,13.546-4.124c1.745-0.324,3.164-0.539,3.508-2.532  C99.531,45.395,99.521,44.92,99.349,44.486z M86.552,20.574c1.115,0.164,1.923,1.139,1.982,2.294  c-0.607-0.232-1.245-0.451-1.935-0.639c-0.834-0.219-1.636-0.37-2.398-0.47C84.687,20.93,85.598,20.433,86.552,20.574z"></path></svg>\n',
  `<svg xmlns="http://www.w3.org/2000/svg" data-name="Layer 2" viewBox="3.200004 3.2 93.6 93.6" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path d="M66,24.78C65.77,8.64,55.63,5,55.63,5c-4.42,6.33-5.26,14.33-5.38,18.33A20.28,20.28,0,0,0,45.83,25a25.23,25.23,0,0,0-7.49,5.9c-4.18-.58-12.57-1.54-18.89-.87,0,0,.36,10.22,13.07,16,1.2,12.14,5.87,16.28,11.59,18.7,6,2.52,13.45-.47,18,7.55S80.55,95,80.55,95V34.3A44.5,44.5,0,0,0,66,24.78ZM49.26,49.27c-4.1,7.37-8.51,2.42-9.63.95a.66.66,0,0,1,0-.76,9.18,9.18,0,0,1,2.91-2.94,8.27,8.27,0,0,0,1,2.35A8.17,8.17,0,0,0,45.46,51a.62.62,0,0,0,1-.63,8.37,8.37,0,0,0-1.1-2.7A8.48,8.48,0,0,0,44,46c2.55-.47,4.56,1.72,5.24,2.59A.65.65,0,0,1,49.26,49.27ZM59.6,42.84a.65.65,0,0,1-.61-.37c-.48-1-1.55-3.76,0-5.85a8.6,8.6,0,0,0,2.86,4.22.62.62,0,0,0,1-.63,8.34,8.34,0,0,0-1.09-2.7,8.79,8.79,0,0,0-1.66-1.94,9.14,9.14,0,0,1,3.93-1.31.64.64,0,0,1,.66.36C65.54,36.27,68,42.41,59.6,42.84Z"></path></svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.2 3.196264 93.6 93.6" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path d="M87.9,73.08a6.5,6.5,0,0,0-2.2.24L75.17,53.48h0c.13-3.46-2.24-7-6-10l15.73-7.77-9.31,1L91.53,25.34l-9.78,1.82L95,15.81,83.33,18.19,86,5.15,74.81,16.79l-3.47-6.66L69.92,24.5l-3-6.73L65.82,33.61,62.2,28.14V39.3c-1.17-.51-2.37-1-3.61-1.37,0-.32.06-.64.06-1a14.51,14.51,0,0,0-2.81-8.47A70.45,70.45,0,0,0,54.57,6.62C48.05,9.45,43,15.77,40.08,20.06a25.4,25.4,0,0,0-2.62-.14A26.29,26.29,0,0,0,33,20.3c-2.82-3.44-8.85-10-15.07-11.66A72.59,72.59,0,0,0,20.29,27a14.86,14.86,0,0,0-4,10c0,6.26,4.22,10.37,10.48,12.43a.7.7,0,0,1,0,.14,9.18,9.18,0,0,0-.07,1.17L12,73.44a5.23,5.23,0,0,0-2.94-.83C6.82,72.61,5,73.8,5,75.27c0,1.23,1.28,2.25,3,2.56-1.25,1.76-1.55,3.67-.59,4.63,1.17,1.17,3.74.5,5.74-1.5l.14-.15c.49,2,1.85,3.45,3.19,3.23s2.32-2.3,1.94-4.6a6.49,6.49,0,0,0-.69-2L33.17,62.69A35.26,35.26,0,0,0,50.5,70.48c.41.06.8.08,1.21.12l.93,13.63a5.56,5.56,0,0,0-3,1.26c-1.87,1.54-2.51,3.85-1.43,5.17.86,1.06,2.57,1.15,4.18.36.25,2.06,1.39,3.66,2.93,3.81,1.77.18,3.4-1.6,3.87-4.06,1.95,1.48,4.23,1.76,5.28.57s.39-3.77-1.64-5.56a7.2,7.2,0,0,0-2-1.25l2.78-16.25A21.76,21.76,0,0,0,68,65.09L79.52,77.85a5,5,0,0,0-1.46,2.65c-.49,2.21.38,4.28,1.93,4.63,1.25.27,2.56-.65,3.28-2.17,1.38,1.37,3.15,1.88,4.36,1.11,1.4-.9,1.57-3.15.49-5.23,2.29,0,4.13-1.15,4.21-2.63S90.43,73.21,87.9,73.08ZM27.21,42.45a7.34,7.34,0,1,1,7.34-7.34A7.34,7.34,0,0,1,27.21,42.45Zm19.38,0a7.34,7.34,0,1,1,7.33-7.34A7.34,7.34,0,0,1,46.59,42.45Z"></path><circle cx="27.21" cy="35.11" r="1.62"></circle><circle cx="46.59" cy="35.11" r="1.62"></circle></svg>\n',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.2 3.19 93.6 93.6" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path d="M95,90.31s-8.77-8.19-8.78-28h0a18.22,18.22,0,0,0,.86-5.5,18.5,18.5,0,0,0-1.64-7.54h0C89.84,29.49,74.19,9.69,74.19,9.69a64.17,64.17,0,0,0-19.3,20.86A62.18,62.18,0,0,0,46,29.92l-1.5,0a122.65,122.65,0,0,0-1-20.25c-24.62,11-32,32.6-32,32.6h0C7.4,46.48,5,51.46,5,56.82c0,8.95,6.67,16.87,16.93,21.76h0a18.12,18.12,0,0,1,1.69,11.73ZM47.28,41.48c10.28-3.24,17.08,9,17.08,9S52.08,69.82,38,57.54C38,57.54,37,44.71,47.28,41.48ZM11.51,53s4.79-12.61,12-9.67,6.53,14.61,6.53,14.61C20.16,69.08,11.51,53,11.51,53Z"></path><path d="M47.61,44.8a13.81,13.81,0,0,0,0,13A16.85,16.85,0,0,0,47.61,44.8Z"></path><path d="M23.3,58.11a15.77,15.77,0,0,0,0-11.78A19.44,19.44,0,0,0,23.3,58.11Z"></path></svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="5.626077 5.624742 88.748209 88.748209" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path fill="currentColor" d="M62.457,25.849c-4.02,1.874-8.488,6.039-10.71,13.079c-3.978,12.599,4.63,19.3,3.956,30.028  c-0.62,9.793-5.844,14.86-7.047,15.968c0.803-1.012,2.694-5.099,0.425-12.408c-1.992-6.415-8.797-14.43-10.673-21.611  c-1.436-5.487-1.919-8.486-1.329-8.488c1.302,0.005,8.388-0.536,11.504-6.082c2.303-4.104-1.005-10.14-0.82-10.189  c7.37-1.892,5.492-9.072,5.492-9.072s-6.873,3.595-7.316,3.057c-0.169-0.206-1.644-1.579-2.904-1.91  c-0.034-0.007,0.18-0.201,0.621-0.252c0.365-0.048,0.978,0.049,0.974,0.034c-0.235-1.077-2.175-0.429-2.379-0.545  c-0.506-0.279,1.81-0.557,1.779-0.622c-0.787-1.731-3.21-0.132-3.223-0.266c-0.085-0.85,1.912-1.061,1.892-1.088  c-1.264-1.687-4.148-0.023-5.845,0.319c-0.633,0.126-2.083-0.324-2.12-0.557c-0.173-1.085-1.138-8.158-2.403-7.906  c-6.566,1.324-7.607,9.224-6.001,11.742c0,0-6.355,4.912-6.002,9.796c0.534,7.307,7.615,10.145,8.34,11.764  c0.25,0.556,0.184,4.904-1.385,9.437c-3.062,8.852-9.159,22.179-7.997,32.576c0.963,8.616,8.239,9.448,9.22,9.601  c4.529,0.714,14.139,0.6,20.553-1.137c1.934-0.525,9.961-3.713,12.147-17.48c0.857-5.396-2.179-13.846-2.194-22.066  c-0.018-7.944,5.971-12.89,11.287-13.134c5.092-0.234,8.725,5.095,8.819,4.932C86.203,30.851,69.865,22.404,62.457,25.849z"></path></svg>\n',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.996701 -2.001573 104.002142 104.002142" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <g>
  <path d="m71.562 8.8672c1.3633-0.26953 2.6133-0.47266 3.8945-0.49609 1.4688-0.023438 2.832-0.30469 4.1523-1.1289 1.875-1.1641 2.9727-0.62109 3.4805 1.4883 0.11328 0.47656 0.33203 0.73047 0.75781 0.91406 2.3711 1.0195 2.9688 3.1016 3.2266 5.3945 0.35156 3.1172-0.5625 5.9688-1.7461 8.7773-1.0703 2.5508-1.8945 5.1445-1.0625 7.957 0.47656 1.6172 1.4023 2.9766 2.3906 4.3086 2.4414 3.2852 4.4805 6.7188 5.0234 10.914 0.52344 4.0586-0.042969 7.875-1.7422 11.57-1.7695 3.8516-4.4297 7.125-6.7773 10.602-2.7617 4.082-5.332 8.2422-6.4141 13.141-0.51562 2.3359-0.61328 4.6641-0.14062 7.0156 0.20312 1.0117 0.66016 1.8359 1.5742 2.4062 1.0664 0.66406 1.9453 1.5234 2.2383 2.8008 0.20312 0.89844 0.84375 0.85938 1.5234 0.85938 3.5391-0.007813 7.082-0.007813 10.625 0 1.5547 0.003906 2.3867 0.62109 2.418 1.7578 0.03125 1.1484-0.80078 1.8164-2.3555 1.8164-17.469 0.007812-34.938 0.007812-52.406 0.003906-0.23438 0-0.47266 0.007812-0.70703-0.023438-1.0859-0.12891-1.8047-0.74219-1.7891-1.8281 0.015626-1.1094 0.80859-1.6836 1.8828-1.707 2.0273-0.046875 4.0586-0.023437 6.0898-0.023437 0.51172-0.003907 1.0195 0 1.6055 0 0.003906-0.80859-0.52344-1.1094-0.88672-1.4922-1.918-2.0234-3.793-4.0859-5.2656-6.4688-1.0586-1.7148-0.87891-1.9219 0.46484-3.3477 1.8711-1.9883 3.8594-3.2969 6.7578-2.9375 1.0234 0.12891 2.1172-0.33594 3.1797-0.10156 0.34766 0.8125-0.25391 1.2031-0.59766 1.6602-1.3477 1.7695-1.3789 3.082-0.10938 4.8828 0.78125 1.1172 1.8789 1.8555 3.0195 2.5195 1.7695 1.0273 3.0859 2.3398 3.1562 4.5312 0.015624 0.44922 0.22266 0.72656 0.68359 0.72656 4.0938 0.007813 8.1914 0.007813 12.176 0.007813 0.45313-0.66797 0.089844-1.0664-0.097656-1.4805-2.6211-5.8984-3.2539-12.059-2.3789-18.402 0.078125-0.56641 0.32422-1.0977-0.1875-1.5742-0.58984-0.55469-1.1641-0.19922-1.6992 0.050782-4.5664 2.125-9.3477 3.5234-14.336 4.1836-1.5234 0.19922-3.0664 0.49609-4.5586 0.32422-0.44922-0.51172-0.28125-0.98438-0.13672-1.418 0.34375-1.0312 0.027344-1.8672-0.92578-2.2227-1.0938-0.40234-1.5117 0.57422-1.7891 1.3477-1.0938 3.0156-3.1055 5.2109-5.7734 6.9258-3.4492 2.2188-7.2227 2.6328-11.152 2.1367-2.1758-0.27344-2.9414 0.49219-2.5625 2.6797 0.28125 1.6055 0.83984 2.9453 2.3203 3.832 0.92188 0.55469 1.4688 1.4883 1.6602 2.5391 0.16016 0.88281 0.60938 1.1836 1.4609 1.1055 0.51563-0.050781 1.043-0.046875 1.5547 0.023438 1.0625 0.12891 1.5938 0.87109 1.6016 1.8438 0.007813 0.94922-0.60547 1.543-1.5859 1.6875-0.18359 0.027343-0.375 0.023437-0.5625 0.023437-7.7461 0-15.484 0.007813-23.23-0.007812-1.5273-0.003906-2.2109-0.57812-2.2266-1.7656-0.015625-1.25 0.65625-1.7969 2.3125-1.8047 3.3047-0.015625 6.6094-0.003906 9.9141-0.011719 0.31641 0 0.66797 0.078126 1.082-0.38672-1.0977-2.2266-1.8945-4.6641-2.4297-7.1914-0.55078-2.5898-1.0195-5.1836-0.95312-7.8477 0.066406-2.6641 0.88281-3.7656 3.4023-4.4805 3.9492-1.1211 5.0547-2.5 4.7812-6.6133-0.16016-2.4531-0.21094-4.8789 0.1875-7.3398-1.6445-0.82813-3.3828-1.0977-5.0156-1.6758-7.7422-2.7461-13.773-7.457-16.98-15.191-4.7812-11.516 1.6836-24.715 14.449-26.52 2.4062-0.33984 4.8125-0.17188 7.0039 1.0977 2.3672 1.3789 3.4453 4.043 2.582 6.3906-0.90625 2.4727-3.4023 3.875-6.1094 3.4375-0.23438-0.035156-0.46875-0.058594-0.69922-0.10156-6.0508-1.1445-10.59 3.4492-9.5312 9.5742 0.85156 4.8906 3.6758 8.3984 7.6211 11.113 2.668 1.8398 5.6992 2.9141 8.8086 3.7773 0.89453 0.24219 1.6055 0.097657 2.3125-0.55469 6.1641-5.6758 13.711-8.0117 21.828-9.0938 3.3594-0.44922 6.793-0.25391 10.102-1.0742 5.9531-1.4766 5.5742-2.9922 2.7656-7.0117-1.6875-2.4102-3.1719-4.9219-3.9844-7.7695-0.21094-0.73828-0.73437-1.1484-1.3047-1.5938-3.1719-2.4648-5.5-5.4609-5.6602-9.6719-0.078125-2.0469 0.76172-2.8203 2.7773-2.8711 2.293-0.054687 4.4961 0.4375 6.6797 1.0586 1.1211 0.31641 1.8633 0.14062 2.6016-0.90234 1.8672-2.6445 4.4883-4.2617 7.7422-5.0742m1.0039 6.2539c0.22656-0.058594 0.45312-0.12891 0.67969-0.17188 0.71875-0.14062 1.5078-0.33984 1.3945-1.2539-0.10938-0.91406-0.95703-0.89453-1.6641-0.89453-2.0469-0.007812-3.8828 1.3867-4.6367 3.5039-0.23828 0.67578-0.55078 1.4375 0.28516 1.8633 0.89062 0.45703 1.4141-0.17969 1.7461-0.91406 0.42578-0.93359 0.98047-1.7031 2.1953-2.1328z"></path>
  <path d="m90.004 79.898c0.125-1.5977-0.73828-2.1484-2.0391-2.2422-1.3594-0.089844-2.7266-0.11719-4.0898-0.20703-1.8672-0.11719-2.082-0.52734-1.2227-2.1172 1.5078-2.7852 3.4844-5.2617 5.2656-7.8672 0.32812-0.47656 0.67969-0.77344 1.2852-0.51953 5.6328 2.3516 9.9531 6.1016 9.6992 13.398-0.050782 1.6016-0.42969 3.1719-1.5117 4.4727-1.0117 1.2148-2.2695 1.9023-3.8438 1.6211-1.7148-0.30859-2.8281-1.4297-3.3945-3.0664-0.37109-1.1016-0.34766-2.2266-0.14844-3.4727z"></path>
  <path d="m97.441 2.0742c0.19922 0.85938-0.21094 1.3945-0.71094 1.8398-1.5156 1.3477-3.0547 2.6641-4.5977 3.9805-0.86328 0.73047-1.8125 0.93359-2.5977-0.046875-0.79297-0.98828-0.16406-1.7461 0.60547-2.4062 1.4688-1.2539 2.918-2.5312 4.4141-3.7578 1.1992-0.98047 1.8711-0.88281 2.8867 0.39062z"></path>
  <path d="m97.121 11.379c-1.4102 0.26562-2.7109 0.5-3.9961 0.76562-1.0898 0.22656-1.9648-0.074219-2.1562-1.2109-0.18359-1.0977 0.48828-1.7461 1.5859-1.9414 1.7109-0.3125 3.4258-0.61328 5.1289-0.96484 1.1211-0.23047 2.1016-0.0625 2.2969 1.1797 0.18359 1.1875-0.66797 1.7578-1.7695 1.9453-0.32813 0.054687-0.64844 0.13672-1.0898 0.22656z"></path>
 </g>
</svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="6.585504 14.167893 86.825908 86.825908" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path d="m91.684 43.48c-0.097656-0.31641-0.3125-0.58594-0.59766-0.75l-1.6055-0.92969c-0.078125-0.042969-0.14062-0.10547-0.19141-0.17578l-0.82031-1.2266c-0.042969-0.0625-0.085938-0.125-0.13281-0.1875v0.003906c-0.74609-0.96484-1.8516-1.5781-3.0625-1.707l-2.4219-0.32422-1.6445-0.19141-1.3164 0.003906c-0.25-0.4375-0.51172-0.86719-0.77734-1.293-0.44141-0.69531-0.91406-1.3828-1.4023-2.043l0.003906 0.003906c-0.089844-0.125-0.23828-0.19531-0.39062-0.19141-0.15234 0.003906-0.29297 0.078125-0.37891 0.20703-0.95703 1.375-1.4414 3.0273-1.3867 4.707 0.015625 0.30078 0.046875 0.60547 0.097656 0.90625l-1.0273 0.73438v-0.003906c-2.2695 1.7734-4.0469 4.0977-5.1641 6.75-0.09375 0.28516-0.38281 0.44922-0.67188 0.38672-12.461-2.7773-25.422-2.3594-37.676 1.2148-0.066407 0.019531-0.13281 0.027344-0.19922 0.019531-2.9688-0.19922-8.582-1.1914-12.836-5.5742-2.8594-2.9453-5.75-8.0039-5.6367-11.367 0-0.035156 0.007813-0.10938 0.019532-0.21484v-0.003906c0.20703-1.1328 0.13281-2.3008-0.21484-3.4023-0.48438-0.72656-1.4062-1.0273-2.2266-0.72656-0.86719 0.46875-1.418 1.3633-1.4453 2.3477-0.027344 0.14062-0.054687 0.26953-0.082031 0.38672-0.90625 3.8711 0.74609 8.6172 4.9062 14.109l0.003906-0.003907c3.2812 4.293 7.5586 7.7188 12.465 9.9844 0.28125 0.13281 0.40234 0.46484 0.28125 0.75-0.51562 1.1875-0.75 2.4766-0.67578 3.7695 0.10938 1.6367 0.69531 3.207 1.6875 4.5156 0.12891 0.16797 0.15234 0.39844 0.058594 0.59375l-3.2656 6.8438-0.84375 11.438 1.1641 2.0898 3.8242 0.16016c0.26563-0.14062 0.66406-0.43359 0.69922-0.74609 0-0.23828-0.09375-0.46875-0.26172-0.64062-0.375-0.40234-0.90234-0.63281-1.457-0.62891-0.30859-0.011719-0.55078-0.26172-0.55469-0.57031l-0.035156-4.3945c-0.003907-0.21094 0.11328-0.40625 0.29687-0.50781l7.0234-3.8555v-0.003906c-1.25-2.6289-2.2266-5.3828-2.9102-8.2148-0.074219-0.30859 0.11719-0.61719 0.42188-0.69141 0.30859-0.074219 0.61719 0.11328 0.69531 0.41797 2 8.3281 6.5664 15.812 13.059 21.395l4.6133 0.12891c0.10547-0.14844 0.16406-0.32422 0.16406-0.50781-0.035157-0.58203-1.0977-1.4648-2.9961-1.6016-0.15625-0.011719-0.29688-0.082031-0.39844-0.19922l-3.8672-4.5625c-0.17578-0.21094-0.17969-0.51953-0.007812-0.73438 2.1055-2.6016 3.2734-5.8359 3.3203-9.1797 0.003906-0.23828 0.15234-0.44922 0.37891-0.53125 2.8086-1.0156 5.7539-1.6094 8.7383-1.7617 3.6953-0.17578 7.3906 0.32422 10.906 1.4727 0.039062 0.007813 0.078124 0.019531 0.11328 0.035156 1.0586 0.34766 2.0977 0.75 3.1094 1.207 0.058594 0.023438 0.10938 0.058594 0.15234 0.10156l17.219 15.773 0.011718 0.011719c0.66406 0.74219 1.7734 0.88672 2.6055 0.33984 0.33594-0.33203 0.50781-0.79688 0.47656-1.2695-0.023438-0.67969-0.34766-1.3203-0.88672-1.7383-0.035157-0.027343-0.066407-0.0625-0.097657-0.097656l-9.4336-12.102c-0.03125-0.035156-0.054688-0.074219-0.070313-0.11719-0.58594-1.2266-0.81641-2.5977-0.66016-3.9492 0.3125-1.6992 1.1562-3.2578 2.4023-4.457 0.20312-0.23047 0.39453-0.44531 0.56641-0.65625 1.1797-1.4492 2.5703-4.7891 2.6172-9.4336 0.003906-0.13672 0.054687-0.26953 0.14844-0.375 0.007813-0.007812 0.011719-0.015624 0.019531-0.023437 0.65625-0.71094 1.4531-1.2812 2.3359-1.6797l2.8008-1.2617-0.003906 0.003906c1.0586-0.57031 1.8438-1.5352 2.1836-2.6875 0.11328-0.42188 0.15625-0.85547 0.13281-1.293-0.027344-0.48828-0.007813-0.98047 0.058594-1.4648 0.023437-0.1875 0.007812-0.37891-0.046875-0.55859z"></path><path d="m72.582 84.723c-0.30078-0.042968-0.51562-0.3125-0.49219-0.61719l0.75391-8.793-4.2461-3.8906c-0.66016-0.29688-1.332-0.56641-2.0117-0.8125l3.5234 16.211 4.6914 0.35156c0.59766-0.35938 0.66797-0.64062 0.67578-0.72266 0.039063-0.46484-0.89453-1.4414-2.8945-1.7266z"></path></svg>\n',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.012973 3.085342 93.828785 93.828785" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m95 52c-0.19141-0.96875-1.1328-1.6016-2.1016-1.4102l-4.6094 0.91016c-0.65625-2.6016-1.8789-5.0234-3.5898-7.0898 0.1875-7.8633-1.4844-15.656-4.8789-22.75-0.41016-0.79688-1.3477-1.1641-2.1914-0.85938-6.5312 2.3281-12.711 8.8984-16.16 13.109-3.8047-0.48438-7.6328-0.71875-11.469-0.71094-3.8242-0.015625-7.6445 0.21484-11.441 0.69141-3.4492-4.2109-9.6289-10.781-16.16-13.109-0.83984-0.3125-1.7812 0.058594-2.1875 0.85938-3.3945 7.0938-5.0664 14.887-4.8828 22.75-1.707 2.0664-2.9336 4.4883-3.5898 7.0898l-4.6094-0.91016c-0.94922-0.14844-1.8438 0.48047-2.0312 1.4219-0.18359 0.94531 0.40625 1.8633 1.3438 2.0859l4.7812 0.94141c0 0.41016-0.050781 0.82031-0.050781 1.25 0 1.3984 0.15234 2.793 0.44922 4.1602l-5.1797 1c-0.47656 0.046874-0.91016 0.27734-1.2148 0.64453-0.30078 0.36719-0.44531 0.83594-0.40234 1.3125 0.09375 0.98438 0.96875 1.707 1.957 1.6133 0.11328 0.011719 0.23047 0.011719 0.34766 0l5.6016-1.1094c3.1406 7.1992 12.211 15.438 37.27 15.438s34.129-8.2383 37.27-15.48l5.6016 1.1523c0.11719 0.011719 0.23438 0.011719 0.34766 0 0.91016-0.019531 1.6602-0.71484 1.75-1.6172 0.085938-0.90625-0.51953-1.7344-1.4102-1.9219l-5.1797-1c0.30078-1.3672 0.45312-2.7617 0.46094-4.1602v-1.25l4.7695-0.94141c0.96484-0.19922 1.5859-1.1445 1.3906-2.1094zm-65.352 5.5586c-0.32813 0.13672-0.69531 0.13672-1.0234 0-0.32812-0.13672-0.58984-0.39844-0.72656-0.73047-0.28125-0.67969 0.039062-1.4609 0.72266-1.75l7.8711-3.2695-7.8711-3.2812v0.003906c-0.36719-0.10547-0.67188-0.35938-0.83594-0.70312-0.16797-0.33984-0.18359-0.73828-0.039062-1.0898 0.14062-0.35156 0.42969-0.62891 0.78516-0.75781 0.35938-0.12891 0.75391-0.10156 1.0898 0.078125l10.84 4.5117c0.5 0.20703 0.82812 0.69531 0.82812 1.2383-0.011718 0.51953-0.32422 0.98438-0.80078 1.1914zm24.52 7.1211h0.003906c-1.6094 0.035156-3.1445-0.66406-4.1719-1.8984-1.0273 1.2344-2.5625 1.9336-4.1719 1.8984-2.6758 0.039062-4.9258-2.0078-5.1367-4.6797-0.074218-0.73828 0.46094-1.3945 1.1992-1.4688s1.3945 0.46094 1.4688 1.1992c0.082031 1.2969 1.1719 2.3008 2.4688 2.2695 1.3633-0.011719 2.5352-0.95312 2.8438-2.2812-0.058594-0.14062-0.089844-0.29297-0.09375-0.44922v-1.7695h-0.44141 0.003906c-0.49609 0.039062-0.98828-0.13281-1.3516-0.47266-0.36719-0.33984-0.57422-0.8125-0.57422-1.3125 0-0.49609 0.20703-0.97266 0.57422-1.3125 0.36328-0.33984 0.85547-0.50781 1.3516-0.47266h3.5703c0.49609-0.035157 0.98437 0.13281 1.3516 0.47266 0.36328 0.33984 0.57031 0.81641 0.57031 1.3125 0 0.5-0.20703 0.97266-0.57031 1.3125-0.36719 0.33984-0.85547 0.51172-1.3516 0.47266h-0.44922v1.7695 0.17969c0.023437 0.054687 0.042969 0.11328 0.058593 0.17188 0.28516 1.3555 1.4648 2.3398 2.8516 2.3789 1.293 0.023438 2.3789-0.96875 2.4688-2.2617 0.078125-0.73438 0.74219-1.2695 1.4805-1.1875 0.73438 0.078125 1.2695 0.74219 1.1875 1.4805-0.22266 2.6602-2.4688 4.6914-5.1367 4.6484zm17.211-9.6016c0.59766 0.24609 0.93359 0.875 0.80859 1.5078-0.12891 0.62891-0.68359 1.0781-1.3281 1.0742-0.17578 0-0.34766-0.035156-0.50781-0.10156l-10.84-4.5586c-0.50391-0.20312-0.83203-0.6875-0.83203-1.2305 0.003906-0.54297 0.32812-1.0312 0.83203-1.2383l10.84-4.5117c0.65625-0.1875 1.3516 0.15234 1.6094 0.78516 0.25391 0.63672-0.007813 1.3633-0.60938 1.6836l-7.8711 3.2812z"></path>
</svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="7.080664 7.117226 85.818599 85.818599" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path d="m91.148 26.148c-0.039063-0.17969-0.17188-0.71875-0.66016-1-2.4102-1.3906-18.059-4.4219-26.922-5.9883-16.09-2.8516-24.84-3.8594-26.031-3-2 1.4609-2.6406 12.219-2.8398 18.941-2.7812 0.64844-5.8594 1.9492-8.9297 4.3789-4.3008 3.3984-6.6719 10.031-5.6289 15.75 0.14062 0.78906 0.35156 1.5508 0.60938 2.2695-12.102 5.0586-12.039 6.6992-12.012 7.3203 0.03125 0.82031 0.070313 1.7617 21.699 10.699 0.21094 0.089844 21.02 8.6797 22.941 8.6719h0.019531c2.7305-0.10938 31.461-15.531 32.871-17.648 1.0703-1.6016 5.7695-36.488 4.8711-40.359zm-64.137 14.883c7.0195-5.5586 14.07-4.6719 16.578-4.1016-0.058594 0.12891-0.12109 0.26172-0.17969 0.37891-0.94922 0.71094-4.1094 3.4297-4.2305 8.5195-0.12109 4.8398 2.5508 6.7891 2.6719 6.8711 0.44922 0.32031 1.0586 0.21094 1.3789-0.23047 0.32031-0.44141 0.21875-1.0703-0.21875-1.3906-0.078125-0.058594-1.9219-1.4805-1.8281-5.1914 0.10938-4.7695 3.4297-6.9805 3.5703-7.0586 0.17188-0.10938 0.30078-0.26172 0.37891-0.44141 0.82813-1.8711 2.0391-3.7188 2.5195-3.8789 0.5-0.011718 1.9414 1.5508 2.9102 3.1602 0.17969 0.30078 0.5 0.48047 0.83984 0.48828 1.2109 0.019531 5.6719 0.12109 5.6719 0.12109 0.33984 0 0.67188-0.16016 0.85938-0.44922 0.94141-1.4414 2.3203-2.7695 2.8203-2.6484 0.53125 0.19141 1.4414 2.3906 1.8711 4.5312 0.050781 0.23828 0.19141 0.44922 0.37891 0.60156 0.10938 0.089844 2.7812 2.1719 2.5117 6.8594-0.19922 3.4688-2.5781 5.3086-2.6797 5.3906-0.44141 0.32812-0.53125 0.94922-0.19922 1.3984 0.19922 0.28125 0.53125 0.42187 0.85156 0.39844 0.14844 0 0.30859-0.058594 0.44922-0.14062 0.42188 1.25 0.75 3.6914-1.4609 6.3789-5.4688 6.6797-17.539 7.8398-32.301 3.1016-5.6602-1.8203-7.5117-5.8008-8.0508-8.8281-0.91016-5.0391 1.1484-10.852 4.8984-13.82zm39.09 13.641c-0.16016-0.89062-0.44141-1.5781-0.64062-1.9883 0.89844-1.1484 1.9102-2.9609 2.0508-5.4219 0.28125-4.8594-2.1211-7.5117-3-8.3203-0.39844-1.8281-1.4219-5.3516-3.3398-5.75-1.8516-0.37891-3.7188 1.8398-4.5898 3.0508-1.0508-0.019532-3.3516-0.078126-4.6016-0.10156-0.94922-1.4805-2.8008-3.9102-4.6211-3.6406-1.0195 0.14844-2.0117 1.3398-2.7812 2.5898-0.83984-0.21875-2.4609-0.55859-4.5781-0.58984 0.25-5.6484 0.71875-11.691 1.1719-13.379 4.6797 0.41016 39.328 7.0117 44.301 8.4297-0.10938 3.6797-2.8984 24.738-3.7305 29.328-2.9492-0.53906-13.57-3.4609-15.621-4.2188zm18.469 10.77c-2.0391 2.0703-28.68 16.34-31.16 16.711-2.1289-0.23828-37.352-14.309-42.359-17.551 1.3984-1.1484 6.1719-3.4805 10.52-5.3008 1.6211 2.9414 4.3398 5.1211 7.9688 6.2812 5.5195 1.7695 10.699 2.7305 15.359 2.9102 0.050781 0.03125 0.078124 0.070312 0.14062 0.089843 2.5586 0.98828 15.441 5.9297 17.512 5.8398 0.71094-0.03125 13.039-6.1016 13.93-7.6211 0.28125-0.46875 0.070312-1.1289-0.39844-1.4102-0.62891-0.37109-4.6289-1.6016-6.9609-2.3008-2.3789-0.71094-3.9219-1.1797-4.9609-1.4492 0.35156-0.44922 0.64062-0.89062 0.89062-1.3203 4.5391 1.2891 15.469 4.4492 16.891 5.1211 0.14844 0.070313 0.30859 0.10156 0.46875 0.089844 0.35938-0.011719 0.69922-0.21875 0.85938-0.57031 0.23047-0.5 0.019531-1.1016-0.48047-1.3281-1.7109-0.80859-13.762-4.2617-16.922-5.1602 0.17969-0.58984 0.28906-1.1602 0.32812-1.6914 3.9688 1.3008 14.66 4.2617 16.352 4.1797 0.050781 0 0.089844 0 0.12109-0.011719 0.28125-0.058594 0.57031-0.26172 0.71875-0.51172 0.35156-0.62109 2.0391-13.309 2.3789-15.84 2.0703-15.648 1.7812-15.98 1.3711-16.422-0.23047-0.25-0.69922-0.76953-23.34-5.1289-22.77-4.3789-23.359-4.0195-23.789-3.7617-0.5 0.30078-1.4102 0.87109-2.0195 15.281-0.41016 0.03125-0.83984 0.070313-1.2812 0.12891 0.25-7.4609 1.0508-15.68 1.9609-16.891 3.7305-0.71094 45.559 6.6992 50.57 8.9297 0.75 3.8281-3.8906 36.031-4.6719 38.699z"></path><path d="m51.398 46.449c0.60937-0.03125 1.0898-0.53906 1.0703-1.1602-0.019531-0.62109-0.53906-1.0898-1.1602-1.0703s-1.0898 0.53906-1.0703 1.1602 0.53906 1.0898 1.1602 1.0703z"></path><path d="m57.859 46.77c0.60938-0.03125 1.0898-0.53906 1.0703-1.1602-0.019532-0.62109-0.53906-1.0898-1.1602-1.0703-0.62109 0.019532-1.0898 0.53906-1.0703 1.1602 0.019531 0.62109 0.53906 1.0898 1.1602 1.0703z"></path><path d="m17.422 37.039c0.21094 0.26953 0.51953 0.39844 0.82812 0.39063 0.19922 0 0.39844-0.078126 0.57031-0.21094 0.44141-0.33984 0.51172-0.96875 0.17969-1.3984-0.51953-0.67187-1.3398-1.4883-1.3711-1.5312-0.39062-0.39062-1.0195-0.39062-1.4102 0-0.39062 0.39063-0.39062 1.0195 0 1.4102 0 0 0.76953 0.76953 1.2109 1.3516z"></path><path d="m23.59 33.238c0.16016 0.39844 0.55859 0.64062 0.96875 0.62109 0.10938 0 0.23047-0.03125 0.33984-0.070313 0.51172-0.21094 0.75-0.78906 0.55078-1.3086-0.28906-0.69922-0.55078-1.7383-0.55078-1.75-0.12891-0.53906-0.67969-0.85938-1.2109-0.73047-0.53906 0.12891-0.85938 0.67969-0.73047 1.2109 0.011719 0.050781 0.30078 1.1914 0.64062 2.0195z"></path></svg>\n',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.198359 3.199949 93.6078 93.6078" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m83.645 9.4961-12.902 14.051v-18.547l-8.8555 9.6758c-0.46484-0.066406-0.9375-0.10547-1.4102-0.10938h-11.98c-0.47266 0.003906-0.94531 0.042969-1.4141 0.10938l-8.8516-9.6758v19.836c0.015625 4.6172 3.1055 8.6602 7.5586 9.8906l-14.992 5.3477c-2.2461 0.69922-3.8672 2.6602-4.1367 4.9961-0.14062 2.2383 1.0547 4.3477 3.043 5.3828l8.1523 4.5977c-0.20703 0.12109-0.40234 0.25781-0.61328 0.37109-0.89063 0.48047-1.6562 1.1641-2.2344 1.9961-4.9336-1.875-9.2461-5.0977-12.445-9.2969-3.1992-4.1992-5.1562-9.2148-5.6562-14.469-0.046875-0.56641-0.32031-1.0859-0.75391-1.4492s-0.99609-0.53906-1.5586-0.48828c-0.56641 0.050781-1.0859 0.32422-1.4492 0.75781s-0.53906 0.99609-0.48438 1.5586c0.57422 6.1133 2.8711 11.941 6.6172 16.805 3.75 4.8672 8.7969 8.5742 14.559 10.691 0.003906 0.074218 0.003906 0.14844 0.011718 0.22266l-0.96875 1.5312v0.003906c-5.5938 8.8516-8.5625 19.109-8.5586 29.582-0.003906 0.56641 0.21875 1.1094 0.62109 1.5117 0.39844 0.40234 0.94531 0.62891 1.5117 0.62891s1.1094-0.22656 1.5117-0.62891c0.39844-0.40234 0.625-0.94531 0.62109-1.5117 0-9.4375 2.6133-18.691 7.5508-26.73 1.9258 1.6484 4.6367 2.0195 6.9297 0.94141l10.066 26.543c0.41797 1.1016 1.6484 1.6562 2.75 1.2383 0.52734-0.19922 0.95703-0.60156 1.1875-1.1172 0.23438-0.51563 0.25-1.1055 0.050782-1.6328l-10.344-27.281c5.9375-4.1797 10.289-10.246 12.348-17.211 0.62891-2.1094 1.0469-4.2734 1.2422-6.4609l26.422-28.773v-0.003906c0.79688-0.86719 0.73828-2.2148-0.12891-3.0117-0.86719-0.79688-2.2188-0.73828-3.0156 0.12891zm-38.047 17.051h-1.8945c-0.89844 0-1.625-0.73047-1.625-1.6289 0-0.89844 0.72656-1.6289 1.625-1.6328h1.8945zm1.0195 17.336 0.003906 0.003907c-0.94531 3.1719-2.6875 6.0469-5.0586 8.3516l-9.7656-5.5039c-0.52734-0.21875-0.875-0.73047-0.88672-1.3008 0.14453-0.66406 0.65625-1.1875 1.3203-1.3398l15.188-5.418c-0.027344 1.7656-0.29688 3.5156-0.79688 5.2109zm4.1367-17.336h-1.8945v-3.2617h1.8984c0.42969 0 0.84766 0.17188 1.1523 0.47656 0.30859 0.30469 0.48047 0.72266 0.48047 1.1562 0 0.43359-0.17188 0.84766-0.48047 1.1523-0.30469 0.30859-0.72266 0.48047-1.1523 0.47656zm9.3555 0h-1.8945c-0.89844 0-1.625-0.73047-1.625-1.6289 0-0.89844 0.72656-1.6289 1.625-1.6328h1.8945zm5.1562 0h-1.8906v-3.2617h1.8945c0.89844 0.003906 1.625 0.73438 1.625 1.6328 0 0.89844-0.72656 1.6289-1.625 1.6289z"></path>
</svg>
`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="10.998886 10.996541 78.006721 78.006721" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m30.621 85.891c-0.66016-0.12109-1.6875-0.74609-3.6562-2.2266-5.0234-3.7773-5.9688-5.8125-5.3828-11.547 0.73047-7.1562 0.62891-8.1406-1.293-12.035-2.9648-6.0156-3.25-8.3789-1.5742-12.992 1.1172-3.0742 0.99219-3.5039-2.2109-7.5156-8.6445-10.84-2.4844-25.496 10.727-25.52 4.4219-0.007813 6.9766 4.3672 3.8164 6.5312-0.54297 0.37109-0.96094 0.45703-4.2891 0.88672-6.625 0.85156-9.4648 7.9102-5.0391 12.523 1.5898 1.6562 2.625 2.0742 6.6836 2.6953 6.4844 0.98828 7.7148 1.2773 10.621 2.4961 4.082 1.7109 6.7695 3.7773 9.6914 7.4531 5.3359 6.7109 5.1641 6.6953 11.543 1.0117 4.4219-3.9414 4.5-3.9961 5.3164-4 1.2266 0 1.4688 0.54297 1.3984 3.1211-0.03125 1.1211-0.03125 1.1211 2.1016-0.98828 2.2617-2.2344 2.7266-2.5156 3.4141-2.0703 0.82031 0.53906 0.87109 0.76562 0.92578 4.1836 0.058594 3.6367 0.066407 3.6641 1.3945 4.9531 1.207 1.168 1.4727 1.7852 1.5859 3.6445 0.10156 1.6523 0.16797 1.7852 0.97266 1.9648 3.793 0.85156 1.2812 6.8984-3.6641 8.8164-0.45703 0.17578-0.36719 0.23828 6.9453 4.7188 4.6719 2.8633 5.9102 3.8047 6.4727 4.9297 1.5508 3.0742-1.8672 5.2695-5.3633 3.4414-1.6562-0.86719-1.6758-0.86719-1.0508-0.15625 1.9102 2.1758 1.5312 4.2422-0.93359 5.1133-1.8906 0.66797-1.9727 0.63281-12.328-5.2031-4.5-2.5352-5.4805-2.9609-8.125-3.5273-0.41406-0.089844-2.7344-0.22656-5.1523-0.30469-7.957-0.25781-9.4102-0.73828-14.707-4.8516-4.1836-3.2461-6.5703-0.24609-2.6367 3.3164 2.1133 1.9141 2.4062 3.1992 1.0547 4.625-1.5078 1.5938-3.1914 1.2812-5.9844-1.1133-1.7969-1.5391-2.2969-1.8633-2.6719-1.7461-0.83984 0.26562-0.19141 1.2383 1.8633 2.7695 3.6133 2.6992 4.0508 3.7773 2.3047 5.6875-0.73047 0.80078-1.6719 1.1094-2.7578 0.91016z"></path>
</svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="13.599867 13.607556 72.793184 72.793184" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path d="m19.656 82.762c-3.043-0.35938-4.6484-1.8789-4.6562-4.4141-0.003906-1.3125 0.16797-1.8164 1.082-3.1562 1.418-2.0859 1.6367-3.4531 1.6523-10.371 0.015625-5.3906-0.32422-9.8008-1.0781-14.066-1.418-8.0156 0.30078-16.625 4.4961-22.547 4.4102-6.2227 15.195-13.074 16.559-10.523 0.30859 0.57812 0.0625 1.8203-0.77734 3.9062-0.44922 1.1133-0.77734 2.0625-0.73047 2.1094s0.86719-0.26953 1.8203-0.70312c2.1289-0.96875 3.3398-1.3906 5.7031-2 1.8281-0.46875 1.8281-0.46875 2.1133-0.11719 0.49609 0.61328-0.015625 1.7969-2.2461 5.1875-1.6602 2.5234-1.6133 2.3516-1.0039 3.875 0.51562 1.2891 0.57031 2.0469 0.21484 3.0234-0.3125 0.86328-0.20313 2.1406 0.3125 3.5742 0.63281 1.7695 0.38672 2.793-1.2227 5.0469-1.5547 2.1797-2.3359 2.5508-4.5273 2.1523-1.5703-0.28906-2.0156-0.16016-2.2109 0.625-0.26562 1.0547 0.66406 1.8047 4.1484 3.3359 7.6914 3.3828 11.402 7.168 12.719 12.984 0.75391 3.3203-0.11719 9.7891-1.6523 12.27-0.32031 0.51953-0.32031 0.51953 0.49609 0.19531 1.7852-0.70313 2.957-1.4414 4.1094-2.5898 2.8281-2.8164 3.6602-5.2461 3.6602-10.676 0-6.75 3.9336-11.676 10.941-13.707 3.7344-1.082 8.5508-0.22266 12.176 2.168 2.9844 1.9688 4.207 5.9023 2.3789 7.6406-1.5508 1.4688-3.5391 1.5586-6.1094 0.26562-4.1914-2.1055-6.9688-2.0352-9.2695 0.23047-1.668 1.6445-2.1094 3.1953-2.2266 7.8867-0.082032 3.2266-0.13281 3.5742-0.87109 5.8867-1.5039 4.7109-4.8516 8.918-8.6367 10.852-2.8086 1.4375-7.4531 1.9805-11.832 1.3789-1.3047-0.17969-3.1602-0.39062-4.1289-0.47266s-2.3789-0.20703-3.1328-0.27344c-1.5039-0.13281-3.5117 0.015625-8.9883 0.66016-3.8047 0.44922-7.3867 0.58984-9.2773 0.36719z"></path></svg>\n',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.199886 3.199811 93.601396 93.601396" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m90.41 28.781c-2.5352 0-4.5898 2.0547-4.5898 4.5898 0 6.5-5.1133 12.121-12.527 14.848-6.4297-2.9062-13.328-4.6445-20.367-5.1328 0.019531-0.29297 0.058594-0.57813 0.058594-0.875h-0.003906c-0.007813-2.4727-0.63672-4.9023-1.8242-7.0742 1.6445-6.5391-0.17969-13.336-4.4648-18.844h0.003906c-4.5 1.4922-8.4336 4.3281-11.27 8.125-4.1953-0.91016-8.5391-0.91016-12.734 0-2.8359-3.7969-6.7656-6.6328-11.266-8.125-4.2852 5.5078-6.1055 12.305-4.4648 18.844-1.1875 2.1719-1.8125 4.6016-1.8242 7.0742 0 5.1094 2.6875 9.7383 7.0312 13.082-1.9922 1.5312-3.8906 3.1797-5.6797 4.9453-0.94141 0.89062-1.4805 2.1328-1.4883 3.4297-0.007812 1.3008 0.51562 2.5469 1.4492 3.4492 1.8125 1.6289 4.5859 1.5547 6.3086-0.16797 0.81641-0.81641 1.6523-1.5977 2.5117-2.3477h0.003907c2.5-2.2148 6.293-2.1055 8.6641 0.24609v0.003906c1.2344 1.2148 1.9102 2.8867 1.8633 4.6211-0.042969 1.7305-0.80078 3.3672-2.0977 4.5195-0.65234 0.56641-1.2852 1.1562-1.9062 1.7695l0.003906-0.003907c-1.6094 1.5508-1.8984 4.0195-0.69531 5.9023 0.76172 1.1445 2 1.8867 3.3672 2.0234 1.3711 0.13672 2.7305-0.34766 3.7031-1.3203 5.4219-5.4219 12.773-8.4648 20.438-8.4648 7.6641 0 15.016 3.043 20.438 8.4648 1.7227 1.7227 4.4922 1.8008 6.3047 0.17578 0.93359-0.89844 1.4609-2.1406 1.457-3.4375-0.003906-1.293-0.53516-2.5312-1.4688-3.4258-0.58984-0.58203-1.1992-1.1445-1.8203-1.6836-1.293-1.1523-2.0547-2.7891-2.0977-4.5195-0.046875-1.7344 0.62891-3.4062 1.8633-4.6211 2.3711-2.3555 6.1641-2.4648 8.6641-0.25 0.85938 0.75 1.6953 1.5312 2.5117 2.3477 0.97656 0.97266 2.3398 1.457 3.7109 1.3203 1.375-0.14062 2.6133-0.88672 3.3711-2.0391 1.1992-1.8867 0.89844-4.3594-0.71875-5.9062-2.4727-2.4492-5.1523-4.6836-8.0078-6.6719 7.4102-4.7266 12.18-12.055 12.18-20.281 0-2.5352-2.0547-4.5898-4.5898-4.5898zm-73.664 16.25c-2.9883-0.44531-5.2148-2.1719-5.2148-4.2383 0-2.0664 2.2305-3.793 5.2148-4.2383-0.27344 2.8203-0.27344 5.6602 0 8.4766zm3.0312 0h0.003906c0.13672-1.4062 0.20703-2.8242 0.20312-4.2383 0.003906-1.4141-0.066406-2.8281-0.20312-4.2383 2.9883 0.44531 5.2188 2.1719 5.2188 4.2383-0.003906 2.0664-2.2344 3.793-5.2188 4.2383zm18.559 0c-2.9883-0.44531-5.2148-2.1719-5.2148-4.2383 0-2.0664 2.2305-3.793 5.2148-4.2383h0.003906c-0.27344 2.8203-0.27344 5.6602 0 8.4766zm3.0312 0h0.003906c0.14062-1.4062 0.21094-2.8242 0.20703-4.2383 0.003906-1.4141-0.066406-2.8281-0.20703-4.2383 2.9883 0.44531 5.2148 2.1719 5.2148 4.2383 0.003906 2.0664-2.2266 3.793-5.2148 4.2383z"></path>
</svg>
`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.199052 3.199986 93.60073 93.60073" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m88.062 5c-0.97656 0-1.8555 0.59375-2.2188 1.4961-1.0547 2.6172-1.8594 5.3242-2.4102 8.0859h-32.719c-0.55078-2.7617-1.3555-5.4688-2.4102-8.0859-0.36328-0.90234-1.2422-1.4961-2.2188-1.4961-0.97656 0-1.8555 0.59375-2.2227 1.4961-4.9102 11.883-4.8359 25.246 0.20703 37.074l-1.4141 2.3711c-6.9102 11.594-11.16 24.578-12.438 38.016-2.0703-3.5664-3.7695-9.5195-1.4648-18.672 2.5977-10.32-0.87109-15.16-3.168-17.125h-0.003907c-3.0703-2.5352-7.3125-3.0977-10.938-1.457-4.7734 2.0273-7.957 6.9297-8.3047 12.793-0.058594 0.95312 0.26562 1.8867 0.89844 2.6016 0.63281 0.71484 1.5234 1.1484 2.4727 1.2031 0.95312 0.058594 1.8906-0.26562 2.6016-0.90234 0.71484-0.63281 1.1445-1.5234 1.1992-2.4766 0.22266-3.7266 2.1797-5.8555 3.9414-6.6016 1.1172-0.55859 2.4531-0.44141 3.457 0.30078 1.7344 1.4844 2.0625 5.1875 0.87109 9.9102-5.5586 22.082 7.9688 30.594 8.5469 30.945 0.55859 0.35547 1.207 0.53906 1.8672 0.52344h54.938c1.3203 0 2.3945-1.0742 2.3945-2.3945v-48.355c2.7812-6.2148 4.1914-12.953 4.1406-19.762 0.027343-6.1562-1.1211-12.266-3.3828-17.992-0.36719-0.90234-1.2461-1.4961-2.2227-1.4961zm-33.227 32.137c-2.8789 0-5.4727-1.7344-6.5742-4.3945-1.1016-2.6562-0.49609-5.7188 1.543-7.7578 2.0352-2.0352 5.0977-2.6445 7.7578-1.543 2.6602 1.1055 4.3945 3.6992 4.3945 6.5781 0 1.8867-0.75 3.6992-2.0859 5.0352-1.3359 1.332-3.1445 2.082-5.0352 2.082zm24.473 0h0.003906c-2.8789 0-5.4766-1.7344-6.5781-4.3945-1.1016-2.6602-0.49219-5.7188 1.543-7.7578 2.0352-2.0352 5.0977-2.6445 7.7578-1.543 2.6602 1.1055 4.3945 3.6992 4.3945 6.5781 0 1.8867-0.75 3.6992-2.0859 5.0352-1.332 1.332-3.1445 2.082-5.0312 2.082z"></path>
 <path d="m79.312 25.797c-1.7109 0-3.25 1.0273-3.9062 2.6055-0.65234 1.5781-0.28906 3.3984 0.91797 4.6055 1.207 1.207 3.0234 1.5703 4.6055 0.91406 1.5781-0.65234 2.6055-2.1914 2.6055-3.9023 0-1.1211-0.44531-2.1953-1.2383-2.9883-0.78906-0.79297-1.8633-1.2344-2.9844-1.2344z"></path>
 <path d="m54.836 25.797c-1.707 0-3.25 1.0273-3.9023 2.6055s-0.29297 3.3984 0.91406 4.6055c1.2109 1.207 3.0273 1.5703 4.6055 0.91406 1.5781-0.65234 2.6094-2.1914 2.6094-3.9023 0-1.1211-0.44531-2.1953-1.2383-2.9883s-1.8672-1.2344-2.9883-1.2344z"></path>
</svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="5.281835 5.26087 89.450799 89.450799" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path d="m84.609 8.5508c-1.1211-1.3711-2.8281-1.9219-4.1406-1.3398-0.62109 0.26953-2 1.2109-1.5703 3.9883 0.14062 0.87109 0.53125 1.8203 0.98047 2.9102 1.5117 3.6484 3.9805 9.6484 0.33984 21.488-2.4297-3.0586-8.7109-9.0508-20.391-8.75-9.6211 0.25-13.602 4.3086-15.52 6.2617-0.14844 0.14844-0.32031 0.32031-0.46094 0.46094-0.03125-0.058593-0.070312-0.12109-0.10156-0.17969-0.23828-0.42969-0.53906-0.96875-1-1.5312-0.91016-1.0898-2.1406-1.9688-2.7305-2.3594-0.69141-2.3984-1.7891-5.1484-3.2695-5.4609-1.5117-0.30859-3.3516 1.7617-4.7305 3.7305-1.25 0.078125-4.4219 0.46875-7.2812 2.3711-2.1094-0.60938-5.3281-1.2383-6.3594 0.17188-0.60938 0.82812-0.070312 4.2617 1.0898 6.1992-0.25 1.1484-0.67969 4.1797 0.67969 7.4492-2.8398 0.60937-7.4297 0.82031-8.3594 0.76172-0.03125 0-0.050781-0.011718-0.078125-0.019531-0.55078-0.089844-1.0586 0.26953-1.1602 0.80859-0.070313 0.39062 0.10156 0.78125 0.42188 1 0.21094 0.14062 0.89062 0.21094 1.8281 0.21094 2.2109 0 5.8594-0.35938 8.2891-0.96094 0.19141 0.30859 0.39844 0.60938 0.62891 0.91016-1.7305 0.85156-3.9688 1.8281-5.2617 1.9492-0.55078 0.050781-0.96094 0.53125-0.91016 1.0781 0.050781 0.51953 0.48047 0.91016 1 0.91016h0.089843c1.8398-0.16016 4.6914-1.4805 6.4609-2.3906 1.0781 1.0508 2.4492 2.0508 4.1719 2.9414 0.26172 2.2188 1.6406 10.219 8.3008 17.16 6.7188 7.0117 8.7812 16.5 8.7812 18.191-0.039062 0.039062-0.078125 0.089843-0.12891 0.14062-0.64062 0.67969-1.8281 1.9414-1.3203 4.1992 0.23828 1.0898 1.1484 1.8398 2.5 2.0703 0.28906 0.050781 0.60156 0.070313 0.92187 0.070313 1.8398 0 4.0195-0.80078 4.9297-2.2812 0.87891-1.4297 1.2305-2.8281 1.3789-3.6484 0.94141-0.39844 2.0703-1.3203 2.1914-3.1016 0.058594-0.83984-0.37109-2.1094-1.1914-4.4805-1.3516-3.8984-3.3984-9.7891-2.3086-13.828 0.98047-3.6484 4.1719-4.4219 6.6797-4.4297 1.0898 0 3.1289 0.23047 4.6406 1.75 1.3398 1.3594 2 3.4805 1.9609 6.3008-0.070312 5.0703-2.6797 10.172-3.6289 10.488-1.2188 0.21875-2.1211 1.3398-2.2305 2.7695-0.10938 1.3594 0.53906 2.5 1.6484 2.8906 0.12109 0.039063 0.23828 0.078125 0.35938 0.12109-0.28125 0.30859-0.51953 0.67969-0.66016 1.0898-0.21094 0.58984-0.32031 1.5195 0.35938 2.6211 0.80078 1.2891 2 1.9883 3.4609 1.9297 2.1289-0.070313 4.5-1.8008 5.7695-4.1992 0.30859-0.58984 1.0898-1.7188 2.0586-3.1484 5.1797-7.5508 17.262-25.16 13.93-40.141 1.1211-2.8203 8.5898-22.93-1.0391-35.172zm-46.961 29.277c-0.23828 1.3398-1.5195 2.2383-2.8594 2.0117-0.64844-0.10938-1.2188-0.46875-1.6016-1.0117-0.37891-0.53906-0.51953-1.1992-0.41016-1.8516 0.10938-0.64844 0.46875-1.2188 1.0195-1.6016 0.42188-0.28906 0.91016-0.44922 1.4102-0.44922 0.14062 0 0.28906 0.011719 0.42969 0.039063 1.3398 0.23828 2.2383 1.5195 2.0117 2.8594zm-10.547 0.023437c0.64844 0.10938 1.2188 0.46875 1.6016 1.0117 0.37891 0.53906 0.51953 1.1992 0.41016 1.8516-0.10938 0.64844-0.46875 1.2188-1.0117 1.6016-0.53906 0.37891-1.1992 0.51953-1.8516 0.41016-0.64844-0.10937-1.2188-0.46875-1.6016-1.0117-0.37891-0.53906-0.51953-1.1992-0.41016-1.8516 0.10938-0.64844 0.46875-1.2188 1.0195-1.6016 0.42188-0.28906 0.91016-0.44922 1.4102-0.44922 0.14062 0 0.28906 0.011719 0.42969 0.039062z"></path><path d="m26.48 41.41c0.070312 0.011719 0.12891 0.019532 0.19922 0.019532 0.55078 0 1.0312-0.39063 1.1289-0.94922 0.050781-0.30078-0.019532-0.60938-0.19141-0.85938-0.17969-0.25-0.44141-0.42188-0.73828-0.46875-0.30078-0.050782-0.60938 0.011718-0.85938 0.19141s-0.42188 0.44141-0.46875 0.73828c-0.050781 0.30078 0.011719 0.60938 0.19141 0.85938 0.17969 0.25 0.44141 0.42188 0.73828 0.46875z"></path><path d="m35.422 36.27c-0.30078-0.050781-0.60938 0.011719-0.85938 0.19141-0.25 0.17969-0.42188 0.44141-0.46875 0.73828-0.050781 0.30078 0.011719 0.60938 0.19141 0.85938 0.17969 0.25 0.44141 0.42188 0.73828 0.46875 0.070312 0.011718 0.12891 0.019531 0.19922 0.019531 0.23047 0 0.46094-0.070313 0.66016-0.21094 0.25-0.17969 0.42188-0.44141 0.46875-0.73828 0.050782-0.30078-0.019531-0.60938-0.19141-0.85938-0.17969-0.25-0.44141-0.42188-0.73828-0.46875z"></path></svg>\n',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.201802 3.201758 93.598675 93.598675" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m15.949 41.211c0.11328 5.2344 2.4688 17.754 22.164 19.176-1.6875 4.7891-2.6523 9.9023-1.8086 14.527-3.5312 0.10938-7.7109 0.93359-9.6992 3.9336-2.082 3.1445-0.80469 7.707 0.76953 11.188-5.3398 0.074219-4.2852 4.9648-4.2852 4.9648h10.43c0.49609 0 0.95703-0.24609 1.2344-0.65234 0.28125-0.40625 0.34375-0.92188 0.17188-1.3828-1.0352-2.8086-2.3008-7.6484 0.79688-8.6719h-0.003906c2.1875-0.5 4.457-0.53125 6.6523-0.089844 0.6875 0.10156 1.3789 0.20312 2.0703 0.27734l12.461 1.3164c2.7578 0.29688 5.3984 1.2734 7.6836 2.8477 5.0586 3.4727 9.6992 6.3555 11.16 6.3555h8.043s0.57031-5.2031-6.6562-5.0078c0 0-2.7305-3.7148-6.1367-8.0742 3.7852-0.14453 7.418-1.5273 10.348-3.9297 8.2656-7.1289 4.625-17.785 1.4688-22.562-0.70703-1.1289-2.125-1.5781-3.3516-1.0586-0.69922 0.32031-1.2188 0.92969-1.4258 1.668-0.20703 0.73828-0.078125 1.5312 0.35156 2.168 0.26953 0.39844 6.5039 9.8203-0.45703 15.828-2.293 1.8125-5.1445 2.7812-8.0664 2.7422 0.28125-0.61719 0.44141-1.2773 0.47266-1.9531 4.1133-1.125 9.3789-3.6875 7.6016-9.3125-2.8125-8.8867-16.59-12.547-16.613-12.551v-0.011719c9.3047-1.7812 15.848-6.5039 15.848-15.508v-0.003906c-0.003906-2.9336-0.69922-5.8242-2.0312-8.4375-0.625-8.6953-2.3594-23.828-6.8477-23.992-4.8008-0.17578-8.8711 7.6992-10.535 11.457v-0.003907c-4.1758-0.87891-8.4883-0.87891-12.664 0-1.6641-3.7539-5.7305-11.629-10.535-11.453-4.4883 0.16406-6.2188 15.297-6.8477 23.992-1.3281 2.6133-2.0273 5.5039-2.0312 8.4375 0 6.5508 3.4688 10.832 8.9375 13.367-5.6484-0.78125-11.98-3.1445-12.691-9.7148h0.003907c1.3711-0.98047 2.1875-2.5664 2.1914-4.2539 0.003906-0.62109-0.125-1.2344-0.375-1.8008l2.4258-5.3828c0.4375-0.99609 0.097656-2.1641-0.80469-2.7734-0.51172-0.29688-1.1289-0.36328-1.6914-0.18359-0.5625 0.17969-1.0234 0.59375-1.2695 1.1328l-1.1445 2.543-0.30859-2.957c-0.089844-1.0977-0.99219-1.9531-2.0938-1.9883-0.58984 0-1.1562 0.25-1.5508 0.69141-0.39453 0.44141-0.58594 1.0273-0.52734 1.6172l0.51172 4.8945h0.003906c-2.125 0.25391-3.7188 2.0664-3.6953 4.207 0 1.7617 0.88281 3.4023 2.3477 4.3789zm54.273 25.113c0.45312 1.8203-2.1133 2.9258-4.1016 3.5h0.003906c-0.77734-2.2812-1.7422-4.4883-2.8867-6.6055 3.2461 0.63281 6.6172 1.6367 6.9844 3.1055zm-7.5391-38.812c4.0312 0 7.2969 4.1094 7.2969 9.1797 0 5.0703-3.2656 9.1797-7.2969 9.1797s-7.2969-4.1094-7.2969-9.1797c-0.003907-5.0703 3.2656-9.1797 7.2969-9.1797zm-13.551 15.109c0-0.86328 1.0273-0.83984 2.293-0.83984s2.293-0.019531 2.293 0.83984c0 0.63672-1.2461 1.1836-1.9023 1.4258v1.7734c0.22656 0.81641 0.93359 1.4023 1.7773 1.4648 1.2188-0.16797 2.0859-1.2773 1.957-2.5 0-0.21484 0.17578-0.39062 0.39062-0.39062 0.21875 0 0.39062 0.17578 0.39453 0.39062 0.13281 1.6562-1.0859 3.1172-2.7422 3.2852-0.89062-0.023437-1.7109-0.50391-2.168-1.2695-0.45703 0.76562-1.2734 1.2461-2.168 1.2695-1.6562-0.16797-2.875-1.6289-2.7383-3.2852-0.003906-0.10547 0.039063-0.20703 0.11328-0.28125 0.074219-0.070312 0.17188-0.11328 0.27734-0.11328 0.10547 0 0.20312 0.042969 0.27734 0.11328 0.074219 0.074219 0.11328 0.17578 0.11328 0.28125-0.12891 1.2227 0.73828 2.332 1.957 2.5 0.84375-0.0625 1.5547-0.64844 1.7773-1.4648v-1.7734c-0.65625-0.24219-1.9023-0.78906-1.9023-1.4258zm-16.262-5.9297c0-5.0703 3.2656-9.1797 7.2969-9.1797s7.2969 4.1094 7.2969 9.1797c0 5.0703-3.2656 9.1797-7.2969 9.1797-4.0273 0-7.2969-4.1094-7.2969-9.1797z"></path>
 <path d="m45.633 36.691c0 3.2656-2.1055 5.9141-4.6992 5.9141-2.5977 0-4.7031-2.6484-4.7031-5.9141s2.1055-5.9141 4.7031-5.9141c2.5938 0 4.6992 2.6484 4.6992 5.9141z"></path>
 <path d="m66.621 36.691c0 3.2656-2.1055 5.9141-4.6992 5.9141-2.5977 0-4.7031-2.6484-4.7031-5.9141s2.1055-5.9141 4.7031-5.9141c2.5938 0 4.6992 2.6484 4.6992 5.9141z"></path>
</svg>
`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.199109 3.199908 93.6 93.6" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m79.48 7.3594c-8.3945-0.30469-15.504 13.457-18.414 20.023h0.003906c-7.3008-1.5391-14.84-1.5391-22.141 0-2.9062-6.5625-10.016-20.328-18.41-20.023-7.8438 0.28516-10.875 26.734-11.969 41.938-2.3281 4.5703-3.543 9.6211-3.5508 14.75 0 20.887 20.148 28.598 45 28.598s45-7.7109 45-28.598c-0.007812-5.1289-1.2227-10.18-3.5508-14.75-1.0938-15.203-4.125-41.652-11.969-41.938zm-51.539 69.723c-8.6328 0-15.633-7.8633-15.633-17.562s7-17.562 15.633-17.562c8.6328 0 15.633 7.8633 15.633 17.562s-7 17.562-15.633 17.562zm26.293 8.3789c-0.14453 0.15625-0.34766 0.25-0.5625 0.25h-7.3438c-0.21484 0-0.41797-0.09375-0.5625-0.25-0.14453-0.16016-0.21484-0.37109-0.19531-0.58594 0.28125-2.9102 1.8672-5.0664 3.8594-5.4219v-8.5508c-1.0312-0.37891-3.1016-1.2656-3.1016-2.3047 0-1.3789 1.6445-1.3477 3.6719-1.3477s3.6719-0.03125 3.6719 1.3477c0 1.0352-2.0703 1.9258-3.1016 2.3047v8.5508c1.9922 0.35547 3.5781 2.5117 3.8594 5.4219 0.019531 0.21484-0.050782 0.42578-0.19531 0.58594zm17.824-8.3789c-8.6328 0-15.633-7.8633-15.633-17.562s7-17.562 15.633-17.562c8.6328-0.003906 15.633 7.8594 15.633 17.562 0 9.6992-7 17.562-15.633 17.562z"></path>
 <path d="m37.375 59.52c0 5.8555-4.2227 10.602-9.4336 10.602-5.2109 0-9.4375-4.7461-9.4375-10.602s4.2266-10.602 9.4375-10.602c5.2109 0 9.4336 4.7461 9.4336 10.602z"></path>
 <path d="m81.496 59.52c0 5.8555-4.2266 10.602-9.4375 10.602-5.2109 0-9.4336-4.7461-9.4336-10.602s4.2227-10.602 9.4336-10.602c5.2109 0 9.4375 4.7461 9.4375 10.602z"></path>
</svg>
`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.198595 3.199892 93.601857 93.601857" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m91.043 58.367c-1.5781 0.27344-2.6328 1.7734-2.3555 3.3516 0.87891 5.0391 1.0781 11.754-2.9727 15.145-2.75 2.3047-7.3242 2.9648-13.266 2.0156h0.003906c-4.7578-1.7344-9.125-4.3945-12.848-7.832 0.38672-2.2461 1.4805-4.3086 3.1289-5.8867 1.6875-1.4062 3.9336-1.8398 6.8633-1.3242 4.7031 0.82422 8.6289 0.085937 11.684-2.1992v0.003906c2.9297-2.3789 4.8516-5.7812 5.3789-9.5195 0.14453-1.2734-0.77344-2.418-2.043-2.5625-1.2734-0.14062-2.4219 0.77344-2.5625 2.0469-0.37891 2.4688-1.6406 4.7148-3.5508 6.3242-1.9844 1.4883-4.7109 1.9375-8.1016 1.3438-4.2969-0.75391-7.875 0.027343-10.637 2.3281-1.7227 1.5039-3.0391 3.418-3.8203 5.5703-3.7734-4.6562-6.6367-9.9766-8.4453-15.688 7.0742-3.582 24.613-11.004 37.238-4.1172 1.4062 0.76172 3.1641 0.24609 3.9297-1.1562 0.76172-1.4062 0.25-3.1641-1.1523-3.9297-11.27-6.1484-25.012-3.1523-34.57 0.44922 2.7227-11.516-9.1836-27.812-9.1836-27.812s-1.8867 12.688-2.9492 16.457l-11.617 1.5977c-2.0391-3.3438-7.2852-15.051-7.2852-15.051 0 0.003906-9.9609 26.684 3.3945 34.008-2.5156-0.71875-4.8711-1.9141-6.9375-3.5234-12-9.0742-6.2227-22.418-5.9688-22.98 0.65625-1.457 0.011718-3.168-1.4453-3.8281-1.4531-0.66016-3.168-0.015625-3.832 1.4375-2.8281 6.207-4.8477 20.465 7.75 29.992h0.003906c4.2266 3.3672 9.457 5.2344 14.863 5.2969 2.5391-0.011719 5.0586-0.4375 7.457-1.2539 2 5.582 4.8086 10.84 8.3438 15.602-11.773-0.65625-23.562 0.88672-34.77 4.5547-1.5078 0.53516-2.2969 2.1914-1.7617 3.6992 0.53516 1.5039 2.1914 2.293 3.6992 1.7578 0.25391-0.089844 25.867-9.0039 47.324-1.1875 6.5625 2.3906 12.363 3.5859 17.27 3.5859 5.0352 0 9.1289-1.2617 12.137-3.7773 3.4062-2.8516 7.0273-8.7383 4.957-20.582-0.27734-1.5781-1.7773-2.6328-3.3516-2.3555zm-69.445-14.934c-0.14844-1.0859 2.0273-2.3008 5.0039-2.8672 0.03125 0.66016 0.097657 1.3867 0.20313 2.1523 0.10547 0.76172 0.23828 1.4766 0.38672 2.1211-3.0195 0.25391-5.4453-0.32031-5.5938-1.4062zm7.4062 1.1602c-0.03125-0.66016-0.097656-1.3867-0.20312-2.1523-0.10547-0.76172-0.23828-1.4766-0.38672-2.1211 3.0117-0.25781 5.4414 0.31641 5.5898 1.4023 0.15234 1.0898-2.0234 2.3047-5 2.8711zm9.5391-3.4922c-0.14844-1.0859 2.0273-2.3008 5.0039-2.8672 0.03125 0.66016 0.097656 1.3867 0.20312 2.1523 0.10547 0.76172 0.23828 1.4766 0.38672 2.1211-3.0156 0.25391-5.4414-0.32031-5.5938-1.4062zm7.207-0.99219c-0.10547-0.76172-0.23828-1.4766-0.38672-2.1211 3.0117-0.25781 5.4414 0.31641 5.5898 1.4023s-2.0273 2.3008-5.0039 2.8672c-0.03125-0.66016-0.09375-1.3828-0.19922-2.1484z"></path>
</svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2.001421 -2.00003 104.001547 104.001547" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><g><path d="M0.127,22.808c0,0,3.159-0.613,4.129-1.076c2.588-1.236,3.353-3.149,5.073-5.667c2.229-3.265,9.419-4.739,9.419-4.739   L18.962,0c0,0,13.638,11.055,15.976,14.933c3.988,6.616,5.997,17.824,5.997,17.824s0.579,5.034,7.408,11.711   c6.44,6.298,30.19,8.071,32.876,36.23c2.221-0.43,4.558-1.33,5.887-3.109c2.637-3.53,0.926-9.928-0.973-14.674   c-6.938-17.329-7.577-29.283-1.852-34.569c3.303-3.049,8.112-3.379,13.199-0.905c2.227,1.082,3.15,3.757,2.063,5.975   c-1.089,2.217-3.774,3.137-6.003,2.053c-1.621-0.788-2.816-0.884-3.155-0.571c-1.179,1.089-2.743,7.65,4.086,24.713   c4.006,10.008,3.938,17.867-0.2,23.36c-3.523,4.676-9.107,6.274-13.265,6.783c-2.081,7.689-10.677,9.848-15.487,9.848   c-2.791,0-31.844,0-34.414,0c0.035,0.035-3.038-0.162-2.688-2.111c0.638-3.553,3.663-4.669,7.416-4.686s4.806,0.054,7.28,0.097   c1.242,0.021-11.955-3.308-10.91-13.315c2.796-19.895,24.22-11.71,24.22-11.71c-21.124-10.388-25.548,6.67-25.548,6.67   c-0.031,0.08-4.949,20.8-4.949,20.8s-1.113,4.651-5.23,4.651c-2.791,0-7.226,0-9.796,0c0.035,0.035-3.038-0.161-2.688-2.111   c1.021-5.684,4.791-3.361,8.916-8.561c4.125-5.2,0.825-9.306,0.825-9.306c-9.624-15.873-2.364-24.603-2.75-34.209   c-0.275-6.841-4.674-9.578-4.674-9.578c-4.674-2.189-6.997-2.621-9.481-6.948C-0.505,26.579,0.127,22.808,0.127,22.808z"></path></g></svg>\n',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.2 3.200004 93.6 93.6" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><g><path d="M53.69,52.82c0.6,0.39,1.33,0.59,2.12,0.59c0.72,0,1.47-0.16,2.16-0.47c0.67-0.3,1.17-0.67,1.54-1.12   c0.41-0.51,0.69-1.18,0.8-1.97c0.27-1.82,0.15-2.81-0.36-2.94c-2.73-0.71-4.8-0.23-6.03,1.39c-0.47,0.63-0.76,1.42-0.83,2.23   C53.05,51.08,53.03,52.39,53.69,52.82z"></path><path d="M39.93,55.43c0.22,0.02,0.45,0.03,0.7,0.03c1.08,0,1.92-0.24,2.49-0.71c0.05-0.04,0.09-0.08,0.14-0.12   c1.17-1.19,0.34-3.54-0.51-4.42c-0.87-0.92-2.23-1.39-3.59-1.26c-0.86,0.09-1.73,0.41-2.22,0.62c-0.32,0.13-0.71,0.3-0.81,0.87   c-0.11,0.67,0.12,1.47,0.4,2.23c0.13,0.37,0.64,1.62,1.6,2.21C38.62,55.18,39.21,55.36,39.93,55.43z"></path><path d="M59.77,58.59c-0.55-0.05-1.03,0.35-1.09,0.9l-0.15,1.5c0,0.01,0,0.01,0,0.02c0,0-0.01,0-0.01,0.01   c-0.08,1.16-0.23,3.1-3.02,4.53c-2,1.03-4.41-0.08-5.39-0.63l1.27-1.35c0.28-0.3,0.39-0.72,0.29-1.12c-0.1-0.4-0.39-0.72-0.79-0.85   c-0.54-0.19-1.12-0.26-1.79-0.2c-0.85,0.07-1.56,0.3-2.12,0.68c-0.31,0.21-0.5,0.54-0.53,0.91c-0.02,0.38,0.13,0.74,0.41,0.99   l1.28,1.14c-0.27,0.42-1.57,2.06-5,1.36c-2.67-0.55-3.42-4.51-3.43-4.59c-0.09-0.54-0.6-0.9-1.16-0.81   c-0.54,0.1-0.9,0.61-0.81,1.16c0.04,0.22,0.98,5.37,5,6.19c0.74,0.16,1.42,0.22,2.03,0.22c0.08,0,0.15-0.01,0.22-0.01   c1.64,1.13,3.29,1.71,4.91,1.71c1.4,0,2.55-0.41,3.45-0.94c0.9-0.53,1.54-1.17,1.95-1.65c0.37-0.1,0.75-0.24,1.13-0.43   c3.75-1.93,4-4.86,4.1-6.13l0.15-1.51C60.72,59.14,60.32,58.65,59.77,58.59z M49.89,68.35c-0.72,0-1.4-0.17-2.03-0.42   c0.66-0.35,1.16-0.77,1.49-1.14c0.65,0.34,1.63,0.78,2.75,1.01C51.5,68.12,50.76,68.35,49.89,68.35z"></path><path d="M69.25,9.48c-6.91,0-13.38,2.67-18.23,7.52L50,18.02L48.98,17c-4.85-4.85-11.32-7.52-18.23-7.52S17.37,12.15,12.52,17   C7.67,21.85,5,28.32,5,35.23c0,6.91,2.67,13.38,7.52,18.23l36.77,36.77c0.19,0.19,0.45,0.29,0.71,0.29c0.25,0,0.51-0.1,0.7-0.29   l35.05-35.04l1.72-1.73C92.33,48.61,95,42.14,95,35.23c0-6.91-2.67-13.38-7.53-18.23C82.63,12.15,76.15,9.48,69.25,9.48z M50,88.11   L30.51,68.62c0.1-0.43,0.19-0.86,0.28-1.29c0.08-0.41,0.16-0.81,0.24-1.19c0.31-1.35,2.18-3.65,2.88-4.42   c0.09-0.1,0.13-0.24,0.12-0.37c-0.01-0.14-0.07-0.26-0.17-0.35c-0.05-0.04-4.58-3.93-4.81-8.87c-0.18-4.06,0.83-8.15,1.28-9.72   c0.14-0.48,0.11-1-0.08-1.45l-0.98-2.5c-0.16-0.4-0.23-0.83-0.23-1.27v-0.92c0-0.5-0.15-1-0.42-1.44l-4.13-6.5   c-0.01-0.02-1.02-1.66-0.03-2.95c0.59-0.78,3.86,0.23,6.51,1.57c0.01,0.01,0.22,0.15,0.56,0.37c0.05,0.05,0.11,0.09,0.19,0.12   c0.467,0.308,1.121,0.746,1.82,1.229c1.407,1.284,2.921,2.697,3.585,3.425c0.39,0.429,1.44,1.989,2.011,2.872   c0.191,0.295,0.513,0.457,0.841,0.457c0.187,0,0.374-0.052,0.542-0.161c0.464-0.3,0.597-0.919,0.297-1.383   c-0.16-0.247-1.583-2.438-2.211-3.13c-0.478-0.524-1.34-1.355-2.29-2.242l1.645,0.374c0.04,0.01,0.07,0.01,0.11,0.01   c0.1,0,0.19-0.03,0.27-0.08c0.04-0.02,3.61-2.3,7.59-3c2.853-0.509,6.646-0.642,8.646-0.678c-1.515,3.332-2.8,7.067-2.881,7.306   c-0.179,0.522,0.101,1.091,0.623,1.27c0.107,0.037,0.216,0.054,0.323,0.054c0.416,0,0.805-0.262,0.946-0.677   c0.785-2.297,3.103-8.484,4.784-10.783c0.08-0.106,0.162-0.221,0.239-0.312c2.08-2.47,3.51-3.6,3.49-3.6   c0.75-0.39,2.19-0.87,2.84-0.49c0.96,0.54,2.37,2.73,2.68,3.9c0.246,0.937,0.366,4.454,0.389,5.856   c-0.018,0.678-0.088,3.709,0.083,4.56c0.051,0.41-0.324,2.101-0.707,3.424c-0.153,0.53,0.152,1.085,0.683,1.238   c0.093,0.027,0.187,0.04,0.279,0.04c0.434,0,0.833-0.284,0.96-0.722c0.149-0.516,0.394-1.413,0.57-2.29   c1.435,3.852,3.369,9.234,3.803,11.423c0.35,1.73,0.32,4.82,0.29,7.8c-0.03,3.27-0.06,6.1,0.39,7.18c0.3,0.72,0.73,1.47,1.19,2.24   L50,88.11z"></path></g></svg>\n',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.200917 3.200211 93.599429 93.599429" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path d="M94.764,15.93c-3.517-0.082-6.705,4.17-6.705,4.17h-7.777c0,0-3.189-4.252-6.706-4.17c-1.063,3.434,1.8,9.321,1.8,9.321  c-2.854,2.861-1.668,4.211-3.917,6.46c-6.255,6.255-25.479,1.534-34.856,0.654c-9.377-0.88-21.728,4.554-23.8,16.382  c-1.853,10.575-1.459,14.16-6.592,18.948c-1.056,0.985-1.546,2.513-0.958,3.566c0.587,1.054,2.232,1.717,3.562,1.147  c9.723-4.16,11.075-17.883,11.075-17.883l3.707,14.5l6.254,14.148c0.22,0.496,0.837,0.897,1.378,0.897h3.707  c4.579,0,2.998-4.361-1.418-4.361l-1.772-5.074l8.532-16.404l23.441,1.091l3.348,23.778c0.078,0.536,0.58,0.971,1.123,0.971h3.814  c4.321,0,2.645-3.816-0.763-3.816L73.312,67.5l6.731,14.59c0.227,0.492,0.85,0.891,1.392,0.891h3.598c4.17,0,2.412-3.762-0.98-3.762  c-5.479-19.052,6.786-29.191,5.806-37.369c5.805-7.358,3.106-16.599,3.106-16.599S95.826,19.363,94.764,15.93z"></path></svg>
`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="3.101643 3.19634 93.796444 93.796444" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet"><path fill="currentColor" d="M90.339,36.623c2.391-11.653,1.194-23.307,0-29.581c-1.194-6.275-12.254,3.287-17.331,10.16  C67.931,24.073,50,22.58,50,22.58s-17.929,1.494-23.009-5.378C21.913,10.329,10.855,0.767,9.662,7.042  c-1.197,6.274-2.392,17.928,0,29.581c0,0-3.957,21.217-1.382,29.583c2.567,8.337,22.263,27.357,41.622,28.962v0.021  c0.032-0.004,0.064-0.008,0.099-0.012c0.032,0.004,0.064,0.008,0.098,0.012v-0.021c19.36-1.604,39.055-20.625,41.621-28.962  C94.294,57.84,90.339,36.623,90.339,36.623z M11.538,5.987c0,0,14.615,9.38,18.541,29.229L11.538,5.987z M50.285,93.863  c-0.011,0.002-0.021,0.003-0.032,0.005c-0.004,0-0.008,0-0.01,0c-0.017,0.002-0.034,0.002-0.051,0.004  c-0.062,0.006-0.322,0.006-0.385,0c-0.017-0.002-0.034-0.002-0.05-0.004c-0.003,0-0.007,0-0.009,0  c-0.011-0.002-0.021-0.003-0.033-0.005c-10.254-1.052-17.357-6.798-17.357-6.798s1.424-9.411,11.683-7.675  c0,0,0.628-6.755,5.276-6.627c0.236,0.005,1.129,0.005,1.367,0c4.646-0.128,5.276,6.627,5.276,6.627  c10.258-1.736,11.683,7.675,11.683,7.675S60.439,92.771,50.285,93.863z M70.113,35.215c3.924-19.849,18.54-29.227,18.54-29.227  L70.113,35.215z"></path><path fill="currentColor" d="M54.451,87.404c-2.081-0.185-4.201-1.435-4.618-3.456c1.241-0.161,1.479-2.146,1.54-2.869  c0.062-0.753,1.696-0.041,1.696-1.254c0-1.896-2.661-1.607-3.267-1.632v-0.004c0,0-0.027,0.002-0.062,0.002  c-0.037,0-0.063-0.002-0.063-0.002v0.004c-0.604,0.024-3.268-0.264-3.268,1.632c0,1.213,1.634,0.501,1.697,1.254  c0.061,0.729,0.302,2.742,1.567,2.878c-0.312,2.138-2.497,3.466-4.644,3.655c-0.039,0.004,0.024,1.087,0,1.089  c2.368-0.209,4.679-1.669,4.713-4.267c0.002-0.056,0-0.11,0.001-0.165c0.063,2.567,2.354,4.015,4.708,4.223  C54.427,88.491,54.491,87.407,54.451,87.404z"></path></svg>\n'
];
var NAVBAR_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8.38088 8.399872 83.200127 83.200127" fill="currentColor" width="24" height="24" preserveAspectRatio="xMidYMid meet">
 <path d="m74.102 60.5c-0.054687-5.3906 0.89453-10.746 2.7969-15.789 0.69922-1.7969 1.4883-3.5547 2.3633-5.2695 1.5547-2.9375 2.2891-6.2422 2.1289-9.5625-0.39062-5.8789-3.8906-8.6797-10.969-8.6797h-0.0625c-0.5625-0.003907-1.0508-0.39062-1.1797-0.9375-1.2812-5.1914-3.3516-8.4297-6.1719-9.6484-3-1.3203-7.0898-0.48828-12.41 2.5l0.003906-0.003906c-0.375 0.20312-0.82812 0.20312-1.2031 0-5.3203-3-9.3789-3.8203-12.41-2.5-2.8203 1.2188-4.8906 4.4609-6.1719 9.6484l0.003906 0.003907c-0.12891 0.54688-0.61719 0.93359-1.1797 0.9375h-0.070313c-7.0703 0-10.559 2.75-11 8.6797-0.16016 3.3242 0.57422 6.6289 2.1289 9.5703 0.87891 1.7109 1.6641 3.4688 2.3594 5.2617 1.918 5.043 2.8789 10.395 2.8398 15.789v29.5h48.203zm-20.902-38.5c0.57031-1.7109 1.6836-3.1875 3.1719-4.2109 0.76953-0.54687 1.6836-0.85937 2.6289-0.89844 0.42188-0.003906 0.84375 0.074219 1.2383 0.21875 1.2891 0.51562 2.2578 1.6094 2.6133 2.9492 0.50391 1.7344 0.4375 3.582-0.19141 5.2695-0.57422 1.7109-1.6914 3.1875-3.1797 4.2031-1.125 0.8125-2.5625 1.0508-3.8906 0.64844-1.2969-0.52734-2.2656-1.6406-2.6094-3-0.49219-1.7031-0.41406-3.5234 0.21875-5.1797zm-16.07-1.9414c0.35547-1.3398 1.3242-2.4336 2.6094-2.9492 0.40625-0.14844 0.83203-0.22266 1.2617-0.21875 0.94531 0.023437 1.8672 0.31641 2.6484 0.84766 1.4883 1.0391 2.5977 2.5352 3.1523 4.2617 0.64453 1.6836 0.71484 3.5312 0.19922 5.2617-0.34375 1.3555-1.3125 2.4727-2.6094 3-1.3281 0.40234-2.7656 0.16016-3.8906-0.65234-1.4922-1.0156-2.6094-2.4883-3.1797-4.1992-0.64453-1.7148-0.71094-3.5938-0.19141-5.3516zm-4.8008 21.18c-2.5508 1.0898-5.8398-0.89062-7.3398-4.4102-0.73438-1.6445-0.91797-3.4883-0.51953-5.25 0.28516-1.3555 1.1836-2.5039 2.4297-3.1094 0.47266-0.19531 0.98047-0.29297 1.4922-0.28906 2.2305 0 4.6406 1.8398 5.8594 4.7109 0.74609 1.6406 0.92188 3.4844 0.51172 5.2383-0.26953 1.3672-1.1719 2.5195-2.4336 3.1094zm32.91 16.82c-1.7305 3.5117-5.7617 4.2383-13.469 2.4219-1.1641-0.26172-2.375-0.26172-3.5391 0-7.7109 1.8203-11.738 1.0898-13.461-2.3906-1.7305-3.7812-0.73047-7.6211 3-11.762 0.62109-0.67578 1.168-1.4141 1.6289-2.207 3.0586-5.3906 6.2109-8 9.5703-8h1.8086c3.4219-0.10938 6.6094 2.5312 9.7188 8h0.003906c0.46094 0.79297 1.0078 1.5312 1.6289 2.207 3.8711 4.1406 4.8711 7.9805 3.1094 11.73zm2.4297-16.82h0.003906c-1.2617-0.58984-2.1641-1.7422-2.4336-3.1094-0.41016-1.7539-0.23438-3.5977 0.51172-5.2383 1.5-3.5195 4.8008-5.4883 7.3516-4.4219 1.2461 0.60547 2.1445 1.7539 2.4297 3.1094 0.39453 1.7617 0.20703 3.6055-0.53125 5.25-1.4883 3.5234-4.7812 5.5-7.3281 4.4102z"></path>
</svg>
`;

// src/ui/icon-cycle.ts
class IconCycle {
  random;
  order;
  constructor(items, random = Math.random) {
    this.random = random;
    if (!items.length)
      throw new Error("An icon cycle needs at least one design.");
    this.order = [...items];
  }
  at(index) {
    return this.order[index % this.order.length];
  }
  shuffle() {
    for (let i = this.order.length - 1;i > 0; i--) {
      const j = Math.floor(this.random() * i);
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
  }
}

// src/ui/cat-icons.ts
var kinds = ["swipes", "settings", "cat"];
var designs = new IconCycle(CAT_ICON_POOL);
designs.shuffle();
function catIcon(className = "ao-cat-icon", kind = "swipes") {
  const template = document.createElement("template");
  template.innerHTML = designs.at(kinds.indexOf(kind));
  const svg = template.content.firstElementChild;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className);
  svg.dataset.aoCatIcon = kind;
  return svg;
}
function rotateCatIcons() {
  designs.shuffle();
  refreshCatIcons();
}
function refreshCatIcons(root = document) {
  for (const svg of root.querySelectorAll("svg[data-ao-cat-icon]")) {
    const kind = svg.dataset.aoCatIcon;
    if (!kinds.includes(kind))
      continue;
    const next = catIcon(svg.getAttribute("class") ?? "", kind);
    for (const attribute of Array.from(svg.attributes))
      svg.removeAttribute(attribute.name);
    for (const attribute of Array.from(next.attributes))
      svg.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    svg.replaceChildren(...Array.from(next.childNodes));
  }
}

// src/ui/components.ts
function el(tag, className = "", text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined)
    node.textContent = text;
  return node;
}
function button(label, action, className = "", disabled = false) {
  const node = el("button", `ao-button ${className}`, label);
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", action);
  return node;
}
function select(label, value, options, onChange, disabled = false) {
  const field = el("label", "ao-field");
  field.append(el("span", "ao-label", label));
  const input = el("select", "ao-input");
  input.disabled = disabled;
  for (const choice of options) {
    const option = el("option", "", choice.name);
    option.value = choice.id;
    input.append(option);
  }
  input.value = value;
  input.addEventListener("change", () => onChange(input.value));
  field.append(input);
  return field;
}

// src/ui/cat-photos.ts
var SEARCH = "https://api.thecatapi.com/v1/images/search?limit=10&size=small&mime_types=jpg,png&order=RAND";
function catPhotos() {
  let urls = [];
  let pending;
  let request;
  let retryAt = 0;
  let serial = 0;
  let disposed = false;
  async function load() {
    request = new AbortController;
    const timeout = setTimeout(() => request?.abort(), 4000);
    try {
      const response = await fetch(SEARCH, { signal: request.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      if (!response.ok)
        throw new Error("Cat search unavailable");
      const data = await response.json();
      if (!Array.isArray(data))
        throw new Error("Invalid cat search response");
      const photos = data.slice(0, 10).flatMap((item) => {
        if (!item || typeof item.url !== "string")
          return [];
        try {
          const url = new URL(item.url);
          return url.protocol === "https:" && /^cdn2?\.thecatapi\.com$/.test(url.hostname) && !url.username && !url.password && !url.port && /\.(jpg|jpeg|png)$/i.test(url.pathname) ? [url.href] : [];
        } catch {
          return [];
        }
      });
      if (!photos.length)
        throw new Error("No cat photos returned");
      if (!disposed)
        urls.push(...new Set(photos));
    } catch {
      retryAt = Date.now() + 60000;
    } finally {
      clearTimeout(timeout);
      request = undefined;
    }
  }
  return {
    async next() {
      if (disposed)
        throw new Error("Cat photos disposed");
      if (!urls.length && Date.now() >= retryAt) {
        pending ??= load().finally(() => {
          pending = undefined;
        });
        await pending;
      }
      if (disposed)
        throw new Error("Cat photos disposed");
      return urls.shift() ?? `https://cataas.com/cat?width=900&another_one=${Date.now()}-${++serial}`;
    },
    dispose() {
      disposed = true;
      request?.abort();
      urls = [];
    }
  };
}

// src/ui/cats.ts
var RESERVE = 30;
var CONCURRENT = 4;

class CatBackground {
  root;
  photos;
  stack;
  loadingPill;
  ready = [];
  loading = new Map;
  retiring = new Map;
  enabled = false;
  galleryActive = false;
  appendCount = 0;
  disposed = false;
  shown = false;
  waiting = false;
  retry;
  resize;
  constructor(root, photos = catPhotos()) {
    this.root = root;
    this.photos = photos;
    this.stack = this.makeStack();
    root.prepend(this.stack);
    this.loadingPill = el("div", "ao-cat-loading");
    this.loadingPill.hidden = true;
    this.loadingPill.setAttribute("role", "status");
    const bubble = el("span", "ao-pill");
    bubble.append(catIcon("ao-cat-icon", "cat"), el("span", "", "Loading more cats…"));
    this.loadingPill.append(bubble);
    const stars = el("span", "ao-cat-stars");
    stars.setAttribute("aria-hidden", "true");
    for (let i = 0;i < 5; i++) {
      const star = el("span", "ao-cat-star", i % 2 ? "✧" : "✦");
      star.style.setProperty("--star", String(i));
      stars.append(star);
    }
    this.loadingPill.append(stars);
    root.append(this.loadingPill);
    this.resize = new ResizeObserver(() => {
      if (this.shown && this.galleryHeight(Array.from(this.stack.children)) < root.clientHeight) {
        if (this.galleryActive && this.stack.childElementCount)
          this.appendCount = 4;
        else
          this.waiting = true;
      }
      this.work();
    });
    this.resize.observe(root);
    root.addEventListener("scroll", this.onScroll, { passive: true });
    this.work();
  }
  makeStack() {
    const stack = document.createElement("div");
    stack.className = "ao-cats";
    stack.setAttribute("aria-hidden", String(!this.galleryActive));
    return stack;
  }
  galleryHeight(images) {
    return images.reduce((sum, image) => sum + this.root.clientWidth * image.naturalHeight / image.naturalWidth, 0);
  }
  setEnabled(enabled) {
    this.enabled = enabled;
    this.updateVisibility();
    this.work();
  }
  setGalleryActive(active) {
    if (active === this.galleryActive)
      return;
    this.galleryActive = active;
    this.appendCount = 0;
    this.root.scrollTop = 0;
    this.root.classList.toggle("ao-cat-view", active);
    this.stack.setAttribute("aria-hidden", String(!active));
    for (const [stack, timer] of this.retiring) {
      clearTimeout(timer);
      stack.remove();
    }
    this.retiring.clear();
    this.stack.classList.remove("ao-cats-enter");
    this.updateVisibility();
    if (active)
      this.show();
    else {
      this.waiting = true;
      this.work();
    }
  }
  updateVisibility() {
    this.root.classList.toggle("ao-with-cat", (this.enabled || this.galleryActive) && !!this.stack.childElementCount);
  }
  onScroll = () => {
    if (!this.galleryActive || this.root.scrollTop <= 0 || this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight > 800)
      return;
    this.appendCount = 4;
    this.work();
  };
  show() {
    this.shown = true;
    if (!this.stack.childElementCount)
      this.waiting = true;
    this.work();
  }
  refresh() {
    if (this.enabled && !this.galleryActive) {
      this.shown = true;
      this.waiting = true;
      this.work();
    }
  }
  work() {
    if (this.disposed)
      return;
    const width = this.root.clientWidth, height = this.root.clientHeight;
    const replace = this.shown && this.waiting && (this.enabled || this.galleryActive);
    const available = this.ready.length;
    let take = 0, filled = 0;
    while (take < available && filled < height) {
      const image = this.ready[take++];
      filled += width * image.naturalHeight / image.naturalWidth;
    }
    const complete = width > 0 && height > 0 && filled >= height;
    if (replace && complete) {
      const next = this.makeStack();
      next.append(...this.ready.splice(0, take));
      const previous = this.stack;
      previous.after(next);
      this.stack = next;
      this.root.classList.add("ao-with-cat");
      next.classList.add("ao-cats-enter");
      this.waiting = false;
      if (this.galleryActive) {
        previous.remove();
        next.classList.remove("ao-cats-enter");
      } else
        this.retiring.set(previous, setTimeout(() => {
          previous.remove();
          this.retiring.delete(previous);
          next.classList.remove("ao-cats-enter");
        }, 400));
    }
    if (this.galleryActive && !this.waiting && this.appendCount && this.ready.length >= this.appendCount) {
      this.stack.append(...this.ready.splice(0, this.appendCount));
      this.appendCount = 0;
    }
    const sample = this.ready.length ? this.ready : Array.from(this.stack.children);
    const averageRatio = sample.length ? sample.reduce((sum, image) => sum + image.naturalHeight / image.naturalWidth, 0) / sample.length : 0.8;
    const estimate = this.shown && width > 0 ? Math.max(1, Math.ceil(height / (width * averageRatio))) : 0;
    const needed = replace && this.waiting && width > 0 && height > 0 ? Math.max(estimate, take + 1) : 0;
    const target = Math.max(RESERVE, needed, this.appendCount);
    this.loadingPill.hidden = !this.galleryActive || !this.waiting && !this.appendCount;
    if (this.retry)
      return;
    while (this.loading.size < CONCURRENT && this.ready.length + this.loading.size < target)
      this.preload();
  }
  preload() {
    const image = new Image;
    image.referrerPolicy = "no-referrer";
    image.decoding = "async";
    image.alt = "A random cat";
    image.className = "ao-cat";
    const failed = () => {
      if (!this.loading.has(image))
        return;
      clearTimeout(this.loading.get(image));
      this.loading.delete(image);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      if (!this.retry && !this.disposed)
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.work();
        }, 5000);
    };
    this.loading.set(image, setTimeout(failed, 15000));
    image.onerror = failed;
    image.onload = async () => {
      try {
        if (typeof image.decode === "function")
          await image.decode();
      } catch {
        failed();
        return;
      }
      if (!this.loading.has(image) || this.disposed)
        return;
      if (!image.naturalWidth || !image.naturalHeight) {
        failed();
        return;
      }
      clearTimeout(this.loading.get(image));
      this.loading.delete(image);
      image.onload = null;
      image.onerror = null;
      image.width = image.naturalWidth;
      image.height = image.naturalHeight;
      this.ready.push(image);
      this.work();
    };
    this.photos.next().then((url) => {
      if (!this.disposed && this.loading.has(image))
        image.src = url;
    }, failed);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.retry);
    this.photos.dispose();
    for (const [image, timeout] of this.loading) {
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    }
    this.loading.clear();
    this.resize.disconnect();
    this.root.removeEventListener("scroll", this.onScroll);
    this.ready = [];
    this.stack.remove();
    this.loadingPill.remove();
    this.root.classList.remove("ao-cat-view", "ao-with-cat");
    for (const [stack, timer] of this.retiring) {
      clearTimeout(timer);
      stack.remove();
    }
    this.retiring.clear();
  }
}

// src/ui/styles.ts
var ICON = CAT_ICON_POOL[0];
var STYLES = `
[data-component="InputArea"] button[data-cat-stop] { background:var(--lumiverse-danger, #ef4444)!important; color:var(--lumiverse-primary-contrast, #fff)!important; }
[data-component="InputArea"] button[data-cat-stop]:not(:disabled) { opacity:1!important; cursor:pointer!important; }
[data-component="InputArea"] button[data-cat-stop]:hover { background:var(--lumiverse-danger-hover, #dc2626)!important; }
[data-component="InputArea"] button[data-cat-stop] > * { visibility:hidden!important; }
[data-component="InputArea"] button[data-cat-stop]::after { display:none!important; }
[data-component="InputArea"] button[data-cat-stop]::before { content:""; position:absolute; width:12px; height:12px; border:2px solid currentColor; border-radius:2px; box-sizing:border-box; }
.ao-icon-credits { display:inline-block; margin:12px 4px 0; color:var(--ao-muted); text-underline-offset:3px; }
.ao-icon-credits:hover { color:var(--ao-text); }
/* LumiBooks' scoped host-padding override; keep the bottom safe-area inset. */
:has(> div > [data-spindle-drawer-tab] > .ao-root) {
  padding-top:0!important; padding-left:0!important; padding-right:0!important;
}
[data-spindle-drawer-tab]:has(> .ao-root) { height:100%; min-height:0; }
.ao-root {
  --ao-text:var(--lumiverse-text, #eee9f3);
  --ao-muted:var(--lumiverse-text-muted, #b7afc5);
  --ao-accent:var(--lumiverse-primary-text, var(--lumiverse-primary, #b5a2d9));
  --ao-success:var(--lumiverse-success, var(--ao-accent));
  --ao-error:var(--lumiverse-danger, var(--ao-accent));
  --ao-bg:var(--lumiverse-bg, #15121d);
  --ao-panel:var(--lumiverse-bg-elevated, #221c2e);
  --ao-line:var(--lumiverse-border, color-mix(in srgb, var(--ao-text) 16%, transparent));
  --ao-glass:color-mix(in srgb, var(--ao-panel) 86%, transparent);
  display:flex; flex-direction:column; height:100%; min-height:0; min-width:0;
  color:var(--ao-text); background:var(--ao-bg);
  font-family:var(--lumiverse-font-family, 'Segoe UI', sans-serif); font-size:12px; line-height:1.45;
}
.ao-root *, .ao-root *::before, .ao-root *::after { box-sizing:border-box; }
.ao-root:not(.ao-hotbar) { container-type:inline-size; }
.ao-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:4px; padding:6px 8px; min-height:48px; border-bottom:1px solid var(--ao-line); background:var(--ao-bg); flex-shrink:0; }
.ao-tabs { display:flex; flex:1 1 auto; flex-wrap:wrap; min-width:0; gap:4px; }
.ao-tab { display:inline-flex; align-items:center; justify-content:center; gap:6px; border:1px solid transparent; border-radius:999px; background:none; color:var(--ao-muted); padding:5px 8px; font:inherit; font-size:11px; cursor:pointer; transition:background .2s, color .2s, box-shadow .2s; }
.ao-tab[aria-selected=true] { color:var(--ao-accent); background:color-mix(in srgb, var(--ao-accent) 12%, transparent); border-color:var(--ao-line); box-shadow:0 2px 8px #00000012; }
.ao-tab:hover { color:var(--ao-text); background:color-mix(in srgb, var(--ao-accent) 8%, transparent); }
.ao-cat-icon { width:24px; height:24px; flex-shrink:0; color:var(--ao-accent); }
.ao-tab .ao-cat-icon { width:24px; height:24px; }
.ao-body { position:relative; isolation:isolate; overflow:hidden; display:flex; flex:1; min-height:0; }
.ao-cats { position:absolute; inset:0; z-index:-2; overflow:hidden; opacity:0; pointer-events:none; transition:opacity .35s; }
.ao-cat { display:block; width:100%; height:auto; object-fit:contain; }
.ao-with-cat .ao-cats { opacity:.7; }
.ao-with-cat .ao-cats-enter { animation:ao-gallery-in .35s ease both; }
.ao-body::before { content:''; position:absolute; inset:0; z-index:-1; pointer-events:none; background:linear-gradient(165deg, color-mix(in srgb, var(--ao-bg) 28%, transparent), color-mix(in srgb, var(--ao-bg) 48%, transparent)); }
.ao-content { flex:1; min-height:0; min-width:0; padding:14px 12px 24px; overflow:auto; scrollbar-width:thin; scrollbar-color:var(--ao-line) transparent; }
.ao-button { border:1px solid var(--ao-line); border-radius:999px; background:var(--ao-glass); color:var(--ao-text); font:inherit; padding:7px 12px; cursor:pointer; line-height:1.35; backdrop-filter:blur(12px); box-shadow:0 3px 10px #00000012; transition:transform .18s, box-shadow .18s, border-color .18s, background .18s; }
.ao-button:hover:not(:disabled) { border-color:color-mix(in srgb, var(--ao-accent) 60%, transparent); transform:translateY(-1px); box-shadow:0 5px 14px #00000024; }
.ao-button:active:not(:disabled) { transform:translateY(1px) scale(.98); }
.ao-toggle { color:var(--ao-accent); min-width:68px; padding:6px 11px; font-size:11px; flex-shrink:0; margin-left:auto; white-space:nowrap; }
.ao-toggle[aria-pressed=true] { background:color-mix(in srgb, var(--ao-accent) 14%, var(--ao-panel)); }
.ao-toggle::before { content:''; display:inline-block; width:5px; height:5px; border-radius:50%; background:currentColor; margin-right:6px; opacity:.6; vertical-align:2px; }
.ao-toggle[aria-pressed=true]::before { background:var(--ao-success); opacity:1; box-shadow:0 0 7px color-mix(in srgb,var(--ao-success) 20%,transparent); }
.ao-small { padding:3px 6px; min-width:25px; min-height:25px; }
.ao-button:disabled, .ao-input:disabled { opacity:.48; cursor:default; }
.ao-root :focus-visible { outline:2px solid var(--ao-accent); outline-offset:2px; }
.ao-pill { display:inline-flex; align-items:center; gap:7px; max-width:100%; border:1px solid var(--ao-line); border-radius:999px; padding:7px 11px; background:var(--ao-glass); color:var(--ao-text); backdrop-filter:blur(14px); box-shadow:0 4px 14px #0000001c, inset 0 1px 0 #ffffff06; }
.ao-status { display:flex; width:fit-content; gap:7px; min-height:33px; margin-bottom:16px; border-radius:17px; }
.ao-status .ao-cat-icon { animation:ao-cat-float 4s ease-in-out infinite; }
.ao-status-text { margin:0; flex:1; font-size:11px; line-height:1.55; }
.ao-dot { width:6px; height:6px; border-radius:50%; background:var(--ao-muted); flex-shrink:0; }
.ao-ready .ao-dot { background:var(--ao-success); }
.ao-running .ao-dot, .ao-preparing .ao-dot { background:var(--ao-accent); animation:ao-pulse 1.4s infinite; }
.ao-error .ao-dot { background:var(--ao-error); }
.ao-muted, .ao-empty { color:var(--ao-muted); margin:8px 0; font-size:11px; }
.ao-empty { border-radius:18px; padding:12px 14px; }
.ao-run { margin-bottom:12px; padding:12px; border:1px solid var(--ao-line); border-radius:18px; background:var(--ao-glass); backdrop-filter:blur(10px); box-shadow:0 6px 22px #00000020, inset 0 1px 0 #ffffff06; animation:ao-card-in .3s ease both; }
.ao-run-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding-bottom:5px; }
.ao-run-title { min-width:0; flex:1; display:flex; align-items:center; flex-wrap:wrap; gap:5px; }
.ao-run-title .ao-pill { padding:5px 8px; font-size:11px; }
.ao-run-title strong { display:inline-flex; font-weight:600; overflow-wrap:anywhere; }
.ao-run-character { min-width:0; overflow-wrap:anywhere; }
.ao-run-date { color:var(--ao-muted); font-size:11px; overflow-wrap:anywhere; }
.ao-step-state { color:var(--ao-accent); font-size:9px; text-transform:capitalize; padding:3px 7px; border-radius:999px; background:color-mix(in srgb, var(--ao-accent) 9%, transparent); white-space:nowrap; }
.ao-step-error { color:var(--ao-error); background:color-mix(in srgb,var(--ao-error) 8%,transparent); }
.ao-step { display:flex; align-items:center; gap:9px; padding:10px 4px; border:0; border-bottom:1px solid var(--ao-line); width:100%; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:9px; transition:background .2s, transform .2s; }
.ao-step:hover:not(:disabled) { color:var(--ao-accent); background:color-mix(in srgb, var(--ao-accent) 7%, transparent); transform:translateX(2px); }
.ao-step:disabled { cursor:default; opacity:.55; }
.ao-run-past { opacity:.52; filter:grayscale(.8); user-select:none; }
.ao-run-past .ao-step { pointer-events:none; }
.ao-step:last-child { border-bottom:0; padding-bottom:0; }
.ao-step-number { display:grid; place-items:center; color:var(--ao-accent); min-width:22px; height:22px; border-radius:50%; background:color-mix(in srgb, var(--ao-accent) 9%, transparent); font-size:10px; }
.ao-step-copy { flex:1; min-width:0; }
.ao-step-copy strong { display:block; font-size:12px; font-weight:500; overflow-wrap:anywhere; }
.ao-step-copy small { display:block; font-size:11px; color:var(--ao-muted); overflow-wrap:anywhere; }
.ao-settings-intro { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-bottom:16px; }
.ao-hint { margin:0; font-size:10px; line-height:1.5; }
.ao-count { font-size:10px; color:var(--ao-accent); padding:5px 8px; }
.ao-slots { position:relative; display:flex; flex-direction:column; gap:16px; margin:10px 0; }
.ao-slot { position:relative; isolation:isolate; padding:12px; border:1px solid var(--ao-line); border-radius:18px; background:var(--ao-glass); backdrop-filter:blur(10px); box-shadow:0 6px 22px #00000020, inset 0 1px 0 #ffffff06; transition:box-shadow .2s, border-color .2s, transform .2s; }
.ao-slot::before, .ao-slot::after { content:''; position:absolute; z-index:-1; top:-5px; width:11px; height:11px; border-top:1px solid var(--ao-line); border-left:1px solid var(--ao-line); background:var(--ao-panel); transform:rotate(45deg); border-radius:3px 0 0; }
.ao-slot::before { left:19px; }
.ao-slot::after { left:47px; }
.ao-slot:hover, .ao-slot:focus-within { border-color:color-mix(in srgb, var(--ao-accent) 34%, transparent); box-shadow:0 9px 26px #0000002a; }
.ao-slot-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.ao-slot-name { display:inline-flex; align-items:center; gap:5px; font-size:10px; color:var(--ao-accent); padding:3px 7px; border-radius:999px; background:color-mix(in srgb, var(--ao-accent) 8%, transparent); }
.ao-slot-controls { display:flex; gap:3px; }
.ao-slot-controls .ao-button { background:color-mix(in srgb, var(--ao-bg) 50%, transparent); border-color:transparent; box-shadow:none; }
.ao-drag-handle { cursor:grab; touch-action:none; font-size:17px; line-height:1; }
.ao-dragging { transform:rotate(-1.2deg) scale(1.025); opacity:.96; border-color:var(--ao-accent); box-shadow:0 18px 44px #00000066, 0 0 0 3px color-mix(in srgb, var(--ao-accent) 10%, transparent); z-index:5; cursor:grabbing; }
.ao-dragging .ao-drag-handle { cursor:grabbing; }
.ao-drag-gap { flex-shrink:0; display:flex; align-items:center; justify-content:center; gap:7px; border:1px dashed color-mix(in srgb, var(--ao-accent) 48%, transparent); border-radius:18px; background:color-mix(in srgb, var(--ao-accent) 6%, transparent); color:var(--ao-accent); font-size:11px; }
.ao-field { display:flex; flex-direction:column; gap:4px; margin-top:9px; min-width:0; }
.ao-label { font-size:10px; color:var(--ao-muted); }
.ao-input { width:100%; min-width:0; color:var(--ao-text); background:color-mix(in srgb, var(--ao-bg) 64%, transparent); border:1px solid var(--ao-line); border-radius:10px; padding:8px 9px; font:inherit; font-size:11px; }
.ao-input option { background:var(--ao-bg); color:var(--ao-text); }
.ao-actions { display:flex; gap:7px; flex-wrap:wrap; margin-top:14px; }
.ao-notice { padding:8px 12px; margin:8px 12px 0; background:var(--ao-panel); font-size:11px; border:1px solid var(--ao-line); border-radius:16px; }
.ao-notice:empty { display:none; }
.ao-lock-cover { position:absolute; z-index:2; inset:0; width:100%; height:100%; background:transparent!important; border:0!important; box-shadow:none!important; border-radius:18px; cursor:pointer; backdrop-filter:none; transform:none!important; }
.ao-lock-tip { position:absolute; z-index:4; top:11px; left:50%; transform:translateX(-50%); font-size:11px; white-space:nowrap; background:var(--ao-panel); border-color:color-mix(in srgb, var(--ao-accent) 45%, transparent); box-shadow:0 6px 24px #00000040; pointer-events:none; animation:ao-pop-in .35s cubic-bezier(.16,1.5,.4,1) both; }

.ao-cat-view { display:block; overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--ao-line) transparent; }
.ao-cat-view .ao-cats { position:relative; inset:auto; z-index:0; overflow:visible; opacity:1; pointer-events:auto; }
.ao-cat-view .ao-content, .ao-cat-view::before { display:none; }
.ao-cat-loading { display:flex; position:sticky; bottom:18px; z-index:1; width:max-content; max-width:calc(100% - 32px); margin:24px auto; font-size:11px; animation:ao-cat-bob 3s ease-in-out infinite; }
.ao-cat-loading > .ao-pill { position:relative; z-index:1; padding:8px 14px; box-shadow:0 6px 24px #00000035; }
.ao-cat-loading[hidden] { display:none; }
.ao-cat-stars { position:absolute; inset:0; pointer-events:none; }
.ao-cat-star { position:absolute; top:5px; left:calc(12% + var(--star) * 19%); color:var(--ao-accent); font-size:14px; text-shadow:0 1px 4px var(--ao-bg); opacity:0; animation:ao-cat-spark 2.8s ease-out infinite; animation-delay:calc(var(--star) * -.56s); }
.ao-slot-name .ao-cat-icon { width:26px; height:26px; }
.ao-slot { border-top-left-radius:25px; border-top-right-radius:25px; }
.ao-hotbar-profile .ao-cat-icon { width:22px; height:22px; }
@container (max-width:360px) { .ao-tab { gap:3px; padding:5px; } .ao-tab .ao-cat-icon { width:21px; height:21px; } .ao-toggle { min-width:0; padding:6px 8px; } }

@keyframes ao-pulse { 50% { opacity:.35; } }
.ao-waiting-cat { display:inline-flex; align-items:center; gap:12px; padding:10px 16px; margin:4px 0; border:1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius:999px; color:var(--lumiverse-primary-text,var(--lumiverse-text-muted,#b7afc5)); background:color-mix(in srgb,currentColor 6%,transparent); font-size:12px; }
.ao-wait-cat { width:30px; height:30px; flex:none; fill:currentColor; animation:ao-cat-spin 3s linear infinite; }
@keyframes ao-cat-spin { to { transform:rotate(360deg); } }
@media(prefers-reduced-motion:reduce) { .ao-wait-cat { animation:none; } }
@keyframes ao-cat-float { 50% { transform:translateY(-2px) rotate(-5deg); } }
@keyframes ao-cat-bob { 50% { transform:translateY(-5px) rotate(-1deg); } }
@keyframes ao-cat-spark { 0% { opacity:0; transform:translate(0,0) scale(.3); } 20% { opacity:.9; transform:translate(calc((var(--star) - 2) * 4px),-8px) rotate(20deg) scale(1); } 100% { opacity:0; transform:translate(calc((var(--star) - 2) * 14px),-42px) rotate(100deg) scale(.35); } }
@keyframes ao-gallery-in { from { opacity:0; } to { opacity:.7; } }
@keyframes ao-card-in { from { opacity:.3; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
@keyframes ao-pop-in { from { opacity:0; transform:translateX(-50%) translateY(8px) scale(.75) rotate(-5deg); } to { opacity:1; transform:translateX(-50%) translateY(0) scale(1) rotate(0); } }
@media(prefers-reduced-motion:reduce) { .ao-root * { animation:none!important; transition:none!important; } }
.ao-root.ao-hotbar { position:fixed; z-index:10000; width:min(340px, calc(var(--app-scaled-viewport-width, 100vw) - 16px)); height:auto; max-height:calc(var(--app-scaled-viewport-height, 100vh) * .75); overflow:auto; display:flex; gap:4px; padding:10px; border:1px solid var(--ao-line); border-radius:18px; background:color-mix(in srgb,var(--ao-panel) 96%,transparent); box-shadow:0 12px 40px #0006; backdrop-filter:blur(18px); animation:ao-card-in .18s ease-out; }
.ao-hotbar-title { display:flex; align-items:center; gap:8px; padding:5px 8px; font-size:12px; color:var(--ao-muted); }
.ao-hotbar .ao-button { width:100%; text-align:left; padding:9px 10px; border:1px solid transparent; border-radius:12px; box-shadow:none; background:transparent; }
.ao-hotbar .ao-button:hover { background:color-mix(in srgb,var(--ao-accent) 10%,transparent); }
.ao-hotbar .ao-button:focus-visible { outline:2px solid var(--ao-accent); outline-offset:-2px; }
.ao-hotbar .ao-hotbar-profile { display:flex; align-items:center; gap:10px; font-size:13px; }
.ao-hotbar-profile > span:last-child { min-width:0; overflow-wrap:anywhere; }
.ao-hotbar-profile[aria-checked=true] { border-color:var(--ao-line); color:var(--ao-accent); background:color-mix(in srgb,var(--ao-accent) 7%,transparent); }
.ao-hotbar-state { font-size:10px; font-weight:700; min-width:22px; opacity:.7; }
.ao-hotbar .ao-hotbar-required:disabled { opacity:1; cursor:default; }
.ao-hotbar-hint { margin:6px 8px; font-size:10px; color:var(--ao-muted); }
.ao-hotbar .ao-hotbar-manage { color:var(--ao-accent); border-top:1px solid var(--ao-line); border-radius:0 0 10px 10px; }
.ao-hotbar-trigger { position:relative; display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; padding:5px; border:0; border-radius:8px; background:transparent; color:var(--lumiverse-text-muted,#b7afc5); cursor:pointer; transition:background .18s,color .18s; }
.ao-hotbar-trigger .ao-cat-icon { width:24px; height:24px; }
.ao-hotbar-trigger:hover,.ao-hotbar-trigger[aria-expanded=true] { color:var(--lumiverse-primary-text,#d3b4ff); background:color-mix(in srgb,currentColor 12%,transparent); }
.ao-hotbar-trigger:focus-visible { outline:2px solid var(--lumiverse-primary-text,#d3b4ff); outline-offset:2px; }
.ao-hotbar-trigger[data-enabled=true]::after { content:""; position:absolute; right:3px; top:3px; width:4px; height:4px; border-radius:50%; background:var(--lumiverse-success,var(--lumiverse-primary-text,#b5a2d9)); }
`;

// src/ui/layout.ts
function uiScale() {
  const value = Number.parseFloat(document.defaultView?.getComputedStyle(document.documentElement).getPropertyValue("--lumiverse-ui-scale") ?? "");
  return Number.isFinite(value) && value > 0 ? value : 1;
}

// src/ui/profile-drag.ts
function profileDrag(list, save) {
  let active;
  const animations = new Map;
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rows = () => Array.from(list.children).filter((row) => row.classList.contains("ao-slot"));
  const positions = () => new Map(rows().map((row) => [row, row.getBoundingClientRect().top]));
  const animate = (before) => {
    for (const row of rows()) {
      if (row === active?.row)
        continue;
      animations.get(row)?.cancel();
      const delta = ((before.get(row) ?? row.getBoundingClientRect().top) - row.getBoundingClientRect().top) / uiScale();
      if (Math.abs(delta) > 1 && !reducedMotion && typeof row.animate === "function") {
        const animation = row.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
        animation.finished.catch(() => {});
        animations.set(row, animation);
      }
    }
  };
  const finish = (commit) => {
    const drag = active;
    active = undefined;
    if (!drag)
      return;
    if (drag.gap) {
      list.insertBefore(drag.row, drag.gap);
      drag.gap.remove();
    }
    drag.row.style.cssText = drag.style;
    drag.row.classList.remove("ao-dragging");
    if (drag.handle.hasPointerCapture(drag.pointer))
      drag.handle.releasePointerCapture(drag.pointer);
    if (!commit) {
      for (const row of drag.order)
        list.append(row);
      return;
    }
    const order = rows();
    if (drag.moved && drag.order.some((row, i) => order[i] !== row))
      save(order.map((row) => row.dataset.slotId));
  };
  const down = (event) => {
    const handle = event.target.closest(".ao-drag-handle");
    if (!handle || handle.matches(":disabled") || event.button !== 0 || !event.isPrimary)
      return;
    const row = handle.closest(".ao-slot");
    active = {
      row,
      handle,
      pointer: event.pointerId,
      y: event.clientY,
      offset: event.clientY - row.getBoundingClientRect().top,
      moved: false,
      order: rows(),
      style: row.style.cssText
    };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event) => {
    if (!active || event.pointerId !== active.pointer)
      return;
    const drag = active;
    if (!drag.moved && Math.abs(event.clientY - drag.y) < 5)
      return;
    if (!drag.moved) {
      const rect = drag.row.getBoundingClientRect();
      drag.moved = true;
      drag.gap = el("div", "ao-drag-gap");
      drag.gap.style.height = `${rect.height / uiScale()}px`;
      drag.gap.setAttribute("aria-hidden", "true");
      drag.gap.append(catIcon(), el("span", "", "Drop here"));
      list.insertBefore(drag.gap, drag.row);
      list.append(drag.row);
      Object.assign(drag.row.style, { position: "absolute", left: "0", width: `${rect.width / uiScale()}px`, height: `${rect.height / uiScale()}px`, pointerEvents: "none" });
      drag.row.classList.add("ao-dragging");
      drag.handle.setPointerCapture(event.pointerId);
    }
    drag.row.style.top = `${(event.clientY - list.getBoundingClientRect().top - drag.offset) / uiScale()}px`;
    const before = rows().find((row) => row !== drag.row && event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    if (drag.gap.nextElementSibling !== before && (before || drag.gap.nextElementSibling !== drag.row)) {
      const old = positions();
      list.insertBefore(drag.gap, before || drag.row);
      animate(old);
    }
    const scroll = list.closest(".ao-content");
    if (scroll) {
      const rect = scroll.getBoundingClientRect();
      if (event.clientY < rect.top + 45)
        scroll.scrollTop -= 12;
      if (event.clientY > rect.bottom - 45)
        scroll.scrollTop += 12;
    }
    event.preventDefault();
  };
  const up = (event) => {
    if (event.pointerId === active?.pointer)
      finish(true);
  };
  const cancel = () => finish(false);
  list.addEventListener("pointerdown", down);
  list.addEventListener("pointermove", move);
  list.addEventListener("pointerup", up);
  list.addEventListener("pointercancel", cancel);
  list.addEventListener("lostpointercapture", cancel);
  return () => {
    cancel();
    for (const animation of animations.values())
      animation.cancel();
    animations.clear();
    list.removeEventListener("pointerdown", down);
    list.removeEventListener("pointermove", move);
    list.removeEventListener("pointerup", up);
    list.removeEventListener("pointercancel", cancel);
    list.removeEventListener("lostpointercapture", cancel);
  };
}

// src/ui/tabs/settings-tab.ts
function renderSettings(host, catalog, locked, saving, actions) {
  const sequence = el("section");
  const intro = el("div", "ao-settings-intro");
  const hint = el("p", "ao-pill ao-hint", "One swipe is generated per profile.");
  hint.prepend(catIcon());
  intro.append(hint, el("span", "ao-pill ao-count", `${catalog.settings.slots.length} / ${MAX_SWIPES} profiles`));
  sequence.append(intro);
  if (!catalog.settings.slots.length)
    sequence.append(el("p", "ao-empty ao-pill", "Add a profile to get started."));
  const rows = el("div", "ao-slots");
  rows.setAttribute("role", "list");
  rows.setAttribute("aria-label", "Swipe profiles");
  const timers = [];
  const change = (fn) => {
    const next = structuredClone(catalog.settings);
    fn(next);
    actions.save(next);
  };
  for (const [index, slot] of catalog.settings.slots.entries()) {
    const row = el("div", "ao-slot");
    row.dataset.slotId = slot.id;
    row.setAttribute("role", "listitem");
    row.setAttribute("aria-label", `Profile ${index + 1}`);
    const heading = el("div", "ao-slot-heading");
    const name = el("span", "ao-slot-name");
    name.append(catIcon("ao-cat-icon", "settings"), el("span", "", `Profile ${index + 1}`));
    heading.append(name);
    const controls = el("div", "ao-slot-controls");
    const move = (direction) => change((s) => {
      [s.slots[index], s.slots[index + direction]] = [s.slots[index + direction], s.slots[index]];
    });
    const drag = button("⠿", () => {}, "ao-small ao-drag-handle", locked || saving);
    drag.setAttribute("aria-label", `Drag profile ${index + 1} to reorder`);
    drag.title = "Drag to reorder, or use the Up and Down keys.";
    drag.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" && index > 0 || event.key === "ArrowDown" && index < catalog.settings.slots.length - 1) {
        event.preventDefault();
        move(event.key === "ArrowUp" ? -1 : 1);
      }
    });
    const remove = button("×", () => change((s) => {
      s.slots.splice(index, 1);
    }), "ao-small", locked || saving);
    remove.setAttribute("aria-label", `Remove profile ${index + 1}`);
    controls.append(drag, remove);
    heading.append(controls);
    row.append(heading);
    const presets = [{ id: "", name: "Choose a preset…" }, ...catalog.presets];
    if (slot.presetId && !catalog.presets.some((p) => p.id === slot.presetId))
      presets.push({ id: slot.presetId, name: "Unavailable preset — choose another" });
    row.append(select("Preset", slot.presetId, presets, (id) => change((s) => {
      s.slots[index].presetId = id;
    }), locked || saving));
    const connections = [{ id: "", name: "Connection active when enabled" }, ...catalog.connections.map((c) => ({ id: c.id, name: c.model ? `${c.name} · ${c.model}` : c.name }))];
    if (slot.connectionId && !catalog.connections.some((c) => c.id === slot.connectionId))
      connections.push({ id: slot.connectionId, name: "Unavailable connection — choose another" });
    row.append(select("Connection", slot.connectionId || "", connections, (id) => change((s) => {
      s.slots[index].connectionId = id || null;
    }), locked || saving));
    if (locked) {
      const cover = button("", () => {
        row.querySelector(".ao-lock-tip")?.remove();
        const tip = el("div", "ao-lock-tip ao-pill", "Disable to edit profiles.");
        tip.setAttribute("role", "status");
        tip.prepend(catIcon());
        row.append(tip);
        timers.push(setTimeout(() => tip.remove(), 3000));
      }, "ao-lock-cover");
      cover.setAttribute("aria-label", `Edit profile ${index + 1}: disable to edit profiles`);
      row.append(cover);
    }
    rows.append(row);
  }
  sequence.append(rows);
  const actionsRow = el("div", "ao-actions");
  actionsRow.append(button("Add profile", () => change((s) => {
    const preset = catalog.presets.find((p) => !s.slots.some((slot) => slot.presetId === p.id)) ?? catalog.presets[0];
    s.slots.push({ id: randomId(), presetId: preset?.id || "", connectionId: null });
  }), "", locked || saving || catalog.settings.slots.length >= MAX_SWIPES), button("Refresh lists", actions.reload, "", locked || saving));
  sequence.append(actionsRow);
  const credits = el("a", "ao-icon-credits", "Icon credits");
  credits.href = "https://github.com/AMousePad/CAT/blob/main/CREDITS.md";
  credits.target = "_blank";
  credits.rel = "noopener noreferrer";
  sequence.append(credits);
  host.append(sequence);
  const removeDrag = profileDrag(rows, (ids) => change((s) => {
    s.slots = ids.map((id) => s.slots.find((slot) => slot.id === id));
  }));
  return () => {
    removeDrag();
    for (const timer of timers)
      clearTimeout(timer);
  };
}

// src/ui/tabs/swipes-tab.ts
function renderSwipes(host, view, history, stop, canStop, open, opening = false, latestMessageId, chatId, messages) {
  const status = el("div", `ao-status ao-pill ao-${view.phase}`);
  status.setAttribute("role", "status");
  status.append(catIcon(), el("span", "ao-dot"), el("p", "ao-status-text", view.detail));
  if (canStop && (view.phase === "running" || view.phase === "preparing"))
    status.append(button("Stop", stop, "ao-small"));
  host.append(status);
  if (!chatId)
    return;
  const currentRun = view.run?.chatId === chatId ? view.run : null;
  const chatHistory = history.filter((run) => run.chatId === chatId && run.id !== currentRun?.id);
  const runs = (currentRun ? [currentRun, ...chatHistory] : chatHistory).filter((run) => run.messageId && messages?.get(run.messageId) !== null);
  if (!runs.length) {
    const empty = el("p", "ao-empty ao-pill", "No swipes yet.");
    empty.prepend(catIcon());
    host.append(empty);
    return;
  }
  for (const run of runs) {
    const latest = run.messageId === latestMessageId && run.chatId === chatId;
    const card = el("article", "ao-run");
    if (!latest)
      card.classList.add("ao-run-past");
    const head = el("header", "ao-run-head");
    const message = messages?.get(run.messageId);
    const messageIndex = message?.index ?? run.messageIndex;
    const label = typeof messageIndex === "number" ? `#${messageIndex}` : "#…";
    const title = el("div", "ao-run-title");
    title.append(el("strong", "ao-pill ao-count", label));
    const time = el("time", "ao-pill ao-run-date", new Date(run.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }));
    time.dateTime = new Date(run.at).toISOString();
    title.append(el("span", "ao-pill ao-run-character", message?.name || run.characterName || "Assistant"), time);
    head.append(title);
    card.append(head);
    for (const [index, step] of run.steps.entries()) {
      const row = el("button", "ao-step");
      row.type = "button";
      row.disabled = !latest || opening || !run.messageId || step.status === "waiting";
      row.setAttribute("aria-label", `Open swipe ${index + 1}, ${step.presetName}`);
      row.addEventListener("click", () => open(run, index));
      row.append(el("span", "ao-step-number", String(index + 1)));
      const body = el("div", "ao-step-copy");
      body.append(el("strong", "", step.presetName), el("small", "", step.connectionName));
      row.append(body);
      if (step.status !== "done" && step.status !== "stopped")
        row.append(el("span", `ao-step-state ao-step-${step.status}`, step.status));
      card.append(row);
      if (step.error)
        card.append(el("p", "ao-muted", step.error));
    }
    if (run.detail && run.outcome !== "stopped")
      card.append(el("p", "ao-muted", run.detail));
    host.append(card);
  }
}

// src/ui/hotbar.ts
class SwipeHotbar {
  options;
  selected;
  panel;
  anchor;
  busy = false;
  focusProfile;
  disposed = false;
  action;
  unsubscribe;
  layoutUnsubscribe;
  trigger;
  constructor(ctx, options) {
    this.options = options;
    this.action = ctx.ui.registerInputBarAction({
      id: "another_one_profiles",
      label: "Concurrent Alternate Trajectories",
      subtitle: "Choose which profiles generate swipes",
      iconSvg: ICON
    });
    this.unsubscribe = this.action.onClick(() => {
      this.options.refreshCats();
      this.close();
      this.open();
    });
    this.layoutUnsubscribe = ctx.state.subscribe("ui.layout", () => this.position());
    this.trigger = button("", () => {
      this.options.refreshCats();
      if (this.panel)
        this.close();
      else
        this.open();
    }, "ao-hotbar-trigger");
    this.trigger.append(catIcon());
    this.trigger.title = "Concurrent Alternate Trajectories";
    this.trigger.setAttribute("aria-label", "Concurrent Alternate Trajectories");
    this.trigger.setAttribute("aria-haspopup", "dialog");
    this.trigger.setAttribute("aria-expanded", "false");
    ctx.ui.mount("chat_actions").append(this.trigger);
    document.addEventListener("pointerdown", this.outside, true);
    document.addEventListener("keydown", this.keydown, true);
  }
  get ids() {
    return this.selected ? [...this.selected] : undefined;
  }
  restore(ids) {
    this.selected = ids ? [...ids] : undefined;
    this.update();
  }
  update() {
    this.trigger.dataset.enabled = String(this.options.enabled());
    const catalog = this.options.catalog();
    if (this.selected && catalog) {
      this.selected = this.selected.filter((id) => catalog.settings.slots.some((s) => s.id === id));
      if (!this.selected.length)
        this.selected = undefined;
    }
    if (this.panel)
      this.render();
  }
  open() {
    this.anchor = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined;
    this.panel = el("div", "ao-root ao-hotbar");
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Swipe profiles");
    this.panel.addEventListener("click", () => this.options.refreshCats());
    document.body.append(this.panel);
    this.render();
    this.trigger.setAttribute("aria-expanded", "true");
    this.position();
    this.panel.querySelector("button")?.focus();
  }
  position() {
    if (!this.panel)
      return;
    const scale = uiScale(), width = window.innerWidth / scale, height = window.innerHeight / scale;
    const rect = this.anchor?.getBoundingClientRect();
    this.panel.style.left = `${Math.max(8, Math.min(width - this.panel.offsetWidth - 8, rect ? rect.left / scale : width - 300))}px`;
    this.panel.style.bottom = `${Math.max(8, Math.min(height - this.panel.offsetHeight - 8, height - (rect ? rect.top / scale : height - 80) + 8))}px`;
  }
  render() {
    const panel = this.panel;
    const focusId = document.activeElement?.dataset.profile ?? this.focusProfile;
    panel.replaceChildren();
    const title = el("div", "ao-hotbar-title", "Swipe profiles");
    title.prepend(catIcon());
    panel.append(title);
    const enabled = this.options.enabled();
    panel.append(button(enabled ? "Disable CAT" : "Enable CAT", () => {
      this.toggle();
    }, "ao-hotbar-enable", this.busy));
    const catalog = this.options.catalog(), slots = catalog?.settings.slots ?? [];
    const ids = this.selected ?? slots.map((s) => s.id);
    for (const [index, slot] of slots.entries()) {
      const on = ids.includes(slot.id);
      const row = button("", () => {
        this.choose(slot.id);
      }, "ao-hotbar-profile", this.busy || on && ids.length === 1);
      row.dataset.profile = slot.id;
      row.setAttribute("role", "checkbox");
      row.setAttribute("aria-checked", String(on));
      if (on && ids.length === 1) {
        row.classList.add("ao-hotbar-required");
        row.title = "Keep at least one profile enabled.";
      }
      row.append(catIcon("ao-cat-icon", index % 2 ? "settings" : "swipes"), el("span", "ao-hotbar-state", on ? "ON" : "OFF"), el("span", "", catalog?.presets.find((p) => p.id === slot.presetId)?.name || `Profile ${index + 1}`));
      panel.append(row);
    }
    if (!slots.length)
      panel.append(el("p", "ao-muted", "Add profiles in Settings."));
    panel.append(el("p", "ao-hotbar-hint", "Keeps your selection for following sends."), button("Manage profiles", () => {
      this.close();
      this.options.manage();
    }, "ao-hotbar-manage"));
    if (focusId)
      Array.from(panel.querySelectorAll("[data-profile]")).find((b) => b.dataset.profile === focusId)?.focus();
    this.position();
  }
  async toggle() {
    this.busy = true;
    this.render();
    try {
      await this.options.toggle();
    } catch (error) {
      this.options.error(error);
    } finally {
      this.busy = false;
      if (!this.disposed && this.panel)
        this.render();
    }
  }
  async choose(id) {
    const slots = this.options.catalog()?.settings.slots ?? [];
    const previous = this.ids;
    const current = this.selected ?? slots.map((s) => s.id);
    const next = current.includes(id) ? current.filter((value) => value !== id) : slots.filter((s) => s.id === id || current.includes(s.id)).map((s) => s.id);
    if (!next.length || this.busy)
      return;
    this.focusProfile = id;
    this.selected = next;
    this.busy = true;
    this.render();
    try {
      await this.options.select(next);
    } catch (error) {
      this.selected = previous;
      this.options.error(error);
    } finally {
      this.busy = false;
      if (!this.disposed && this.panel)
        this.render();
    }
  }
  outside = (event) => {
    if (this.panel && !this.panel.contains(event.target) && !this.anchor?.contains(event.target))
      this.close();
  };
  keydown = (event) => {
    if (!this.panel)
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      this.anchor?.focus();
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const buttons = Array.from(this.panel.querySelectorAll("button:not(:disabled)"));
      const i = buttons.indexOf(document.activeElement);
      buttons[(i + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  };
  close() {
    this.panel?.remove();
    this.panel = undefined;
    this.focusProfile = undefined;
    this.trigger?.setAttribute("aria-expanded", "false");
  }
  dispose() {
    this.disposed = true;
    this.close();
    this.trigger.remove();
    this.unsubscribe();
    this.layoutUnsubscribe();
    this.action.destroy();
    document.removeEventListener("pointerdown", this.outside, true);
    document.removeEventListener("keydown", this.keydown, true);
  }
}

// src/ui/composer-stop.ts
var ATTRIBUTES = ["title", "aria-label"];
var LABEL = "Stop parallel swipes";

class ComposerStop {
  document;
  currentChat;
  stop;
  chatId = null;
  root = null;
  button = null;
  original = new Map;
  stopping = false;
  observer;
  events = ["click", "pointerdown", "pointerup", "pointercancel", "keydown"];
  constructor(document2, currentChat, stop) {
    this.document = document2;
    this.currentChat = currentChat;
    this.stop = stop;
    this.observer = new document2.defaultView.MutationObserver((records) => {
      if (!this.button?.isConnected || records.some((record) => this.root?.contains(record.target)))
        this.sync(records);
    });
  }
  update(chatId) {
    if (chatId === this.chatId)
      return;
    this.dispose();
    this.chatId = chatId;
    this.stopping = false;
    if (!chatId)
      return;
    for (const name of this.events)
      this.document.defaultView.addEventListener(name, this.handle, { capture: true, passive: false });
    this.sync([]);
  }
  remember(records) {
    for (const record of records)
      if (record.target === this.button && this.original.has(record.attributeName)) {
        this.original.set(record.attributeName, this.button.getAttribute(record.attributeName));
      }
  }
  restore() {
    if (this.button) {
      for (const [name, value] of this.original)
        if (this.button.getAttribute(name) === LABEL)
          this.setAttribute(name, value);
      this.button.removeAttribute("data-cat-stop");
    }
    this.original.clear();
    this.button = null;
    this.root = null;
  }
  setAttribute(name, value) {
    if (value === null)
      this.button.removeAttribute(name);
    else
      this.button.setAttribute(name, value);
  }
  sync(records) {
    this.remember(records);
    this.observer.disconnect();
    let button = null;
    let root = null;
    for (const anchor of this.document.querySelectorAll('[data-spindle-mount="chat_input_tools_right"]')) {
      if (anchor.getAttribute("data-spindle-scope") !== `chat:${this.chatId}:input-tools-right`)
        continue;
      root = anchor.closest('[data-component="InputArea"]');
      const shell = anchor.previousElementSibling;
      const buttons = shell?.querySelectorAll(":scope > button");
      if (root?.querySelector('textarea[name="chat-message"]') && buttons?.length === 1) {
        button = buttons[0];
        break;
      }
    }
    if (button !== this.button) {
      this.restore();
      this.button = button;
      this.root = button ? root : null;
      if (button)
        for (const name of ATTRIBUTES)
          this.original.set(name, button.getAttribute(name));
    }
    if (this.button) {
      this.button.setAttribute("data-cat-stop", "");
      for (const name of ATTRIBUTES)
        if (this.button.getAttribute(name) !== LABEL)
          this.setAttribute(name, LABEL);
    }
    if (this.chatId)
      this.observer.observe(this.document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [...ATTRIBUTES, "data-cat-stop"]
      });
  }
  handle = (event) => {
    if (!this.chatId || this.currentChat() !== this.chatId)
      return;
    if (!this.button?.isConnected)
      this.sync(this.observer.takeRecords());
    const target = event.target;
    let stop = false;
    if (event.type === "keydown") {
      const key = event;
      if (key.isComposing || key.keyCode === 229)
        return;
      if (key.key === "Escape")
        stop = true;
      else if (key.key === "Enter" && target === this.root?.querySelector('textarea[name="chat-message"]')) {
        if (key.shiftKey && !key.ctrlKey && !key.metaKey)
          return;
      } else
        return;
    } else {
      if (!target || !this.button?.contains(target))
        return;
      if (event.type !== "click") {
        event.stopImmediatePropagation();
        return;
      }
      stop = true;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (stop && !this.stopping) {
      this.stopping = true;
      this.stop();
    }
  };
  dispose() {
    this.remember(this.observer.takeRecords());
    this.observer.disconnect();
    for (const name of this.events)
      this.document.defaultView.removeEventListener(name, this.handle, true);
    this.restore();
    this.chatId = null;
  }
}

// src/ui/waiting-cat.ts
class WaitingCat {
  ctx;
  document;
  run = null;
  message = null;
  wrapper;
  observer;
  unsubs;
  constructor(ctx, document2) {
    this.ctx = ctx;
    this.document = document2;
    this.observer = new document2.defaultView.MutationObserver(() => this.render());
    this.unsubs = ["MESSAGE_SENT", "MESSAGE_EDITED", "SWIPE_EDITED", "MESSAGE_SWIPED"].map((event) => ctx.events.on(event, (raw) => {
      const { message, action } = raw;
      if (!message || message.chat_id !== this.ctx.state.get("chat.active").chatId)
        return;
      if (this.run ? message.id !== this.run.messageId : !message.extra?.spindle_metadata?.another_one_run)
        return;
      if (action === "deleted" || action === "added") {
        this.update(null);
        return;
      }
      this.message = message;
      this.render();
    }));
    this.unsubs.push(ctx.events.on("MESSAGE_DELETED", (raw) => {
      if (raw.messageId === this.run?.messageId)
        this.update(null);
    }));
  }
  update(view) {
    const run = view?.phase === "running" && view.run?.outcome === "running" && view.run.chatId === this.ctx.state.get("chat.active").chatId ? view.run : null;
    if (run?.messageId !== this.run?.messageId || run?.chatId !== this.run?.chatId) {
      if (!run || !this.message || this.message.id !== run.messageId || this.message.chat_id !== run.chatId)
        this.message = null;
      this.remove();
    }
    this.run = run;
    this.render();
  }
  render() {
    this.observer.disconnect();
    const message = this.message;
    const status = message && this.run?.steps[message.swipe_id]?.status;
    const reasoning = message?.extra?.reasoning;
    const waiting = this.run && message && (status === "running" || status === "waiting") && this.run.chatId === this.ctx.state.get("chat.active").chatId && !message.content.trim() && !(typeof reasoning === "string" && reasoning.trim());
    if (!waiting) {
      this.remove();
      return;
    }
    if (this.wrapper)
      return;
    const bubble = this.ctx.dom.findMessageElement(message.id);
    const target = bubble?.querySelector('[data-spindle-mount="message_body_before"]');
    if (!target) {
      this.observer.observe(this.document.body, { childList: true, subtree: true });
      return;
    }
    this.wrapper = this.ctx.dom.inject(target, '<div class="ao-waiting-cat" role="status"><span>Waiting For First Token...</span></div>', "beforeend");
    this.wrapper.querySelector(".ao-waiting-cat").prepend(catIcon("ao-wait-cat", "cat"));
  }
  remove() {
    this.observer.disconnect();
    if (this.wrapper) {
      this.ctx.dom.uninject(this.wrapper);
      this.wrapper = undefined;
    }
  }
  dispose() {
    this.update(null);
    for (const unsub of this.unsubs)
      unsub();
    this.unsubs = [];
  }
}

// src/ui/app.ts
function setup(ctx) {
  const removeStyle = ctx.dom.addStyle(STYLES);
  const tab = ctx.ui.registerDrawerTab({
    id: "another_one_tab",
    title: "Concurrent Alternate Trajectories",
    shortName: "CAT",
    iconSvg: NAVBAR_ICON,
    description: "Generate swipes using your configured profiles",
    keywords: ["swipes", "presets", "another one", "generation"]
  });
  const root = el("div", "ao-root");
  tab.root.append(root);
  const toggle = button("Enable", () => {
    toggleEnabled();
  }, "ao-toggle", true);
  const tabs = el("div", "ao-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Concurrent Alternate Trajectories");
  const toolbar = el("div", "ao-toolbar");
  toolbar.append(tabs, toggle);
  const notice = el("div", "ao-notice");
  notice.setAttribute("role", "status");
  const content = el("div", "ao-content");
  const body = el("div", "ao-body");
  body.id = "ao-tab-content";
  body.setAttribute("role", "tabpanel");
  body.tabIndex = 0;
  body.append(content);
  root.append(toolbar, notice, body);
  let disposed = false;
  let catalog = null;
  let activation = { enabled: false, revision: 0 };
  let history = [];
  let messages = new Map;
  let contextRevision = 0;
  let selected = "swipes";
  let saving = false;
  let toggling = false;
  let opening = false;
  let opened = false;
  let cleanupSettings;
  const bridge = new Bridge(ctx);
  const cat = new CatBackground(body);
  const refreshCats = () => {
    rotateCatIcons();
    cat.refresh();
  };
  root.addEventListener("click", (event) => {
    rotateCatIcons();
    const control = event.target.closest("button, summary");
    if (control && control.getAttribute("role") !== "tab")
      cat.refresh();
  });
  let controller;
  const composerStop = new ComposerStop(document, () => ctx.state.get("chat.active").chatId, () => {
    controller.disable("Stopped.", true);
  });
  const waitingCat = new WaitingCat(ctx, document);
  let hotbar;
  const tabButtons = [];
  const render = () => {
    if (disposed)
      return;
    const scroll = content.scrollTop;
    cleanupSettings?.();
    cleanupSettings = undefined;
    content.replaceChildren();
    cat.setGalleryActive(selected === "cat" && opened);
    const chatId = ctx.state.get("chat.active").chatId;
    const chatView = !chatId ? { phase: "off", detail: "Open a chat to see swipes.", run: null } : controller.view.run && controller.view.run.chatId !== chatId ? { phase: "off", detail: "Disabled", run: null } : controller.view;
    const view = chatId && activation.enabled && chatView.phase === "off" ? { ...chatView, phase: "ready", detail: "Enabled. Send a message to generate swipes." } : chatView;
    tab.setBadge(view.phase === "running" && view.run ? `${view.run.steps.filter((s) => s.status === "done").length}/${view.run.steps.length}` : activation.enabled ? "on" : null);
    toggle.textContent = activation.enabled ? "Disable" : "Enable";
    toggle.setAttribute("aria-pressed", String(activation.enabled));
    toggle.disabled = !catalog || saving || toggling || !activation.enabled && controller.enabled;
    for (const b of tabButtons) {
      const active = b.dataset.tab === selected;
      b.setAttribute("aria-selected", String(active));
      b.tabIndex = active ? 0 : -1;
    }
    body.setAttribute("aria-labelledby", `ao-tab-${selected}`);
    if (selected === "cat")
      return;
    if (!catalog) {
      content.append(el("p", "ao-empty ao-pill", "Loading presets and connections…"));
      return;
    }
    if (selected === "settings")
      cleanupSettings = renderSettings(content, catalog, activation.enabled || controller.enabled, saving, {
        save: (settings) => {
          save(settings);
        },
        reload: () => {
          load();
        }
      });
    else if (selected === "swipes")
      renderSwipes(content, view, history, () => {
        controller.disable("Stopped.", true);
      }, controller.armed || controller.view.phase === "running", (run, stepIndex) => {
        openSwipe(run, stepIndex);
      }, opening, ctx.messages.getLatestMessageId(), chatId, messages);
    content.scrollTop = scroll;
  };
  try {
    controller = new Session(ctx, bridge, (view) => {
      composerStop.update(controller.generatingChatId);
      waitingCat.update(view);
      if (view.run && view.run.outcome !== "running")
        history = [structuredClone(view.run), ...history.filter((r) => r.id !== view.run.id)].slice(0, 20);
      notice.textContent = view.phase === "error" && selected !== "swipes" ? view.detail : "";
      render();
      hotbar?.update();
    });
  } catch (error) {
    content.append(el("p", "ao-muted", errorText(error)));
    return () => {
      waitingCat.dispose();
      composerStop.dispose();
      cat.dispose();
      bridge.dispose();
      tab.destroy();
      removeStyle();
    };
  }
  for (const [id, label] of [["swipes", "Swipes"], ["settings", "Settings"], ["cat", "CAT"]]) {
    const b = button(label, () => {
      const leavingCats = selected === "cat";
      selected = id;
      render();
      content.scrollTop = 0;
      if (!leavingCats && id !== "cat")
        cat.refresh();
    }, "ao-tab");
    b.prepend(catIcon("ao-cat-icon", id));
    b.className = "ao-tab";
    b.id = `ao-tab-${id}`;
    b.dataset.tab = id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", body.id);
    tabs.append(b);
    tabButtons.push(b);
  }
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      return;
    event.preventDefault();
    const index = tabButtons.findIndex((b) => b.dataset.tab === selected);
    const next = tabButtons[(index + (event.key === "ArrowRight" ? 1 : tabButtons.length - 1)) % tabButtons.length];
    next.click();
    next.focus();
  });
  async function toggleEnabled() {
    if (!catalog || toggling)
      return;
    toggling = true;
    render();
    try {
      if (activation.enabled)
        applyActivation(await bridge.call("activation", { enabled: false }));
      else {
        await controller.enable(catalog, hotbar?.ids);
        if (controller.armed && !disposed)
          applyActivation(await bridge.call("activation", { enabled: true, slotIds: hotbar?.ids ?? null }));
      }
    } catch (error) {
      if (!activation.enabled && controller.armed)
        await controller.disable("Could not save enabled state.", true);
      if (!disposed)
        notice.textContent = errorText(error);
    } finally {
      toggling = false;
      render();
    }
  }
  function applyActivation(next) {
    if (disposed || next.revision < activation.revision)
      return;
    activation = next;
    hotbar?.restore(next.slotIds);
    render();
  }
  async function openSwipe(run, stepIndex) {
    if (opening)
      return;
    opening = true;
    notice.textContent = "";
    render();
    try {
      await controller.openSwipe(run, stepIndex);
    } catch (error) {
      if (!disposed)
        notice.textContent = errorText(error);
    } finally {
      opening = false;
      render();
    }
  }
  async function load() {
    notice.replaceChildren();
    const chatId = ctx.state.get("chat.active").chatId;
    const revision = contextRevision;
    try {
      const next = await bridge.call("load", { ...chatId ? { chatId } : {} });
      if (disposed)
        return;
      catalog = next;
      if (revision === contextRevision && ctx.state.get("chat.active").chatId === chatId)
        history = next.history;
      applyActivation(next.activation);
      cat.setEnabled(next.settings.cats);
      if (opened)
        cat.show();
      render();
      hotbar?.update();
    } catch (error) {
      if (disposed)
        return;
      notice.textContent = errorText(error);
      notice.append(button("Retry", () => {
        load();
      }, "ao-small"));
    }
  }
  async function save(settings) {
    if (!catalog || saving)
      return;
    saving = true;
    notice.textContent = "Saving…";
    render();
    try {
      const saved = await bridge.call("save", { settings });
      if (disposed)
        return;
      catalog.settings = saved;
      cat.setEnabled(saved.cats);
      if (opened)
        cat.show();
      notice.textContent = "";
      hotbar?.update();
    } catch (error) {
      if (!disposed)
        notice.textContent = errorText(error);
    } finally {
      saving = false;
      render();
    }
  }
  const stopAction = ctx.ui.registerInputBarAction({ id: "another_one_stop", label: "Stop parallel swipes", subtitle: "Stop all CAT requests", iconSvg: ICON, enabled: false });
  hotbar = new SwipeHotbar(ctx, {
    catalog: () => catalog,
    enabled: () => activation.enabled,
    toggle: toggleEnabled,
    select: async (slotIds) => {
      applyActivation(await bridge.call("activation", { slotIds }));
    },
    manage: () => {
      selected = "settings";
      render();
      tab.activate();
    },
    refreshCats,
    error: (error) => {
      notice.textContent = errorText(error);
    }
  });
  const updateStopAction = ctx.onBackendMessage((raw) => {
    const message = raw;
    if (message.type === "activation" && message.activation)
      applyActivation(message.activation);
    if (message.type === "view")
      stopAction.setEnabled(message.view?.phase === "running" || message.view?.phase === "preparing");
    if (message.type === "historyChanged") {
      load();
      restoreContexts();
    }
    if (message.type === "variableError")
      notice.textContent = message.error || "The selected swipe's variables could not be applied.";
  });
  let lastMessage = ctx.messages.getLatestMessageId();
  const restoreContexts = () => {
    const revision = ++contextRevision;
    const { chatId } = ctx.state.get("chat.active");
    if (chatId && ctx.host.capabilities["message-preset-context-v1"])
      bridge.call("restoreContexts", { chatId }).then((result) => {
        if (disposed || revision !== contextRevision || ctx.state.get("chat.active").chatId !== chatId)
          return;
        for (const [id, summary] of Object.entries(result.messages))
          messages.set(id, summary);
        history = result.history;
        render();
      }).catch((error) => {
        if (!disposed && revision === contextRevision && ctx.state.get("chat.active").chatId === chatId)
          notice.textContent = errorText(error);
      });
  };
  const messageChanged = () => queueMicrotask(() => {
    const latest = ctx.messages.getLatestMessageId();
    if (latest !== lastMessage) {
      lastMessage = latest;
      if (selected === "swipes")
        render();
    }
  });
  const unsubs = [
    updateStopAction,
    stopAction.onClick(() => {
      controller.disable("Stopped.", true);
    }),
    tab.onActivate(() => {
      opened = true;
      refreshCatIcons(root);
      cat.show();
      render();
    }),
    ctx.state.subscribe("ui.drawer", (value) => {
      const drawer = value;
      opened = drawer.open && drawer.tabId === tab.tabId;
      cat.setGalleryActive(selected === "cat" && opened);
      if (opened)
        cat.show();
    }),
    ctx.events.on("__ws_close", () => controller.disconnected()),
    ctx.events.on("CONNECTED", (raw) => {
      if (raw.role) {
        load();
        restoreContexts();
      }
    }),
    ctx.state.subscribe("chat.active", () => {
      messages.clear();
      waitingCat.update(null);
      composerStop.update(controller.generatingChatId);
      controller.chatChanged();
      render();
      restoreContexts();
    }),
    ctx.events.on("MESSAGE_SENT", messageChanged),
    ctx.events.on("MESSAGE_DELETED", (raw) => {
      const event = raw;
      history = history.filter((run) => run.chatId !== event.chatId || run.messageId !== event.messageId);
      controller.messageDeleted(event.chatId, event.messageId);
      if (ctx.state.get("chat.active").chatId === event.chatId) {
        contextRevision++;
        messages.set(event.messageId, null);
        render();
      }
      messageChanged();
    })
  ];
  const drawer = ctx.state.get("ui.drawer");
  opened = drawer.open && drawer.tabId === tab.tabId;
  load();
  render();
  restoreContexts();
  return () => {
    disposed = true;
    waitingCat.dispose();
    composerStop.dispose();
    cleanupSettings?.();
    for (const unsub of unsubs)
      unsub();
    controller.dispose().finally(() => bridge.dispose());
    hotbar?.dispose();
    cat.dispose();
    stopAction.destroy();
    tab.destroy();
    removeStyle();
  };
}
export {
  setup
};
