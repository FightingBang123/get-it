#!/usr/bin/env node
/**
 * scripts/pi-stub.cjs
 *
 * Stand-in for the Pi coding-agent CLI, used by scripts/test-pi-stream.ts.
 *
 * It reproduces the two properties of real Pi in `--mode json` that broke
 * lib/pi-coder.ts:
 *
 *   1. **Quadratic stdout.** Pi writes one NDJSON line per session event, and
 *      its `message_update` event re-serialises the FULL accumulated assistant
 *      message on every streaming chunk (see
 *      @earendil-works/pi-agent-core types + pi-coding-agent/dist/modes/
 *      print-mode.js, which stringifies each event). This stub therefore grows
 *      an accumulator and re-emits it each step, so total stdout lands around
 *      20 MB — comfortably past the 10 MB `maxBuffer` the old
 *      `promisify(execFile)` used, which failed with
 *      "stdout maxBuffer length exceeded".
 *
 *   2. **Lines split across chunk boundaries.** The final `message_end` line is
 *      written in two halves with a delay between them, forcing them into
 *      separate `data` chunks. Any reader that splits each chunk independently
 *      (as the old logPiProcess did) mis-parses it.
 *
 * Injected via PI_BINARY_PATH: resolveBundledBinary("pi") honours it, and
 * getPiExecutionConfig places it as node's entry script, so plain node runs
 * this file — no production change needed to use it.
 *
 * Modes (PI_STUB_MODE):
 *   (unset)      normal — huge stream, valid JSON result, exit 0
 *   auth-error   emits a 401 errorMessage event, exit 0 (mimics Pi reporting
 *                an API failure through the event stream rather than the exit
 *                code), so the test can assert error classification survives.
 *
 * Usage: PI_BINARY_PATH=scripts/pi-stub.cjs npx tsx scripts/test-pi-stream.ts
 */

"use strict";

const ITERATIONS = 400;
const GROWTH = 250; // chars appended per message_update

const USAGE = {
  input: 123,
  output: 456,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 579,
  cost: { total: 0.0123 },
};

const MODE = process.env.PI_STUB_MODE || "normal";

let bytesWritten = 0;

function write(line) {
  const payload = line + "\n";
  bytesWritten += Buffer.byteLength(payload);
  process.stdout.write(payload);
}

/** Drain the prompt Pi receives on stdin. */
function drainStdin() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 5000);
    if (process.stdin.readableEnded) {
      finish();
      return;
    }
    process.stdin.resume();
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

async function main() {
  await drainStdin();

  write(JSON.stringify({ type: "session_header", sessionId: "pi-stub-session" }));
  write(JSON.stringify({ type: "agent_start" }));

  if (MODE === "auth-error") {
    write(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "401 Unauthorized: invalid api key",
        },
      }),
    );
    write(
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "prompt" }] },
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "401 Unauthorized: invalid api key",
          },
        ],
        willRetry: false,
      }),
    );
    process.exit(0);
  }

  // The quadratic part: re-emit the whole accumulated message every step.
  let accumulated = "";
  for (let i = 0; i < ITERATIONS; i++) {
    accumulated += "x".repeat(GROWTH);
    write(
      JSON.stringify({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: accumulated }],
        },
        assistantMessageEvent: { type: "text_delta", delta: "x".repeat(GROWTH) },
      }),
    );
  }

  const result = {
    ok: true,
    note: "pi-stub",
    chars: accumulated.length,
    bytes: bytesWritten,
  };
  const finalText = JSON.stringify(result);

  // Deliberately split this line across two writes so the halves land in
  // separate chunks — a boundary-unsafe reader loses the event entirely.
  const endLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalText }],
      usage: USAGE,
    },
  });
  const half = Math.floor(endLine.length / 2);
  process.stdout.write(endLine.slice(0, half));
  await new Promise((r) => setTimeout(r, 25));
  const tail = endLine.slice(half) + "\n";
  bytesWritten += Buffer.byteLength(tail);
  process.stdout.write(tail);

  write(
    JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "prompt" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          usage: USAGE,
        },
      ],
      willRetry: false,
    }),
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
