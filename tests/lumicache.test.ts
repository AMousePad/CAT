import { expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { LumiCacheLink } from "../src/backend/lumicache";

const input = { id: "one", userId: "user", chatId: "chat", slotId: "slot", label: "CAT Preset", connectionId: "c", model: "m", session: "s", messages: [{ role: "user" as const, content: "Hi" }] };

function fixture(answer: (request: any) => unknown) {
  const requests: any[] = [];
  let slot: any = null;
  const results = new Map<string, unknown>();
  const api = { rpcPool: {
    sync: (_name: string, value: unknown) => { slot = value; return ""; },
    read: async (name: string) => {
      if (name === "lumicache.cat") {
        const request = slot;
        await Bun.sleep(1);
        requests.push(request);
        const value = answer(request);
        if (value) results.set(request.id, value);
        return { accepted: true };
      }
      const value = results.get(name.split(".").at(-1)!);
      if (!value) throw new Error(`Shared RPC endpoint "${name}" is not registered`);
      return value;
    },
  } } as unknown as Pick<SpindleAPI, "rpcPool">;
  return { link: new LumiCacheLink(api, 1), requests };
}

test("sends the prompt and returns what LumiCache decided", async () => {
  const changed = [{ role: "user", content: "Restored" }];
  const f = fixture(() => ({ status: "done", messages: changed }));
  expect(await f.link.check(input, () => false)).toEqual(changed as never);
  expect(f.requests[0]).toMatchObject({ op: "check", slotId: "slot", connectionId: "c" });
});

test("a declined review stops the swipes", async () => {
  const f = fixture(() => ({ status: "error", error: "LumiCache cancelled this request before sending." }));
  await expect(f.link.check(input, () => false)).rejects.toThrow("cancelled");
});

test("stopping during a review tells LumiCache", async () => {
  const f = fixture(() => null);
  let stop = false;
  setTimeout(() => { stop = true; }, 5);
  await expect(f.link.check(input, () => stop)).rejects.toThrow("Stopped");
  expect(f.requests.map(request => request.op)).toEqual(["check", "cancel"]);
});

test("without LumiCache the swipes continue unchanged", async () => {
  const api = { rpcPool: { sync: () => "", read: async () => { throw new Error('Shared RPC endpoint "lumicache.cat" is not registered'); } } } as unknown as Pick<SpindleAPI, "rpcPool">;
  expect(await new LumiCacheLink(api, 1).check(input, () => false)).toBeNull();
});

test("other failures surface instead of skipping the check", async () => {
  const api = { rpcPool: { sync: () => "", read: async () => { throw new Error("Shared RPC endpoint timed out"); } } } as unknown as Pick<SpindleAPI, "rpcPool">;
  await expect(new LumiCacheLink(api, 1).check(input, () => false)).rejects.toThrow("timed out");
});

test("overlapping requests never share the request slot", async () => {
  const f = fixture(() => null);
  await Promise.all(["a", "b", "c"].map(id => f.link.finish(id, "user", true)));
  expect(f.requests.map(request => request.id)).toEqual(["a", "b", "c"]);
});
