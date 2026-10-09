import { describe, expect, test } from "bun:test";
import { inferProfile, parseNewCommand } from "./telegram-agent-control";

describe("Telegram agent command parsing", () => {
  test("parses a task without invoking a shell", () => {
    expect(parseNewCommand("/new studio developer Fix the login flow")).toEqual({
      project: "studio", profile: "developer", task: "Fix the login flow",
    });
  });
  test("allows an omitted role and preserves the task text", () => {\n    expect(parseNewCommand("/new studio Fix the login flow")).toEqual({\n      project: "studio", profile: "project", task: "Fix the login flow",\n    });\n  });\n  test("rejects missing project/task and oversized prompts", () => {
    expect(parseNewCommand("/new studio")).toBeNull();
    expect(parseNewCommand("/new studio developer " + "x".repeat(4001))).toBeNull();\n    expect(parseNewCommand("/new studio " + "x".repeat(4001))).toBeNull();
  });
  test("chooses a conservative role for auto profile", () => {
    expect(inferProfile("проведи ревью кода")).toBe("reviewer");
    expect(inferProfile("покрой API тестами")).toBe("tester");
    expect(inferProfile("ошибка при запуске")).toBe("debugger");
    expect(inferProfile("добавь настройку темы")).toBe("developer");
  });
});
