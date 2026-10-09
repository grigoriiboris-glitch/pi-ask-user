import { describe, expect, test } from "bun:test";
import { toVkKeyboard } from "../vk-agent-control";

describe("VK agent-control keyboard", () => {
  test("converts confirmation actions into VK callback buttons", () => {
    const keyboard = JSON.parse(toVkKeyboard({
      inline_keyboard: [[
        { text: "▶ Подтвердить", callback_data: "pac:yes:abcd1234" },
        { text: "✖ Отклонить", callback_data: "pac:no:abcd1234" },
      ]],
    })!);
    expect(keyboard.inline).toBe(true);
    expect(keyboard.buttons[0][0].action.type).toBe("callback");
    expect(JSON.parse(keyboard.buttons[0][0].action.payload).command).toBe("pac:yes:abcd1234");
    expect(keyboard.buttons[0][1].color).toBe("negative");
  });

  test("returns no VK keyboard when no inline actions are present", () => {
    expect(toVkKeyboard(undefined)).toBeUndefined();
    expect(toVkKeyboard({ inline_keyboard: [] })).toBeUndefined();
  });

  test("truncates labels to VK's button limit", () => {
    const keyboard = JSON.parse(toVkKeyboard({
      inline_keyboard: [[{ text: "x".repeat(80), callback_data: "pac:yes:abcd1234" }]],
    })!);
    expect(keyboard.buttons[0][0].action.label).toHaveLength(40);
  });
});
