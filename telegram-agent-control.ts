import type { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { telegramControlApi } from "./telegram-decision";

type Profile = "developer" | "reviewer" | "tester" | "debugger";
type Project = { id: string; path: string; description?: string };
const ROLES: Record<Profile, string> = {
  developer: "Implement the request with the smallest correct change and run relevant tests.",
  reviewer: "Review code only. Report concrete bugs, regressions, security issues, and missing tests with file/line references. Do not edit files.",
  tester: "Test the requested behavior and report reproducible results. Do not modify application code.",
  debugger: "Diagnose the root cause and propose a minimal fix. Avoid destructive operations.",
};
let started = false;
let child: ChildProcess | undefined;
let activeId: string | undefined;
const now = () => new Date().toISOString();
const short = (s: string, n = 3500) => s.length > n ? s.slice(0, n - 1) + "…" : s;

export function inferProfile(task: string): Profile {
  const s = task.toLowerCase();
  if (/review|ревью|проведи ревью|проверь код/.test(s)) return "reviewer";
  if (/test|тест|покрой тестами|проверить работу/.test(s)) return "tester";
  if (/debug|bug|ошиб|не работает|падает|исправь баг/.test(s)) return "debugger";
  return "developer";
}
export function parseNewCommand(text: string): { project: string; profile: Profile | "auto"; task: string } | null {
  const m = text.trim().match(/^\/new\s+([a-zA-Z0-9_-]+)\s+(developer|reviewer|tester|debugger|auto)\s+([\s\S]+)$/i);
  if (!m || !m[3]!.trim() || m[3]!.trim().length > 4000) return null;
  return { project: m[1]!, profile: m[2]!.toLowerCase() as Profile | "auto", task: m[3]!.trim() };
}
function root(): string { return resolve(process.env.PI_ASK_USER_CONTROL_STATE_DIR?.trim() || join(homedir(), ".pi", "agent", "telegram-control")); }
function projectsFile(): string { return resolve(process.env.PI_ASK_USER_CONTROL_PROJECTS_FILE?.trim() || join(root(), "projects.json")); }
async function projects(): Promise<Project[]> {
  let raw: any;
  try { raw = JSON.parse(await readFile(projectsFile(), "utf8")); } catch { return []; }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.projects) ? raw.projects : [];
  const result: Project[] = [];
  for (const p of items) {
    if (!p || typeof p.id !== "string" || !/^[\w-]{1,40}$/.test(p.id) || typeof p.path !== "string" || !isAbsolute(p.path)) continue;
    try { result.push({ id: p.id, path: await realpath(p.path), ...(typeof p.description === "string" ? { description: p.description.slice(0, 160) } : {}) }); } catch {}
  }
  return result;
}
async function dbOpen(): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(root(), "tasks.sqlite");
  const db = new DatabaseSync(path);
  try { chmodSync(path, 0o600); } catch {}
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project TEXT NOT NULL, project_path TEXT NOT NULL, profile TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', exit_code INTEGER); CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status,created_at); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);");
  return db;
}
async function send(chat: number, text: string, reply_markup?: unknown): Promise<any> {
  try {
    return await telegramControlApi("sendMessage", { chat_id: chat, text: short(text, 3900), disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });
  } catch {
    // Telegram outages must not strand a local Pi process or stop the queue.
    return { message_id: 0 };
  }
}
function update(db: DatabaseSync, id: string, status: string, output?: string, code?: number) {
  db.prepare("UPDATE tasks SET status=?, updated_at=?, output=COALESCE(?,output), exit_code=COALESCE(?,exit_code) WHERE id=?").run(status, now(), output ?? null, code ?? null, id);
}
function keyboard(id: string) {
  return { inline_keyboard: [[{ text: "▶ Подтвердить и поставить в очередь", callback_data: "pac:yes:" + id }, { text: "✖ Отклонить", callback_data: "pac:no:" + id }]] };
}
async function runNext(db: DatabaseSync, chat: number): Promise<void> {
  if (child) return;
  const t = db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1").get() as any;
  if (!t) return;
  activeId = t.id;
  let cwd: string;
  try { cwd = await realpath(t.project_path); } catch {
    update(db, t.id, "failed", "Project directory is unavailable.", -1);
    await send(chat, "❌ Каталог проекта для задачи #" + t.id + " недоступен.");
    activeId = undefined; return runNext(db, chat);
  }
  update(db, t.id, "running");
  await send(chat, "⏳ Запускаю #" + t.id + ": " + t.project + "/" + t.profile);
  const prompt = ROLES[t.profile as Profile] + "\n\nTask:\n" + t.prompt + "\n\nDo not expose secrets or run destructive commands. Stay within the selected project; if a risky action is needed, stop and report it.";
  let output = "", settled = false;
  const proc = spawn(process.env.PI_ASK_USER_CONTROL_PI_BIN?.trim() || "pi", ["--print", prompt], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  child = proc;
  const collect = (chunk: Buffer) => { output = short(output + chunk.toString("utf8"), 50000); };
  proc.stdout?.on("data", collect); proc.stderr?.on("data", collect);
  const finish = async (code: number, failed = false) => {
    if (settled) return; settled = true;
    const current = db.prepare("SELECT status FROM tasks WHERE id=?").get(t.id) as any;
    const status = current?.status === "cancelled" ? "cancelled" : failed || code !== 0 ? "failed" : "completed";
    update(db, t.id, status, output, code);
    await send(chat, (status === "completed" ? "✅" : status === "cancelled" ? "⏹" : "❌") + " Задача #" + t.id + ": " + status + " (exit " + code + ")\n\n" + (output || "(нет текстового вывода)"));
    child = undefined; activeId = undefined; void runNext(db, chat);
  };
  proc.once("error", async e => { output += "\n" + e.message; await finish(-1, true); });
  proc.once("close", code => { void finish(code ?? -1); });
}
async function textCommand(db: DatabaseSync, chat: number, text: string): Promise<void> {
  const cmd = text.trim();
  if (cmd === "/start" || cmd === "/help") return void await send(chat, "Команды:\n/projects — проекты\n/new <проект> <auto|developer|reviewer|tester|debugger> <задача> — показать план\n/tasks — очередь и история\n/status — текущая задача\n/logs <id> — вывод задачи\n/cancel <id> — отмена\n\nЗадачи запускаются только после нажатия «Подтвердить».");
  if (cmd === "/projects") {
    const list = await projects();
    return void await send(chat, list.length ? list.map(p => p.id + " — " + p.path + (p.description ? " (" + p.description + ")" : "")).join("\n") : "Нет доступных проектов. Создай " + projectsFile() + ' с массивом [{"id":"app","path":"/absolute/path"}].');
  }
  if (cmd === "/tasks") {
    const rows = db.prepare("SELECT id,project,profile,status,prompt FROM tasks ORDER BY created_at DESC LIMIT 10").all() as any[];
    return void await send(chat, rows.length ? rows.map(t => "#" + t.id + " [" + t.status + "] " + t.project + "/" + t.profile + "\n" + t.prompt).join("\n\n") : "Задач пока нет.");
  }
  const logs = cmd.match(/^\/logs\s+([a-f0-9-]{4,40})$/i);
  if (logs) {
    const t = db.prepare("SELECT status,output,exit_code FROM tasks WHERE id=?").get(logs[1]!) as any;
    return void await send(chat, t ? "Задача #" + logs[1] + " [" + t.status + "] exit=" + (t.exit_code ?? "n/a") + "\n\n" + (t.output || "(вывод пока отсутствует)") : "Задача не найдена.");
  }
  if (cmd === "/status") {
    const t = db.prepare("SELECT id,project,profile,prompt FROM tasks WHERE status='running' LIMIT 1").get() as any;
    return void await send(chat, t ? "Выполняется #" + t.id + ": " + t.project + "/" + t.profile + "\n" + t.prompt : "Агент сейчас не выполняет задачу.");
  }
  const cancel = cmd.match(/^\/cancel\s+([a-f0-9-]{4,40})$/i);
  if (cancel) {
    const id = cancel[1]!;
    if (activeId === id && child) { update(db, id, "cancelled"); child.kill("SIGTERM"); return void await send(chat, "Отправлен SIGTERM задаче #" + id + "."); }
    const res = db.prepare("UPDATE tasks SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','awaiting_confirmation')").run(now(), id);
    return void await send(chat, Number(res.changes) ? "Задача #" + id + " отменена." : "Активную или неизвестную задачу отменить не удалось.");
  }
  const parsed = parseNewCommand(cmd);
  if (!parsed) return void await send(chat, "Формат: /new <проект> <auto|developer|reviewer|tester|debugger> <задача>. Сначала выполни /projects.");
  const project = (await projects()).find(p => p.id === parsed.project);
  if (!project) return void await send(chat, "Проект не найден в разрешённом списке. Выполни /projects.");
  const profile = parsed.profile === "auto" ? inferProfile(parsed.task) : parsed.profile;
  const id = randomUUID().slice(0, 8), ts = now();
  db.prepare("INSERT INTO tasks(id,project,project_path,profile,prompt,status,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_confirmation',?,?)").run(id, project.id, project.path, profile, parsed.task, ts, ts);
  await send(chat, "🧭 План задачи #" + id + "\nПроект: " + project.id + "\nПрофиль: " + profile + "\nЗадача: " + parsed.task + "\n\nПосле подтверждения задача попадёт в последовательную SQLite-очередь и запустится локально командой pi --print. До подтверждения процесс не запускается.", keyboard(id));
}
async function callback(db: DatabaseSync, chat: number, query: any): Promise<void> {
  await telegramControlApi("answerCallbackQuery", { callback_query_id: query.id }).catch(() => undefined);
  const m = String(query.data ?? "").match(/^pac:(yes|no):([a-f0-9-]{4,40})$/);
  if (!m) return;
  const t = db.prepare("SELECT status FROM tasks WHERE id=?").get(m[2]) as any;
  if (!t || t.status !== "awaiting_confirmation") return void await send(chat, "План уже обработан или задача не найдена.");
  if (m[1] === "no") { update(db, m[2]!, "cancelled"); return void await send(chat, "Задача #" + m[2] + " отклонена; Pi не запускался."); }
  update(db, m[2]!, "queued");
  await send(chat, "Задача #" + m[2] + " подтверждена и добавлена в очередь.");
  void runNext(db, chat);
}
export function startTelegramAgentControl(): void {
  if (started || !process.env.PI_ASK_USER_CONTROL_BOT_TOKEN?.trim() || !process.env.PI_ASK_USER_CONTROL_CHAT_ID?.trim()) return;
  const chat = Number(process.env.PI_ASK_USER_CONTROL_CHAT_ID);
  const allowedText = process.env.PI_ASK_USER_CONTROL_USER_ID?.trim();
  const allowedUser = allowedText ? Number(allowedText) : undefined;
  if (!Number.isSafeInteger(chat) || !allowedText || !Number.isSafeInteger(allowedUser)) return;
  started = true;
  void (async () => {
    await mkdir(root(), { recursive: true, mode: 0o700 });
    try { await (await import("node:fs/promises")).chmod(root(), 0o700); } catch {}
    const db = await dbOpen();
    db.prepare("UPDATE tasks SET status='failed',output='Pi exited or restarted before the task result was saved; inspect the project before retrying.',updated_at=? WHERE status='running'").run(now());
    let offset = Number((db.prepare("SELECT value FROM settings WHERE key='telegram_offset'").get() as any)?.value ?? 0);
    while (true) {
      try {
        const updates = await telegramControlApi<any[]>("getUpdates", { offset, timeout: 20, allowed_updates: ["message", "callback_query"] });
        for (const u of updates) {
          offset = Math.max(offset, Number(u.update_id) + 1);
          db.prepare("INSERT INTO settings(key,value) VALUES('telegram_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(offset));
          const q = u.callback_query, m = u.message;
          if ((q?.message?.chat?.id ?? m?.chat?.id) !== chat) continue;
          if (allowedUser !== undefined && (q?.from?.id ?? m?.from?.id) !== allowedUser) continue;
          if (q) await callback(db, chat, q);
          else if (typeof m?.text === "string") await textCommand(db, chat, m.text);
        }
        await runNext(db, chat);
      } catch {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  })().catch(() => { started = false; });
}
