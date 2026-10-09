import { randomUUID } from "node:crypto";
import { request as httpsRequest, Agent, type RequestOptions } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ClientRequestArgs } from "node:http";
import type { Duplex } from "node:stream";

export interface TelegramChoice {
  title: string;
  description?: string;
}
export type TelegramAnswer =
  | { kind: "selection"; selections: string[] }
  | { kind: "freeform"; text: string };

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id: number; chat: { id: number } };
  };
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id?: number };
    text?: string;
    reply_to_message?: { message_id: number };
  };
}
interface TelegramApiResult<T> { ok: boolean; result?: T; description?: string; }
interface TelegramMessage { message_id: number; chat: { id: number }; }

function socksAgent(proxyUrl: string): Agent {
  const proxy = new URL(proxyUrl);
  if (!["socks5:", "socks5h:"].includes(proxy.protocol)) {
    throw new Error("Telegram proxy must use socks5:// or socks5h://");
  }
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || 2080);
  if (!proxyHost || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error("Invalid Telegram SOCKS5 proxy URL");
  }

  class Socks5HttpsAgent extends Agent {
    override createConnection(
      options: ClientRequestArgs,
      callback?: (err: Error | null, stream: Duplex) => void,
    ): Duplex | null {
      const host = String(options.hostname || options.host || "api.telegram.org").replace(/^\[|\]$/g, "");
      const port = Number(options.port || 443);
      const socket = netConnect({ host: proxyHost, port: proxyPort });
      let pending = Buffer.alloc(0);
      let stage: "auth" | "connect" | "tls" = "auth";
      let finished = false;

      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        callback?.(error, undefined as unknown as Duplex);
      };
      const onData = (chunk: Buffer) => {
        if (finished) return;
        pending = Buffer.concat([pending, chunk]);
        if (stage === "auth") {
          if (pending.length < 2) return;
          if (pending[0] !== 5 || pending[1] !== 0) {
            fail(new Error("SOCKS5 proxy rejected no-auth connection"));
            return;
          }
          pending = pending.subarray(2);
          const domain = Buffer.from(host, "utf8");
          if (domain.length > 255) {
            fail(new Error("Telegram host name is too long for SOCKS5"));
            return;
          }
          const portBytes = Buffer.from([(port >> 8) & 255, port & 255]);
          socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, portBytes]));
          stage = "connect";
        }
        if (stage === "connect") {
          if (pending.length < 5) return;
          if (pending[0] !== 5 || pending[1] !== 0) {
            fail(new Error("SOCKS5 proxy could not connect to Telegram"));
            return;
          }
          const addressLength = pending[3] === 1 ? 4 : pending[3] === 4 ? 16 : pending[3] === 3 ? 1 + pending[4]! : 0;
          if (!addressLength) {
            fail(new Error("Invalid SOCKS5 response"));
            return;
          }
          const total = 4 + addressLength + 2;
          if (pending.length < total) return;
          socket.off("data", onData);
          pending = Buffer.alloc(0);
          stage = "tls";
          const secureSocket = tlsConnect({ socket, servername: host });
          secureSocket.once("secureConnect", () => {
            if (finished) return;
            finished = true;
            callback?.(null, secureSocket);
          });
          secureSocket.once("error", fail);
        }
      };
      socket.on("data", onData);
      socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
      socket.once("error", fail);
      return null;
    }
  }
  return new Socks5HttpsAgent({ keepAlive: false });
}

async function telegramCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  proxyUrl: string,
  timeoutMs: number,
): Promise<T> {
  const agent = socksAgent(proxyUrl);
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = httpsRequest(
        new URL(`https://api.telegram.org/bot${token}/${method}`),
        {
          method: "POST",
          agent,
          headers: { "content-type": "application/json" },
        } as RequestOptions,
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TelegramApiResult<T>;
              if (!payload.ok || payload.result === undefined) {
                reject(new Error(payload.description || `Telegram API ${method} failed`));
              } else {
                resolve(payload.result);
              }
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.setTimeout(timeoutMs, () => request.destroy(new Error("Telegram request timed out")));
      request.once("error", reject);
      request.end(JSON.stringify(body));
    });
  } finally {
    agent.destroy();
  }
}

function configuredTimeout(): number {
  const parsed = Number(process.env.PI_ASK_USER_TELEGRAM_TIMEOUT_MS ?? "300000");
  return Number.isFinite(parsed) ? Math.max(1000, Math.min(3600000, parsed)) : 300000;
}


export interface TelegramDecisionAudit {
  question: string;
  context?: string;
  options: string[];
  model: string;
  mode: "ask" | "auto";
  suggestion: string;
  confidence: number;
  reason: string;
  threshold: number;
}

