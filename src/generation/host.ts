import type { SpindleFrontendContext } from "lumiverse-spindle-types";
export interface HostNavigation {
  chatId(): string | null;
  connectionId(): string | null;
  openChat(chatId: string): Promise<void>;
}

export function hostDriver(ctx: SpindleFrontendContext,
  settle = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): HostNavigation {
  const surfaces = ctx.host.surfaces;
  const connections = ctx.connections;
  const state = ctx.state;
  if (!surfaces || !connections?.getActive || !state || !ctx.frontendSessionId) throw new Error("Update Lumiverse: CAT requires host actions, connection profiles, and frontend session routing.");
  const driver: HostNavigation = {
    chatId: () => state.get<{ chatId: string | null }>("chat.active").chatId,
    connectionId: () => connections.getActive!().activeProfileId,
    async openChat(chatId) {
      if (driver.chatId() === chatId) return;
      await surfaces.invoke({ kind: "route", id: "/chat/:chatId" }, { chatId });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (driver.chatId() === chatId) return;
        await settle(50);
      }
      throw new Error("Lumiverse did not open this chat.");
    },
  };
  return driver;
}
