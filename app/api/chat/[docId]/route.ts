/**
 * Chat with the document.
 *
 *   GET    /api/chat/[docId]                         → list of chats (full)
 *   POST   /api/chat/[docId] { action:"create", title? }
 *                                                    → new empty chat
 *   POST   /api/chat/[docId] { action:"send", chatId, message }
 *                                                    → user message + assistant reply
 *   DELETE /api/chat/[docId]?chatId=...              → remove a chat
 *
 * After every assistant turn we schedule a knowledge-graph evaluation pass
 * (fire-and-forget) so the user's mastery scores update as soon as the
 * model has finished writing.
 */

import { NextResponse } from "next/server";
import { runJsonInThread, CodexError, getActiveProviderName } from "@/lib/codex";
import { getDoc } from "@/lib/store";
import {
  loadWorkContext,
  saveWorkContext,
  newId,
  type ChatMessage,
} from "@/lib/work-context";
import { chatReplySchema, type ChatReplyResult } from "@/lib/schemas-kg";
import { loadKG } from "@/lib/kg";
import { buildDocumentContext } from "@/lib/retrieval";
import { systemPrompt } from "@/prompt/registry";
import type { ProviderName } from "@/lib/provider-types";

export const runtime = "nodejs";
export const maxDuration = 180;

function docContext(
  docId: string,
  message: string,
  history: ChatMessage[],
): { text: string; mode: "full" | "relevance" | "coverage" } {
  const doc = getDoc(docId);
  if (!doc) return { text: "", mode: "full" };
  const kg = loadKG(docId);
  const kgPart = kg && kg.status === "ready"
    ? `\nKEY CONCEPTS (knowledge graph):\n${kg.nodes
        .map((n) => `- ${n.label}: ${n.summary}`)
        .join("\n")}\n`
    : "";
  // Short documents go to the model whole (the persistent thread caches the
  // block across turns). Long ones are narrowed to the pages relevant to this
  // message, otherwise the thread exceeds the model's context on the first
  // turn — which is what used to break long books.
  const context = buildDocumentContext({
    docId,
    pages: doc.extracted.pages,
    kg,
    tool: "chat",
    message,
    history: history.map((m) => ({ role: m.role, content: m.content })),
  });
  return {
    text: `DOCUMENT: ${doc.filename}\n${kgPart}\n${context.text}`,
    mode: context.mode,
  };
}

