import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { join } from "node:path";

export interface PresetProbe {
  id: string;
  variable: string;
  promptIncludes?: string;
  display?: { input: string; includes: string[]; excludes: string[] };
}

/** Read production presets only; every mutation and dry run uses the disposable host. */
export async function auditInstalledPresets(host: string, api: (path: string, method?: string, body?: unknown) => Promise<any>,
  chatId: string, connectionId: string, userId: string, regexService: any, pass: (message: string) => void, probes: PresetProbe[]) {
  assert(Array.isArray(probes) && probes.length, "Provide at least one preset probe");
  const source = new Database(join(host, "data/lumiverse.db"), { readonly: true });
  try {
    for (const probe of probes) {
      const { id, variable: probeName } = probe;
      assert(typeof id === "string" && typeof probeName === "string", "Each probe needs an id and variable");
      const row = source.query("SELECT * FROM presets WHERE id=?").get(id) as any;
      assert(row, `Installed preset missing: ${id}`);
      const preset = { name: row.name, provider: row.provider, engine: row.engine,
        metadata: JSON.parse(row.metadata), parameters: JSON.parse(row.parameters), prompts: JSON.parse(row.prompts), prompt_order: JSON.parse(row.prompt_order) };
      const copy = await api("/api/v1/presets", "POST", preset);
      const definitions = copy.prompt_order.filter((b: any) => b.enabled).flatMap((b: any) => b.variables ?? []);
      const types = [...new Set(definitions.map((v: any) => v.type))];
      const dry = () => api("/api/v1/generate/dry-run", "POST", { chat_id: chatId, connection_id: connectionId, preset_id: copy.id, force_preset_id: true, generation_type: "normal" });
      const baseline = await dry();
      assert(baseline.messages.length && baseline.variable_state?.local);
      for (const def of definitions) assert(Object.hasOwn(baseline.variable_state.local, def.name), `Missing native variable ${def.name}`);
      assert(definitions.some((def: any) => def.name === probeName), `Missing variable definition: ${probeName}`);
      const outputs: any[] = [];
      for (const value of [0, 1]) {
        const promptVariables = structuredClone(copy.metadata.promptVariables ?? {});
        for (const block of copy.prompt_order) if (block.variables?.some((v: any) => v.name === probeName))
          promptVariables[block.id] = { ...promptVariables[block.id], [probeName]: value };
        const latest = await api(`/api/v1/presets/${copy.id}`);
        await api(`/api/v1/presets/${copy.id}`, "PUT", { expected_cache_revision: latest.cache_revision, metadata: { ...copy.metadata, promptVariables } });
        const output = await dry(); outputs.push(output);
        assert.equal(output.variable_state.local[probeName], String(value));
      }
      assert.notDeepEqual(outputs[0].messages, outputs[1].messages, `${probeName} must change assembled conditional blocks`);
      if (probe.promptIncludes) {
        const includes = (output: any) => output.messages.some((m: any) => m.content.includes(probe.promptIncludes));
        assert(!includes(outputs[0]) && includes(outputs[1]), "Conditional prompt must follow the UI switch");
      }
      const saved = source.query("SELECT value FROM settings WHERE user_id=? AND key=?").get(row.user_id, `presetRegexEnabled:${id}`) as any;
      const enabled: string[] | null = saved ? JSON.parse(saved.value) : null;
      const scripts = (source.query("SELECT * FROM regex_scripts WHERE user_id=? AND preset_id=? ORDER BY sort_order,created_at").all(row.user_id, id) as any[])
        .map(rule => ({ ...rule, placement: JSON.parse(rule.placement), target: JSON.parse(rule.target), trim_strings: JSON.parse(rule.trim_strings), metadata: JSON.parse(rule.metadata),
          actions: JSON.parse(rule.actions ?? "[]"), disabled: enabled ? !enabled.includes(rule.id) : !!rule.disabled }));
      regexService.importPresetBoundRegexScripts(userId, copy.id, copy.name, scripts);
      if (probe.display) {
        const raw = probe.display.input;
        const message = await api(`/api/v1/chats/${chatId}/messages`, "POST", { name: "Miso", is_user: false, content: raw,
          extra: { spindle_metadata: { preset_contexts: [{ preset_id: copy.id, variables: baseline.variable_state }] } } });
        const preprocessed = await api(`/api/v1/chats/${chatId}/display-preprocess`, "POST", { messageId: message.id, rawContent: raw, role: "assistant", depth: 0 });
        const active = await api(`/api/v1/regex-scripts/active?target=display&chat_id=${chatId}&preset_id=${copy.id}`);
        const result = await api('/api/v1/regex-scripts/apply', "POST", { content: preprocessed.content, scripts: active,
          context: { chat_id: chatId, message_id: message.id, use_message_preset: true, is_user: false, depth: 0, role: "assistant" } });
        for (const text of probe.display.includes) assert(result.result.includes(text), `Missing rendered content: ${text}`);
        for (const text of probe.display.excludes) assert(!result.result.includes(text), `Unexpected rendered content: ${text}`);
        pass(`${row.name}: ordered display regexes match the rendering probe`);
      }
      pass(`${row.name.normalize("NFKC").trim()}: ${definitions.length} enabled-block variables (${types.join(", ")}); ${probeName} changes native conditional prompts; ${scripts.filter(s => !s.disabled).length} enabled regexes`);
    }
  } finally { source.close(); }
}
