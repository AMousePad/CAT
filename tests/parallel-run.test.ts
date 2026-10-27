import { expect, test } from "bun:test";
import { ParallelRun, type PreparedPrompt, type SwipeReasoning } from "../src/generation/parallel-run";
import type { RunRecord } from "../src/shared";
const prompts: PreparedPrompt[] = [0, 1, 2].map(i => ({ connectionId: String(i), provider: "custom", model: "fixture", messages: [{ role: "user", content: "hello" }], parameters: {} }));
const record = (): RunRecord => ({ id: "run", chatId: "chat", chatName: "Test", messageId: "reply", at: 0, outcome: "running", steps: prompts.map((p, i) => ({ presetId: String(i), presetName: String(i), connectionName: p.connectionId, status: "waiting" })) });
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(2); }
  throw new Error("Test did not settle");
}
test("all streams start together; completing out of order never reorders the swipe slots", async () => {
  const finish: (() => void)[] = [];
  const writes: string[][] = [];
  const run = new ParallelRun(record(), prompts, {
    async *stream(p) {
      const i = Number(p.connectionId);
      yield { type: "token", token: `partial${i}` };
      await new Promise<void>(r => { finish[i] = r; });
      yield { type: "done", content: `final${i}`, finish_reason: "stop" };
    }, write: async s => { writes.push([...s]); }, changed: () => {},
  }, 1);
  const result = run.run();
  await until(() => finish.filter(Boolean).length === 3 && writes.some(s => s.every(v => v.startsWith("partial"))));
  finish[2](); finish[1](); await Bun.sleep(3);
  expect(run.record.steps.map(s => s.status)).toEqual(["running", "done", "done"]);
  finish[0](); expect((await result).outcome).toBe("complete");
  expect(writes.at(-1)).toEqual(["final0", "final1", "final2"]);
});
test("a failed provider does not cancel sibling streams", async () => {
  const run = new ParallelRun(record(), prompts, {
    async *stream(p) { if (p.connectionId === "1") throw new Error("rate limit"); yield { type: "done", content: p.connectionId, finish_reason: "stop" }; },
    write: async () => {}, changed: () => {},
  });
  const result = await run.run();
  expect(result.outcome).toBe("error"); expect(result.steps.map(s => s.status)).toEqual(["done", "error", "done"]);
  expect(result.steps[1].error).toBe("rate limit"); expect(run.swipes).toEqual(["0", "", "2"]);
});
test("stop cancels every provider and saves partial output", async () => {
  let starts = 0, cancelled = 0;
  const writes: string[][] = [];
  const run = new ParallelRun(record(), prompts, {
    async *stream(p, signal) {
      starts++; yield { type: "token", token: p.connectionId };
      await new Promise<void>(resolve => { signal.addEventListener("abort", () => { cancelled++; resolve(); }, { once: true }); });
    }, write: async s => { writes.push([...s]); }, changed: () => {},
  }, 1);
  const result = run.run(); await until(() => starts === 3 && writes.some(s => s.every(Boolean)));
  run.stop(); expect((await result).outcome).toBe("stopped"); expect(cancelled).toBe(3);
  expect(writes.at(-1)).toEqual(["0", "1", "2"]);
});
test("an external message edit stops writes instead of replacing the user's changes", async () => {
  const writes: string[][] = [];
  const run = new ParallelRun(record(), prompts, {
    async *stream(p, signal) {
      yield { type: "token", token: p.connectionId };
      await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); });
    }, write: async s => { writes.push([...s]); }, changed: () => {},
  }, 1);
  const result = run.run(); await until(() => writes.some(s => s.every(Boolean)));
  run.observeEdit(writes.at(-1)!); expect(run.abort.signal.aborted).toBe(false);
  const count = writes.length; run.observeEdit(["User edited this reply", "1", "2"]);
  expect((await result).outcome).toBe("stopped"); expect(writes).toHaveLength(count);
});
test("a persistence error aborts the streams and is surfaced", async () => {
  let starts = 0;
  const run = new ParallelRun(record(), prompts, {
    async *stream() { starts++; yield { type: "done", content: "wrong", finish_reason: "stop" }; },
    write: async () => { throw new Error("disk full"); }, changed: () => {},
  });
  expect((await run.run()).detail).toContain("disk full"); expect(starts).toBe(0);
});

test("slow storage keeps a single writer and saves the latest tokens at completion", async () => {
  const finish: (() => void)[] = [], writes: string[][] = [];
  let release!: () => void, active = 0, maximum = 0;
  const run = new ParallelRun(record(), prompts, {
    async *stream(p) {
      yield { type: "token", token: `partial${p.connectionId}` };
      await new Promise<void>(resolve => { finish[Number(p.connectionId)] = resolve; });
      yield { type: "done", content: `final${p.connectionId}`, finish_reason: "stop" };
    },
    write: async swipes => {
      active++; maximum = Math.max(maximum, active); writes.push([...swipes]);
      if (writes.length === 2) await new Promise<void>(resolve => { release = resolve; });
      active--;
    }, changed: () => {},
  }, 1);
  const result = run.run(); await until(() => !!release);
  finish.forEach(fn => fn()); await Bun.sleep(20);
  expect(writes).toHaveLength(2); release();
  expect((await result).outcome).toBe("complete"); expect(maximum).toBe(1);
  expect(writes).toHaveLength(3); expect(writes.at(-1)).toEqual(["final0", "final1", "final2"]);
});

