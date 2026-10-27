import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { Session } from "../generation/session";
import { errorText, type Activation, type Catalog, type MessageSummary, type RunRecord, type Settings, type ViewState } from "../shared";
import { Bridge } from "./bridge";
import { CatBackground } from "./cats";
import { button, catIcon, el } from "./components";
import { refreshCatIcons, rotateCatIcons } from "./cat-icons";
import { ICON, STYLES } from "./styles";
import { NAVBAR_ICON } from "./icons";
import { renderSettings } from "./tabs/settings-tab";
import { renderSwipes } from "./tabs/swipes-tab";
import { SwipeHotbar } from "./hotbar";
import { ComposerStop } from "./composer-stop";
import { WaitingCat } from "./waiting-cat";

export function setup(ctx: SpindleFrontendContext): () => void {
  const removeStyle = ctx.dom.addStyle(STYLES);
  const tab = ctx.ui.registerDrawerTab({ id: "another_one_tab", title: "Concurrent Alternate Trajectories", shortName: "CAT", iconSvg: NAVBAR_ICON,
    description: "Generate swipes using your configured profiles", keywords: ["swipes", "presets", "another one", "generation"] });
  const root = el("div", "ao-root"); tab.root.append(root);
  const toggle = button("Enable", () => { void toggleEnabled(); }, "ao-toggle", true);
  const tabs = el("div", "ao-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Concurrent Alternate Trajectories");
  const toolbar = el("div", "ao-toolbar"); toolbar.append(tabs, toggle);
  const notice = el("div", "ao-notice"); notice.setAttribute("role", "status");
  const content = el("div", "ao-content");
  const body = el("div", "ao-body"); body.id = "ao-tab-content"; body.setAttribute("role", "tabpanel"); body.tabIndex = 0; body.append(content);
  root.append(toolbar, notice, body);
  let disposed = false;
  let catalog: Catalog | null = null;
  let activation: Activation = { enabled: false, revision: 0 };
  let history: RunRecord[] = [];
  let messages = new Map<string, MessageSummary | null>();
  let contextRevision = 0;
  let selected = "swipes";
  let saving = false;
  let toggling = false;
  let opening = false;
  let opened = false;
  let cleanupSettings: (() => void) | undefined;
  const bridge = new Bridge(ctx);
  const cat = new CatBackground(body);
  const refreshCats = () => { rotateCatIcons(); cat.refresh(); };
  root.addEventListener("click", event => {
    rotateCatIcons();
    const control = (event.target as Element).closest("button, summary");
    if (control && control.getAttribute("role") !== "tab") cat.refresh();
  });
  let controller: Session;
  const composerStop = new ComposerStop(document, () => ctx.state!.get<{ chatId: string | null }>("chat.active").chatId,
    () => { void controller.disable("Stopped.", true); });
  const waitingCat = new WaitingCat(ctx, document);
  let hotbar: SwipeHotbar | undefined;
  const tabButtons: HTMLButtonElement[] = [];
  const render = () => {
    if (disposed) return;
    const scroll = content.scrollTop;
    cleanupSettings?.(); cleanupSettings = undefined;
    content.replaceChildren();
    cat.setGalleryActive(selected === "cat" && opened);
    const chatId = ctx.state!.get<{ chatId: string | null }>("chat.active").chatId;
    const chatView: ViewState = !chatId ? { phase: "off", detail: "Open a chat to see swipes.", run: null }
      : controller.view.run && controller.view.run.chatId !== chatId ? { phase: "off", detail: "Disabled", run: null } : controller.view;
    const view = chatId && activation.enabled && chatView.phase === "off"
      ? { ...chatView, phase: "ready" as const, detail: "Enabled. Send a message to generate swipes." } : chatView;
    tab.setBadge(view.phase === "running" && view.run ? `${view.run.steps.filter(s => s.status === "done").length}/${view.run.steps.length}` : activation.enabled ? "on" : null);
    toggle.textContent = activation.enabled ? "Disable" : "Enable";
    toggle.setAttribute("aria-pressed", String(activation.enabled));
    toggle.disabled = !catalog || saving || toggling || (!activation.enabled && controller.enabled);
    for (const b of tabButtons) { const active = b.dataset.tab === selected; b.setAttribute("aria-selected", String(active)); b.tabIndex = active ? 0 : -1; }
    body.setAttribute("aria-labelledby", `ao-tab-${selected}`);
    if (selected === "cat") return;
    if (!catalog) { content.append(el("p", "ao-empty ao-pill", "Loading presets and connections…")); return; }
    if (selected === "settings") cleanupSettings = renderSettings(content, catalog, activation.enabled || controller.enabled, saving, {
      save: settings => { void save(settings); },
      reload: () => { void load(); },
    });
    else if (selected === "swipes") renderSwipes(content, view, history, () => { void controller.disable("Stopped.", true); }, controller.armed || controller.view.phase === "running",
      (run, stepIndex) => { void openSwipe(run, stepIndex); }, opening, ctx.messages.getLatestMessageId(), chatId,
      messages);
    content.scrollTop = scroll;
  };
  try {
    controller = new Session(ctx, bridge, view => {
      composerStop.update(controller.view.phase === "preparing" ? controller.generatingChatId : null);
      waitingCat.update(view);
      if (view.run && view.run.outcome !== "running") history = [structuredClone(view.run), ...history.filter(r => r.id !== view.run!.id)].slice(0, 20);
      notice.textContent = view.phase === "error" && selected !== "swipes" ? view.detail : "";
      render();
      hotbar?.update();
    });
  } catch (error) {
    content.append(el("p", "ao-muted", errorText(error)));
    return () => { waitingCat.dispose(); composerStop.dispose(); cat.dispose(); bridge.dispose(); tab.destroy(); removeStyle(); };
  }
  for (const [id, label] of [["swipes", "Swipes"], ["settings", "Settings"], ["cat", "CAT"]]) {
    const b = button(label, () => {
      const leavingCats = selected === "cat";
      selected = id; render(); content.scrollTop = 0;
      if (!leavingCats && id !== "cat") cat.refresh();
    }, "ao-tab");
    b.prepend(catIcon("ao-cat-icon", id as "swipes" | "settings" | "cat"));
    b.className = "ao-tab";
    b.id = `ao-tab-${id}`; b.dataset.tab = id; b.setAttribute("role", "tab"); b.setAttribute("aria-controls", body.id);
    tabs.append(b); tabButtons.push(b);
  }
  tabs.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = tabButtons.findIndex(b => b.dataset.tab === selected);
    const next = tabButtons[(index + (event.key === "ArrowRight" ? 1 : tabButtons.length - 1)) % tabButtons.length]; next.click(); next.focus();
  });
  async function toggleEnabled() {
    if (!catalog || toggling) return;
    toggling = true; render();
    try {
      if (activation.enabled) applyActivation(await bridge.call("activation", { enabled: false }));
      else {
        await controller.enable(catalog, hotbar?.ids);
        if (controller.armed && !disposed) applyActivation(await bridge.call("activation", { enabled: true, slotIds: hotbar?.ids ?? null }));
      }
    } catch (error) {
      if (!activation.enabled && controller.armed) await controller.disable("Could not save enabled state.", true);
      if (!disposed) notice.textContent = errorText(error);
    }
    finally { toggling = false; render(); }
  }
  function applyActivation(next: Activation) {
    if (disposed || next.revision < activation.revision) return;
    activation = next; hotbar?.restore(next.slotIds); render();
  }
  async function openSwipe(run: RunRecord, stepIndex: number) {
    if (opening) return;
    opening = true; notice.textContent = ""; render();
    try { await controller.openSwipe(run, stepIndex); }
    catch (error) { if (!disposed) notice.textContent = errorText(error); }
    finally { opening = false; render(); }
  }
  async function load() {
    notice.replaceChildren();
    const chatId = ctx.state!.get<{ chatId: string | null }>("chat.active").chatId;
    const revision = contextRevision;
    try {
      const next = await bridge.call("load", { ...(chatId ? { chatId } : {}) });
      if (disposed) return;
      catalog = next;
      if (revision === contextRevision && ctx.state!.get<{ chatId: string | null }>("chat.active").chatId === chatId) history = next.history;
      applyActivation(next.activation); cat.setEnabled(next.settings.cats); if (opened) cat.show(); render(); hotbar?.update();
    } catch (error) {
      if (disposed) return;
      notice.textContent = errorText(error); notice.append(button("Retry", () => { void load(); }, "ao-small"));
    }
  }
  async function save(settings: Settings) {
    if (!catalog || saving) return;
    saving = true; notice.textContent = "Saving…"; render();
    try {
      const saved = await bridge.call("save", { settings });
      if (disposed) return;
      catalog.settings = saved; cat.setEnabled(saved.cats); if (opened) cat.show(); notice.textContent = "";
      hotbar?.update();
    } catch (error) { if (!disposed) notice.textContent = errorText(error); }
    finally { saving = false; render(); }
  }
  const stopAction = ctx.ui.registerInputBarAction({ id: "another_one_stop", label: "Stop parallel swipes", subtitle: "Stop all CAT requests", iconSvg: ICON, enabled: false });
  hotbar = new SwipeHotbar(ctx, { catalog: () => catalog, enabled: () => activation.enabled, toggle: toggleEnabled,
    select: async slotIds => { applyActivation(await bridge.call("activation", { slotIds })); },
    manage: () => { selected = "settings"; render(); tab.activate(); }, refreshCats, error: error => { notice.textContent = errorText(error); } });
  const updateStopAction = ctx.onBackendMessage(raw => {
    const message = raw as { type: string; view?: { phase: string }; error?: string; activation?: Activation };
    if (message.type === "activation" && message.activation) applyActivation(message.activation);
    if (message.type === "view") stopAction.setEnabled(message.view?.phase === "running" || message.view?.phase === "preparing");
    if (message.type === "historyChanged") { void load(); restoreContexts(); }
    if (message.type === "variableError") notice.textContent = message.error || "The selected swipe's variables could not be applied.";
  });
  let lastMessage = ctx.messages.getLatestMessageId();
  const restoreContexts = () => {
    const revision = ++contextRevision;
    const { chatId } = ctx.state!.get<{ chatId: string | null }>("chat.active");
    if (chatId && ctx.host.capabilities["message-preset-context-v1"]) void bridge.call("restoreContexts", { chatId }).then(result => {
      if (disposed || revision !== contextRevision || ctx.state!.get<{ chatId: string | null }>("chat.active").chatId !== chatId) return;
      for (const [id, summary] of Object.entries(result.messages)) messages.set(id, summary);
      history = result.history;
      render();
    }).catch(error => { if (!disposed && revision === contextRevision && ctx.state!.get<{ chatId: string | null }>("chat.active").chatId === chatId) notice.textContent = errorText(error); });
  };
  const messageChanged = () => queueMicrotask(() => {
    const latest = ctx.messages.getLatestMessageId();
    if (latest !== lastMessage) { lastMessage = latest; if (selected === "swipes") render(); }
  });
  const unsubs = [
    updateStopAction,
    stopAction.onClick(() => { void controller.disable("Stopped.", true); }),
    tab.onActivate(() => { opened = true; refreshCatIcons(root); cat.show(); render(); }),
    ctx.state!.subscribe("ui.drawer", value => {
      const drawer = value as { open: boolean; tabId: string | null };
      opened = drawer.open && drawer.tabId === tab.tabId;
      cat.setGalleryActive(selected === "cat" && opened);
      if (opened) cat.show();
    }),
    ctx.events.on("__ws_close", () => controller.disconnected()),
    ctx.events.on("CONNECTED", raw => { if ((raw as { role?: string }).role) { void load(); restoreContexts(); } }),
    ctx.state!.subscribe("chat.active", () => { messages.clear(); waitingCat.update(null); composerStop.update(controller.view.phase === "preparing" ? controller.generatingChatId : null); void controller.chatChanged(); render(); restoreContexts(); }),
    ctx.events.on("MESSAGE_SENT", messageChanged), ctx.events.on("MESSAGE_DELETED", raw => {
      const event = raw as { chatId: string; messageId: string };
      history = history.filter(run => run.chatId !== event.chatId || run.messageId !== event.messageId);
      controller.messageDeleted(event.chatId, event.messageId);
      if (ctx.state!.get<{ chatId: string | null }>("chat.active").chatId === event.chatId) {
        contextRevision++;
        messages.set(event.messageId, null); render();
      }
      messageChanged();
    }),
  ];
  // Drawer selection may already point to this extension after a page reload.
  const drawer = ctx.state!.get<{ open: boolean; tabId: string | null }>("ui.drawer");
  opened = drawer.open && drawer.tabId === tab.tabId;
  void load(); render(); restoreContexts();
  return () => {
    disposed = true;
    waitingCat.dispose();
    composerStop.dispose();
    cleanupSettings?.();
    for (const unsub of unsubs) unsub();
    void controller.dispose().finally(() => bridge.dispose());
    hotbar?.dispose(); cat.dispose(); stopAction.destroy(); tab.destroy(); removeStyle();
  };
}
