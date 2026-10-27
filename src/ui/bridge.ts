import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import type { Operations, Reply } from "../types";
import { randomId } from "./id";

export class Bridge {
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private unsubscribe: () => void;
  private disposed = false;
  constructor(private ctx: SpindleFrontendContext) {
    this.unsubscribe = ctx.onBackendMessage(raw => {
      const message = raw as Reply;
      if (message?.type !== "reply") return;
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
    });
  }
  call<K extends keyof Operations>(operation: K, input: Operations[K]["input"]): Promise<Operations[K]["output"]> {
    if (this.disposed) return Promise.reject(new Error("Extension unloaded."));
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CAT's backend did not respond. Check the connection and extension permissions.")); }, 20_000);
      this.pending.set(id, { resolve: value => resolve(value as Operations[K]["output"]), reject, timer });
      try { this.ctx.sendToBackend({ type: "request", id, operation, input }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  dispose() {
    this.disposed = true;
    this.unsubscribe();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("Extension unloaded.")); }
    this.pending.clear();
  }
}
