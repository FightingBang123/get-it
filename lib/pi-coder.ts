import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { loadSettings } from "./settings-store";
import { CodexError } from "./codex-errors";
import { resolveBundledBinary } from "./providers/cli-runner";

export type RunOptions = {
  signal?: AbortSignal;
};

/** Absolute path to the Pi Coding Agent's `dist/cli.js`. */
function getPiCliPath(): string {
  // resolveBundledBinary("pi") honours PI_BINARY_PATH (wired by the Electron
  // main) and the staged electron/pi-bin/pi-cli copy used in the packaged
  // app and in dev after `electron:prepare`.
  const resolved = resolveBundledBinary("pi");
  if (resolved) return resolved;
  // Source-tree dev fallback: the package as installed in node_modules.
  return path.resolve(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
}

import fs from "node:fs";
import { DATA_DIR } from "./paths";

/**
 * Pi's bundled `undici` calls `node:worker_threads.markAsUncloneable`, which
 * only exists in Node ≥ 22.8. Electron 33 bundles Node 20, and we run Pi
 * through Electron's own node (process.execPath) — so without this it throws
 * "webidl.util.markAsUncloneable is not a function". We --require a tiny shim
 * that defines a no-op before Pi loads undici. No-op is safe: it only skips
 * marking objects uncloneable for structuredClone, which Pi never relies on.
 */
const PI_UNDICI_SHIM = `"use strict";
try {
  const wt = require("node:worker_threads");
  if (typeof wt.markAsUncloneable !== "function") wt.markAsUncloneable = () => {};
} catch {}
`;

function ensurePiShim(): string {
  const shimPath = path.join(DATA_DIR, "pi-undici-shim.cjs");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(shimPath, PI_UNDICI_SHIM, "utf8");
  } catch {
    /* best-effort */
  }
  return shimPath;
}

/**
 * Pi ships as a pure-JS CLI (like Gemini), so we run its `cli.js` through
 * Electron's own node (process.execPath) rather than a bare `node` binary —
 * the packaged app has no system `node` on PATH. The caller sets
 * ELECTRON_RUN_AS_NODE=1 so Electron executes the script instead of booting
 * a GUI; in plain Node contexts that var is simply ignored. `--require`s the
 * undici shim (above) before the CLI loads.
 */
function getPiExecutionConfig(): { binary: string; preArgs: string[] } {
  return { binary: process.execPath, preArgs: ["--require", ensurePiShim(), getPiCliPath()] };
}

function buildEnvAndProvider(settings: ReturnType<typeof loadSettings>): { env: NodeJS.ProcessEnv; provider: string } {
  const env = { ...process.env };
  let provider = "openai";

  // Configure Pi to use the provided BYOK settings via a dynamic models.json config
  if (settings.piUrl) {
    const agentDir = path.join(DATA_DIR, "pi-agent");
    fs.mkdirSync(agentDir, { recursive: true });

    provider = "getit_byok";
    const apiType = settings.piApiType || "openai-completions";

    // Set appropriate API Key in environment variables based on API Protocol
    if (settings.piApiKey) {
      if (apiType === "google-generative-ai") {
        env.GEMINI_API_KEY = settings.piApiKey;
      } else if (apiType === "anthropic-messages") {
        env.ANTHROPIC_API_KEY = settings.piApiKey;
      } else {
        env.OPENAI_API_KEY = settings.piApiKey;
      }
    }

    const modelsJson = {
      providers: {
        getit_byok: {
          baseUrl: settings.piUrl,
          api: apiType,
          apiKey: settings.piApiKey || "dummy",
          models: [
            { id: settings.piModelFast || "llama3.2", reasoning: true },
            { id: settings.piModelSmart || "llama3.2", reasoning: true }
          ]
        }
      }
    };
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(modelsJson, null, 2));
    env.PI_CODING_AGENT_DIR = agentDir;
  } else if (settings.piApiKey) {
    env.OPENAI_API_KEY = settings.piApiKey;
  }

  // Set offline/telemetry rules for hermetic execution
  env.PI_OFFLINE = "1";
  env.PI_TELEMETRY = "0";

  // We launch cli.js through Electron's node (process.execPath); this makes
  // Electron run the script instead of opening a window. Harmless under
  // plain Node (dev/tests), where the variable is ignored.
  env.ELECTRON_RUN_AS_NODE = "1";

  return { env, provider };
}

/** Strip markdown code fences the model sometimes wraps JSON in, then parse. */
function parseTurnJson<T>(finalResponse: string | undefined): T {
  let text = finalResponse?.trim();
  if (!text) throw new Error("Empty finalResponse from pi");

  // Strip thought/thinking blocks first
  text = text
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned) as T;
}

