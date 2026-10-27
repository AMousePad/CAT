export const MAX_SWIPES = 20;
export const MAX_HISTORY = 20;
export interface SwipeSlot { id: string; presetId: string; connectionId: string | null }
export interface Settings { version: 1; slots: SwipeSlot[]; cats: boolean }
export interface Activation { enabled: boolean; slotIds?: string[]; revision: number }
export interface ActivationPatch { enabled?: boolean; slotIds?: string[] | null }
export const defaults = (): Settings => ({ version: 1, slots: [], cats: true });

export function normalizeSettings(raw: unknown): Settings {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const slots: SwipeSlot[] = [];
  const ids = new Set<string>();
  for (const entry of Array.isArray(value.slots) ? value.slots.slice(0, MAX_SWIPES) : []) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== "string" || !s.id || s.id.length > 100 || ids.has(s.id)) continue;
    ids.add(s.id);
    slots.push({ id: s.id, presetId: typeof s.presetId === "string" ? s.presetId.slice(0, 100) : "",
      connectionId: typeof s.connectionId === "string" && s.connectionId ? s.connectionId.slice(0, 100) : null });
  }
  return { version: 1, slots, cats: value.cats !== false };
}

export function validateSlots(slots: SwipeSlot[], presets: Choice[], connections: Choice[]): void {
  if (!slots.length) throw new Error("Add a profile in Settings first.");
  if (slots.length > MAX_SWIPES) throw new Error(`Use up to ${MAX_SWIPES} profiles.`);
  for (const slot of slots) {
    if (!presets.some(p => p.id === slot.presetId)) throw new Error("Choose a preset for each profile.");
    if (slot.connectionId && !connections.some(c => c.id === slot.connectionId)) throw new Error("A selected connection is no longer available.");
  }
}
export interface Choice { id: string; name: string; model?: string }
export interface Catalog { settings: Settings; presets: Choice[]; connections: Choice[] }
export interface Inspection {
  chatId: string; chatName: string; blockedReason?: string; busy: boolean;
}
export interface RunStep { presetId: string; presetName: string; connectionName: string; status: "waiting" | "running" | "done" | "stopped" | "error"; swipe?: number; swipeId?: string; contentHash?: string; error?: string }
export interface RunRecord { id: string; chatId: string; chatName: string; messageId: string; messageIndex?: number; characterName?: string; at: number; steps: RunStep[]; outcome: "running" | "complete" | "stopped" | "error"; detail?: string }
export interface MessageSummary { index: number; name: string }
export interface ViewState { phase: "off" | "preparing" | "ready" | "running" | "stopping" | "error"; detail: string; run: RunRecord | null }
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
