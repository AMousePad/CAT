import { expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { listSourcePresets } from "../src/backend/preset-support";

test("retiring presets uses ownership metadata, preserves user presets, and never deletes during pagination", async () => {
  const rows = [
    { id: "owned", name: "Renamed by user", metadata: { another_one: { kind: "controller" } } },
    { id: "same-name", name: "CAT (Cross-Compatibility Preset)", metadata: {} },
    { id: "old-copy", name: "Preparation", metadata: { another_one: { kind: "preparation", createdAt: 1 } } },
    { id: "live-copy", name: "Preparing", metadata: { another_one: { kind: "preparation", createdAt: Date.now() } } },
    { id: "foreign", name: "Other extension", metadata: { another_one: { kind: "other" } } },
    { id: "realm", name: "LumiRealm", metadata: { source: "risupreset" } },
    { id: "last", name: "Last page", metadata: {} },
  ];
  const calls: string[] = [];
  const api = {
    list: async ({ userId, offset }: { userId: string; offset: number }) => {
      expect(userId).toBe("user"); calls.push(`list:${offset}`);
      return { data: rows.slice(offset, offset + 2), total: rows.length };
    },
    delete: async (id: string, userId: string) => { expect(userId).toBe("user"); calls.push(`delete:${id}`); rows.splice(rows.findIndex(p => p.id === id), 1); },
  } as unknown as SpindleAPI["presets"];
  expect((await listSourcePresets(api, "user")).map(p => p.id)).toEqual(["same-name", "foreign", "last"]);
  expect(calls).toEqual(["list:0", "list:2", "list:4", "list:6", "delete:owned", "delete:old-copy"]);
  calls.length = 0;
  await listSourcePresets(api, "user");
  expect(calls.some(c => c.startsWith("delete:"))).toBe(false);
});