type PiContentBlock = { type?: string; text?: string };
type PiMessage = {
  role?: string;
  content?: PiContentBlock[];
  usage?: unknown;
  errorMessage?: string;
};
type PiEvent = {
  type?: string;
  errorMessage?: string;
  message?: PiMessage;
  messages?: PiMessage[];
};

/**
 * Bounded retention for the non-NDJSON fallback path. The happy path never
 * reads `rawStdout`; only a genuine non-NDJSON stdout does, and a response
 * larger than this cap could not be parsed as one JSON object anyway — so
 * keeping more would only waste memory.
 */
const RAW_OUTPUT_CAP = 1 * 1024 * 1024;
/** Keep the most recent stderr bytes — the newest lines carry the cause. */
const STDERR_CAP = 8 * 1024;

type PiCollectResult = {
  assistantText: string;
  usage: unknown;
  errorMessage: string;
  rawStdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError: Error | null;
  aborted: boolean;
  rawTruncated: boolean;
};

/**
 * Kill a Pi child on abort. `execFile` used to do this for us via its `signal`
 * option; with `spawn` we have to do it ourselves. Mirrors
 * lib/providers/cli-runner.ts:197-213.
 */
function killPiChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  try {
    if (process.platform === "win32" && typeof pid === "number") {
      spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      // The child is non-detached (it shares the server's process group), so
      // kill it directly — a negative-pid group kill would hit the server.
      child.kill("SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

/**
 * Run Pi in `--mode json` and consume its NDJSON stdout incrementally.
 *
 * Why not `execFile`: Pi writes one JSON line per session event, and its
 * `message_update` event carries the FULL accumulated assistant message on
 * every streaming chunk (see @earendil-works/pi-agent-core types, and
 * pi-coding-agent/dist/modes/print-mode.js which stringifies each event). The
 * total stdout therefore grows QUADRATICALLY with response length, so any
 * fixed `maxBuffer` is eventually exceeded — the failure surfaced as
 * "stdout maxBuffer length exceeded". Streaming means we hold only the final
 * assistant text and usage, regardless of how much Pi emits.
 *
 * Only two event types are ever consumed (`agent_end` / `message_end`), so the
 * delta flood is skipped entirely — it carries nothing we read.
 */
function spawnAndCollect(
  label: "runJson" | "runJsonInThread",
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  prompt: string,
  signal?: AbortSignal,
): Promise<PiCollectResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    console.log(`\x1b[35m[Pi Telemetry] [${label}] Starting child process...\x1b[0m`);

    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // NOT detached: the child must stay in the server's process group so the
        // Electron main's group tree-kill (and the watchdog) reap it on shutdown.
        // Detaching would make it its own group leader and orphan in-flight
        // calls when the app quits.
      });
    } catch (err) {
      resolve({
        assistantText: "",
        usage: null,
        errorMessage: "",
        rawStdout: "",
        stderr: "",
        exitCode: null,
        spawnError: err instanceof Error ? err : new Error(String(err)),
        aborted: false,
        rawTruncated: false,
      });
      return;
    }

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    let stdoutBuf = "";
    let stderrBuf = "";
    let rawStdout = "";
    let rawTruncated = false;
    let stderr = "";
    let assistantText = "";
    let usage: unknown = null;
    let errorMessage = "";
    let spawnError: Error | null = null;
    let aborted = false;
    let settled = false;
    let firstTokenTime: number | null = null;

    const markFirstToken = () => {
      if (firstTokenTime !== null) return;
      firstTokenTime = Date.now();
      console.log(
        `\x1b[32m[Pi Telemetry] [${label}] Time to First Token (TTFT): ${firstTokenTime - startTime}ms\x1b[0m`,
      );
    };

    const appendRaw = (s: string) => {
      const room = RAW_OUTPUT_CAP - rawStdout.length;
      if (room <= 0) {
        rawTruncated = true;
        return;
      }
      if (s.length <= room) {
        rawStdout += s;
      } else {
        rawStdout += s.slice(0, room);
        rawTruncated = true;
      }
    };

    const handleEvent = (event: PiEvent) => {
      // TTFT is reported for the first event carrying assistant content — the
      // session header and other lifecycle events arrive earlier and are not
      // the first token.
      if (event.message?.content) markFirstToken();

      if (event.type) {
        console.log(`\x1b[36m[Pi Event] [${label}] ${event.type}\x1b[0m`);
      }

      if (event.errorMessage) {
        errorMessage = event.errorMessage;
      }
      if (event.message?.errorMessage) {
        errorMessage = event.message.errorMessage;
      }
      if (event.errorMessage || event.message?.errorMessage) {
        console.error(
          `\x1b[31m[Pi Coder ERROR] [${label}] ${event.errorMessage || event.message?.errorMessage}\x1b[0m`,
        );
      }

      if (event.type === "agent_end" && event.messages) {
        const lastMsg = event.messages[event.messages.length - 1];
        if (lastMsg?.role === "assistant") {
          const textContent = lastMsg.content?.find((c) => c.type === "text")?.text;
          if (textContent) assistantText = textContent;
          if (lastMsg.usage) usage = lastMsg.usage;
        }
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        const textContent = event.message.content?.find((c) => c.type === "text")?.text;
        if (textContent) assistantText = textContent;
        if (event.message.usage) usage = event.message.usage;
      }
    };

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;

      // Fast-skip the streaming-delta flood. `message_update` re-serialises the
      // whole accumulated message on every chunk, so it dominates stdout volume
      // while carrying nothing handleEvent reads. This is a fail-safe
      // optimisation: we do not depend on key ordering, and if the prefix ever
      // misses we fall through to a normal parse that ignores the event anyway.
      // It only skips the JSON.parse cost, never correctness.
      if (line.startsWith('{"type":"message_update"')) {
        markFirstToken();
        return;
      }

      let event: PiEvent;
      try {
        event = JSON.parse(line) as PiEvent;
      } catch {
        // Not JSON, log as raw text.
        console.log(`[Pi Raw stdout] [${label}] ${line}`);
        return;
      }
      handleEvent(event);
    };

    /** Boundary-safe drain: a line split across chunks is reassembled. */
    const flushLines = (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    };

    const finalizeBuf = () => {
      const tailOut = stdoutDecoder.end();
      if (tailOut) {
        appendRaw(tailOut);
        flushLines(tailOut);
      }
      const tailErr = stderrDecoder.end();
      if (tailErr) {
        stderr = (stderr + tailErr).slice(-STDERR_CAP);
        stderrBuf += tailErr;
      }
      // A final line can arrive without a trailing newline.
      if (stdoutBuf) {
        const last = stdoutBuf;
        stdoutBuf = "";
        handleLine(last);
      }
      if (stderrBuf.trim()) {
        for (const line of stderrBuf.split("\n")) {
          if (line.trim()) console.error(`\x1b[33m[Pi stderr] [${label}] ${line}\x1b[0m`);
        }
      }
      stderrBuf = "";
    };

    const onAbort = () => {
      aborted = true;
      killPiChild(child);
    };

    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      // `once: true` only auto-removes when the listener FIRES; remove it here
      // too so a normally-completed call doesn't leak a listener while
      // codex.ts's 5-minute linkAbort timer is still pending.
      signal?.removeEventListener("abort", onAbort);
      finalizeBuf();
      if (rawTruncated) {
        console.warn(
          `\x1b[33m[Pi Telemetry] [${label}] stdout exceeded the ${RAW_OUTPUT_CAP}-byte raw-retention cap; kept the prefix only.\x1b[0m`,
        );
      }
      console.log(
        `\x1b[35m[Pi Telemetry] [${label}] Process exited with code ${exitCode}. Total duration: ${Date.now() - startTime}ms\x1b[0m`,
      );
      resolve({
        assistantText,
        usage,
        errorMessage,
        rawStdout,
        stderr,
        exitCode,
        spawnError,
        aborted,
        rawTruncated,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const s = stdoutDecoder.write(chunk);
      if (!s) return;
      appendRaw(s);
      flushLines(s);
    });
    child.stdout?.on("error", () => {});

    child.stderr?.on("data", (chunk: Buffer) => {
      const s = stderrDecoder.write(chunk);
      if (!s) return;
      stderr = (stderr + s).slice(-STDERR_CAP);
      stderrBuf += s;
      let nl: number;
      while ((nl = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.trim()) console.error(`\x1b[33m[Pi stderr] [${label}] ${line}\x1b[0m`);
      }
    });
    child.stderr?.on("error", () => {});

    // `close` (not `exit`) so every stdout byte has been read before we settle.
    child.once("error", (err: Error) => {
      spawnError = err;
      done(null);
    });
    child.once("close", (code: number | null) => done(code));

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        killPiChild(child);
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (child.stdin) {
      // Guard the write: if the child dies before draining the prompt the pipe
      // raises EPIPE, which without a handler becomes an unhandled 'error'
      // event and takes the whole server process down.
      child.stdin.on("error", () => {});
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch {
        /* stream already destroyed */
      }
    }
  });
}

