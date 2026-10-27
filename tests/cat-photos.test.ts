import { afterEach, expect, test } from "bun:test";
import { catPhotos } from "../src/ui/cat-photos";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("concurrent preloads share a batch and use cacheable CDN URLs without credentials", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    expect(init?.credentials).toBe("omit"); expect(init?.referrerPolicy).toBe("no-referrer");
    return Response.json(Array.from({ length: 10 }, (_, i) => ({ url: `https://cdn2.thecatapi.com/images/${calls}-${i}.jpg` })));
  }) as unknown as typeof fetch;
  const photos = catPhotos();
  try {
    const urls = await Promise.all(Array.from({ length: 4 }, () => photos.next()));
    expect(calls).toBe(1); expect(new Set(urls).size).toBe(4);
    expect(urls[0]).toBe("https://cdn2.thecatapi.com/images/1-0.jpg");
    for (let i = 0; i < 6; i++) await photos.next();
    expect(calls).toBe(1);
    expect(await photos.next()).toBe("https://cdn2.thecatapi.com/images/2-0.jpg"); expect(calls).toBe(2);
  } finally { photos.dispose(); }
});

test.each(["offline", "rate limit", "invalid JSON", "empty", "untrusted URLs"])("cat search falls back without repeatedly hitting a broken service: %s", async failure => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (failure === "offline") throw new Error("Offline");
    if (failure === "rate limit") return new Response("", { status: 429 });
    if (failure === "invalid JSON") return new Response("broken");
    return Response.json(failure === "empty" ? [] : [
      { url: "https://example.com/cat.jpg" }, { url: "http://cdn2.thecatapi.com/images/cat.jpg" },
      { url: "https://cdn2.thecatapi.com/images/cat.svg" }, { url: "https://user:pass@cdn2.thecatapi.com/images/cat.jpg" }, null,
    ]);
  }) as unknown as typeof fetch;
  const photos = catPhotos();
  try {
    const urls = await Promise.all(Array.from({ length: 4 }, () => photos.next()));
    expect(urls.every(url => url.startsWith("https://cataas.com/cat?"))).toBe(true);
    expect(new Set(urls).size).toBe(4);
    expect(await photos.next()).toStartWith("https://cataas.com/cat?"); expect(calls).toBe(1);
  } finally { photos.dispose(); }
});

test("disposal aborts search and prevents late results from starting image loads", async () => {
  let signal: AbortSignal | undefined, finish!: (response: Response) => void;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    return new Promise<Response>(resolve => { finish = resolve; });
  }) as unknown as typeof fetch;
  const photos = catPhotos(), pending = photos.next(); photos.dispose();
  expect(signal?.aborted).toBe(true);
  finish(Response.json([{ url: "https://cdn2.thecatapi.com/images/late.jpg" }]));
  await expect(pending).rejects.toThrow("disposed");
  await expect(photos.next()).rejects.toThrow("disposed");
});
