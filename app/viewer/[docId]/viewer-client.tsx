"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  FileText,
  RefreshCw,
  AlertCircle,
  MousePointerClick,
  Upload,
  BookOpen,
  Tag as TagIcon,
  Network,
  Copy,
} from "lucide-react";

import PdfViewer, { type Tag } from "@/components/PdfViewer";
import RightPane, { type RightPaneMode } from "@/components/RightPane";
import AccountButton from "@/components/AccountButton";
import SettingsButton, { SETTINGS_EVENT } from "@/components/SettingsButton";
import TooltipChip from "@/components/TooltipChip";
import type { DetectedConcept, VizSpec } from "@/lib/schemas";
import { AUTO_GENERATE_VIZ, MAX_VIZ_GEN_RETRIES } from "@/lib/config";
import { PROVIDER_LABELS, type ProviderName } from "@/lib/provider-types";

type DocMeta = {
  docId: string;
  filename: string;
  pdfUrl: string;
  numPages: number;
  pages: Array<{ pageIndex: number; width: number; height: number; text: string }>;
};

type TagState = Tag & {
  concept: DetectedConcept;
  spec?: VizSpec;
  error?: string;
  attempts?: number;
  lastRuntimeError?: string;
};

type TagsApiResponse = {
  file: {
    v: 1;
    docId: string;
    savedAt: number;
    tags: TagState[];
    activeTagId: string | null;
    pagesAnalyzed: number[];
  } | null;
  detectionRunning: boolean;
  vizQueueRunning: boolean;
  detectionError?: string;
  numPages: number;
};

const FILENAME_TO_TITLE: Record<string, string> = {
  "anatomy.pdf": "Anatomy & Physiology",
  "physics.pdf": "Classical Mechanics",
  "costituzione.pdf": "Costituzione Italiana",
  "calculus.pdf": "Differential & Integral Calculus",
  "chemistry.pdf": "Organic Chemistry",
};

const POLL_FAST_MS = 1500;
const POLL_IDLE_MS = 5000;