/** Map a collected run onto a result, preserving the original error surface. */
function finalizePiRun<T>(r: PiCollectResult): { data: T; usage: unknown } {
  if (r.spawnError) throw r.spawnError;
  if (r.aborted) throw new Error("Pi CLI call aborted");

  if (r.exitCode !== 0) {
    // Reproduce execFile's old reject-on-non-zero behaviour, which embedded
    // stderr in the error message. classifyCodexError (lib/codex-errors.ts)
    // re-derives the kind from this text, so the raw cause must stay in it.
    const detail =
      r.errorMessage.trim() ||
      r.stderr.trim() ||
      r.rawStdout.trim() ||
      `exited with code ${r.exitCode}`;
    throw new Error(detail);
  }

  if (r.errorMessage && !r.assistantText) {
    throw new Error(r.errorMessage);
  }

  if (!r.assistantText) {
    // Fallback if the output wasn't NDJSON.
    return { data: parseTurnJson<T>(r.rawStdout), usage: null };
  }

  return { data: parseTurnJson<T>(r.assistantText), usage: r.usage };
}

async function runPiJsonMode<T>(
  label: "runJson" | "runJsonInThread",
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ data: T; usage: unknown }> {
  try {
    const collected = await spawnAndCollect(label, binary, args, env, prompt, signal);
    return finalizePiRun<T>(collected);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CodexError("generic", `Pi CLI ${label} failed: ${message}`);
  }
}

