import type { ChatMessageDTO, SpindleFrontendContext } from "lumiverse-spindle-types";
import type { RunRecord, ViewState } from "../shared";
import { catIcon } from "./cat-icons";

/** The waiting indicator follows the displayed swipe, using message events rather than polling. */
export class WaitingCat {
  private run: RunRecord | null = null;
  private message: ChatMessageDTO | null = null;
  private wrapper?: Element;
  private observer: MutationObserver;
  private unsubs: (() => void)[];
  constructor(private ctx: SpindleFrontendContext, private document: Document) {
    this.observer = new document.defaultView!.MutationObserver(() => this.render());
    this.unsubs = ["MESSAGE_SENT", "MESSAGE_EDITED", "SWIPE_EDITED", "MESSAGE_SWIPED"].map(event => ctx.events.on(event, raw => {
      const { message, action } = raw as { message?: ChatMessageDTO; action?: string };
      if (!message || message.chat_id !== this.ctx.state!.get<{ chatId: string | null }>("chat.active").chatId) return;
      if (this.run ? message.id !== this.run.messageId : !(message.extra?.spindle_metadata as Record<string, unknown> | undefined)?.another_one_run) return;
      if (action === "deleted" || action === "added") { this.update(null); return; }
      this.message = message; this.render();
    }));
    this.unsubs.push(ctx.events.on("MESSAGE_DELETED", raw => {
      if ((raw as { messageId?: string }).messageId === this.run?.messageId) this.update(null);
    }));
  }
  update(view: ViewState | null) {
    const run = view?.phase === "running" && view.run?.outcome === "running" &&
      view.run.chatId === this.ctx.state!.get<{ chatId: string | null }>("chat.active").chatId ? view.run : null;
    if (run?.messageId !== this.run?.messageId || run?.chatId !== this.run?.chatId) {
      // The blank message event arrives before the run starts. Retain that
      // snapshot so waiting is visible before the first provider chunk.
      if (!run || !this.message || this.message.id !== run.messageId || this.message.chat_id !== run.chatId) this.message = null;
      this.remove();
    }
    this.run = run; this.render();
  }
  private render() {
    this.observer.disconnect();
    const message = this.message;
    const status = message && this.run?.steps[message.swipe_id]?.status;
    const reasoning = message?.extra?.reasoning;
    const waiting = this.run && message && (status === "running" || status === "waiting") &&
      this.run.chatId === this.ctx.state!.get<{ chatId: string | null }>("chat.active").chatId &&
      !message.content.trim() && !(typeof reasoning === "string" && reasoning.trim());
    if (!waiting) { this.remove(); return; }
    if (this.wrapper) return; // Host-managed injections survive virtualization.
    const bubble = this.ctx.dom.findMessageElement(message.id);
    const target = bubble?.querySelector('[data-spindle-mount="message_body_before"]');
    if (!target) {
      this.observer.observe(this.document.body, { childList: true, subtree: true });
      return;
    }
    this.wrapper = this.ctx.dom.inject(target, '<div class="ao-waiting-cat" role="status"><span>Waiting For First Token...</span></div>', "beforeend");
    this.wrapper.querySelector(".ao-waiting-cat")!.prepend(catIcon("ao-wait-cat", "cat"));
  }
  private remove() {
    this.observer.disconnect();
    if (this.wrapper) { this.ctx.dom.uninject(this.wrapper); this.wrapper = undefined; }
  }
  dispose() {
    this.update(null);
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }
}
