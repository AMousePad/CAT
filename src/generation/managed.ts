import type { SpindleAPI, LlmMessageDTO } from "lumiverse-spindle-types";
import type { VariableSnapshot } from "./variable-state";
type Generate = SpindleAPI["generate"];
export type ManagedGenerate = Omit<Generate, "dryRun"> & {
  dryRun(input: Parameters<Generate["dryRun"]>[0] & { retainResponseContext: true; forcePresetId: true; includeRequestMessages: true }, userId: string):
    Promise<Awaited<ReturnType<Generate["dryRun"]>> & { responseContextId?: string; request_messages?: LlmMessageDTO[]; variable_state?: VariableSnapshot; assistantPrefill?: string }>;
  beginMessage(input: { chatId: string; messageId: string; responseContextIds: string[]; frontendSessionId: string; userId: string }): Promise<{ id: string }>;
  finishMessage(id: string): Promise<{ completed: boolean; messageId: string }>;
  abortMessage(id: string): Promise<void>;
};
export const managedGenerate = (api: SpindleAPI) => api.generate as ManagedGenerate;