/** Stable, testable audit message; confidence is always shown as a percentage. */
export function formatDecisionAudit(input: TelegramDecisionAudit): string {
  const confidence = Number.isFinite(input.confidence)
    ? Math.round(Math.max(0, Math.min(1, input.confidence)) * 100)
    : 0;
  const threshold = Math.round(Math.max(0, Math.min(1, input.threshold)) * 100);
  const automatic = input.mode === "auto" && input.suggestion !== "NEEDS_HUMAN" && confidence >= threshold;
  const clip = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + "…" : value;
  return [
    "📊 Решение ИИ · анализ",
    `Режим: ${input.mode === "auto" ? "авто" : "предложение"}`,
    `Уверенность: ${confidence}%`,
    `Порог автоответа: ${threshold}%`,
    `Статус: ${automatic ? "применено автоматически" : "требуется/ожидается проверка"}`,
    `Вопрос: ${clip(input.question, 700)}`,
    `Решение ИИ: ${clip(input.suggestion, 600)}`,
    input.reason ? `Обоснование: ${clip(input.reason, 600)}` : "",
    input.context ? `Контекст: ${clip(input.context, 700)}` : "",
    input.options.length ? `Варианты: ${clip(input.options.join(" | "), 800)}` : "",
    `Модель: ${clip(input.model, 150)}`,
  ].filter(Boolean).join("\n\n").slice(0, 3900);
}

/**
 * Sends a read-only audit entry to Telegram. Like all other Bot API calls,
 * this is forced through the configured SOCKS5 proxy and never blocks decisions.
 */
export async function notifyTelegramDecision(input: TelegramDecisionAudit): Promise<void> {
  const token = process.env.PI_ASK_USER_TELEGRAM_BOT_TOKEN?.trim();
  const chatText = process.env.PI_ASK_USER_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatText) return;
  const chatId = Number(chatText);
  if (!Number.isSafeInteger(chatId)) return;
  const proxyUrl = process.env.PI_ASK_USER_TELEGRAM_PROXY?.trim() || "socks5h://127.0.0.1:2080";
  try {
    await telegramCall(token, "sendMessage", {
      chat_id: chatId,
      text: formatDecisionAudit(input),
      disable_web_page_preview: true,
    }, proxyUrl, 10000);
  } catch {
    // Audit delivery must never break ask_user or silently bypass the proxy.
  }
}

/**
 * Sends an uncertain decision to a configured Telegram chat. All Bot API
 * traffic goes through the configured SOCKS5 proxy (2080 by default).
 * Returns null when unconfigured, cancelled, timed out, or unreachable so the
 * caller can fall back to Pi's local UI.
 */
/** Shared Telegram API transport for the separate agent-control bot. */
export async function telegramControlApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = process.env.PI_ASK_USER_CONTROL_BOT_TOKEN?.trim();
  if (!token) throw new Error("PI_ASK_USER_CONTROL_BOT_TOKEN is not configured");
  const proxyUrl = process.env.PI_ASK_USER_TELEGRAM_PROXY?.trim() || "socks5h://127.0.0.1:2080";
  return telegramCall<T>(token, method, body, proxyUrl, 15000);
}

