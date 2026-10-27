export type VariableMap = Record<string, string>;
export interface VariableSnapshot {
  local: VariableMap; global: VariableMap; chat: VariableMap;
  prompt_selections?: Record<string, string[]>; prompt_defaults?: VariableMap;
}
export interface VariableChange { scope: "global" | "chat"; key: string; before: string | null; after: string | null }
export interface SwipeVariables { presetId: string; changes: VariableChange[]; local: VariableMap; contentHash?: string; snapshot?: VariableSnapshot }
export interface MessageVariables { version: 1; slots: SwipeVariables[] }
export interface AppliedVariables { messageId: string; changes: VariableChange[] }

export function variableMap(value: unknown): VariableMap {
  return Object.fromEntries(value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([key, entry]) => [key, String(entry)]) : []);
}
export function persistentVariables(metadata: Record<string, any>): Pick<VariableSnapshot, "global" | "chat"> {
  return { global: variableMap(metadata.macro_variables?.global), chat: variableMap(metadata.chat_variables) };
}
export function variableChanges(before: Pick<VariableSnapshot, "global" | "chat">, after: VariableSnapshot): VariableChange[] {
  const value = (map: VariableMap, key: string) => Object.hasOwn(map, key) ? map[key] : null;
  return (["global", "chat"] as const).flatMap(scope => Array.from(new Set([...Object.keys(before[scope]), ...Object.keys(after[scope])]))
    .filter(key => value(before[scope], key) !== value(after[scope], key))
    .map(key => ({ scope, key, before: value(before[scope], key), after: value(after[scope], key) })));
}

/** Undo our prior selection only where its value is still present. */
export function applyVariableSelection(current: Pick<VariableSnapshot, "global" | "chat">,
  prior: VariableChange[], next: VariableChange[]): Pick<VariableSnapshot, "global" | "chat"> {
  const maps = { global: new Map(Object.entries(current.global)), chat: new Map(Object.entries(current.chat)) };
  const put = (change: VariableChange, value: string | null) => value === null ? maps[change.scope].delete(change.key) : maps[change.scope].set(change.key, value);
  for (const change of prior) if ((maps[change.scope].get(change.key) ?? null) === change.after) put(change, change.before);
  for (const change of next) {
    const value = maps[change.scope].get(change.key) ?? null;
    if (value !== change.before && value !== change.after) throw new Error(`Variable “${change.key}” changed after this reply. Its value has been kept.`);
    put(change, change.after);
  }
  return { global: Object.fromEntries(maps.global), chat: Object.fromEntries(maps.chat) };
}
