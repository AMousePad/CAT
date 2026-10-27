import type { LlmMessageDTO, StreamChunkDTO } from "lumiverse-spindle-types";
import { errorText, type RunRecord } from "../shared";
import { contentHash } from "./preset-context";

export interface PreparedPrompt { messages: LlmMessageDTO[]; parameters: Record<string, unknown>; connectionId: string; provider: string; model: string; prefill?: string; captureToken?: string; responseContextId?: string; variableState?: import("./variable-state").VariableSnapshot }
export interface SwipeReasoning { text: string | null; duration: number | null }
export interface ParallelDriver {
  stream(prompt: PreparedPrompt, signal: AbortSignal): AsyncIterable<StreamChunkDTO>;
  write(swipes: string[], final: boolean, reasoning: SwipeReasoning[]): Promise<void>;
  changed(run: RunRecord): void;
  finalize?(): Promise<{ swipes: string[]; reasoning: SwipeReasoning[] }>;
}

/** Provider streams are independent. One writer owns the message's swipe array. */
export class ParallelRun {
  readonly abort = new AbortController();
  readonly swipes: string[];
  readonly reasoning: SwipeReasoning[];
  deleted = false;
  private dirty = false;
  private writing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private writeError?: string;
  private externallyChanged = false;
  private snapshots = new Set<string>();
  private finishing = false;
  constructor(readonly record: RunRecord, private prompts: PreparedPrompt[], private driver: ParallelDriver, private flushMs = 120) {
    this.swipes = prompts.map(() => "");
    this.reasoning = prompts.map(() => ({ text: null, duration: null }));
  }
  private emit() { this.driver.changed(structuredClone(this.record)); }
  private flush(final = false): Promise<void> {
    // Coalesce timer ticks while storage is busy; only the final flush waits.
    if (this.writing) return final ? this.writing.then(() => this.flush(true)) : this.writing;
    const task = Promise.resolve().then(async () => {
      if (this.externallyChanged || (!this.dirty && !final)) return;
      this.dirty = false;
      const snapshot = [...this.swipes];
      const reasoning = this.reasoning.map(value => ({ ...value }));
      this.snapshots.add(JSON.stringify([snapshot, reasoning]));
      if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.values().next().value!);
      try { await this.driver.write(snapshot, final, reasoning); }
      catch (error) { this.writeError = errorText(error); this.abort.abort(); }
    });
    this.writing = task;
    void task.finally(() => { if (this.writing === task) this.writing = undefined; }).catch(() => {});
    return task;
  }
  observeEdit(swipes: string[], extra: Record<string, unknown> = {}): void {
    if (this.finishing) return;
    const texts = Array.isArray(extra.reasoningBySwipe) ? extra.reasoningBySwipe : [];
    const durations = Array.isArray(extra.reasoningDurationBySwipe) ? extra.reasoningDurationBySwipe : [];
    const reasoning = swipes.map((_, index) => ({ text: texts[index] || null, duration: durations[index] ?? null }));
    if (this.snapshots.has(JSON.stringify([swipes, reasoning]))) return;
    this.externallyChanged = true;
    this.stop("The reply was edited or its swipes changed. Streaming stopped to preserve your changes.");
  }
  stop(detail?: string) {
    this.record.detail = detail ?? this.record.detail ?? "Stopped. Partial replies have been kept."; this.abort.abort();
  }
  observeDeletion() {
    this.deleted = true; this.externallyChanged = true;
    this.stop("The reply was deleted."); this.emit();
  }
  async run(): Promise<RunRecord> {
    this.dirty = true; await this.flush();
    this.timer = setInterval(() => { void this.flush(); }, this.flushMs);
    try {
      await Promise.all(this.prompts.map(async (prompt, index) => {
        const step = this.record.steps[index];
        if (this.abort.signal.aborted) { step.status = "stopped"; return; }
        step.status = "running"; this.emit();
        let content = "";
        this.swipes[index] = prompt.prefill || ""; this.dirty = true;
        let done = false;
        const reasoning = this.reasoning[index];
        let reasoningStartedAt: number | undefined;
        const finishReasoning = () => {
          if (reasoningStartedAt !== undefined && reasoning.duration === null) {
            reasoning.duration = Math.max(1, Math.round(performance.now() - reasoningStartedAt));
          }
        };
        try {
          for await (const chunk of this.driver.stream(prompt, this.abort.signal)) {
            if (this.abort.signal.aborted) break;
            if (chunk.type === "reasoning") {
              if (!chunk.token) continue;
              reasoningStartedAt ??= performance.now();
              reasoning.text = (reasoning.text || "") + chunk.token;
            }
            if (chunk.type === "token") {
              if (!chunk.token) continue;
              finishReasoning(); content += chunk.token;
            }
            if (chunk.type === "done") {
              content = chunk.content; done = true;
              if (chunk.reasoning !== undefined) reasoning.text = chunk.reasoning || null;
            }
            this.swipes[index] = (prompt.prefill || "") + content;
            this.dirty = true;
          }
          if (this.abort.signal.aborted) step.status = "stopped";
          else if (!done) throw new Error("The provider stream ended without a final response.");
          else { step.status = "done"; step.swipe = index; }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") this.stop();
          step.status = this.abort.signal.aborted ? "stopped" : "error";
          if (step.status === "error") step.error = errorText(error);
        }
        finishReasoning();
        if (!reasoning.text) reasoning.duration = null;
        this.dirty = true;
        this.emit();
      }));
    } finally { clearInterval(this.timer); }
    await this.flush(true);
    this.finishing = true;
    if (this.driver.finalize) {
      try {
        const saved = await this.driver.finalize();
        this.swipes.splice(0, this.swipes.length, ...saved.swipes);
        this.reasoning.splice(0, this.reasoning.length, ...saved.reasoning);
      } catch (error) { this.writeError ??= errorText(error); this.abort.abort(); }
    }
    await Promise.all(this.record.steps.map(async (step, index) => {
      step.swipe = index;
      if (this.swipes[index]) step.contentHash = await contentHash(this.swipes[index]);
    }));
    this.record.outcome = this.writeError || this.record.steps.some(s => s.status === "error") ? "error"
      : this.abort.signal.aborted ? "stopped" : "complete";
    if (this.writeError) this.record.detail = `Could not save streamed replies: ${this.writeError}`;
    this.emit();
    return this.record;
  }
}
