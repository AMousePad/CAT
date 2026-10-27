import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ChatMessageDTO, SpindleFrontendContext } from "lumiverse-spindle-types";
import type { ViewState } from "../src/shared";
import { WaitingCat } from "../src/ui/waiting-cat";

let window: Window;
let previous: Document;
let indicator: WaitingCat;
beforeEach(() => { previous = globalThis.document; window = new Window(); globalThis.document = window.document as unknown as Document; });
afterEach(() => { indicator?.dispose(); window.close(); globalThis.document = previous; });
const message = (patch = {}): ChatMessageDTO => ({ id: "reply", chat_id: "chat", swipe_id: 0, content: "", extra: { spindle_metadata: { another_one_run: "run" } },
  index_in_chat: 0, is_user: false, name: "Miso", send_date: 0, swipes: ["", ""], swipe_dates: [0, 0], parent_message_id: null, branch_id: null, created_at: 0, ...patch });
const view = (): ViewState => ({ phase: "running", detail: "", run: { id: "run", chatId: "chat", chatName: "Chat", messageId: "reply", at: 0, outcome: "running",
  steps: [0, 1].map(i => ({ presetId: String(i), presetName: "Preset", connectionName: "Connection", status: "running" })) } });
function fixture(mounted = true) {
  const events = new Map<string, (raw: unknown) => void>();
  let chatId = "chat";
  let injections = 0, removals = 0;
  const bubble = document.createElement("div"); bubble.innerHTML = '<span data-spindle-mount="message_body_before"></span>';
  if (mounted) document.body.append(bubble);
  const ctx = {
    state: { get: () => ({ chatId }) },
    events: { on: (event: string, callback: (raw: unknown) => void) => { events.set(event, callback); return () => { events.delete(event); }; } },
    dom: {
      findMessageElement: () => bubble.isConnected ? bubble : null,
      inject: (target: Element, html: string) => { injections++; const wrapper = document.createElement("div"); wrapper.innerHTML = html; target.append(wrapper); return wrapper; },
      uninject: (element: Element) => { removals++; element.remove(); },
    },
  } as unknown as SpindleFrontendContext;
  indicator = new WaitingCat(ctx, document);
  events.get("MESSAGE_SENT")!({ message: message() });
  return { bubble, events, stats: () => [injections, removals], setChat: (id: string) => { chatId = id; },
    emit: (m: ChatMessageDTO, event = "MESSAGE_EDITED", extra = {}) => events.get(event)?.({ message: m, ...extra }) };
}
const visible = () => document.querySelector(".ao-waiting-cat");

test("empty active swipes show the spinning cat; reasoning, prose and completed slots hide it", async () => {
  const f = fixture(); const state = view(); indicator.update(state); await Bun.sleep(1);
  expect(visible()?.textContent).toBe("Waiting For First Token...");
  expect(visible()?.getAttribute("role")).toBe("status");
  expect(visible()?.querySelector(".ao-wait-cat")?.getAttribute("aria-hidden")).toBe("true");
  const first = visible();
  f.emit(message()); indicator.update(state);
  expect(visible()).toBe(first); expect(f.stats()).toEqual([1, 0]);
  f.emit(message({ extra: { reasoning: "Thinking" } })); expect(visible()).toBeNull();
  f.emit(message({ swipe_id: 1 }), "MESSAGE_SWIPED"); expect(visible()).not.toBeNull();
  f.emit(message({ swipe_id: 1, content: "Answer" })); expect(visible()).toBeNull();
  f.emit(message({ swipe_id: 1, content: " \n" })); expect(visible()).not.toBeNull();
  state.run!.steps[1].status = "done"; indicator.update(state); expect(visible()).toBeNull();
  state.run!.steps[1].status = "error"; indicator.update(state); expect(visible()).toBeNull();
});

test("message events before the run starts retain first tokens; other chats cannot restore the spinner", async () => {
  const f = fixture();
  f.emit(message({ content: "Already arrived" }));
  indicator.update(view());
  expect(visible()).toBeNull();
  f.emit(message()); expect(visible()).not.toBeNull();
  f.setChat("other"); indicator.update(view()); expect(visible()).toBeNull();
  f.emit(message()); expect(visible()).toBeNull();
});

test("the indicator waits for virtualized bubbles to mount, then retires its host injection on stop", async () => {
  const f = fixture(false); const state = view();
  indicator.update(state); await Bun.sleep(1); expect(visible()).toBeNull();
  document.body.append(f.bubble); await Bun.sleep(2); expect(visible()).not.toBeNull();
  state.phase = "stopping"; indicator.update(state);
  expect(visible()).toBeNull(); expect(f.stats()).toEqual([1, 1]);
  f.bubble.remove(); document.body.append(f.bubble); await Bun.sleep(2);
  expect(visible()).toBeNull();
});

test("disposal, deleted messages and reshaped swipes cannot leave a waiting indicator behind", async () => {
  const f = fixture(); indicator.update(view()); await Bun.sleep(1);
  f.emit(message(), "MESSAGE_SWIPED", { action: "deleted" }); expect(visible()).toBeNull();
  f.emit(message()); indicator.update(view()); await Bun.sleep(1);
  f.events.get("MESSAGE_DELETED")!({ messageId: "reply" }); expect(visible()).toBeNull();
  f.emit(message()); indicator.update(view()); indicator.dispose(); f.emit(message()); await Bun.sleep(1);
  expect(visible()).toBeNull(); expect(f.events.size).toBe(0);
});
