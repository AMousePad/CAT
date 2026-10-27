import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { ComposerStop } from "../src/ui/composer-stop";

function fixture() {
  const window = new Window(), document = window.document;
  document.body.innerHTML = `<div data-component="InputArea"><div><div><textarea name="chat-message"></textarea></div>
    <div class="shell"><span class="touch-hint">Hold to queue</span><button title="Send" aria-label="Send"><span><svg></svg></span></button></div>
    <span data-spindle-mount="chat_input_tools_right" data-spindle-scope="chat:chat:input-tools-right"></span></div></div>`;
  const root = document.querySelector("[data-component]")!, button = root.querySelector("button")!, textarea = root.querySelector("textarea")!;
  let chat: string | null = "chat", stopped = 0, sent = 0, queued = 0;
  root.addEventListener("click", () => sent++);
  root.addEventListener("pointerdown", () => queued++);
  textarea.addEventListener("keydown", event => { const e = event as unknown as KeyboardEvent; if (e.key === "Enter" && (!e.shiftKey || e.ctrlKey || e.metaKey)) sent++; });
  const control = new ComposerStop(document as unknown as Document, () => chat, () => stopped++);
  const click = (target = button) => target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const key = (key: string, init = {}, target: any = textarea) => {
    const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }); target.dispatchEvent(event); return event;
  };
  return { window, document, root, button, textarea, control, click, key, setChat: (value: string | null) => { chat = value; },
    stopped: () => stopped, sent: () => sent, queued: () => queued, close: () => { control.dispose(); window.close(); } };
}
const settle = () => Bun.sleep(5);

test("CAT restyles the same button, intercepts Stop once and restores native behavior without replacing children", () => {
  const f = fixture();
  try {
    const original = f.button.innerHTML, icon = f.button.firstElementChild;
    f.button.focus(); f.control.update("chat");
    expect(f.document.activeElement).toBe(f.button);
    expect(f.button.getAttribute("aria-label")).toBe("Stop parallel swipes");
    expect(f.button.hasAttribute("data-cat-stop")).toBe(true);
    expect(f.button.innerHTML).toBe(original); expect(f.button.firstElementChild).toBe(icon);
    f.button.firstElementChild!.dispatchEvent(new f.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    f.click(); f.key("Escape");
    expect(f.stopped()).toBe(1); expect(f.sent()).toBe(0);
    f.control.update(null);
    expect(f.button.hasAttribute("data-cat-stop")).toBe(false);
    expect(f.button.getAttribute("title")).toBe("Send"); expect(f.button.getAttribute("aria-label")).toBe("Send");
    expect(f.button.firstElementChild).toBe(icon);
    f.click(); expect(f.sent()).toBe(1);
  } finally { f.close(); }
});

test("Enter and queue shortcuts cannot send during CAT; Shift+Enter, IME and other inputs keep working", () => {
  const f = fixture();
  try {
    f.control.update("chat");
    for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) expect(f.key("Enter", modifiers).defaultPrevented).toBe(true);
    expect(f.sent()).toBe(0);
    expect(f.key("Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(f.key("Enter", { isComposing: true }).defaultPrevented).toBe(false);
    const other = f.document.createElement("textarea"); f.document.body.append(other);
    expect(f.key("Enter", {}, other).defaultPrevented).toBe(false);
    f.key("Escape", {}, f.document.body); expect(f.stopped()).toBe(1);
  } finally { f.close(); }
});

test("touch hold and modified clicks stop CAT without triggering the native queue handler", () => {
  const f = fixture();
  try {
    f.control.update("chat");
    for (const type of ["pointerdown", "pointerup", "pointercancel"]) f.button.dispatchEvent(new f.window.PointerEvent(type, { bubbles: true, pointerType: "touch" }));
    f.button.dispatchEvent(new f.window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(f.queued()).toBe(0); expect(f.sent()).toBe(0); expect(f.stopped()).toBe(1);
  } finally { f.close(); }
});

test("React attribute updates are reapplied during streaming and the latest host values are restored", async () => {
  const f = fixture();
  try {
    f.button.disabled = true; f.control.update("chat"); expect(f.button.disabled).toBe(true);
    f.button.setAttribute("title", "Send queued messages"); f.button.setAttribute("aria-label", "New label");
    f.button.removeAttribute("disabled");
    await settle(); expect(f.button.getAttribute("title")).toBe("Stop parallel swipes");
    f.control.dispose();
    expect(f.button.getAttribute("title")).toBe("Send queued messages");
    expect(f.button.getAttribute("aria-label")).toBe("New label"); expect(f.button.disabled).toBe(false);
  } finally { f.close(); }
});

test("cleanup preserves host changes still queued for the observer", () => {
  const f = fixture();
  try {
    f.control.update("chat"); f.button.disabled = true; f.button.setAttribute("title", "Saving");
    f.control.dispose(); expect(f.button.disabled).toBe(true); expect(f.button.getAttribute("title")).toBe("Saving");
  } finally { f.close(); }
});

test("button and composer remounts regain Stop; mutations do not create an observer loop", async () => {
  const f = fixture();
  try {
    f.control.update("chat");
    const replacement = f.document.createElement("button"); replacement.textContent = "New send";
    f.button.replaceWith(replacement); await settle();
    expect(replacement.hasAttribute("data-cat-stop")).toBe(true);
    expect(f.button.hasAttribute("data-cat-stop")).toBe(false);
    let writes = 0;
    const observer = new f.window.MutationObserver(records => { writes += records.length; });
    observer.observe(replacement, { attributes: true }); await settle(); await settle();
    expect(writes).toBe(0); observer.disconnect();
    const clone = f.root.cloneNode(true) as typeof f.root; f.root.replaceWith(clone); await settle();
    const next = clone.querySelector("button")!;
    f.click(next); expect(f.stopped()).toBe(1);
    f.control.dispose(); expect(next.hasAttribute("data-cat-stop")).toBe(false);
  } finally { f.close(); }
});

test("different chats and idle native generations are never intercepted", () => {
  const f = fixture();
  try {
    f.click(); expect(f.sent()).toBe(1);
    f.control.update("other"); expect(f.button.hasAttribute("data-cat-stop")).toBe(false);
    f.key("Escape"); f.click(); expect(f.stopped()).toBe(0); expect(f.sent()).toBe(2);
    f.control.update("chat"); f.setChat("other");
    f.key("Escape"); f.click(); expect(f.stopped()).toBe(0);
    f.control.update(null); expect(f.button.hasAttribute("data-cat-stop")).toBe(false);
  } finally { f.close(); }
});

test("a missing or changed button layout leaves other buttons untouched and Escape still stops CAT", async () => {
  const f = fixture();
  try {
    f.button.parentElement!.append(f.document.createElement("button")); f.control.update("chat"); await settle();
    expect(f.document.querySelector("[data-cat-stop]")).toBeNull();
    f.key("Escape"); expect(f.stopped()).toBe(1);
    f.control.update(null); f.control.update("chat"); f.key("Escape"); expect(f.stopped()).toBe(2);
  } finally { f.close(); }
});
