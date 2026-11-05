import type { SpindleAPI } from "lumiverse-spindle-types";

export const DOCS_SURFACE = "cat_docs";
export const DOCS_HINT = 'CAT help: list_external({surface_id:"cat_docs"}), then read_external({surface_id:"cat_docs",item_id:<topic>}). Read-only docs; CAT controls are in its drawer/hotbar.';

const topics = [
  { id: "overview", label: "Setup, scope, cost", text: `CAT (Concurrent Alternate Trajectories; extension another_one) generates parallel alternate swipes of one assistant message. Each selected profile has its own preset and connection/model, with streaming, reasoning, regex rendering and variables retained per swipe.
Start: CAT sidebar > Settings > Add profile; choose preset and optional connection; open a supported chat; Enable; send normally. Swipes tab shows runs; composer cat icon selects profiles and toggles CAT. Read profiles for configuration, generation for lifecycle, swipes for history/state, troubleshooting for limits.
One selected profile = one model request: N profiles incur N requests. Separate connections per profile may help provider cache setups; CAT does not guarantee caching. LumiCache can review prepared requests.
This bridge serves documentation only. It cannot inspect/change CAT settings, enable/disable, generate, select swipes or stop requests. Guide the user through CAT UI; do not invent CAT agent tools or edit its private storage.` },
  { id: "profiles", label: "Profiles, connections, hotbar", text: `CAT > Settings: Add profile (maximum 20); select a native Lumiverse preset and explicit connection or "Connection active when enabled". The latter resolves when CAT arms for that chat/send, not independently midway through a run. Duplicate presets/connections are allowed. Remove with ×; drag to reorder or use Up/Down on the drag handle. Changes save automatically. Disable CAT to edit; Refresh lists reloads presets/connections.
All configured profiles must have valid presets/connections, even if deselected. Deleted/unavailable choices must be replaced. LumiRealm/Risu presets are excluded.
Composer cat icon / input-bar CAT action: enable/disable; switch profiles ON/OFF; Manage profiles opens Settings. Keep at least one selected. Selection and enabled state persist across sends, reloads and chat forks; selection changes affect following runs. Settings/activation belong to the user, history to each chat.
CAT tab displays cat photos; icons/backgrounds rotate on interaction. These are decorative and do not affect generation.` },
  { id: "generation", label: "Send, stream, stop, cache review", text: `Enable CAT in a private single-character text chat; send normally. CAT intercepts normal browser sends, prepares each selected profile's prompt, then streams requests concurrently into one assistant message's swipes. Dry runs and non-normal generation modes are not CAT runs. Navigate swipes while streaming; each retains its preset's formatting/regex and reasoning.
Mixed-preset history/selection adds a short instruction to use currently specified prose structures rather than repeat old preset templates. A single-profile CAT setup can switch presets while retaining old messages' rendering.
Once a send reaches Lumiverse, preparation/generation runs on the server: navigating away or closing the browser does not stop it. Lumiverse must stay running. Reopen the chat to recover saved replies/history. This does not promise recovery across a server/extension restart.
Stop in Swipes, the composer, or "Stop parallel swipes" cancels active requests; Disable also disarms/stops. Already generated text may remain. A new message can stop previous swipes. Wait for completion or stop before starting another run.
With LumiCache installed, all profile prompts pass review/force consistency before any swipe starts. Declining one review stops the batch. Handle send approvals in LumiCache, not through the docs bridge.` },
  { id: "swipes", label: "History, rendering, variables, forks", text: `Swipes tab: current/recent runs show message number, character, time, each profile's preset/connection, progress and errors. Up to 20 runs are retained per chat. Click a non-waiting row for the latest message to open its swipe; older run rows are informational. Use native chat swipe navigation where available. Some requests can fail while others finish; inspect each row's error before retrying.
Each swipe retains its own preset context and reasoning. Selecting a swipe restores its captured variable state through Lumiverse; avoid manually overwriting CAT metadata or variable snapshots. A variable error means state could not be applied; resolve it before continuing.
Forks and native chat export/import preserve message-linked CAT data; restored histories use the new chat/message identities. Native history restoration also restores preset contexts. Deleted messages lose their history entries. Edits/deletions during streaming can invalidate a run; CAT must not recreate deleted messages.
Browser reopening restores saved runs, not transient model execution after a server restart.` },
  { id: "troubleshooting", label: "Requirements and failure recovery", text: `Requires a current Lumiverse build with CAT's background generation, managed messages, per-swipe preset/reasoning/variables and conditional metadata support; follow the exact "Update Lumiverse" error. Extension minimum is 1.3.0, but required capabilities must also be present.
Unsupported: group chats, multiplayer rooms, Council with members enabled, temporary chats with presets disabled, LumiRealm/Risu presets. Chats with attachments fall back to ordinary Lumiverse generation because CAT is text-only. Use a private single-character text chat, native presets and Council off.
"Add a profile"/unavailable choices: Disable, fix every profile in Settings, Refresh lists, Enable. "Another browser controls CAT": disable there first; detached server work may still be running. "Wait"/fork switching: let it finish or Stop. Preparation/provider errors: inspect Swipes details and check the selected connection/preset; a failed batch may leave successful/partial swipes, so inspect before resending.
Cache pause: open LumiCache in the sending browser, inspect/approve or cancel there; missing browser approval may time out. Docs bridge unavailable: enable both extensions and grant CAT's characters permission for LumiAgent's request-envelope handshake, then restart/refresh discovery. CAT docs require no focused character or live browser and expose no chat/user content.` },
] as const;

export function registerAgentDocs(api: Pick<SpindleAPI, "rpcPool">) {
  api.rpcPool.handle("phoneline", async context => {
    if (context.requesterExtensionId !== "lumiagent") throw new Error("Only LumiAgent may use this bridge.");
    const raw = await api.rpcPool.read("lumiagent.phoneline_request");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Malformed CAT bridge request.");
    const request = raw as Record<string, unknown>;
    switch (request.op) {
      case "describe": return { extension: { id: "another_one", name: "Concurrent Alternate Trajectories" },
        surfaces: [{ id: DOCS_SURFACE, label: "CAT guide", scope: "global", description: "Read-only LLM help. List topics, then read one topic; no CAT controls." }] };
      case "system_prompt": return { text: DOCS_HINT };
      case "list_items":
        if (request.surfaceId !== DOCS_SURFACE) throw new Error("Unknown CAT surface.");
        return { items: topics.map(({ id, label }) => ({ id, label })), total: topics.length };
      case "read_item": {
        if (request.surfaceId !== DOCS_SURFACE) throw new Error("Unknown CAT surface.");
        if (request.field !== undefined && request.field !== "text") throw new Error("Read a whole CAT topic or field text.");
        const topic = topics.find(topic => topic.id === request.itemId);
        if (!topic) throw new Error("Unknown CAT topic. List cat_docs first.");
        return { value: topic.text };
      }
      case "write_field": return { ok: false, error: "CAT documentation is read-only." };
      default: throw new Error("Unknown CAT bridge operation. This bridge only serves documentation.");
    }
  }, { requires: ["characters"] });
}
