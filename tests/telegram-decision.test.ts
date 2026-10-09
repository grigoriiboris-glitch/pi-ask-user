import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { requestTelegramDecision } from "../telegram-decision";

const keys = [
  "PI_ASK_USER_TELEGRAM_BOT_TOKEN",
  "PI_ASK_USER_TELEGRAM_CHAT_ID",
  "PI_ASK_USER_TELEGRAM_USER_ID",
  "PI_ASK_USER_TELEGRAM_PROXY",
  "PI_ASK_USER_TELEGRAM_TIMEOUT_MS",
] as const;
let saved: Partial<Record<(typeof keys)[number], string>>;

beforeEach(() => {
  saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("Telegram human fallback", () => {
  test("is inactive when bot credentials are missing", async () => {
    expect(await requestTelegramDecision({
      question: "Choose?",
      options: [{ title: "A" }, { title: "B" }],
      allowMultiple: false,
      allowFreeform: true,
    })).toBeNull();
  });

  test("does not contact Telegram when the caller is already aborted", async () => {
    process.env.PI_ASK_USER_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.PI_ASK_USER_TELEGRAM_CHAT_ID = "123456";
    const controller = new AbortController();
    controller.abort();

    expect(await requestTelegramDecision({
      question: "Choose?",
      options: [{ title: "A" }],
      allowMultiple: false,
      allowFreeform: false,
      signal: controller.signal,
    })).toBeNull();
  });

  test("rejects a non-numeric chat ID without network access", async () => {
    process.env.PI_ASK_USER_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.PI_ASK_USER_TELEGRAM_CHAT_ID = "not-a-chat-id";

    expect(await requestTelegramDecision({
      question: "Choose?",
      options: [{ title: "A" }],
      allowMultiple: false,
      allowFreeform: false,
    })).toBeNull();
  });
});