export default function ViewerClient({ docId }: { docId: string }) {
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Server-owned state — refreshed by polling /api/tags/<docId>. The
  // viewer is a *consumer*: it reads, never authoritatively mutates,
  // except for `activeTagId` (which is purely a UI selection).
  const [tags, setTags] = useState<TagState[]>([]);
  const [pagesAnalyzed, setPagesAnalyzed] = useState<Set<number>>(new Set());
  const [detectionRunning, setDetectionRunning] = useState(false);
  const [vizQueueRunning, setVizQueueRunning] = useState(false);
  const [detectionError, setDetectionError] = useState<string | undefined>();

  const [activeTagId, setActiveTagId] = useState<string | null>(null);

  // Settings (auto-generate, max repair attempts) — start from env-baked
  // defaults, hydrate from /api/settings, react to `getit:settings`
  // CustomEvents the SettingsButton fires.
  const [autoGenerate, setAutoGenerate] = useState<boolean>(AUTO_GENERATE_VIZ);
  const [maxRetries, setMaxRetries] = useState<number>(MAX_VIZ_GEN_RETRIES);
  const [provider, setProvider] = useState<ProviderName>("codex");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: { autoGenerate: boolean; maxRetries: number; provider?: ProviderName }) => {
        if (cancelled) return;
        if (typeof s.autoGenerate === "boolean") setAutoGenerate(s.autoGenerate);
        if (typeof s.maxRetries === "number") setMaxRetries(s.maxRetries);
        if (s.provider === "codex" || s.provider === "gemini" || s.provider === "claude" || s.provider === "pi")
          setProvider(s.provider);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { autoGenerate?: boolean; maxRetries?: number; provider?: ProviderName; theme?: string }
        | undefined;
      if (!detail) return;
      if (typeof detail.autoGenerate === "boolean") setAutoGenerate(detail.autoGenerate);
      if (typeof detail.maxRetries === "number") setMaxRetries(detail.maxRetries);
      if (detail.provider === "codex" || detail.provider === "gemini" || detail.provider === "claude" || detail.provider === "pi")
        setProvider(detail.provider);
    };
    window.addEventListener(SETTINGS_EVENT, onChange);
    return () => window.removeEventListener(SETTINGS_EVENT, onChange);
  }, []);

  // Right-pane mode (Visualizer / KG / Chat / Flashcards / Feynman) —
  // tab-scoped, sessionStorage backed so a reload restores it.
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>(() => {
    if (typeof window === "undefined") return "visualizer";
    const v = window.sessionStorage.getItem(`getit:${docId}:right-mode`);
    if (
      v === "visualizer" ||
      v === "graph" ||
      v === "chat" ||
      v === "flashcards" ||
      v === "feynman"
    ) {
      return v;
    }
    return "visualizer";
  });
  useEffect(() => {
    try {
      window.sessionStorage.setItem(`getit:${docId}:right-mode`, rightPaneMode);
    } catch {
      /* noop */
    }
  }, [docId, rightPaneMode]);

  // ── Chat → knowledge-graph evaluation, batched per visit ──────────────
  //
  // The Chat tool no longer triggers an evaluation after every reply. Instead
  // the student can chat freely — many messages, many threads — and we run a
  // SINGLE evaluation pass when they leave the Chat tab (or close the doc),
  // and only if they actually sent something while there. ChatView fires a
  // `getit:chat-sent` event on each successful send; we just track whether one
  // happened since we entered Chat.
  const chatDirtyRef = useRef(false);
  useEffect(() => {
    const onChatSent = (e: Event) => {
      const detail = (e as CustomEvent).detail as { docId?: string } | undefined;
      if (!detail || detail.docId === docId) chatDirtyRef.current = true;
    };
    window.addEventListener("getit:chat-sent", onChatSent);
    return () => window.removeEventListener("getit:chat-sent", onChatSent);
  }, [docId]);

  const flushChatEval = useCallback(
    (useKeepalive = false) => {
      if (!chatDirtyRef.current) return;
      chatDirtyRef.current = false;
      void fetch(`/api/kg/${docId}/evaluate`, {
        method: "POST",
        keepalive: useKeepalive,
      }).catch(() => {});
    },
    [docId],
  );

  // Fire when the student switches AWAY from the Chat tab.
  const prevModeRef = useRef<RightPaneMode>(rightPaneMode);
  useEffect(() => {
    if (prevModeRef.current === "chat" && rightPaneMode !== "chat") {
      flushChatEval();
    }
    prevModeRef.current = rightPaneMode;
  }, [rightPaneMode, flushChatEval]);

  // Fire on unmount too (navigating to Upload/Library, closing the doc) so a
  // chat-and-leave still scores. keepalive lets the request outlive the page.
  useEffect(() => {
    return () => flushChatEval(true);
  }, [flushChatEval]);

  // ── Bootstrap: doc meta + bump lastOpenedAt + kick KG build + start
  //    detection job + start polling. All idempotent server-side.
  useEffect(() => {
    let cancelled = false;
    // Doc meta — without it the PdfViewer can't render.
    fetch(`/api/doc/${docId}`)
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(
            r.status === 404
              ? "This document is no longer in memory. Please re-upload from the home page."
              : `Could not load document (HTTP ${r.status})`,
          );
        }
        return (await r.json()) as DocMeta;
      })
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as Error).message);
      });
    // Touch (so library's "last opened" reflects this open).
    void fetch(`/api/doc/${docId}/touch`, { method: "POST" }).catch(() => {});
    // Kick the KG build (idempotent — server skips if ready).
    void fetch(`/api/kg/${docId}/build`, { method: "POST" }).catch(() => {});
    // Kick the detection job (idempotent — server skips if running or done).
    void fetch(`/api/jobs/detect/${docId}`, { method: "POST" }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // ── Polling loop ─────────────────────────────────────────────────────
  //
  // Single source of truth: GET /api/tags/<docId>. Updates `tags`,
  // `pagesAnalyzed`, and the two job-running flags. Cadence speeds up
  // while any background work is in progress and slows down when idle
  // so a doc that's fully prepared doesn't poll itself in the foot.
  const lastSavedAtRef = useRef<number>(0);
  const anyWorkInFlight = detectionRunning || vizQueueRunning;
  useEffect(() => {
    let cancelled = false;
    const pollOnce = async () => {
      try {
        const r = await fetch(`/api/tags/${docId}`, { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as TagsApiResponse;
        if (cancelled) return;
        setDetectionRunning(data.detectionRunning);
        setVizQueueRunning(data.vizQueueRunning);
        setDetectionError(data.detectionError);
        const file = data.file;
        if (!file) {
          // Tags file doesn't exist yet — leave local state empty.
          return;
        }
        // Skip re-renders if savedAt hasn't moved (no real change).
        if (file.savedAt === lastSavedAtRef.current) return;
        lastSavedAtRef.current = file.savedAt;
        setTags(file.tags as TagState[]);
        setPagesAnalyzed(new Set(file.pagesAnalyzed));
        // Only honor the server's active tag if the user hasn't picked
        // one locally yet — otherwise the server's stale value would
        // override a fresh click.
        setActiveTagId((cur) => cur ?? file.activeTagId);
      } catch {
        /* network blip — try again next tick */
      }
    };
    pollOnce();
    const id = setInterval(
      pollOnce,
      anyWorkInFlight ? POLL_FAST_MS : POLL_IDLE_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [docId, anyWorkInFlight]);

  // Persist activeTagId to the server (it's the one piece of state the
  // viewer still owns end-to-end). Debounced so a quick browse doesn't
  // hammer the API.
  useEffect(() => {
    const handle = setTimeout(() => {
      void fetch(`/api/tags/${docId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ activeTagId }),
        keepalive: true,
      }).catch(() => {});
    }, 250);
    return () => clearTimeout(handle);
  }, [docId, activeTagId]);

  const docTitle = useMemo(
    () =>
      meta && (FILENAME_TO_TITLE[meta.filename] || meta.filename.replace(/\.(pdf|epub|md|markdown|mdown|mkd|mdwn)$/i, "")),
    [meta],
  );

  // Auto-select the first ready tag when nothing is selected yet.
  useEffect(() => {
    if (activeTagId) return;
    const firstReady = tags.find((t) => t.ready);
    if (firstReady) setActiveTagId(firstReady.id);
  }, [tags, activeTagId]);

  // Clicking a tag: select it + ask the server-side viz queue to
  // generate the spec if we don't have one yet. The server flips
  // `generating: true` immediately, the next poll picks it up.
  const handleTagClick = useCallback(
    (id: string) => {
      setActiveTagId(id);
      // Bring the Visualizer forward no matter which tool is open, so the
      // clicked concept renders (or starts rendering) where the user can see
      // it. Switching mode also runs the normal tab-change side effects —
      // e.g. leaving Chat flushes a knowledge-graph evaluation (see the
      // rightPaneMode effect above) — so it stays fully coherent.
      setRightPaneMode("visualizer");
      const tag = tags.find((t) => t.id === id);
      if (!tag) return;
      if (tag.generating) return; // already in flight — don't double-queue
      if (tag.spec && !tag.error) return; // already rendered — selecting is enough
      // Idle OR previously failed → (re)generate. Clearing any error optimistically
      // marks it generating so the spinner shows at once; this is also the manual
      // retry path after a backend Codex error left the tag idle/errored.
      setTags((prev) =>
        prev.map((t) => (t.id === id ? { ...t, generating: true, error: undefined } : t)),
      );
      void fetch(`/api/jobs/viz/${docId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagId: id }),
      }).catch(() => {});
    },
    [docId, tags],
  );

  // Visualizer reported a runtime error → single-attempt policy: surface the
  // error so the user can refresh the graph manually (no auto-repair retry).
  const handleRuntimeError = useCallback(
    (tagId: string, message: string) => {
      // Optimistic flip so the failure is shown immediately.
      setTags((prev) =>
        prev.map((t) =>
          t.id === tagId
            ? {
                ...t,
                ready: false,
                generating: false,
                error: message,
                lastRuntimeError: message,
              }
            : t,
        ),
      );
      void fetch(`/api/jobs/viz/${docId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagId, runtimeError: message }),
      }).catch(() => {});
    },
    [docId],
  );

  // User asked to regenerate the active visualization from scratch (it looks
  // wrong, stopped animating, etc.). Unlike handleTagClick, this re-queues even
  // when a valid spec already exists. We drop the cached spec optimistically so
  // the spinner shows at once; the server treats it as a fresh generation (no
  // lastRuntimeError ⇒ no repair context) with the current prompt.
  const handleRegenerateTag = useCallback(
    (tagId: string) => {
      setTags((prev) =>
        prev.map((t) =>
          t.id === tagId
            ? { ...t, spec: undefined, ready: false, generating: true, error: undefined, lastRuntimeError: undefined }
            : t,
        ),
      );
      void fetch(`/api/jobs/viz/${docId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagId }),
      }).catch(() => {});
    },
    [docId],
  );

  // User asked to retry a single failed graph → clear the terminal error
  // and re-queue just that tag.
  const handleRetryTag = useCallback(
    (tagId: string) => {
      setTags((prev) =>
        prev.map((t) =>
          t.id === tagId
            ? { ...t, ready: false, generating: true, error: undefined }
            : t,
        ),
      );
      void fetch(`/api/jobs/viz/${docId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagId }),
      }).catch(() => {});
    },
    [docId],
  );

  // User asked to retry every failed graph at once → re-queue only the
  // tags currently in an error state, leaving working ones untouched.
  const handleRetryFailed = useCallback(() => {
    setTags((prev) =>
      prev.map((t) =>
        t.error
          ? { ...t, ready: false, generating: true, error: undefined }
          : t,
      ),
    );
    void fetch(`/api/jobs/viz/${docId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retryFailed: true }),
    }).catch(() => {});
  }, [docId]);

  // When auto-generate flips off → on mid-session, ask the server to
  // queue every still-idle tag so the right pane fills in without the
  // user clicking each one. The server-side detection job already
  // does this for *new* tags it discovers; this catches tags that were
  // detected before the toggle.
  const prevAutoRef = useRef(autoGenerate);
  useEffect(() => {
    if (!prevAutoRef.current && autoGenerate) {
      const idle = tags.filter(
        (t) => !t.spec && !t.error && !t.generating,
      );
      for (const t of idle) {
        void fetch(`/api/jobs/viz/${docId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tagId: t.id }),
        }).catch(() => {});
      }
    }
    prevAutoRef.current = autoGenerate;
    // tags intentionally excluded — we only want to fire on the toggle
    // transition itself, not every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerate, docId]);

  if (loadError) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 bg-[var(--surface-canvas)] text-[var(--ink-900)]">
        <AlertCircle className="h-7 w-7 text-rose-500" />
        <p className="text-sm text-[var(--ink-700)]">{loadError}</p>
        <Link
          href="/"
          className="rounded-full bg-[var(--button-primary-bg)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--button-primary-hover)]"
        >
          Back to upload
        </Link>
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center bg-[var(--surface-canvas)] text-[var(--ink-500)]">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin text-[var(--accent-600)]" />
        loading document…
      </div>
    );
  }

  const totalPages = meta.numPages;
  const doneCount = pagesAnalyzed.size;
  const tagReadyCount = tags.filter((t) => t.ready).length;
  const tagGeneratingCount = tags.filter((t) => t.generating).length;
  const detecting = detectionRunning && doneCount < totalPages;

  const activeTag = tags.find((t) => t.id === activeTagId) ?? null;
  const activeSpec = activeTag?.spec ?? null;

  const truncated =
    docTitle && docTitle.length > 28
      ? `${docTitle.slice(0, 28)}…`
      : docTitle ?? meta.filename;

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--surface-canvas)]">
      {/* Top tab bar — Upload + Library pinned on the left, then the
          open-document tab (acts as the active "window"). Clicking
          Upload or Library navigates away, closing this doc tab. */}
      <div className="tab-bar tab-bar--fused shrink-0">
        <TooltipChip tip="Upload a new PDF.">
          <Link href="/" aria-label="Upload" className="tab-item">
            <Upload className="h-3.5 w-3.5 text-[var(--ink-400)]" />
            <span>Upload</span>
          </Link>
        </TooltipChip>
        <TooltipChip tip="Your library of opened PDFs.">
          <Link href="/library" aria-label="Open library" className="tab-item">
            <BookOpen className="h-3.5 w-3.5 text-[var(--ink-400)]" />
            <span>Library</span>
          </Link>
        </TooltipChip>
        <div className="tab-item" data-active="true">
          <FileText className="h-3.5 w-3.5 text-[var(--accent-600)]" />
          <span className="max-w-[180px] truncate">{truncated}</span>
          {!autoGenerate && (
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
              <MousePointerClick className="h-2.5 w-2.5" /> manual
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2 pr-1">
          <KGStatusBadge docId={docId} />
          <TagsChip
            pagesDone={doneCount}
            pagesTotal={totalPages}
            detecting={detecting}
            tagsReady={tagReadyCount}
            tagsTotal={tags.length}
            generating={tagGeneratingCount > 0}
            error={detectionError}
          />
          <SettingsButton />
          <AccountButton />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-2 bg-[var(--surface-canvas)] p-2">
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
          <PdfViewer
            pdfUrl={meta.pdfUrl}
            numPages={meta.numPages}
            pageDims={meta.pages.map((p) => ({ width: p.width, height: p.height }))}
            tags={tags}
            activeTagId={activeTagId}
            onTagClick={handleTagClick}
            detecting={detecting}
            providerLabel={PROVIDER_LABELS[provider]}
          />
        </div>
        <div className="flex w-[44%] min-w-[420px] max-w-[720px] flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
          <RightPane
            docId={docId}
            mode={rightPaneMode}
            onModeChange={setRightPaneMode}
            providerLabel={PROVIDER_LABELS[provider]}
            visualizer={{
              spec: activeTag?.generating || activeTag?.error ? null : activeSpec,
              loading:
                activeTag != null &&
                !activeTag.error &&
                (activeTag.generating || !activeTag.spec),
              loadingDetail:
                activeTag?.generating && (activeTag.attempts ?? 0) >= 1
                  ? `repairing — attempt ${(activeTag.attempts ?? 0) + 1} of ${maxRetries + 1}`
                  : undefined,
              onRuntimeError: activeTag
                ? (msg) => handleRuntimeError(activeTag.id, msg)
                : undefined,
              emptyHint: activeTag?.error
                ? "We weren't able to build a working visualization for this concept. Retry below, or pick another tag — most of them work cleanly."
                : tags.length === 0
                  ? `${PROVIDER_LABELS[provider]} is reading the document — tags will appear inline as soon as they're detected.`
                  : autoGenerate
                    ? "Click any colored tag in the document to render its concept here."
                    : "Click any tag to generate its visualization. (manual mode — toggle auto-generate in settings)",
              activeTagError: activeTag?.error ?? null,
              onRetry: activeTag ? () => handleTagClick(activeTag.id) : undefined,
              onRegenerate:
                activeTag && activeTag.spec && !activeTag.generating
                  ? () => handleRegenerateTag(activeTag.id)
                  : undefined,
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Visualization agent status pill.
 *
 * Two phases:
 *   • Detection in progress — `pagesDone < pagesTotal`. We show the
 *     page-scan progress (`N/total pages`).
 *   • Detection done — switch to `N/total viz ready`.
 */
function TagsChip({
  pagesDone,
  pagesTotal,
  detecting,
  tagsReady,
  tagsTotal,
  generating,
  error,
}: {
  pagesDone: number;
  pagesTotal: number;
  detecting: boolean;
  tagsReady: number;
  tagsTotal: number;
  generating: boolean;
  error?: string;
}) {
  const detectionDone = pagesTotal > 0 && pagesDone >= pagesTotal;
  const spinning = detectionDone ? generating : detecting;
  const tip = error 
    ? `Detection error: ${error}`
    : detectionDone
      ? "Visualization agent — concept detection done; each tag spins up a per-concept renderer (3D, animation, formula, graph, source)."
      : "Visualization agent — scanning each page for the concepts worth tagging.";
  return (
    <span className="viz-tooltip-anchor relative inline-flex">
      <div className={`flex items-center gap-1.5 rounded-md border bg-[var(--surface-raised)] px-2 py-1 text-[11px] ${error ? "border-rose-300" : "border-[var(--border-subtle)]"}`}>
        {spinning ? (
          <RefreshCw className="h-3 w-3 animate-spin text-[var(--accent-600)]" />
        ) : error ? (
          <AlertCircle className="h-3 w-3 text-rose-500" />
        ) : (
          <TagIcon className="h-3 w-3 text-[var(--ink-400)]" />
        )}
        {!detectionDone && !error ? (
          <>
            <span className="tabular-nums font-medium text-[var(--ink-900)]">
              {pagesDone}
              <span className="font-normal text-[var(--ink-400)]">/{pagesTotal}</span>
            </span>
            <span className="text-[var(--ink-500)]">pages</span>
          </>
        ) : error ? (
          <span className="font-medium text-rose-700 dark:text-rose-300">Failed</span>
        ) : (
          <>
            <span className="tabular-nums font-medium text-[var(--ink-900)]">
              {tagsReady}
              <span className="font-normal text-[var(--ink-400)]">/{tagsTotal}</span>
            </span>
            <span className="text-[var(--ink-500)]">viz ready</span>
          </>
        )}
      </div>
      <span className="viz-tooltip" role="tooltip">
        {tip}
      </span>
    </span>
  );
}

/** Compact status badge for the knowledge-graph evaluator agent. */
function KGStatusBadge({ docId }: { docId: string }) {
  const [state, setState] = useState<{
    status: "missing" | "building" | "ready" | "error";
    evaluating: boolean;
    evaluationCount: number;
    lastEvaluatedAt: number | null;
    buildError?: string;
  } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch(`/api/kg/${docId}/state`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as {
          status: "missing" | "building" | "ready" | "error";
          evaluating?: boolean;
          evaluationCount: number;
          lastEvaluatedAt: number | null;
          buildError?: string;
        };
        if (cancelled) return;
        setState({
          status: j.status,
          evaluating: !!j.evaluating,
          evaluationCount: j.evaluationCount,
          lastEvaluatedAt: j.lastEvaluatedAt,
          buildError: j.buildError,
        });
      } catch {
        /* ignore */
      }
    };
    fetchOnce();
    const id = setInterval(
      fetchOnce,
      state && (state.status === "building" || state.evaluating) ? 2500 : 6000,
    );
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, state?.status, state?.evaluating]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!state) return null;

  let icon: React.ReactNode;
  let label: string;
  let tone = "text-[var(--ink-500)]";
  let valueTone = "text-[var(--ink-900)]";
  let title = "";

  if (state.status === "building") {
    icon = <RefreshCw className="h-3 w-3 animate-spin text-[var(--accent-600)]" />;
    label = "Building graph";
    title = "Knowledge-graph agent is extracting concepts from the document";
  } else if (state.status === "error") {
    icon = <AlertCircle className="h-3 w-3 text-rose-500" />;
    label = "Graph error";
    valueTone = "text-rose-700 dark:text-rose-300";
    title = state.buildError ?? "Graph build failed";
  } else if (state.evaluating) {
    icon = <RefreshCw className="h-3 w-3 animate-spin text-[var(--accent-600)]" />;
    label = "Evaluating";
    title = "Evaluator is re-scoring concepts based on your latest interaction";
  } else if (state.status === "ready" && state.evaluationCount === 0) {
    icon = <Network className="h-3 w-3 text-[var(--ink-400)]" />;
    label = "No evaluations yet";
    tone = "text-[var(--ink-500)]";
    title = "Interact with chat / flashcards / quizzes / feynman to start the evaluator";
  } else if (state.status === "ready" && state.lastEvaluatedAt) {
    icon = <Network className="h-3 w-3 text-emerald-600" />;
    label = `Synced ${humaniseAgo(state.lastEvaluatedAt)}`;
    title = `${state.evaluationCount} evaluation${state.evaluationCount === 1 ? "" : "s"} so far`;
  } else {
    icon = <Network className="h-3 w-3 text-[var(--ink-400)]" />;
    label = "Graph pending";
    title = "Waiting to build the knowledge graph";
  }

  return (
    <span className="viz-tooltip-anchor relative inline-flex">
      <div className="flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1 text-[11px]">
        {icon}
        <span className={`font-medium ${valueTone}`}>{label.split(" ")[0]}</span>
        <span className={tone}>{label.split(" ").slice(1).join(" ")}</span>
      </div>
      <span className="viz-tooltip" role="tooltip">
        <div className="flex items-start justify-between gap-2">
          <span>
            Knowledge-graph agent —{" "}
            {title ||
              "tracks per-concept mastery from your chats, flashcards, quizzes and Feynman sessions."}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const textToCopy = state.status === "error" && state.buildError
                ? state.buildError
                : `Knowledge-graph agent - ${
                    title || "tracks per-concept mastery from your chats, flashcards, quizzes and Feynman sessions."
                  }`;
              navigator.clipboard.writeText(textToCopy);
            }}
            className="p-1 hover:bg-gray-100 dark:hover:bg-[var(--surface-sunken)] rounded transition-colors text-[var(--ink-500)] hover:text-[var(--ink-900)] shrink-0"
            title="Copy message"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
      </span>
    </span>
  );
}

function humaniseAgo(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 5_000) return "just now";
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}
