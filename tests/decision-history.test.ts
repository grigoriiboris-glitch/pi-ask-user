import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rateDecision, readDecisionHistory, recordActual, recordDecision } from "../decision-history";

let directory: string;
let previousPath: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-ask-user-history-"));
  previousPath = process.env.PI_ASK_USER_DECISION_HISTORY;
  process.env.PI_ASK_USER_DECISION_HISTORY = join(directory, "history.jsonl");
});

afterEach(async () => {
  if (previousPath === undefined) delete process.env.PI_ASK_USER_DECISION_HISTORY;
  else process.env.PI_ASK_USER_DECISION_HISTORY = previousPath;
  await rm(directory, { recursive: true, force: true });
});

describe("decision history", () => {
  test("persists decisions, actual answers, and ratings across reads", async () => {
    const id = await recordDecision({
      mode: "auto", model: "test-flash", question: "Use SQLite?", context: "Small local app",
      options: ["yes", "no"], suggestion: "yes", confidence: 0.91, reason: "Simpler deployment",
    });
    expect(id).toBeTruthy();
    await recordActual(id!, "yes");
    expect(await rateDecision(id!, "correct")).toBe(true);
    const records = await readDecisionHistory();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id, mode: "auto", model: "test-flash", question: "Use SQLite?",
      suggestion: "yes", actual: "yes", rating: "correct",
    });
  });

  test("returns false when rating an unknown id", async () => {
    expect(await rateDecision("missing", "incorrect")).toBe(false);
  });
});
