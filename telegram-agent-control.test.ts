import { describe, expect, test } from "bun:test";
import { inferProfile, parseNewCommand } from "./telegram-agent-control";

describe("Telegram agent command parsing", () => {
  test("parses a task with an explicit role", () => {
    expect(parseNewCommand("/new studio developer Fix the login flow")).toEqual({
      project: "studio", profile: "developer", task: "Fix the login flow",
    });
  });
  test("allows an omitted role and preserves the task text", () => {
    expect(parseNewCommand("/new studio Fix the login flow")).toEqual({
      project: "studio", profile: "project", task: "Fix the login flow",
    });
  });
  test("allows selecting a project without starting a task", () => {
    expect(parseNewCommand("/new studio")).toEqual({ project: "studio", profile: "project", task: "" });
  });
  test("rejects oversized prompts", () => {
    expect(parseNewCommand("/new studio developer " + "x".repeat(4001))).toBeNull();
    expect(parseNewCommand("/new studio " + "x".repeat(4001))).toBeNull();
  });
  test("chooses a conservative role for auto profile", () => {
    expect(inferProfile("проведи ревью кода")).toBe("reviewer");
    expect(inferProfile("покрой API тестами")).toBe("tester");
    expect(inferProfile("ошибка при запуске")).toBe("debugger");
    expect(inferProfile("добавь настройку темы")).toBe("developer");
  });
});
