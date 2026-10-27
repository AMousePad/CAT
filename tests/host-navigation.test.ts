import { expect, test } from "bun:test";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { hostDriver } from "../src/generation/host";

function fixture() {
  const current = { chat: "chat", connection: "main", pauses: 0 };
  const actions: unknown[] = [];
  const ctx = {
    frontendSessionId: "session",
    state: { get: () => ({ chatId: current.chat }) },
    connections: { getActive: () => ({ activeProfileId: current.connection }) },
    host: { surfaces: { invoke: async (ref: unknown, input: { chatId: string }) => { actions.push(ref); current.chat = input.chatId; } } },
  };
  const driver = hostDriver(ctx as unknown as SpindleFrontendContext, async () => { current.pauses++; });
  return { current, actions, ctx, driver };
}

test("opening a result navigates only when needed and never changes the connection", async () => {
  const f = fixture();
  await f.driver.openChat("chat"); expect(f.actions).toEqual([]);
  await f.driver.openChat("fork");
  expect(f.actions).toEqual([{ kind: "route", id: "/chat/:chatId" }]);
  expect(f.driver.chatId()).toBe("fork"); expect(f.driver.connectionId()).toBe("main");
});

test("failed navigation propagates the error; navigation that never finishes times out", async () => {
  const f = fixture();
  f.ctx.host.surfaces.invoke = async () => { throw new Error("PERMISSION_DENIED"); };
  await expect(f.driver.openChat("fork")).rejects.toThrow("PERMISSION_DENIED");
  expect(f.current.pauses).toBe(0);
  f.ctx.host.surfaces.invoke = async () => {};
  await expect(f.driver.openChat("fork")).rejects.toThrow("did not open");
  expect(f.current.pauses).toBe(100);
});
