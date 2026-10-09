/**
 * VK Community Messages Long Poll transport for the local agent controller.
 * Uses outbound HTTPS only; no public webhook or inbound port is required.
 */
type TelegramKeyboard = { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
type VkCallback = { event_id: string; user_id: number; peer_id: number };
let longPoll: { server: string; key: string; ts: string } | undefined;
let syntheticUpdateId = 1;
const callbacks = new Map<string, VkCallback>();

function config() {
  const token = process.env.PI_ASK_USER_CONTROL_VK_TOKEN?.trim();
  const groupText = process.env.PI_ASK_USER_CONTROL_VK_GROUP_ID?.trim();
  if (!token || !groupText || !/^\d+$/.test(groupText)) {
    throw new Error("Set PI_ASK_USER_CONTROL_VK_TOKEN and PI_ASK_USER_CONTROL_VK_GROUP_ID");
  }
  return { token, groupId: Number(groupText) };
}

async function vkMethod<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const { token } = config();
  const body = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : String(v)])), access_token: token, v: "5.199" });
  const response = await fetch("https://api.vk.com/method/" + method, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("VK HTTP " + response.status);
  const data = await response.json() as { response?: T; error?: { error_msg?: string; error_code?: number } };
  if (data.error || data.response === undefined) throw new Error("VK API " + method + ": " + (data.error?.error_msg || "empty response"));
  return data.response;
}

export function toVkKeyboard(markup: unknown): string | undefined {
  const keyboard = markup as TelegramKeyboard | undefined;
  if (!keyboard?.inline_keyboard?.length) return undefined;
  return JSON.stringify({
    inline: true,
    buttons: keyboard.inline_keyboard.map(row => row.map(button => ({
      action: { type: "callback", label: button.text.slice(0, 40), payload: JSON.stringify({ command: button.callback_data }) },
      color: /отклонить|reject|cancel|✖/i.test(button.text) ? "negative" : "primary",
    }))),
  });
}

async function sendMessage(body: Record<string, unknown>): Promise<{ message_id: number }> {
  const peerId = Number(body.chat_id);
  const params: Record<string, unknown> = {
    peer_id: peerId,
    random_id: Math.floor(Math.random() * 2_000_000_000),
    message: String(body.text ?? "").slice(0, 4000),
  };
  const keyboard = toVkKeyboard(body.reply_markup);
  if (keyboard) params.keyboard = keyboard;
  const response = await vkMethod<{ message_id?: number; conversation_message_id?: number }>("messages.send", params);
  return { message_id: Number(response.message_id ?? response.conversation_message_id ?? 0) };
}

async function initLongPoll(): Promise<void> {
  const { groupId } = config();
  const response = await vkMethod<{ key: string; server: string; ts: string }>("groups.getLongPollServer", { group_id: groupId });
  longPoll = response;
}

async function getUpdates(): Promise<any[]> {
  if (!longPoll) await initLongPoll();
  const current = longPoll!;
  const url = new URL(current.server);
  url.searchParams.set("act", "a_check");
  url.searchParams.set("key", current.key);
  url.searchParams.set("ts", current.ts);
  url.searchParams.set("wait", "25");
  url.searchParams.set("version", "3");
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("VK Long Poll HTTP " + response.status);
  const data = await response.json() as { ts?: string; failed?: number; updates?: any[] };
  if (data.failed === 1) { longPoll = { ...current, ts: String(data.ts ?? current.ts) }; return []; }
  if (data.failed === 2 || data.failed === 3 || !data.ts) { longPoll = undefined; await initLongPoll(); return []; }
  longPoll = { ...current, ts: String(data.ts) };
  const updates: any[] = [];
  for (const item of data.updates ?? []) {
    const [type, event] = item as [string, any];
    if (type === "message_new") {
      const message = event?.message ?? event;
      if (typeof message?.text !== "string") continue;
      updates.push({
        update_id: syntheticUpdateId++,
        message: { message_id: Number(message.id ?? 0), chat: { id: Number(message.peer_id) }, from: { id: Number(message.from_id) }, text: message.text },
      });
    } else if (type === "message_event") {
      const eventId = String(event?.event_id ?? "");
      const userId = Number(event?.user_id);
      const peerId = Number(event?.peer_id);
      if (!eventId || !Number.isSafeInteger(userId) || !Number.isSafeInteger(peerId)) continue;
      callbacks.set(eventId, { event_id: eventId, user_id: userId, peer_id: peerId });
      const payload = event?.payload;
      let command = "";
      if (typeof payload === "string") {
        try { command = String(JSON.parse(payload)?.command ?? payload); } catch { command = payload; }
      } else if (payload && typeof payload === "object") command = String(payload.command ?? "");
      updates.push({
        update_id: syntheticUpdateId++,
        callback_query: { id: eventId, data: command, from: { id: userId }, message: { message_id: Number(event?.conversation_message_id ?? 0), chat: { id: peerId } } },
      });
    }
  }
  return updates;
}

async function answerCallback(queryId: string): Promise<void> {
  const event = callbacks.get(queryId);
  if (!event) return;
  callbacks.delete(queryId);
  await vkMethod("messages.sendMessageEventAnswer", {
    event_id: event.event_id, user_id: event.user_id, peer_id: event.peer_id,
    event_data: JSON.stringify({ type: "show_snackbar", text: "Принято" }),
  });
}

export async function vkControlApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  if (method === "sendMessage") return await sendMessage(body) as T;
  if (method === "getUpdates") return await getUpdates() as T;
  if (method === "answerCallbackQuery") {
    await answerCallback(String(body.callback_query_id ?? ""));
    return true as T;
  }
  throw new Error("Unsupported VK controller operation: " + method);
}
