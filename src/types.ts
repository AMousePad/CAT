import type { Activation, ActivationPatch, Catalog, MessageSummary, RunRecord, Settings } from "./shared";
import type { PreparedPrompt } from "./generation/parallel-run";
import type { ViewState } from "./shared";
export interface Preparation {
  type: "prepare"; runId: string; chatId: string; name: string; characterId?: string; personaId?: string;
  slots: { presetId: string; connectionId: string }[];
  mixedPresets?: boolean;
}
export interface Operations {
  preparePreset: { input: { runId: string; stepIndex: number }; output: { token: string; presetId: string } };
  load: { input: Record<string, never>; output: Catalog & { history: RunRecord[]; activation: Activation } };
  activation: { input: ActivationPatch; output: Activation };
  save: { input: { settings: Settings }; output: Settings };
  heartbeat: { input: Record<string, never>; output: boolean };
  arm: { input: { chatId: string; connectionId: string; slotIds?: string[] }; output: ViewState };
  followFork: { input: { chatId: string }; output: ViewState | null };
  restoreContexts: { input: { chatId: string }; output: Record<string, MessageSummary | null> };
  disarm: { input: { stop?: boolean }; output: ViewState };
  launch: { input: { runId: string; messageId: string; prompts: PreparedPrompt[] }; output: boolean };
  preparationFailed: { input: { runId: string; error: string; chatId: string; messageId?: string }; output: boolean };
  selectSwipe: { input: { runId: string; stepIndex: number }; output: boolean };
}
export type Reply = { type: "reply"; id: string; value?: unknown; error?: string };
