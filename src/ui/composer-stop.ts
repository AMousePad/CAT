const ATTRIBUTES = ["title", "aria-label"] as const;
const LABEL = "Stop parallel swipes";

/** Temporary control of the existing composer button; never replace React-owned nodes. */
export class ComposerStop {
  private chatId: string | null = null;
  private root: Element | null = null;
  private button: HTMLButtonElement | null = null;
  private original = new Map<string, string | null>();
  private stopping = false;
  private observer: MutationObserver;
  private events = ["click", "pointerdown", "pointerup", "pointercancel", "keydown"];
  constructor(private document: Document, private currentChat: () => string | null, private stop: () => void) {
    this.observer = new document.defaultView!.MutationObserver(records => {
      if (!this.button?.isConnected || records.some(record => this.root?.contains(record.target))) this.sync(records);
    });
  }
  update(chatId: string | null) {
    if (chatId === this.chatId) return;
    this.dispose();
    this.chatId = chatId; this.stopping = false;
    if (!chatId) return;
    for (const name of this.events) this.document.defaultView!.addEventListener(name, this.handle, { capture: true, passive: false });
    this.sync([]);
  }
  private remember(records: MutationRecord[]) {
    for (const record of records) if (record.target === this.button && this.original.has(record.attributeName!)) {
      this.original.set(record.attributeName!, this.button!.getAttribute(record.attributeName!));
    }
  }
  private restore() {
    if (this.button) {
      for (const [name, value] of this.original) if (this.button.getAttribute(name) === LABEL) this.setAttribute(name, value);
      this.button.removeAttribute("data-cat-stop");
    }
    this.original.clear(); this.button = null; this.root = null;
  }
  private setAttribute(name: string, value: string | null) {
    if (value === null) this.button!.removeAttribute(name);
    else this.button!.setAttribute(name, value);
  }
  private sync(records: MutationRecord[]) {
    this.remember(records);
    // Own writes are not observed. Later host changes become the values restored at the end.
    this.observer.disconnect();
    let button: HTMLButtonElement | null = null;
    let root: Element | null = null;
    for (const anchor of this.document.querySelectorAll('[data-spindle-mount="chat_input_tools_right"]')) {
      if (anchor.getAttribute("data-spindle-scope") !== `chat:${this.chatId}:input-tools-right`) continue;
      root = anchor.closest('[data-component="InputArea"]');
      const shell = anchor.previousElementSibling;
      const buttons = shell?.querySelectorAll<HTMLButtonElement>(":scope > button");
      if (root?.querySelector('textarea[name="chat-message"]') && buttons?.length === 1) {
        button = buttons[0]; break;
      }
    }
    if (button !== this.button) {
      this.restore(); this.button = button; this.root = button ? root : null;
      if (button) for (const name of ATTRIBUTES) this.original.set(name, button.getAttribute(name));
    }
    if (this.button) {
      this.button.setAttribute("data-cat-stop", "");
      for (const name of ATTRIBUTES) if (this.button.getAttribute(name) !== LABEL) this.setAttribute(name, LABEL);
    }
    if (this.chatId) this.observer.observe(this.document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: [...ATTRIBUTES, "data-cat-stop"] });
  }
  private handle = (event: Event) => {
    if (!this.chatId || this.currentChat() !== this.chatId) return;
    if (!this.button?.isConnected) this.sync(this.observer.takeRecords());
    const target = event.target as Node | null;
    let stop = false;
    if (event.type === "keydown") {
      const key = event as KeyboardEvent;
      if (key.isComposing || key.keyCode === 229) return;
      if (key.key === "Escape") stop = true;
      else if (key.key === "Enter" && target === this.root?.querySelector('textarea[name="chat-message"]')) {
        // Preserve Shift+Enter for composing the next message, but block send/queue shortcuts.
        if (key.shiftKey && !key.ctrlKey && !key.metaKey) return;
      } else return;
    } else {
      if (!target || !this.button?.contains(target)) return;
      if (event.type !== "click") { event.stopImmediatePropagation(); return; }
      stop = true;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    if (stop && !this.stopping) { this.stopping = true; this.stop(); }
  };
  dispose() {
    this.remember(this.observer.takeRecords()); this.observer.disconnect();
    for (const name of this.events) this.document.defaultView!.removeEventListener(name, this.handle, true);
    this.restore(); this.chatId = null;
  }
}
