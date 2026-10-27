import type { SpindleAPI } from "lumiverse-spindle-types";
import { persistentVariables, variableChanges, variableMap, type SwipeVariables, type VariableSnapshot } from "../generation/variable-state";
import { isLumiRealmPreset } from "./preset-support";

interface Capture {
  user: string; chatId: string; runId: string; sourceId: string;
  before: Pick<VariableSnapshot, "global" | "chat">;
}

/** Native dry-run snapshots preserve the preset's own blocks, bindings and regexes. */
export class VariableCapture {
  private captures = new Map<string, Capture>();
  constructor(private api: SpindleAPI) {}
  async create(user: string, chatId: string, runId: string, sourceId: string) {
    const [source, chat] = await Promise.all([this.api.presets.get(sourceId, user), this.api.chats.get(chatId, user)]);
    if (!source || !chat) throw new Error("The preset or chat is no longer available.");
    if (isLumiRealmPreset(source)) throw new Error("LumiRealm presets are not supported. Choose a native Lumiverse preset.");
    const token = crypto.randomUUID();
    this.captures.set(token, { user, chatId, runId, sourceId, before: persistentVariables(chat.metadata) });
    return { token, presetId: sourceId };
  }
  async finish(user: string, runId: string, sourceId: string, token: string, state?: VariableSnapshot): Promise<SwipeVariables> {
    const capture = this.captures.get(token);
    if (!capture || capture.user !== user || capture.runId !== runId || capture.sourceId !== sourceId) throw new Error("The prepared request does not match this profile.");
    try {
      if (!state || [state.local, state.global, state.chat].some(map => !map || typeof map !== "object" || Array.isArray(map))) {
        throw new Error("Update Lumiverse to the version with native preset contexts and dry-run variable snapshots. No requests were sent.");
      }
      if (JSON.stringify(state).length > 1_000_000) throw new Error("The preset's variable state is too large to save.");
      const snapshot: VariableSnapshot = { local: variableMap(state.local), global: variableMap(state.global), chat: variableMap(state.chat),
        ...(state.prompt_defaults ? { prompt_defaults: variableMap(state.prompt_defaults) } : {}),
        ...(state.prompt_selections ? { prompt_selections: Object.fromEntries(Object.entries(state.prompt_selections)
          .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(v => typeof v === "string"))) } : {}),
      };
      const chat = await this.api.chats.get(capture.chatId, user);
      const latest = chat && persistentVariables(chat.metadata);
      if (!latest || variableChanges(capture.before, { local: {}, ...latest }).length) throw new Error("Chat variables changed while prompts were preparing. Send again to use the updated values.");
      return { presetId: sourceId, changes: variableChanges(capture.before, snapshot), local: snapshot.local, snapshot };
    } finally { this.captures.delete(token); }
  }
  async cancel(user: string, runId: string) {
    for (const [token, capture] of this.captures) if (capture.user === user && capture.runId === runId) this.captures.delete(token);
  }
}
