import { expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { Storage } from "../src/backend/storage";
import { Leases } from "../src/backend/leases";
import { normalizeSettings } from "../src/shared";
test("leases are scoped by user and expire without a living controller", () => {
  let now = 0; const leases = new Leases(() => now, 60);
  expect(leases.claim("u", "a")).toBe(true); expect(leases.claim("u", "b")).toBe(false);
  expect(leases.claim("other-user", "b")).toBe(true);
  expect(leases.release("u", "b")).toBe(false);
  now = 61; expect(leases.heartbeat("u", "a")).toBe(false); expect(leases.claim("u", "b")).toBe(true);
  expect(leases.release("u", "a")).toBe(false);
});
test("settings isolate users and serialize edits; failed reads do not overwrite saved preferences", async () => {
  const files = new Map<string, string>();
  const api = { exists: async (p: string, u: string) => files.has(u+p), read: async (p: string, u: string) => files.get(u+p),
    setJson: async (p: string, v: unknown, opts: { userId: string }) => { files.set(opts.userId+p, JSON.stringify(v)); } } as SpindleAPI["userStorage"];
  const storage = new Storage(api);
  await Promise.all([storage.save("a", { cats: false }), storage.save("a", { cats: true }), storage.save("b", { cats: false })]);
  expect((await storage.settings("a")).cats).toBe(true); expect((await storage.settings("b")).cats).toBe(false);
  files.set("asettings.json", "broken"); await expect(storage.settings("a")).rejects.toThrow(); expect(files.get("asettings.json")).toBe("broken");
});
test("settings normalization is bounded and preserves chosen connection ids", () => {
  const input = Array.from({ length: 30 }, (_, n) => ({ id: `${n}`, presetId: `p${n}`, connectionId: n === 0 ? "c1" : null }));
  const settings = normalizeSettings({ slots: input }); expect(settings.slots).toHaveLength(20); expect(settings.slots[0].connectionId).toBe("c1");
  expect(normalizeSettings({ slots: [input[0], input[0]] }).slots).toHaveLength(1);
});

test("account activation survives new workers and independent browsers without resetting profile selection", async () => {
  const files = new Map<string, string>();
  const api = { exists: async (path: string, user: string) => files.has(user + path), read: async (path: string, user: string) => files.get(user + path)!,
    setJson: async (path: string, value: unknown, options: { userId: string }) => { files.set(options.userId + path, JSON.stringify(value)); } } as SpindleAPI["userStorage"];
  const server = new Storage(api);
  expect((await server.activation("user")).enabled).toBe(false);
  await Promise.all([server.setActivation("user", { enabled: true }), server.setActivation("user", { slotIds: ["second"] })]);
  const restarted = new Storage(api);
  expect(await restarted.activation("user")).toEqual({ enabled: true, slotIds: ["second"], revision: 2 });
  await restarted.setActivation("user", { enabled: false });
  expect(await new Storage(api).activation("user")).toEqual({ enabled: false, slotIds: ["second"], revision: 3 });
  expect(await restarted.activation("other-user")).toEqual({ enabled: false, revision: 0 });
  expect(() => restarted.setActivation("user", { enabled: "false" as any })).toThrow();
  expect(() => restarted.setActivation("user", { slotIds: [] })).toThrow();
});
