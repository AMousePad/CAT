const SEARCH = "https://api.thecatapi.com/v1/images/search?limit=10&size=small&mime_types=jpg,png&order=RAND";

/** Fetch photo URLs in batches; keep CDN image requests cacheable. */
export function catPhotos() {
  let urls: string[] = [];
  let pending: Promise<void> | undefined;
  let request: AbortController | undefined;
  let retryAt = 0;
  let serial = 0;
  let disposed = false;

  async function load() {
    request = new AbortController();
    const timeout = setTimeout(() => request?.abort(), 4000);
    try {
      const response = await fetch(SEARCH, { signal: request.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      if (!response.ok) throw new Error("Cat search unavailable");
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error("Invalid cat search response");
      const photos = data.slice(0, 10).flatMap(item => {
        if (!item || typeof item.url !== "string") return [];
        try {
          const url = new URL(item.url);
          return url.protocol === "https:" && /^cdn2?\.thecatapi\.com$/.test(url.hostname)
            && !url.username && !url.password && !url.port && /\.(jpg|jpeg|png)$/i.test(url.pathname) ? [url.href] : [];
        } catch { return []; }
      });
      if (!photos.length) throw new Error("No cat photos returned");
      if (!disposed) urls.push(...new Set(photos));
    } catch {
      retryAt = Date.now() + 60_000;
    } finally {
      clearTimeout(timeout); request = undefined;
    }
  }

  return {
    async next(): Promise<string> {
      if (disposed) throw new Error("Cat photos disposed");
      if (!urls.length && Date.now() >= retryAt) {
        pending ??= load().finally(() => { pending = undefined; });
        await pending;
      }
      if (disposed) throw new Error("Cat photos disposed");
      return urls.shift() ?? `https://cataas.com/cat?width=900&another_one=${Date.now()}-${++serial}`;
    },
    dispose() { disposed = true; request?.abort(); urls = []; },
  };
}