function renderHistory(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "STUDENT" : "ASSISTANT"}: ${m.content}`)
    .join("\n\n");
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
  return NextResponse.json({ chats: wc.chats });
}

type Body =
  | { action: "create"; title?: string }
  | { action: "send"; chatId: string; message: string };

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

  if (body.action === "create") {
    const now = Date.now();
    const chat = {
      id: newId(),
      title: (body.title ?? "New chat").slice(0, 80),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    wc.chats.unshift(chat);
    saveWorkContext(wc);
    return NextResponse.json({ chat });
  }

  if (body.action === "send") {
    const chat = wc.chats.find((c) => c.id === body.chatId);
    if (!chat) return NextResponse.json({ error: "chat not found" }, { status: 404 });
    const message = body.message?.trim();
    if (!message) return NextResponse.json({ error: "empty message" }, { status: 400 });

    const userMsg: ChatMessage = { role: "user", content: message, ts: Date.now() };
    // History to send the model with the new turn appended — but NOT yet
    // persisted. We commit the user message and the reply together only after
    // the codex call succeeds (below), so a failed turn leaves no orphan user
    // message on disk and the client can re-send to retry without duplicating
    // it.
    const messagesForPrompt = [...chat.messages, userMsg];

    // Document context for this turn. Short docs are the whole document; long
    // docs are the handful of chunks relevant to this message.
    const docCtx = docContext(docId, message, messagesForPrompt);

    // The new turn the student just typed. When the document is excerpted we
    // re-send the matching excerpts on every turn — a resumed thread only
    // knows the pages it was seeded with, which may not cover this question.
    const turnBody = `STUDENT: ${message}\n\n--- ASSISTANT REPLY ---\nReply now as ASSISTANT. Output JSON.`;
    const turnInput =
      docCtx.mode === "full" ? turnBody : `${docCtx.text}\n\n${turnBody}`;

    const activeProvider = getActiveProviderName();
    let reply: ChatReplyResult | null = null;
    let codexThreadId: string | null = chat.codexThreadId ?? null;
    let threadProvider: ProviderName | null = chat.threadProvider ?? null;

    // Resume the engine's native thread ONLY when it was minted by the engine
    // that's active right now — a thread id is provider-specific. The document
    // + prior turns already live in that thread, so we send only the new
    // message (a prefix-cache hit, a fraction of the tokens). If the user
    // switched providers, we skip resume entirely and migrate transparently
    // below (no wasted cross-provider resume call, no error-string guessing).
    const canResume = !!chat.codexThreadId && chat.threadProvider === activeProvider;
    if (canResume) {
      try {
        const { data, threadId } = await runJsonInThread<ChatReplyResult>({
          outputSchema: chatReplySchema,
          opts: { reasoning: "low" },
          resume: { threadId: chat.codexThreadId!, input: turnInput },
        });
        reply = data;
        codexThreadId = threadId ?? chat.codexThreadId!;
        threadProvider = activeProvider;
      } catch (e) {
        // Rate-limit / auth / binary: let the health banner take over.
        if (e instanceof CodexError && e.kind !== "generic") throw e;
        // Generic failure (e.g. the session expired / was evicted): fall
        // through and rebuild a fresh thread with full context so the answer
        // never silently degrades.
        reply = null;
      }
    }

    // No usable thread (first turn, provider switched, or resume failed): open
    // a fresh thread and seed it with the full context — system prompt + whole
    // document + the conversation so far. Stable prefix first, latest turn last.
    // This is the transparent migration: the new engine sees the entire history.
    if (!reply) {
      const systemText = systemPrompt("chat", getDoc(docId)?.materialKind);
      const fullInput = `${systemText}\n\n${docCtx.text}\n\n--- CONVERSATION SO FAR ---\n${renderHistory(
        messagesForPrompt,
      )}\n\n--- ASSISTANT REPLY ---\nReply now as ASSISTANT. Output JSON.`;
      const { data, threadId } = await runJsonInThread<ChatReplyResult>({
        outputSchema: chatReplySchema,
        opts: { reasoning: "low" },
        start: { input: fullInput },
      });
      reply = data;
      codexThreadId = threadId;
      threadProvider = activeProvider;
    }

    // Codex succeeded — commit the user turn and the reply atomically.
    const reloaded = loadWorkContext(docId);
    const liveChat = reloaded.chats.find((c) => c.id === chat.id);
    if (!liveChat) return NextResponse.json({ error: "chat vanished" }, { status: 500 });
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: reply.reply,
      ts: Date.now(),
    };
    // First user message becomes the chat title if still unnamed.
    if (liveChat.title === "New chat" && liveChat.messages.length === 0) {
      liveChat.title = message.slice(0, 60);
    }
    liveChat.messages.push(userMsg, assistantMsg);
    liveChat.updatedAt = assistantMsg.ts;
    if (codexThreadId) {
      liveChat.codexThreadId = codexThreadId;
      liveChat.threadProvider = threadProvider ?? activeProvider;
    } else {
      // No native thread this turn (e.g. Gemini) — drop any stale id so the
      // next turn rebuilds full context instead of resuming a dead thread.
      liveChat.codexThreadId = undefined;
      liveChat.threadProvider = undefined;
    }
    saveWorkContext(reloaded);

    // NB: the knowledge-graph evaluation is intentionally NOT scheduled here.
    // The client triggers a single pass when the student leaves the Chat tab
    // (see viewer-client), so a multi-message, multi-thread chat session costs
    // exactly one evaluation instead of one per reply.

    return NextResponse.json({
      chat: liveChat,
      reply: assistantMsg,
    });
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
  const chatId = url.searchParams.get("chatId");
  if (!chatId) return NextResponse.json({ error: "chatId required" }, { status: 400 });
  const wc = loadWorkContext(docId);
  wc.chats = wc.chats.filter((c) => c.id !== chatId);
  saveWorkContext(wc);
  return NextResponse.json({ ok: true });
}
