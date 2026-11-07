/**
 * Quizzes.
 *
 *   GET  /api/quizzes/[docId]                       → all sessions
 *   POST /api/quizzes/[docId] { action:"generate", topic? }
 *                                                   → new session with questions
 *   POST /api/quizzes/[docId] { action:"answer", sessionId, questionIndex, chosenIndex }
 *                                                   → record a forced-choice pick
 *   POST /api/quizzes/[docId] { action:"end", sessionId }
 *                                                   → mark session ended; trigger KG eval
 *   DELETE /api/quizzes/[docId]?sessionId=...
 *
 * Sibling tool to flashcards: same lifecycle, same KG-evaluation handoff
 * when a quiz ends. Where flashcards measure open-ended recall (self-
 * graded 1–4), quizzes measure forced-choice discrimination — can the
 * student pick the correct option *over* a plausible distractor? — and
 * give the evaluator a clean correct/incorrect signal per concept.
 */

import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { runJson, toCodexErrorPayload } from "@/lib/codex";
import { getDoc } from "@/lib/store";
import {
  loadWorkContext,
  saveWorkContext,
  newId,
  type QuizQuestion,
  type QuizSession,
} from "@/lib/work-context";
import {
  quizGenerateSchema,
  type QuizGenerateResult,
} from "@/lib/schemas-kg";
import { loadKG } from "@/lib/kg";
import { buildDocumentContext } from "@/lib/retrieval";
import { systemPrompt } from "@/prompt/registry";
import { scheduleEvaluation } from "@/lib/kg-runner";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * Fisher–Yates with crypto.randomInt as the entropy source. Returns a new
 * array so callers don't accidentally mutate the input. We pick crypto
 * over Math.random because option order is the kind of thing a curious
 * student WILL try to game ("the second option always seems to be right")
 * and a PRNG would let them.
 */
function shuffle<T>(input: readonly T[]): T[] {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generationPrompt(docId: string, topic: string): string {
  const doc = getDoc(docId)!;
  const kg = loadKG(docId);
  const kgPart =
    kg && kg.status === "ready"
      ? `\nKEY CONCEPTS:\n${kg.nodes.map((n) => `- ${n.label}: ${n.summary}`).join("\n")}\n`
      : "";
  // Short documents come back whole; long ones are narrowed to the chunks
  // that match the topic so the request stays inside the input budget.
  const context = buildDocumentContext({
    docId,
    pages: doc.extracted.pages,
    kg,
    tool: "quizzes",
    topic,
  });
  return `${systemPrompt("quizzes", doc.materialKind)}

DOCUMENT: ${doc.filename}
${kgPart}
${context.text}

TOPIC: ${topic === "all" ? "the whole document — broad coverage" : topic}

Produce the quiz now. Output JSON.`;
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
  return NextResponse.json({ sessions: wc.quizzes });
}

type Body =
  | { action: "generate"; topic?: string }
  | { action: "answer"; sessionId: string; questionIndex: number; chosenIndex: number }
  | { action: "end"; sessionId: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!getDoc(docId)) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  const body = (await req.json()) as Body;
  const wc = loadWorkContext(docId);

  if (body.action === "generate") {
    const topic = (body.topic ?? "all").trim() || "all";
    let data: QuizGenerateResult;
    try {
      ({ data } = await runJson<QuizGenerateResult>(
        generationPrompt(docId, topic),
        quizGenerateSchema,
        { reasoning: "low" },
      ));
    } catch (e) {
      const p = toCodexErrorPayload(e);
      return NextResponse.json({ error: p.message, kind: p.kind }, { status: 503 });
    }
    // Defensive clamp: in case the model emits a stray correctIndex
    // outside 0..3 we treat the first option as correct rather than
    // throwing — the JSON Schema already enforces bounds but the
    // server-side guard keeps us safe if the schema is ever loosened.
    //
    // Then shuffle: LLMs have a strong positional bias toward placing
    // the correct option at index 0 (it's the most natural way to write
    // a "right answer + 3 distractors" list). If we left that bias in
    // place every quiz would be trivially A-A-A-A. We shuffle each
    // question's options independently with crypto-grade entropy and
    // remap correctIndex so the right answer lands in a uniformly
    // random slot.
    const questions: QuizQuestion[] = data.questions.map((q) => {
      const rawOptions = q.options.slice(0, 4);
      const rawCorrect = Math.min(3, Math.max(0, q.correctIndex | 0));
      const indices = shuffle([0, 1, 2, 3]);
      const options = indices.map((i) => rawOptions[i]);
      const correctIndex = indices.indexOf(rawCorrect);
      return {
        stem: q.stem,
        options,
        correctIndex,
        explanation: q.explanation,
      };
    });
    const session: QuizSession = {
      id: newId(),
      topic,
      createdAt: Date.now(),
      questions,
    };
    const reloaded = loadWorkContext(docId);
    reloaded.quizzes.unshift(session);
    saveWorkContext(reloaded);
    return NextResponse.json({ session });
  }

  if (body.action === "answer") {
    const session = wc.quizzes.find((s) => s.id === body.sessionId);
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
    const question = session.questions[body.questionIndex];
    if (!question) {
      return NextResponse.json({ error: "question index out of range" }, { status: 400 });
    }
    if (body.chosenIndex < 0 || body.chosenIndex > 3) {
      return NextResponse.json({ error: "chosenIndex must be 0..3" }, { status: 400 });
    }
    // Write-once: the first answer sticks. Ignore re-submits silently so
    // a double-click can't change a recorded choice.
    if (question.chosenIndex == null) {
      question.chosenIndex = body.chosenIndex;
      question.answeredAt = Date.now();
      saveWorkContext(wc);
    }
    return NextResponse.json({ session });
  }

  if (body.action === "end") {
    const session = wc.quizzes.find((s) => s.id === body.sessionId);
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
    if (!session.endedAt) {
      session.endedAt = Date.now();
      saveWorkContext(wc);
      scheduleEvaluation(docId);
    }
    return NextResponse.json({ session });
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
  wc.quizzes = wc.quizzes.filter((s) => s.id !== sessionId);
  saveWorkContext(wc);
  return NextResponse.json({ ok: true });
}
