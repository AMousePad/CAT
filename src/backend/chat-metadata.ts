import type { SpindleAPI } from "lumiverse-spindle-types";

type Message = Awaited<ReturnType<SpindleAPI["chat"]["getMessages"]>>[number];
interface ConditionalMetadata {
  expected_metadata: Record<string, unknown>; metadata: Record<string, unknown>;
  expected_last_message_id: string | null;
  expected_message?: { id: string; swipe_id: number; swipes: string[]; metadata: Record<string, unknown> };
}

export async function compareChatMetadata(api: SpindleAPI, user: string, chatId: string,
  expected: Record<string, unknown>, metadata: Record<string, unknown>, messages: Message[], target?: Message) {
  const chats = api.chats as SpindleAPI["chats"] & {
    compareAndSetMetadata(chatId: string, input: ConditionalMetadata, userId: string): Promise<unknown | null>;
  };
  return await chats.compareAndSetMetadata(chatId, { expected_metadata: expected, metadata,
    expected_last_message_id: messages.at(-1)?.id ?? null,
    ...(target ? { expected_message: { id: target.id, swipe_id: target.swipe_id, swipes: target.swipes, metadata: target.metadata ?? {} } } : {}),
  }, user) !== null;
}
