import type { SpindleFrontendContext } from "lumiverse-spindle-types";

export function randomId(ctx: SpindleFrontendContext): string {
  if (!ctx.uuid) throw new Error("Update Lumiverse to a build with frontend UUID support to use CAT.");
  return ctx.uuid.v4();
}
