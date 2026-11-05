import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import type { Bridge } from "../ui/bridge";
import { hostDriver } from "./host";
import { errorText, type Catalog, type RunRecord, type ViewState } from "../shared";

export class Session {
  view: ViewState = { phase: "off", detail: "Disabled", run: null };
  armed = false;
  private chatId: string | null = null;
  private heartbeat?: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  private disposed = false;
  private driver;
  private changingChat = false;
  private navigation = 0;
  private viewRevision = 0;
  constructor(private ctx: SpindleFrontendContext, private bridge: Bridge, private changed: (view: ViewState) => void) {
    this.driver = hostDriver(ctx);
    this.unsubscribe = ctx.onBackendMessage(raw => {
      const message = raw as { type: string; chatId?: string; view?: ViewState; armed?: boolean };
      if (message.type === "view" && message.view) {
        if (this.changingChat || message.chatId !== this.driver.chatId()) return;
        this.viewRevision++;
        this.armed = message.armed === true; this.view = message.view;
        const running = this.view.phase === "running" || this.view.phase === "stopping";
        if (this.armed || running) { this.chatId = this.driver.chatId(); this.startHeartbeat(); }
        if (!this.armed && !running) {
          clearInterval(this.heartbeat); this.heartbeat = undefined;
        }
        this.changed(this.view);
      }
    });
  }
  get generatingChatId(): string | null {
    if (this.disposed || this.changingChat || this.driver.chatId() !== this.chatId) return null;
    return this.view.phase === "running" || this.view.phase === "stopping" || (this.armed && this.view.phase === "preparing") ? this.chatId : null;
  }
  private startHeartbeat() {
    if (this.heartbeat || this.disposed) return;
    this.heartbeat = setInterval(() => { void this.bridge.call("heartbeat", {}).then(ok => {
      if (!ok && this.enabled) this.disconnected();
    }).catch(error => { this.showError(error); }); }, 15_000);
  }
  disconnected() {
    this.navigation++; this.changingChat = false; this.armed = false;
    clearInterval(this.heartbeat); this.heartbeat = undefined;
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
  async disable(_detail?: string, stop = false) {
    this.navigation++; this.changingChat = false;
    this.armed = false;
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
    this.changingChat = true;
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
    this.disposed = true; clearInterval(this.heartbeat); this.unsubscribe();
    this.navigation++; this.armed = false;
    this.view = { phase: "off", detail: "Disconnected", run: null };
  }
}
