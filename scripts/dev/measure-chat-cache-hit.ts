import { randomUUID } from "node:crypto";

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

type ChatMessage = {
  role?: string;
  timestamp?: number;
  content?: unknown;
  usage?: Usage;
};

type ChatHistoryPayload = {
  sessionKey?: string;
  messages?: ChatMessage[];
};

const argv = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) {
    return undefined;
  }
  return argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return argv.includes(flag);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function usage() {
  console.log(
    [
      "Usage: bun scripts/dev/measure-chat-cache-hit.ts [options]",
      "",
      "Measures cache reuse on the exact gateway path:",
      "1. chat.send baseline",
      "2. same chat.send again",
      "3. system event",
      "4. same chat.send again",
      "",
      "Options:",
      "  --session-key <key>    Session key. Default: main",
      "  --message <text>       Message to send. Default: generated probe message",
      "  --event-text <text>    System event text. Default: Model switched.",
      "  --history-limit <n>    chat.history limit. Default: 40",
      "  --poll-ms <n>          Poll interval. Default: 1000",
      "  --timeout-ms <n>       Wait timeout per turn. Default: 45000",
    ].join("\n"),
  );
}

async function runCli(args: string[]): Promise<string> {
  const proc = Bun.spawn(["pnpm", "--silent", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  if (exitCode !== 0) {
    throw new Error(
      [
        `command failed: pnpm ${args.join(" ")}`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  return stdout.trim();
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("empty output");
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  const objectStart = trimmed.lastIndexOf("\n{");
  const arrayStart = trimmed.lastIndexOf("\n[");
  const start = Math.max(objectStart, arrayStart);
  if (start !== -1) {
    return trimmed.slice(start + 1).trim();
  }
  throw new Error(`no JSON payload found in output:\n${trimmed}`);
}

async function runJson<T>(args: string[]): Promise<T> {
  const text = await runCli(args);
  const jsonText = extractJsonText(text);
  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    throw new Error(
      `failed to parse JSON for: pnpm ${args.join(" ")}\n${String(error)}\noutput:\n${text}`,
      { cause: error },
    );
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (typeof part === "string") {
        return [part];
      }
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return [part.text];
      }
      return [];
    })
    .join("");
}

function assistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === "assistant");
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.0%";
  }
  return `${value.toFixed(1)}%`;
}

function summarizeTurn(label: string, assistant: ChatMessage, precedingUser?: ChatMessage) {
  const usage = assistant.usage ?? {};
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  const cacheHitPct = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : 0;
  const userText = precedingUser ? contentText(precedingUser.content).replaceAll("\n", "\\n") : "";
  console.log(
    [
      `${label}: input=${input} cacheRead=${cacheRead} cacheWrite=${cacheWrite} promptTokens=${promptTokens} cacheHit=${formatPercent(cacheHitPct)}`,
      userText ? `  user=${JSON.stringify(userText)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function fetchHistory(sessionKey: string, limit: number): Promise<ChatHistoryPayload> {
  return await runJson<ChatHistoryPayload>([
    "openclaw",
    "gateway",
    "call",
    "chat.history",
    "--json",
    "--params",
    JSON.stringify({ sessionKey, limit }),
  ]);
}

async function sendChat(sessionKey: string, message: string): Promise<string> {
  const runId = randomUUID();
  await runJson<unknown>([
    "openclaw",
    "gateway",
    "call",
    "chat.send",
    "--json",
    "--params",
    JSON.stringify({
      sessionKey,
      message,
      idempotencyKey: runId,
    }),
  ]);
  return runId;
}

async function enqueueSystemEvent(text: string): Promise<void> {
  await runJson<unknown>([
    "openclaw",
    "system",
    "event",
    "--json",
    "--mode",
    "next-heartbeat",
    "--text",
    text,
  ]);
}

async function waitForAssistantTurn(params: {
  sessionKey: string;
  historyLimit: number;
  previousAssistantCount: number;
  pollMs: number;
  timeoutMs: number;
}): Promise<{ history: ChatHistoryPayload; assistant: ChatMessage; precedingUser?: ChatMessage }> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const history = await fetchHistory(params.sessionKey, params.historyLimit);
    const messages = Array.isArray(history.messages) ? history.messages : [];
    const assistants = assistantMessages(messages);
    if (assistants.length > params.previousAssistantCount) {
      const assistantIndex = [...messages]
        .map((message, index) => ({ message, index }))
        .filter((entry) => entry.message.role === "assistant")
        .at(-1)?.index;
      if (assistantIndex === undefined) {
        throw new Error("assistant count increased but latest assistant message was not found");
      }
      const precedingUser = messages
        .slice(0, assistantIndex)
        .toReversed()
        .find((message) => message.role === "user");
      return {
        history,
        assistant: messages[assistantIndex] ?? assistants.at(-1)!,
        precedingUser,
      };
    }
    await Bun.sleep(params.pollMs);
  }
  throw new Error(`timed out waiting for assistant reply in session ${params.sessionKey}`);
}

async function main() {
  if (hasFlag("--help")) {
    usage();
    return;
  }

  const sessionKey = getArg("--session-key") ?? "main";
  const probeId = `cache-probe-${Date.now().toString(36)}`;
  const message = getArg("--message") ?? `say only ok [${probeId}]`;
  const eventText = getArg("--event-text") ?? "Model switched.";
  const historyLimit = parsePositiveInt(getArg("--history-limit"), 40);
  const pollMs = parsePositiveInt(getArg("--poll-ms"), 1000);
  const timeoutMs = parsePositiveInt(getArg("--timeout-ms"), 45_000);

  if (sessionKey !== "main") {
    throw new Error(
      `exact repro expects --session-key main; system events are queued onto main, not ${sessionKey}`,
    );
  }

  console.log(`session=${sessionKey}`);
  console.log(`message=${JSON.stringify(message)}`);
  console.log(`event=${JSON.stringify(eventText)}`);

  let history = await fetchHistory(sessionKey, historyLimit);
  let assistantCount = assistantMessages(history.messages ?? []).length;

  await sendChat(sessionKey, message);
  let turn = await waitForAssistantTurn({
    sessionKey,
    historyLimit,
    previousAssistantCount: assistantCount,
    pollMs,
    timeoutMs,
  });
  summarizeTurn("baseline-1", turn.assistant, turn.precedingUser);

  history = turn.history;
  assistantCount = assistantMessages(history.messages ?? []).length;

  await sendChat(sessionKey, message);
  turn = await waitForAssistantTurn({
    sessionKey,
    historyLimit,
    previousAssistantCount: assistantCount,
    pollMs,
    timeoutMs,
  });
  summarizeTurn("baseline-2", turn.assistant, turn.precedingUser);

  history = turn.history;
  assistantCount = assistantMessages(history.messages ?? []).length;

  await enqueueSystemEvent(eventText);
  console.log("system-event: queued");

  await sendChat(sessionKey, message);
  turn = await waitForAssistantTurn({
    sessionKey,
    historyLimit,
    previousAssistantCount: assistantCount,
    pollMs,
    timeoutMs,
  });
  summarizeTurn("event-turn", turn.assistant, turn.precedingUser);
}

await main();