test("reasoning streams per swipe before prose; final reasoning replaces rather than duplicates deltas", async () => {
  const finish: (() => void)[] = [];
  const writes: { swipes: string[]; reasoning: SwipeReasoning[] }[] = [];
  const run = new ParallelRun(record(), prompts, {
    async *stream(p) {
      const i = Number(p.connectionId);
      yield { type: "reasoning", token: `thinking${i}` };
      yield { type: "reasoning", token: "..." };
      await new Promise<void>(resolve => { finish[i] = resolve; });
      yield { type: "token", token: `answer${i}` };
      if (i === 0) yield { type: "reasoning", token: "later thought" };
      yield { type: "done", content: `answer${i}`, ...(i === 1 ? {} : { reasoning: i === 0 ? "final thought" : "" }), finish_reason: "stop" };
    },
    write: async (swipes, _, reasoning) => { writes.push({ swipes, reasoning }); }, changed: () => {},
  }, 1);
  const result = run.run();
  await until(() => finish.filter(Boolean).length === 3 && writes.some(w => w.reasoning.every(r => r.text)));
  const partial = writes.at(-1)!;
  expect(partial.swipes).toEqual(["", "", ""]);
  expect(partial.reasoning).toEqual([0, 1, 2].map(i => ({ text: `thinking${i}...`, duration: null })));
  finish[2](); finish[0](); finish[1]();
  expect((await result).outcome).toBe("complete");
  expect(writes.at(-1)!.reasoning.map(r => r.text)).toEqual(["final thought", "thinking1...", null]);
  expect(writes.at(-1)!.reasoning[0].duration).toBeGreaterThan(0);
  expect(writes.at(-1)!.reasoning[2].duration).toBeNull();
  expect(partial.reasoning[0]).toEqual({ text: "thinking0...", duration: null });
  expect(writes.at(-1)!.swipes).toEqual(["answer0", "answer1", "answer2"]);
});

test("stopping during reasoning saves partial thoughts without adding them to prose", async () => {
  let starts = 0;
  const writes: SwipeReasoning[][] = [];
  const run = new ParallelRun(record(), prompts, {
    async *stream(p, signal) {
      starts++;
      yield { type: "reasoning", token: `partial${p.connectionId}` };
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    write: async (_, __, reasoning) => { writes.push(reasoning); }, changed: () => {},
  }, 1);
  const result = run.run();
  await until(() => starts === 3 && writes.some(w => w.every(r => r.text)));
  run.stop();
  expect((await result).outcome).toBe("stopped");
  expect(run.swipes).toEqual(["", "", ""]);
  expect(writes.at(-1)!.map(r => r.text)).toEqual(["partial0", "partial1", "partial2"]);
  expect(writes.at(-1)!.every(r => r.duration! > 0)).toBe(true);
});

test("reasoning survives provider failure and missing terminal chunks; final-only reasoning has no invented duration", async () => {
  const run = new ParallelRun(record(), prompts, {
    async *stream(p) {
      if (p.connectionId === "2") { yield { type: "done", content: "", reasoning: "final-only", finish_reason: "length" }; return; }
      yield { type: "reasoning", token: `partial${p.connectionId}` };
      if (p.connectionId === "0") throw new Error("provider failed");
    }, write: async () => {}, changed: () => {},
  });
  const result = await run.run();
  expect(result.steps.map(s => s.status)).toEqual(["error", "error", "done"]);
  expect(run.reasoning.map(r => r.text)).toEqual(["partial0", "partial1", "final-only"]);
  expect(run.reasoning[2].duration).toBeNull();
});

test("editing reasoning during streaming stops the writer and preserves the user's edit", async () => {
  const writes: { swipes: string[]; reasoning: SwipeReasoning[] }[] = [];
  const run = new ParallelRun(record(), prompts, {
    async *stream(p, signal) {
      yield { type: "reasoning", token: `thinking${p.connectionId}` };
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }, write: async (swipes, _, reasoning) => { writes.push({ swipes, reasoning }); }, changed: () => {},
  }, 1);
  const result = run.run();
  await until(() => writes.some(w => w.reasoning.every(r => r.text)));
  const snapshot = writes.at(-1)!;
  const extra = { reasoningBySwipe: snapshot.reasoning.map(r => r.text), reasoningDurationBySwipe: snapshot.reasoning.map(r => r.duration) };
  run.observeEdit(snapshot.swipes, extra); expect(run.abort.signal.aborted).toBe(false);
  const count = writes.length;
  extra.reasoningBySwipe[1] = "User edited this thought";
  run.observeEdit(snapshot.swipes, extra);
  expect((await result).outcome).toBe("stopped"); expect(writes).toHaveLength(count);
});
