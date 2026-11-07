/**
 * Regression test for the Pi CLI stdout ceiling.
 *
 * Run: npm run test:pi      (from the repo root)
 *
 * The old bug: lib/pi-coder.ts ran Pi via `promisify(execFile)` with
 * `maxBuffer: 10 * 1024 * 1024`. Pi's `--mode json` writes one NDJSON line per
 * session event, and its `message_update` event carries the FULL accumulated
 * assistant message every chunk — so stdout grows quadratically with response
 * length and any fixed buffer is eventually exceeded:
 *
 *     Pi CLI runJson failed: stdout maxBuffer length exceeded
 *
 * getPiExecutionConfig also split each stdout chunk on "\n" independently, so a
 * line straddling a chunk boundary was mis-parsed.
 *
 * scripts/pi-stub.cjs reproduces both: it emits ~20 MB of NDJSON and writes the
 * final `message_end` line in two halves. This test drives the real
 * runJsonPi / runJsonInThreadPi through it via the PI_BINARY_PATH seam
 * (resolveBundledBinary honours it), so it needs no API key and no network.
 */

import path from "node:path";

process.env.PI_BINARY_PATH = path.resolve(process.cwd(), "scripts", "pi-stub.cjs");

import { runJsonPi, runJsonInThreadPi } from "../lib/pi-coder";
import { classifyCodexError } from "../lib/codex-errors";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

type StubResult = { ok: boolean; note: string; chars: number; bytes: number };

const EXPECTED_CHARS = 400 * 250;

async function main() {
  console.log("=== runJsonPi over a >10 MB quadratic NDJSON stream ===\n");

  let data: StubResult;
  let usage: unknown;
  try {
    const out = await runJsonPi<StubResult>("test prompt", { type: "object" });
    data = out.data;
    usage = out.usage;
  } catch (err) {
    check("runJsonPi completes (no maxBuffer ceiling)", false, String(err));
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }

  check("runJsonPi completes instead of hitting a stdout ceiling", true);

  // Proves the stream really was bigger than the old 10 MB execFile buffer —
  // otherwise this test would pass against the broken code too.
  check(
    "stub stream exceeded the old 10 MB maxBuffer",
    data.bytes > 10 * 1024 * 1024,
    `${(data.bytes / 1024 / 1024).toFixed(1)} MB`,
  );

  // The final assistant text (not the raw stdout) must be what we parsed.
  check("final assistant text is the parsed result", data.note === "pi-stub", data.note);
  check("assistant text is intact", data.chars === EXPECTED_CHARS, `${data.chars} chars`);

  // The usage object rides on the SAME line that was split across two chunks,
  // so this is what proves the boundary-safe reassembly works.
  const u = usage as Record<string, unknown> | null;
  check("usage survived (line split across chunks was reassembled)", !!u && typeof u === "object");
  check("usage.input preserved", u?.input === 123, String(u?.input));
  check("usage.output preserved", u?.output === 456, String(u?.output));
  check(
    "usage.cost.total preserved (shape lib/usage-store.ts reads)",
    (u?.cost as Record<string, unknown> | undefined)?.total === 0.0123,
    String((u?.cost as Record<string, unknown> | undefined)?.total),
  );

  console.log("\n=== runJsonInThreadPi ===\n");

  const threaded = await runJsonInThreadPi<StubResult>({
    outputSchema: { type: "object" },
    start: { input: "hello" },
  });
  check("runJsonInThreadPi returns data", threaded.data.note === "pi-stub");
  check("runJsonInThreadPi returns usage", !!threaded.usage);
  check(
    "runJsonInThreadPi returns a threadId",
    typeof threaded.threadId === "string" && threaded.threadId.length > 0,
    String(threaded.threadId),
  );

  console.log("\n=== error classification is preserved ===\n");

  // Pi reports API failures through the event stream, not the exit code. The
  // thrown message must still carry the cause so classifyCodexError can map it.
  process.env.PI_STUB_MODE = "auth-error";
  let authMessage = "";
  try {
    await runJsonPi<StubResult>("test prompt", { type: "object" });
    check("auth error is surfaced as a throw", false, "no error thrown");
  } catch (err) {
    authMessage = err instanceof Error ? err.message : String(err);
    check("auth error is surfaced as a throw", true);
  }
  check(
    "thrown message keeps the 'Pi CLI runJson failed: ' prefix",
    authMessage.startsWith("Pi CLI runJson failed: "),
    authMessage,
  );
  check(
    "thrown message embeds the raw cause",
    authMessage.includes("401 Unauthorized"),
    authMessage,
  );
  check(
    "classifyCodexError still maps it to auth_lost",
    classifyCodexError(authMessage).kind === "auth_lost",
    classifyCodexError(authMessage).kind,
  );
  delete process.env.PI_STUB_MODE;

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
