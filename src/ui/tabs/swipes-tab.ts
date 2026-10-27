import type { MessageSummary, RunRecord, ViewState } from "../../shared";
import { button, catIcon, el } from "../components";
export function renderSwipes(host: HTMLElement, view: ViewState, history: RunRecord[], stop: () => void, canStop: boolean,
  open: (run: RunRecord, stepIndex: number) => void, opening = false, latestMessageId?: string | null, chatId?: string | null,
  messages?: ReadonlyMap<string, MessageSummary | null>) {
  const status = el("div", `ao-status ao-pill ao-${view.phase}`); status.setAttribute("role", "status");
  status.append(catIcon(), el("span", "ao-dot"), el("p", "ao-status-text", view.detail));
  if (canStop && (view.phase === "running" || view.phase === "preparing")) status.append(button("Stop", stop, "ao-small"));
  host.append(status);
  if (!chatId) return;
  const currentRun = view.run?.chatId === chatId ? view.run : null;
  const chatHistory = history.filter(run => run.chatId === chatId && run.id !== currentRun?.id);
  const runs = (currentRun ? [currentRun, ...chatHistory] : chatHistory)
    .filter(run => run.messageId && messages?.get(run.messageId) !== null);
  if (!runs.length) { const empty = el("p", "ao-empty ao-pill", "No swipes yet."); empty.prepend(catIcon()); host.append(empty); return; }
  for (const run of runs) {
    const latest = run.messageId === latestMessageId && run.chatId === chatId;
    const card = el("article", "ao-run");
    if (!latest) card.classList.add("ao-run-past");
    const head = el("header", "ao-run-head");
    const message = messages?.get(run.messageId);
    const messageIndex = message?.index ?? run.messageIndex;
    const label = typeof messageIndex === "number" ? `#${messageIndex}` : "#…";
    const title = el("div", "ao-run-title"); title.append(el("strong", "ao-pill ao-count", label));
    const time = el("time", "ao-pill ao-run-date", new Date(run.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }));
    time.dateTime = new Date(run.at).toISOString();
    title.append(el("span", "ao-pill ao-run-character", message?.name || run.characterName || "Assistant"), time);
    head.append(title); card.append(head);
    for (const [index, step] of run.steps.entries()) {
      const row = el("button", "ao-step"); row.type = "button";
      row.disabled = !latest || opening || !run.messageId || step.status === "waiting";
      row.setAttribute("aria-label", `Open swipe ${index + 1}, ${step.presetName}`);
      row.addEventListener("click", () => open(run, index));
      row.append(el("span", "ao-step-number", String(index + 1)));
      const body = el("div", "ao-step-copy"); body.append(el("strong", "", step.presetName), el("small", "", step.connectionName));
      row.append(body);
      if (step.status !== "done" && step.status !== "stopped") row.append(el("span", `ao-step-state ao-step-${step.status}`, step.status));
      card.append(row);
      if (step.error) card.append(el("p", "ao-muted", step.error));
    }
    if (run.detail && run.outcome !== "stopped") card.append(el("p", "ao-muted", run.detail));
    host.append(card);
  }
}
