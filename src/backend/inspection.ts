import type { SpindleAPI } from "lumiverse-spindle-types";
import type { Inspection } from "../shared";

/** The configured slots already identify every preset; no active-preset RPC is needed. */
export async function inspectChat(api: Pick<SpindleAPI, "chats">, active: ReadonlyMap<string, string>, chatId: string, userId: string): Promise<Inspection> {
  const chat = await api.chats.get(chatId, userId);
  if (!chat) throw new Error("This chat is no longer available.");
  const m = chat.metadata;
  const blockedReason = m.group ? "Group chats are not supported yet. Open a single-character chat."
    : m.multiplayer ? "Multiplayer rooms are not supported yet. Open a private chat."
    : m.temporary && m.no_preset ? "This chat has presets disabled. Enable presets first." : undefined;
  return { chatId, chatName: chat.name, blockedReason, busy: active.has(`${userId}:${chatId}`) };
}
