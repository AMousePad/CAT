import type { SpindleAPI, UserPresetDTO } from "lumiverse-spindle-types";

export function isLumiRealmPreset(preset: Pick<UserPresetDTO, "metadata">): boolean {
  return preset.metadata.source === "risupreset" || preset.metadata.lumirealm != null;
}

/** Retire extension-created presets while loading the user's source presets. */
export async function listSourcePresets(api: SpindleAPI["presets"], userId: string) {
  const sources: { id: string; name: string }[] = [];
  const obsolete: string[] = [];
  for (let offset = 0; ; ) {
    const page = await api.list({ userId, limit: 100, offset });
    for (const preset of page.data) {
      const marker = preset.metadata.another_one as { kind?: string; createdAt?: number } | undefined;
      if (marker?.kind === "controller" || marker?.kind === "preparation") {
        if (marker.kind === "controller" || !marker.createdAt || Date.now() - marker.createdAt > 120_000) obsolete.push(preset.id);
      } else if (!isLumiRealmPreset(preset)) sources.push({ id: preset.id, name: preset.name });
    }
    offset += page.data.length;
    if (!page.data.length || offset >= page.total) break;
  }
  // Delete after pagination so removing a row cannot shift the next page.
  for (const id of obsolete) await api.delete(id, userId);
  return sources;
}
