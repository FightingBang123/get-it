/**
 * Feynman method tool.
 *
 * The user explains a topic to a curious "child". The child asks 3-4 short,
 * pointed prompts in sequence; the user answers each one in their own words.
 * After the final turn, the agent produces a one-paragraph summary that
 * feeds the evaluator.
 *
 *   GET  /api/feynman/[docId]                                  → all sessions
 *   POST /api/feynman/[docId] { action:"start", topic }        → first child prompt
 *   POST /api/feynman/[docId] { action:"explain", sessionId, userExplanation }
 *                                                              → next child prompt
 *                                                                OR end-of-session
 *                                                                summary if turns >= MAX
 *   DELETE /api/feynman/[docId]?sessionId=...
 */

import { NextResponse } from "next/server";
import { runJson, toCodexErrorPayload } from "@/lib/codex";
import { getDoc } from "@/lib/store";
import {
  loadWorkContext,
  saveWorkContext,
  newId,
  type FeynmanSession,
  type FeynmanTurn,
} from "@/lib/work-context";
import {
  feynmanChildPromptSchema,
  feynmanSummarySchema,
  type FeynmanChildPromptResult,
  type FeynmanSummaryResult,
} from "@/lib/schemas-kg";
import { loadKG } from "@/lib/kg";
import { scheduleEvaluation } from "@/lib/kg-runner";
import { buildDocumentContext } from "@/lib/retrieval";
import { systemPrompt } from "@/prompt/registry";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_TURNS = 4;

function topicLineFor(topic: string): string {
  return topic === "all"
    ? "TOPIC THE STUDENT IS TEACHING: the whole document (no specific sub-topic — pick the most important thread)"
    : `TOPIC THE STUDENT IS TEACHING: ${topic}`;
}

/** Lightweight context for the child-prompt turns: the curious-child agent
 *  reacts to the student's own words, the topic and the concept map — it does
 *  NOT need the source text. Skipping the document body here keeps every turn
 *  small (the heaviest part of a Feynman session is its 4 turns). */
function childContext(docId: string, topic: string): string {
  const kg = loadKG(docId);
  const kgPart =
    kg && kg.status === "ready"
      ? `\nGRAPH NODES:\n${kg.nodes.map((n) => `- ${n.label}: ${n.summary}`).join("\n")}\n`
      : "";
  return `${topicLineFor(topic)}\n${kgPart}`;
}

/** Context for the end-of-session summary: it judges how faithfully the
 *  student re-explained the material. Short documents are sent whole; long
 *  ones are narrowed to the chunks relevant to the topic. */
function summaryContext(docId: string, topic: string): string {
  const doc = getDoc(docId);
  const kg = loadKG(docId);
  const kgPart =
    kg && kg.status === "ready"
      ? `\nGRAPH NODES:\n${kg.nodes.map((n) => `- ${n.label}: ${n.summary}`).join("\n")}\n`
      : "";
  const context = doc
    ? buildDocumentContext({
        docId,
        pages: doc.extracted.pages,
        kg,
        tool: "feynman",
        topic,
      })
    : null;
  const docPart = doc && context
    ? `DOCUMENT: ${doc.filename}\n${kgPart}\n${context.text}`
    : "";
  return `${topicLineFor(topic)}\n\n${docPart}`;
}

function renderTranscript(turns: FeynmanTurn[], pendingChildPrompt?: string): string {
  const lines: string[] = [];
  for (const t of turns) {
    lines.push(`CHILD: ${t.childPrompt}`);
    lines.push(`STUDENT: ${t.userExplanation}`);
  }
  if (pendingChildPrompt) lines.push(`CHILD: ${pendingChildPrompt}`);
  return lines.join("\n\n");
}

async function nextChildPrompt(docId: string, session: FeynmanSession): Promise<string> {
  const prompt = `${systemPrompt("feynman-child", getDoc(docId)?.materialKind)}

${childContext(docId, session.topic)}

--- TRANSCRIPT SO FAR ---
${renderTranscript(session.turns) || "(the student is about to start — ask an opening question that invites them to explain the topic from scratch in their own words)"}

Ask the next child prompt. JSON only.`;
  const { data } = await runJson<FeynmanChildPromptResult>(
    prompt,
    feynmanChildPromptSchema,
    { reasoning: "low" },
  );
  return data.childPrompt.trim();
}