export async function requestTelegramDecision(input: {
  question: string;
  context?: string;
  options: TelegramChoice[];
  allowMultiple: boolean;
  allowFreeform: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<TelegramAnswer | null> {
  const token = process.env.PI_ASK_USER_TELEGRAM_BOT_TOKEN?.trim();
  const chatText = process.env.PI_ASK_USER_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatText) return null;
  const chatId = Number(chatText);
  if (!Number.isSafeInteger(chatId)) return null;
  const allowedUserText = process.env.PI_ASK_USER_TELEGRAM_USER_ID?.trim();
  const allowedUserId = allowedUserText ? Number(allowedUserText) : undefined;
  if (allowedUserText && !Number.isSafeInteger(allowedUserId)) return null;

  const proxyUrl = process.env.PI_ASK_USER_TELEGRAM_PROXY?.trim() || "socks5h://127.0.0.1:2080";
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0
    ? Math.min(3600000, Math.max(1000, input.timeoutMs))
    : configuredTimeout();
  const deadline = Date.now() + timeoutMs;
  const requestId = randomUUID().slice(0, 8);
  const selected = new Set<number>();
  let promptMessageId: number | undefined;
  let replyToMessageId: number | undefined;
  let freeformMode = input.options.length === 0;
  let offset: number | undefined;

  const promptText = [
    "🤖 Pi требует решения",
    input.question,
    input.context ? `Контекст: ${input.context}` : "",
    input.options.length ? "Выберите вариант:" : "Ответьте на это сообщение текстом.",
  ].filter(Boolean).join("\n\n");

  const makeKeyboard = () => {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    input.options.forEach((option, index) => {
      const title = option.title.length > 55 ? option.title.slice(0, 52) + "…" : option.title;
      const description = option.description ? ` — ${option.description}` : "";
      rows.push([{
        text: `${selected.has(index) ? "✓ " : ""}${title}${description.slice(0, Math.max(0, 60 - title.length))}`,
        callback_data: `pau:${requestId}:${index}`,
      }]);
    });
    if (input.allowFreeform) rows.push([{ text: "✍️ Свой ответ", callback_data: `pau:${requestId}:free` }]);
    if (input.allowMultiple) rows.push([{ text: "Готово", callback_data: `pau:${requestId}:done` }]);
    return { inline_keyboard: rows };
  };

  try {
    if (input.signal?.aborted) return null;
    const message = await telegramCall<TelegramMessage>(token, "sendMessage", {
      chat_id: chatId,
      text: promptText,
      ...(input.options.length ? { reply_markup: makeKeyboard() } : { reply_markup: { force_reply: true, selective: true } }),
    }, proxyUrl, Math.min(15000, timeoutMs));
    promptMessageId = message.message_id;
    if (freeformMode) replyToMessageId = message.message_id;

    while (!input.signal?.aborted && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const updates = await telegramCall<TelegramUpdate[]>(token, "getUpdates", {
        offset,
        timeout: Math.max(0, Math.min(10, Math.floor(remaining / 1000))),
        allowed_updates: ["callback_query", "message"],
      }, proxyUrl, Math.min(15000, Math.max(3000, remaining)));
      for (const update of updates) {
        offset = Math.max(offset ?? 0, update.update_id + 1);
        const callback = update.callback_query;
        if (callback) {
          const messageChat = callback.message?.chat.id;
          const data = callback.data ?? "";
          if (messageChat !== chatId || !data.startsWith(`pau:${requestId}:`)
            || (allowedUserId !== undefined && callback.from?.id !== allowedUserId)) continue;
          const action = data.slice(`pau:${requestId}:`.length);
          await telegramCall(token, "answerCallbackQuery", { callback_query_id: callback.id }, proxyUrl, 8000).catch(() => undefined);
          if (action === "free" && input.allowFreeform) {
            freeformMode = true;
            await telegramCall(token, "editMessageReplyMarkup", {
              chat_id: chatId, message_id: promptMessageId, reply_markup: { inline_keyboard: [] },
            }, proxyUrl, 8000).catch(() => undefined);
            const reply = await telegramCall<TelegramMessage>(token, "sendMessage", {
              chat_id: chatId,
              text: "Напишите свой ответ и отправьте его ответом на это сообщение.",
              reply_to_message_id: promptMessageId,
              reply_markup: { force_reply: true, selective: true },
            }, proxyUrl, 10000);
            replyToMessageId = reply.message_id;
            continue;
          }
          if (action === "done" && input.allowMultiple && selected.size > 0) {
            await telegramCall(token, "editMessageReplyMarkup", {
              chat_id: chatId, message_id: promptMessageId, reply_markup: { inline_keyboard: [] },
            }, proxyUrl, 8000).catch(() => undefined);
            return { kind: "selection", selections: [...selected].sort((a, b) => a - b).map((index) => input.options[index]!.title) };
          }
          const index = Number(action);
          if (!Number.isInteger(index) || index < 0 || index >= input.options.length) continue;
          if (input.allowMultiple) {
            if (selected.has(index)) selected.delete(index); else selected.add(index);
            await telegramCall(token, "editMessageReplyMarkup", {
              chat_id: chatId, message_id: promptMessageId, reply_markup: makeKeyboard(),
            }, proxyUrl, 8000).catch(() => undefined);
            continue;
          }
          await telegramCall(token, "editMessageText", {
            chat_id: chatId, message_id: promptMessageId,
            text: `✅ Вы выбрали: ${input.options[index]!.title}`,
            reply_markup: { inline_keyboard: [] },
          }, proxyUrl, 8000).catch(() => undefined);
          return { kind: "selection", selections: [input.options[index]!.title] };
        }

        const incoming = update.message;
        if (!incoming || incoming.chat.id !== chatId || typeof incoming.text !== "string") continue;
        if (allowedUserId !== undefined && incoming.from?.id !== allowedUserId) continue;
        if (freeformMode && incoming.reply_to_message?.message_id === replyToMessageId) {
          return { kind: "freeform", text: incoming.text.trim() };
        }
      }
    }
  } catch {
    // A network/proxy/bot failure should not break ask_user; the local UI is fallback.
  }
  return null;
}
