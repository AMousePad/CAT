import { expect, test } from "bun:test";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { Bridge } from "../src/ui/bridge";

test("unloading rejects pending requests and prevents later sends", async () => {
  const sent: unknown[] = [];
  let unsubscribed = false;
  const bridge = new Bridge({ onBackendMessage: () => () => { unsubscribed = true; }, sendToBackend: (message: unknown) => sent.push(message) } as unknown as SpindleFrontendContext);
  const pending = bridge.call("load", {}).catch(error => error);
  bridge.dispose(); expect((await pending).message).toContain("unloaded");
  await expect(bridge.call("load", {})).rejects.toThrow("unloaded");
  expect(sent).toHaveLength(1); expect(unsubscribed).toBe(true);
});

test("backend requests work on HTTP without crypto.randomUUID", async () => {
  const original = globalThis.crypto;
  let receive!: (message: unknown) => void;
  let id = "";
  const bridge = new Bridge({
    onBackendMessage: (callback: typeof receive) => { receive = callback; return () => {}; },
    sendToBackend: (request: { id: string }) => { id = request.id; receive({ type: "reply", id, value: true }); },
  } as unknown as SpindleFrontendContext);
  try {
    Object.assign(globalThis, { crypto: { getRandomValues: original.getRandomValues.bind(original) } });
    expect(await bridge.call("heartbeat", {})).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  } finally { Object.assign(globalThis, { crypto: original }); bridge.dispose(); }
});
