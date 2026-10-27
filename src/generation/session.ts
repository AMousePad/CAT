import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import type { Bridge } from "../ui/bridge";
import { hostDriver } from "./host";
import { errorText, type Catalog, type RunRecord, type ViewState } from "../shared";
import type { Preparation } from "../types";
import type { PreparedPrompt } from "./parallel-run";

/** Same-origin authenticated host routes; credentials never leave Lumiverse. */
export async function hostRequest(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`/api/v1/${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Lumiverse returned ${response.status}.`);
  return value;
}

export class Session {
  view: ViewState = { phase: "off", detail: "Disabled", run: null };
  armed = false;
  private chatId: string | null = null;
  private heartbeat?: ReturnType<typeof setInterval>;
  private preparing?: AbortController;
  private preparation?: Promise<void>;
  private unsubscribe: () => void;
  private disposed = false;
  private driver;
  private changingChat = false;
  private navigation = 0;
  private viewRevision = 0;
  constructor(private ctx: SpindleFrontendContext, private bridge: Bridge, private changed: (view: ViewState) => void) {
    this.driver = hostDriver(ctx);
    this.unsubscribe = ctx.onBackendMessage(raw => {
      const message = raw as { type: string; view?: ViewState; armed?: boolean };
      if (message.type === "view" && message.view) {
        if (this.changingChat) return;
        this.viewRevision++;
        this.armed = message.armed === true; this.view = message.view;
        if (this.armed) { this.chatId = this.driver.chatId(); this.startHeartbeat(); }
        if (!this.armed && this.view.phase !== "running") {
          this.preparing?.abort(); clearInterval(this.heartbeat); this.heartbeat = undefined;
        }
        this.changed(this.view);
      } else if (message.type === "prepare") this.preparation = this.prepare(raw as Preparation);
    });
  }
  get generatingChatId(): string | null {
    if (this.disposed || this.changingChat || this.driver.chatId() !== this.chatId) return null;
    return this.view.phase === "running" || this.view.phase === "stopping" || (this.armed && this.view.phase === "preparing") ? this.chatId : null;
  }
  private startHeartbeat() {
    if (this.heartbeat || this.disposed) return;
    this.heartbeat = setInterval(() => { void this.bridge.call("heartbeat", {}).then(ok => {
      if (!ok && this.enabled) void this.disable("Control was lost.", true);
    }).catch(error => { this.preparing?.abort(); this.showError(error); }); }, 15_000);
  }
  disconnected() {
    this.navigation++; this.changingChat = false; this.armed = false;
    this.preparing?.abort(); clearInterval(this.heartbeat); this.heartbeat = undefined;
    this.view = { phase: "off", detail: "Disconnected. Waiting to reconnect.", run: null }; this.changed(this.view);
  }
  messageDeleted(chatId: string, messageId: string) {
    if (this.view.run?.chatId !== chatId || this.view.run.messageId !== messageId) return;
    this.viewRevision++;
    this.view = { ...this.view, run: null }; this.changed(this.view);
  }
  get enabled() { return this.armed || ["preparing", "running", "stopping"].includes(this.view.phase); }
  async openSwipe(run: RunRecord, stepIndex: number) {
    if (!run.messageId || !run.steps[stepIndex]) return;
    if (this.disposed) return;
    if (this.enabled && this.driver.chatId() !== run.chatId) await this.disable("Chat changed.", true);
    await this.driver.openChat(run.chatId);
    if (this.disposed || this.driver.chatId() !== run.chatId) return;
    await this.bridge.call("selectSwipe", { chatId: run.chatId, runId: run.id, stepIndex });
    if (this.disposed || this.driver.chatId() !== run.chatId) return;
    this.ctx.dom.findMessageElement(run.messageId)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  private showError(error: unknown) { if (!this.disposed) { this.view = { ...this.view, phase: "error", detail: errorText(error) }; this.changed(this.view); } }
  async enable(catalog: Catalog, slotIds?: string[]) {
    if (this.enabled || this.disposed) return;
    const navigation = ++this.navigation;
    this.chatId = this.driver.chatId();
    const chatId = this.chatId;
    if (!chatId) { this.showError(new Error("Open a chat first.")); return; }
    const connectionId = this.driver.connectionId() || catalog.settings.slots[0]?.connectionId || "";
    let armRequested = false;
    try {
      if (!this.ctx.host.capabilities["message-preset-context-v1"]) throw new Error("Update Lumiverse to use per-swipe presets and variables with CAT.");
      this.view = { ...this.view, phase: "preparing", detail: "Enabling parallel swipes…" }; this.changed(this.view);
      if (this.disposed || this.driver.chatId() !== chatId) throw new Error("Chat changed while enabling.");
      armRequested = true;
      const view = await this.bridge.call("arm", { chatId, connectionId, slotIds });
      if (this.disposed || navigation !== this.navigation || this.driver.chatId() !== chatId) return;
      this.view = view; this.armed = true; this.changed(this.view);
      this.startHeartbeat();
    } catch (error) {
      if (navigation !== this.navigation) return;
      if (armRequested) void this.bridge.call("disarm", { stop: true }).catch(() => {});
      this.showError(error);
    }
  }
  private async prepare(message: Preparation) {
    if (!this.armed || message.chatId !== this.chatId || this.driver.chatId() !== this.chatId) return;
    this.preparing?.abort();
    const abort = new AbortController(); this.preparing = abort;
    let messageId: string | undefined;
    let creatingReply = false;
    let launched = false;
    let failure = "Stopped before generating swipes.";
    try {
      const prompts: PreparedPrompt[] = await Promise.all(message.slots.map(async (slot, stepIndex) => {
        const prepared = await this.bridge.call("preparePreset", { runId: message.runId, stepIndex });
        if (abort.signal.aborted) throw new Error("Cancelled while preparing swipes.");
        const value = await hostRequest("generate/dry-run", { chat_id: message.chatId, connection_id: slot.connectionId,
          preset_id: prepared.presetId, force_preset_id: true, persona_id: message.personaId, generation_type: "normal" }, abort.signal);
        return { connectionId: slot.connectionId, captureToken: prepared.token, variableState: value.variable_state, messages: value.messages.map((m: any) => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) })),
          parameters: value.parameters, provider: value.provider, model: value.model, prefill: value.assistantPrefill || "" };
      }));
      if (abort.signal.aborted || !this.armed || this.driver.chatId() !== message.chatId) return;
      creatingReply = true;
      const reply = await hostRequest(`chats/${encodeURIComponent(message.chatId)}/messages`, { is_user: false, name: message.name, content: "",
        extra: { ...(message.characterId ? { character_id: message.characterId } : {}), spindle_metadata: { another_one_run: message.runId } } }, AbortSignal.timeout(20_000));
      messageId = reply.id;
      if (abort.signal.aborted) return;
      await this.bridge.call("launch", { runId: message.runId, messageId: reply.id, prompts });
      launched = true;
    } catch (error) {
      failure = errorText(error);
    } finally {
      if (!launched && (creatingReply || !abort.signal.aborted)) {
        try { await this.bridge.call("preparationFailed", { runId: message.runId, error: failure, chatId: message.chatId, messageId }); }
        catch (error) { this.showError(error); }
      }
      if (this.preparing === abort) this.preparing = undefined;
    }
  }
  async disable(_detail?: string, stop = false) {
    this.navigation++; this.changingChat = false;
    this.preparing?.abort(); this.armed = false;
    const revision = this.viewRevision;
    try {
      const view = await this.bridge.call("disarm", { stop });
      if (revision === this.viewRevision) { this.view = view; this.changed(this.view); }
    }
    catch (error) { this.showError(error); }
    if (this.view.phase !== "running") { clearInterval(this.heartbeat); this.heartbeat = undefined; }
  }
  async chatChanged() {
    const chatId = this.driver.chatId();
    if (!this.enabled) return;
    if (chatId === this.chatId) {
      if (this.changingChat) await this.disable("Chat changed.", true);
      return;
    }
    if (!this.armed) { await this.disable("Chat changed.", true); return; }
    if (!chatId) { await this.disable("Chat changed.", true); return; }
    const navigation = ++this.navigation;
    this.changingChat = true; this.preparing?.abort();
    this.view = { ...this.view, phase: "preparing", detail: "Opening chat…" }; this.changed(this.view);
    try {
      const view = await this.bridge.call("followFork", { chatId });
      if (this.disposed || navigation !== this.navigation || this.driver.chatId() !== chatId) return;
      this.changingChat = false;
      if (!view) { await this.disable("Chat changed.", true); return; }
      this.chatId = chatId; this.view = view; this.armed = true;
      this.changed(this.view);
    } catch (error) {
      if (navigation !== this.navigation || this.disposed) return;
      await this.disable("Could not open fork.", true); this.showError(error);
    } finally { if (navigation === this.navigation) this.changingChat = false; }
  }
  async dispose() {
    this.disposed = true; clearInterval(this.heartbeat); this.unsubscribe(); this.preparing?.abort();
    if (this.enabled) await this.disable("Extension unloaded.", true);
    await this.preparation;
  }
}