export async function runJsonPi<T>(
  prompt: string,
  outputSchema: object,
  opts: RunOptions = {},
): Promise<{ data: T; usage: unknown }> {
  const settings = loadSettings();
  const model = settings.piModelFast || "llama3.2";
  const { binary, preArgs } = getPiExecutionConfig();
  const { env, provider } = buildEnvAndProvider(settings);

  // Instruct the model to return JSON matching the schema
  const augmentedPrompt = `${prompt}\n\nYou MUST respond ONLY in valid JSON that matches the following schema:\n${JSON.stringify(outputSchema, null, 2)}`;

  // Prompt goes over STDIN (not as a `--print <arg>`): a full-document prompt
  // would otherwise exceed the OS command-line limit (E2BIG → spawn failure).
  const args = [
    ...preArgs,
    "--mode", "json",
    "--print",
    "--provider", provider,
    "--model", model,
    "--no-tools" // Hermetic execution, no side effects
  ];

  console.log(`\x1b[34m[Pi Command] Running: ${binary} ${args.join(" ")}\x1b[0m`);

  return runPiJsonMode<T>("runJson", binary, args, env, augmentedPrompt, opts.signal);
}

export async function runJsonInThreadPi<T>(args: {
  outputSchema: object;
  opts?: RunOptions;
  resume?: { threadId: string; input: string };
  start?: { input: string };
}): Promise<{ data: T; usage: unknown; threadId: string | null }> {
  const settings = loadSettings();
  const model = settings.piModelSmart || "llama3.2";
  const { binary, preArgs } = getPiExecutionConfig();
  const { env, provider } = buildEnvAndProvider(settings);

  let prompt = "";
  let threadId = args.resume?.threadId;

  if (args.start) {
    prompt = `${args.start.input}\n\nYou MUST respond ONLY in valid JSON that matches the following schema:\n${JSON.stringify(args.outputSchema, null, 2)}`;
  } else if (args.resume) {
    prompt = `${args.resume.input}\n\nYou MUST respond ONLY in valid JSON that matches the following schema:\n${JSON.stringify(args.outputSchema, null, 2)}`;
  } else {
    throw new Error("runJsonInThreadPi: provide `start` or `resume`");
  }

  // Prompt over STDIN (not `--print <arg>`) to avoid the command-line limit.
  const cliArgs = [
    ...preArgs,
    "--mode", "json",
    "--print",
    "--provider", provider,
    "--model", model,
    "--no-tools"
  ];

  // If resuming, pass the session flag
  if (threadId) {
    cliArgs.push("--session", threadId);
  } else {
    // We need a unique session id so we can resume it later
    threadId = `pi-session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    cliArgs.push("--session-id", threadId);
  }

  console.log(`\x1b[34m[Pi Command] Running: ${binary} ${cliArgs.join(" ")}\x1b[0m`);

  const parsed = await runPiJsonMode<T>(
    "runJsonInThread",
    binary,
    cliArgs,
    env,
    prompt,
    args.opts?.signal,
  );
  return { data: parsed.data, usage: parsed.usage, threadId };
}
