import { expect, test } from "bun:test";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { Bridge } from "../src/ui/bridge";

test("unloading rejects pending requests and prevents later sends", async () => {
  const sent: unknown[] = [];
  let unsubscribed = false;
  const bridge = new Bridge({ uuid: { v4: () => "host-uuid" }, onBackendMessage: () => () => { unsubscribed = true; }, sendToBackend: (message: unknown) => sent.push(message) } as unknown as SpindleFrontendContext);
  const pending = bridge.call("load", {}).catch(error => error);
  bridge.dispose(); expect((await pending).message).toContain("unloaded");
  await expect(bridge.call("load", {})).rejects.toThrow("unloaded");
  expect(sent).toHaveLength(1); expect(unsubscribed).toBe(true);
});

test("hosts without the frontend UUID API reject requests with an update error", async () => {
  const sent: unknown[] = [];
  const bridge = new Bridge({ onBackendMessage: () => () => {}, sendToBackend: (message: unknown) => sent.push(message) } as unknown as SpindleFrontendContext);
  await expect(bridge.call("heartbeat", {})).rejects.toThrow("Update Lumiverse");
  expect(sent).toHaveLength(0);
  bridge.dispose();
});

test("backend requests use the Spindle UUID API when browser crypto is blocked", async () => {
  const original = globalThis.crypto;
  let receive!: (message: unknown) => void;
  let id = "";
  const bridge = new Bridge({
    uuid: { v4: () => "host-uuid" },
    onBackendMessage: (callback: typeof receive) => { receive = callback; return () => {}; },
    sendToBackend: (request: { id: string }) => { id = request.id; receive({ type: "reply", id, value: true }); },
  } as unknown as SpindleFrontendContext);
  try {
    Object.assign(globalThis, { crypto: undefined });
    expect(await bridge.call("heartbeat", {})).toBe(true);
    expect(id).toBe("host-uuid");
  } finally { Object.assign(globalThis, { crypto: original }); bridge.dispose(); }
});
