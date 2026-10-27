import type { SpindleAPI } from "lumiverse-spindle-types";
import { errorText } from "../shared";
import { Storage } from "./storage";
import { Leases } from "./leases";
import { Automation } from "./automation";
import { inspectChat } from "./inspection";
import { selectSwipe } from "./select-swipe";
import { VariableCapture } from "./variable-capture";
import { VariableSelection } from "./variable-selection";
import { listSourcePresets } from "./preset-support";
import { restoreMessageContexts } from "./message-contexts";
import { Forks } from "./forks";
import { restoreRunHistory } from "./run-history";
declare const spindle: SpindleAPI;
const storage = new Storage(spindle.userStorage);
const leases = new Leases();
const variableCapture = new VariableCapture(spindle);
const forks = new Forks(spindle, storage);
const variableSelection = new VariableSelection(spindle, (user, chat) => forks.ensure(user, chat));
const active = new Map<string, string>();
spindle.on("GENERATION_STARTED", (p, user) => { if (user) active.set(`${user}:${p.chatId}`, p.generationId); });
for (const event of ["GENERATION_ENDED", "GENERATION_STOPPED"] as const) spindle.on(event, (payload, user) => {
  const p = payload as { chatId: string; generationId: string };
  const key = `${user}:${p.chatId}`;
  if (active.get(key) === p.generationId) active.delete(key);
});

async function loadCatalog(userId: string, chatId?: string) {
  if (!spindle.host.capabilities["message-preset-context-v1"]) throw new Error("CAT requires a Lumiverse build with per-swipe preset support. Update Lumiverse before enabling CAT.");
  if (!spindle.host.capabilities["chat-swipe-reasoning-v1"]) throw new Error("Update Lumiverse to a build with per-swipe reasoning support before enabling CAT.");
  if (!spindle.host.capabilities["chat-metadata-patch-v1"]) throw new Error("Update Lumiverse to a build with message metadata patch support before enabling CAT.");
  if (!spindle.host.capabilities["generation-request-messages-v1"]) throw new Error("Update Lumiverse to a build with prepared request messages before enabling CAT.");
  if (!spindle.host.capabilities["chat-conditional-metadata-v1"]) throw new Error("Update Lumiverse to a build with conditional chat metadata updates before enabling CAT.");
  const presets = await listSourcePresets(spindle.presets, userId);
  const [settings, connections, history, activation] = await Promise.all([storage.settings(userId), spindle.connections.list(userId), chatId ? storage.history(userId, chatId) : [], storage.activation(userId)]);
  return { settings, history, activation, presets, connections: connections.map(c => ({ id: c.id, name: c.name, model: c.model })) };
}
const automation = new Automation(spindle, storage, leases, loadCatalog, (chatId, userId) => inspectChat(spindle, active, chatId, userId),
  { capture: variableCapture, selection: variableSelection }, (user, chat) => forks.ensure(user, chat));
spindle.on("MESSAGE_DELETED", (raw, userId) => {
  if (!userId) return;
  const event = raw as { chatId: string; messageId: string };
  void storage.removeMessage(userId, event.chatId, event.messageId).then(changed => {
    if (changed) spindle.sendToFrontend({ type: "historyChanged" }, userId);
  }).catch(error => spindle.log.error(`Could not remove swipe history: ${errorText(error)}`));
});

spindle.onFrontendMessage(async (raw, userId, session) => {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Record<string, unknown>;
  if (msg.type !== "request" || typeof msg.id !== "string" || msg.id.length > 100 || !session) return;
  const input = msg.input && typeof msg.input === "object" ? msg.input as Record<string, unknown> : {};
  try {
    let value: unknown;
    switch (msg.operation) {
      case "load": value = await loadCatalog(userId, typeof input.chatId === "string" ? input.chatId : undefined); break;
      case "activation": value = await automation.setActivation(userId, input); break;
      case "preparePreset": value = await automation.preparePreset(userId, session, String(input.runId), Number(input.stepIndex)); break;
      case "save": value = await storage.save(userId, input.settings); break;
      case "heartbeat": value = leases.heartbeat(userId, session); break;
      case "arm":
        if (typeof input.chatId !== "string" || typeof input.connectionId !== "string") throw new Error("A chat and connection are required.");
        value = await automation.arm(userId, session, input.chatId, input.connectionId, input.slotIds as string[] | undefined); break;
      case "followFork":
        if (typeof input.chatId !== "string") throw new Error("Open a chat first.");
        value = await automation.followFork(userId, session, input.chatId); break;
      case "restoreContexts": {
        if (typeof input.chatId !== "string") throw new Error("Open a chat first.");
        await forks.ensure(userId, input.chatId);
        const chat = await spindle.chats.get(input.chatId, userId);
        if (!chat) throw new Error("This chat no longer exists.");
        await restoreRunHistory(spindle, storage, userId, chat, await spindle.chat.getMessages(input.chatId),
          runId => automation.isCurrentRun(userId, runId));
        const checked = await storage.history(userId, input.chatId);
        const messages = await restoreMessageContexts(spindle, input.chatId, checked);
        await storage.reconcileHistory(userId, checked, messages);
        value = { messages, history: await storage.history(userId, input.chatId) }; break;
      }
      case "disarm": value = await automation.disarm(userId, session, input.stop === true); break;
      case "launch": value = await automation.launch(userId, session, String(input.runId), String(input.messageId), input.prompts as import("../generation/parallel-run").PreparedPrompt[]); break;
      case "preparationFailed": value = await automation.preparationFailed(userId, session, String(input.runId), String(input.error), String(input.chatId), typeof input.messageId === "string" ? input.messageId : undefined); break;
      case "selectSwipe": {
        const runId = String(input.runId);
        if (typeof input.chatId !== "string") throw new Error("A chat is required.");
        const run = automation.getRun(userId, runId) || (await storage.history(userId, input.chatId)).find(r => r.id === runId);
        if (!run || run.chatId !== input.chatId) throw new Error("This run is no longer available.");
        await selectSwipe(spindle, run, Number(input.stepIndex), () => variableSelection.sync(userId, run.chatId)); value = true; break;
      }
      default: throw new Error("Unknown CAT operation.");
    }
    spindle.sendToFrontend({ type: "reply", id: msg.id, value }, userId, { frontendSessionId: session });
  } catch (error) {
    spindle.sendToFrontend({ type: "reply", id: msg.id, error: errorText(error) }, userId, { frontendSessionId: session });
  }
});
