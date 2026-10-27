import { isDeepStrictEqual } from "node:util";

export function conditionalMetadata(chat: { metadata: any }, messages: any[], input: any) {
  if (!isDeepStrictEqual(chat.metadata, input.expected_metadata) || (messages.at(-1)?.id ?? null) !== input.expected_last_message_id) return null;
  const guard = input.expected_message;
  if (guard) {
    const m = messages.find(m => m.id === guard.id);
    if (!m || m.swipe_id !== guard.swipe_id || !isDeepStrictEqual(m.swipes, guard.swipes) || !isDeepStrictEqual(m.metadata ?? {}, guard.metadata)) return null;
  }
  chat.metadata = structuredClone(input.metadata);
  return structuredClone(chat);
}