async function endingSummary(docId: string, session: FeynmanSession): Promise<string> {
  const prompt = `${systemPrompt("feynman-summary", getDoc(docId)?.materialKind, { maxTurns: MAX_TURNS })}

${summaryContext(docId, session.topic)}

--- TRANSCRIPT ---
${renderTranscript(session.turns)}

Write the summary. JSON only.`;
  const { data } = await runJson<FeynmanSummaryResult>(prompt, feynmanSummarySchema, {
    reasoning: "medium",
  });
  return data.summary.trim();
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!getDoc(docId)) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  const wc = loadWorkContext(docId);
  return NextResponse.json({ sessions: wc.feynman, maxTurns: MAX_TURNS });
}

type Body =
  | { action: "start"; topic: string }
  | { action: "explain"; sessionId: string; userExplanation: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!getDoc(docId)) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  const body = (await req.json()) as Body;

  if (body.action === "start") {
    // Empty topic → "all" sentinel (mirrors flashcards): the agent works
    // over the whole document. The sidebar/header renders this as
    // "Whole document".
    const topic = body.topic?.trim() || "all";
    const session: FeynmanSession = {
      id: newId(),
      topic,
      createdAt: Date.now(),
      turns: [],
    };
    let childPrompt: string;
    try {
      childPrompt = await nextChildPrompt(docId, session);
    } catch (e) {
      const p = toCodexErrorPayload(e);
      return NextResponse.json({ error: p.message, kind: p.kind }, { status: 503 });
    }
    // Persist the open-question turn placeholder by stashing the prompt on
    // the session object — we'll merge it with the user reply when it lands.
    const wc = loadWorkContext(docId);
    wc.feynman.unshift(session);
    saveWorkContext(wc);
    return NextResponse.json({
      session,
      childPrompt,
      done: false,
      maxTurns: MAX_TURNS,
    });
  }

  if (body.action === "explain") {
    const wc = loadWorkContext(docId);
    const session = wc.feynman.find((s) => s.id === body.sessionId);
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
    if (session.endedAt) {
      return NextResponse.json({ error: "session already ended" }, { status: 400 });
    }
    const userExplanation = body.userExplanation?.trim();
    if (!userExplanation) {
      return NextResponse.json({ error: "userExplanation required" }, { status: 400 });
    }

    // We need to know which child prompt this answer was for. The previous
    // POST response carried it; the client echoes it back in the persisted
    // session via this endpoint. To keep the API symmetric we re-derive it
    // by asking the model again only if missing, but the client always sends
    // a userExplanation tied to the most-recently-issued child prompt — so
    // we trust the client's lastChildPrompt tracked in state. To avoid
    // ambiguity, we accept the prompt inline:
    const childPrompt = (body as unknown as { childPrompt?: string }).childPrompt;
    if (!childPrompt) {
      return NextResponse.json(
        { error: "childPrompt required (echo the last prompt from the previous response)" },
        { status: 400 },
      );
    }

    // Build the would-be turn in memory only. We persist it (and any model
    // output) ONLY after the codex call succeeds, so a failed turn leaves the
    // session untouched on disk and the client can re-submit to retry without
    // duplicating the turn.
    const pendingTurns = [
      ...session.turns,
      { childPrompt, userExplanation, ts: Date.now() },
    ];

    if (pendingTurns.length >= MAX_TURNS) {
      // End of session — generate the summary, then commit.
      let summary: string;
      try {
        summary = await endingSummary(docId, { ...session, turns: pendingTurns });
      } catch (e) {
        const p = toCodexErrorPayload(e);
        return NextResponse.json({ error: p.message, kind: p.kind }, { status: 503 });
      }
      session.turns = pendingTurns;
      session.summary = summary;
      session.endedAt = Date.now();
      saveWorkContext(wc);
      scheduleEvaluation(docId);
      return NextResponse.json({ session, done: true, summary, maxTurns: MAX_TURNS });
    }

    let next: string;
    try {
      next = await nextChildPrompt(docId, { ...session, turns: pendingTurns });
    } catch (e) {
      const p = toCodexErrorPayload(e);
      return NextResponse.json({ error: p.message, kind: p.kind }, { status: 503 });
    }
    session.turns = pendingTurns;
    saveWorkContext(wc);
    return NextResponse.json({ session, childPrompt: next, done: false, maxTurns: MAX_TURNS });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!getDoc(docId)) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  const wc = loadWorkContext(docId);
  wc.feynman = wc.feynman.filter((s) => s.id !== sessionId);
  saveWorkContext(wc);
  return NextResponse.json({ ok: true });
}
