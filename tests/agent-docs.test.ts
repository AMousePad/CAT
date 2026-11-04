import { expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { registerAgentDocs } from "../src/backend/agent-docs";
import manifest from "../spindle.json";

function fixture() {
  let handler!: (context: { requesterExtensionId: string }) => Promise<any>;
  let envelope: unknown, reads = 0;
  const api = { rpcPool: {
    handle: (endpoint: string, fn: typeof handler, policy: unknown) => {
      expect(endpoint).toBe("phoneline"); expect(policy).toEqual({ requires: ["characters"] }); handler = fn;
    },
    read: async (endpoint: string) => { expect(endpoint).toBe("lumiagent.phoneline_request"); reads++; return envelope; },
  } } as unknown as SpindleAPI;
  registerAgentDocs(api);
  return { call: (request: unknown, requester = "lumiagent") => { envelope = request; return handler({ requesterExtensionId: requester }); }, reads: () => reads };
}

test("docs bridge pins caller before reading the request and declares the envelope permission", async () => {
  const f = fixture();
  await expect(f.call({ op: "describe" }, "foreign")).rejects.toThrow("Only LumiAgent");
  expect(f.reads()).toBe(0);
  expect(manifest.permissions).toContain("characters");
  expect((await f.call({ op: "describe" })).extension).toEqual({ id: manifest.identifier, name: manifest.name });
});

test("global topics are discoverable and readable without user, chat or character state", async () => {
  const f = fixture();
  const description = await f.call({ op: "describe" });
  const surfaceId = description.surfaces[0].id;
  expect(description.surfaces[0].scope).toBe("global");
  const listed = await f.call({ op: "list_items", surfaceId });
  expect(listed.total).toBe(listed.items.length);
  expect(listed.items.length).toBeGreaterThan(0);
  expect(new Set(listed.items.map((item: any) => item.id)).size).toBe(listed.total);
  expect(JSON.stringify(listed).length).toBeLessThan(600);
  for (const item of listed.items) {
    expect(item.text).toBeUndefined();
    const result = await f.call({ op: "read_item", surfaceId, itemId: item.id });
    expect(typeof result.value).toBe("string");
    expect(result.value.length).toBeGreaterThan(100);
    expect(result.value.length).toBeLessThan(2200);
    expect(await f.call({ op: "read_item", surfaceId, itemId: item.id, field: "text" })).toEqual(result);
  }
  const prompt = await f.call({ op: "system_prompt" });
  expect(prompt.text.length).toBeLessThan(220);
  expect(prompt.text).toContain(surfaceId);
});

test("docs reject malformed, unknown and write requests without exposing controls", async () => {
  const f = fixture();
  await expect(f.call(null)).rejects.toThrow("Malformed");
  await expect(f.call([])).rejects.toThrow("Malformed");
  await expect(f.call({ op: "list_items", surfaceId: "settings" })).rejects.toThrow("Unknown CAT surface");
  await expect(f.call({ op: "read_item", surfaceId: "cat_docs", itemId: "missing" })).rejects.toThrow("Unknown CAT topic");
  await expect(f.call({ op: "read_item", surfaceId: "cat_docs", itemId: "overview", field: "settings" })).rejects.toThrow("field text");
  expect(await f.call({ op: "write_field", surfaceId: "cat_docs", itemId: "overview", field: "text", value: "changed" })).toEqual({ ok: false, error: "CAT documentation is read-only." });
  await expect(f.call({ op: "activation", enabled: true })).rejects.toThrow("only serves documentation");
  expect((await f.call({ op: "read_item", surfaceId: "cat_docs", itemId: "overview" })).value).toContain("CAT (Concurrent");
});
