import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type DecisionRating = "correct" | "incorrect" | "unsure";
export interface DecisionRecord {
  id: string;
  timestamp: string;
  mode: "ask" | "auto";
  model: string;
  question: string;
  context?: string;
  options: string[];
  suggestion: string;
  confidence: number;
  reason: string;
  actual?: string;
  rating?: DecisionRating;
}
type Event =
  | { type: "decision"; record: DecisionRecord }
  | { type: "actual"; id: string; actual: string }
  | { type: "rating"; id: string; rating: DecisionRating };

export function decisionHistoryPath(): string {
  return process.env.PI_ASK_USER_DECISION_HISTORY?.trim()
    || join(homedir(), ".pi", "agent", "ask-user-decisions.jsonl");
}

async function writeEvent(event: Event): Promise<void> {
  const path = decisionHistoryPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
}

export async function recordDecision(record: Omit<DecisionRecord, "id" | "timestamp">): Promise<string | null> {
  const id = randomUUID().slice(0, 8);
  try {
    await writeEvent({ type: "decision", record: { ...record, id, timestamp: new Date().toISOString() } });
    return id;
  } catch {
    return null;
  }
}

export async function recordActual(id: string, actual: string): Promise<void> {
  try { await writeEvent({ type: "actual", id, actual }); } catch { /* history must not break ask_user */ }
}

export async function rateDecision(id: string, rating: DecisionRating): Promise<boolean> {
  const records = await readDecisionHistory().catch(() => []);
  if (!records.some((record) => record.id === id)) return false;
  try { await writeEvent({ type: "rating", id, rating }); return true; } catch { return false; }
}

export async function readDecisionHistory(): Promise<DecisionRecord[]> {
  let raw: string;
  try { raw = await readFile(decisionHistoryPath(), "utf8"); } catch { return []; }
  const records = new Map<string, DecisionRecord>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Event;
      if (event.type === "decision") records.set(event.record.id, event.record);
      else if (event.type === "actual") {
        const record = records.get(event.id); if (record) record.actual = event.actual;
      } else if (event.type === "rating") {
        const record = records.get(event.id); if (record) record.rating = event.rating;
      }
    } catch { /* ignore incomplete/corrupt journal lines */ }
  }
  return [...records.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
