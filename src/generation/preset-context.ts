import type { LlmMessageDTO } from "lumiverse-spindle-types";

export const PRESET_CHANGE_NOTE = "Note: Your instructions have changed, ensure you only generate prose-adjacent items that are **currently** specified. Do not generate structures based on past messages.";

/** Keep provenance on the message, so this still works after run history expires. */
export function usesMultiplePresets(messages: { metadata?: Record<string, unknown> }[], presetIds: string[]): boolean {
  const used = new Set(presetIds);
  for (const message of messages) {
    const ids = message.metadata?.another_one_presets;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" && id) used.add(id);
  }
  return used.size > 1;
}

export function withPresetNote(messages: LlmMessageDTO[], needed: boolean): LlmMessageDTO[] {
  if (!needed) return messages;
  // A final instruction keeps this next to the generation, including when a
  // provider adapter merges system messages. Do not change the saved user text.
  return [...messages, { role: "system", content: PRESET_CHANGE_NOTE }];
}

export async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
