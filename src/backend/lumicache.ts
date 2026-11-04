import type { LlmMessageDTO, SpindleAPI } from "lumiverse-spindle-types";
import { errorText } from "../shared";

const POLICY = { requires: ["generation"] };
const REVIEW_LIMIT_MS = 300_000;
type Result = { status: "done"; messages: LlmMessageDTO[] } | { status: "error"; error: string };
export interface CacheCheck { id: string; userId: string; chatId: string; slotId: string; label: string; connectionId: string; model: string; session: string; messages: LlmMessageDTO[] }

const notRegistered = (error: unknown) => /not registered/i.test(errorText(error));

/** rawStream skips LumiCache's interceptor, so swipes hand it their final prompt. */
export class LumiCacheLink {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private api: Pick<SpindleAPI, "rpcPool">, private pollMs = 150) {}
  /** LumiCache reads one shared slot per call, so requests must not overlap. */
  private send(request: unknown): Promise<void> {
    const work = this.tail.then(async () => {
      this.api.rpcPool.sync("cache_request", request, POLICY);
      try { await this.api.rpcPool.read("lumicache.cat"); }
      finally { this.api.rpcPool.sync("cache_request", null, POLICY); }
    });
    this.tail = work.catch(() => {});
    return work;
  }
  /** Returns null when LumiCache is not installed. A declined review throws. */
  async check(input: CacheCheck, cancelled: () => boolean): Promise<LlmMessageDTO[] | null> {
    try { await this.send({ op: "check", ...input }); }
    catch (error) {
      if (notRegistered(error)) return null;
      throw error;
    }
    const deadline = Date.now() + REVIEW_LIMIT_MS;
    while (Date.now() < deadline) {
      if (cancelled()) {
        await this.send({ op: "cancel", id: input.id });
        throw new Error("Stopped before generating swipes.");
      }
      const result = await this.read(input.id);
      if (result?.status === "done") return result.messages;
      if (result?.status === "error") throw new Error(result.error);
      await Bun.sleep(this.pollMs);
    }
    throw new Error("LumiCache did not answer in time. Retry sending.");
  }
  private async read(id: string): Promise<Result | null> {
    try { return await this.api.rpcPool.read<Result>(`lumicache.cat_result.${id}`); }
    catch (error) {
      if (notRegistered(error)) return null;
      throw error;
    }
  }
  finish(id: string, userId: string, success: boolean): Promise<void> {
    return this.send({ op: "finish", id, userId, success });
  }
}
