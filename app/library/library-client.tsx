"use client";

/**
 * Library page.
 *
 * Lists every PDF the user has ever opened in this installation. Each row
 * shows filename, page count, last-activity time, the knowledge-graph
 * status, and how many evaluator passes have run. Clicking a row jumps
 * back into the viewer with all state restored (tags + workctx + KG are
 * already on disk thanks to lib/paths.ts).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AccountButton from "@/components/AccountButton";
import SettingsButton from "@/components/SettingsButton";
import TooltipChip from "@/components/TooltipChip";
import {
  BookOpen,
  FileText,
  Loader2,
  Network,
  RefreshCw,
  Tag as TagIcon,
  Trash2,
  Upload,
} from "lucide-react";

type LibraryRow = {
  id: string;
  filename: string;
  uploadedAt: number;
  numPages: number;
  lastActivityAt: number;
  kgStatus: "missing" | "building" | "ready" | "error";
  kgEvaluationCount: number;
  tagsAnalyzedPages: number | null;
  tagsTotal: number | null;
  tagsReady: number | null;
};

const FILENAME_TO_TITLE: Record<string, string> = {
  "anatomy.pdf": "Anatomy & Physiology",
  "physics.pdf": "Classical Mechanics",
  "costituzione.pdf": "Costituzione Italiana",
  "calculus.pdf": "Differential & Integral Calculus",
  "chemistry.pdf": "Organic Chemistry",
};

function titleOf(filename: string): string {
  return FILENAME_TO_TITLE[filename] ?? filename.replace(/\.(pdf|epub|md|markdown|mdown|mkd|mdwn)$/i, "");
}

function humaniseAgo(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 5_000) return "just now";
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  if (dt < 7 * 86_400_000) return `${Math.round(dt / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function LibraryClient() {
  const [rows, setRows] = useState<LibraryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/library", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { docs: LibraryRow[] };
      setRows(j.docs);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-poll while at least one doc has background work in progress:
  // tag detection still running (analyzedPages < numPages), or the KG
  // still building, or some tags still generating. Same source as the
  // viewer's TagsChip — keeps the badges live across multiple PDFs at
  // once. Slows to idle cadence when everything is settled.
  const anyDocWorking = useMemo(() => {
    if (!rows) return false;
    return rows.some((d) => {
      if (d.kgStatus === "building") return true;
      if (
        d.tagsAnalyzedPages != null &&
        d.tagsAnalyzedPages < d.numPages
      ) return true;
      if (
        d.tagsTotal != null &&
        d.tagsReady != null &&
        d.tagsReady < d.tagsTotal
      ) return true;
      return false;
    });
  }, [rows]);
  useEffect(() => {
    if (!rows) return;
    const interval = anyDocWorking ? 2000 : 8000;
    const id = setInterval(reload, interval);
    return () => clearInterval(id);
  }, [reload, anyDocWorking, rows]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Remove this document from your library? This deletes the PDF, work context, and knowledge graph for it.")) {
        return;
      }
      setDeleting(id);
      try {
        const r = await fetch(`/api/library?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await reload();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setDeleting(null);
      }
    },
    [reload],
  );

  const empty = rows != null && rows.length === 0;

  return (
    <main className="flex flex-1 min-h-0 flex-col bg-[var(--surface-canvas)] text-[var(--ink-900)]">
      {/* Top tab bar */}
      <div className="tab-bar tab-bar--fused">
        <TooltipChip tip="Open or drop a new PDF.">
          <Link href="/" aria-label="Go to upload" className="tab-item">
            <Upload className="h-3.5 w-3.5 text-[var(--ink-400)]" />
            <span>Upload</span>
          </Link>
        </TooltipChip>
        <div className="tab-item" data-active="true">
          <BookOpen className="h-3.5 w-3.5 text-[var(--accent-600)]" />
          <span>Library</span>
        </div>
        <div className="ml-auto flex items-center gap-1 pr-1">
          <TooltipChip tip="Refresh the library list.">
            <button
              type="button"
              onClick={reload}
              aria-label="Refresh library"
              className="tab-icon-btn"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </TooltipChip>
          <SettingsButton />
          <AccountButton />
        </div>
      </div>

      {/* Content */}
      <div className="relative flex-1 overflow-y-auto overflow-x-hidden bg-[var(--surface-raised)]">
        <div className="mx-auto w-full max-w-4xl px-10 py-12">
          <h1 className="text-[34px] font-bold leading-[1.1] tracking-tight text-[var(--ink-900)]">
            Your library
          </h1>
          <p className="mt-3 max-w-2xl text-[14px] leading-[1.65] text-[var(--ink-700)]">
            Every PDF you&apos;ve opened lives here. Click any row to jump back
            in — your tags, chats, flashcards, quizzes, Feynman sessions and
            knowledge graph are all still there.
          </p>

          {error && (
            <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
              Could not load library: {error}
            </div>
          )}

          {rows == null && !error && (
            <div className="mt-10 flex items-center gap-2 text-[var(--ink-500)]">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-600)]" />
              loading…
            </div>
          )}

          {empty && (
            <div className="mt-10 rounded-2xl border border-dashed border-[var(--accent-100)] bg-[var(--accent-50)]/40 px-6 py-12 text-center">
              <FileText className="mx-auto h-10 w-10 text-[var(--ink-300)]" />
              <p className="mt-3 text-[14px] font-medium text-[var(--ink-900)]">
                Nothing here yet
              </p>
              <p className="mt-1 text-[12.5px] text-[var(--ink-500)]">
                Drop a PDF or pick a sample on the upload page to get started.
              </p>
              <Link
                href="/"
                className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-600)] px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-[var(--accent-700)]"
              >
                <Upload className="h-3.5 w-3.5" />
                Go to upload
              </Link>
            </div>
          )}

          {rows && rows.length > 0 && (
            <ul className="mt-8 space-y-2">
              {rows.map((d) => (
                <LibraryRowItem
                  key={d.id}
                  row={d}
                  deleting={deleting === d.id}
                  onDelete={() => handleDelete(d.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

function LibraryRowItem({
  row,
  deleting,
  onDelete,
}: {
  row: LibraryRow;
  deleting: boolean;
  onDelete: () => void;
}) {
  const title = useMemo(() => titleOf(row.filename), [row.filename]);
  return (
    <li className="group relative flex items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 transition hover:border-[var(--border-strong)]">
      <Link
        href={`/viewer/${row.id}`}
        className="flex flex-1 items-center gap-4"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-sunken)] text-[var(--ink-500)]">
          <FileText className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-[var(--ink-900)]">
            {title}
          </p>
          <p className="mt-0.5 truncate text-[11.5px] text-[var(--ink-500)]">
            {row.filename} · {row.numPages} page{row.numPages === 1 ? "" : "s"} · last opened {humaniseAgo(row.lastActivityAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <TagsBadge
            analyzedPages={row.tagsAnalyzedPages}
            numPages={row.numPages}
            tagsReady={row.tagsReady}
            tagsTotal={row.tagsTotal}
          />
          <KGBadge status={row.kgStatus} evals={row.kgEvaluationCount} />
        </div>
      </Link>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete();
        }}
        disabled={deleting}
        title="Remove from library"
        className="ml-1 shrink-0 rounded-md p-1.5 text-[var(--ink-400)] opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 disabled:opacity-50"
      >
        {deleting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </button>
    </li>
  );
}

/**
 * Two-phase tag-progress pill, mirroring the viewer's top-bar TagsChip.
 *
 *   • Doc never opened in the viewer (tagsTotal == null) → "no tags yet"
 *     in neutral grey.
 *   • Detection still running (analyzedPages < numPages) → "N/total
 *     pages" in neutral grey with a spinner.
 *   • Detection done → "N/total viz" in emerald when every tag has
 *     a ready visualization, otherwise neutral grey.
 *
 * Same compact pill style as KGBadge so the two read as a pair.
 */
function TagsBadge({
  analyzedPages,
  numPages,
  tagsReady,
  tagsTotal,
}: {
  analyzedPages: number | null;
  numPages: number;
  tagsReady: number | null;
  tagsTotal: number | null;
}) {
  if (analyzedPages == null || tagsTotal == null || tagsReady == null) {
    return (
      <span
        title="Open this PDF to start tagging concepts"
        className="hidden shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1 text-[10.5px] text-[var(--ink-500)] sm:inline-flex"
      >
        <TagIcon className="h-3 w-3" />
        no tags yet
      </span>
    );
  }
  const detectionDone = analyzedPages >= numPages && numPages > 0;
  if (!detectionDone) {
    return (
      <span
        title={`Tag detection in progress — ${analyzedPages} of ${numPages} pages scanned`}
        className="hidden shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1 text-[10.5px] text-[var(--ink-500)] sm:inline-flex"
      >
        <Loader2 className="h-3 w-3 animate-spin text-[var(--accent-600)]" />
        {analyzedPages}/{numPages} pages
      </span>
    );
  }
  const allReady = tagsTotal > 0 && tagsReady >= tagsTotal;
  return (
    <span
      title={`${tagsReady} of ${tagsTotal} visualizations ready`}
      className={
        allReady
          ? "hidden shrink-0 items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10.5px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300 sm:inline-flex"
          : "hidden shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1 text-[10.5px] text-[var(--ink-500)] sm:inline-flex"
      }
    >
      <TagIcon className="h-3 w-3" />
      {tagsReady}/{tagsTotal} viz
    </span>
  );
}

function KGBadge({
  status,
  evals,
}: {
  status: LibraryRow["kgStatus"];
  evals: number;
}) {
  if (status === "missing") {
    return (
      <span
        title="Knowledge graph will build on first open"
        className="hidden shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1 text-[10.5px] text-[var(--ink-500)] sm:inline-flex"
      >
        <Network className="h-3 w-3" />
        pending
      </span>
    );
  }
  if (status === "building") {
    return (
      <span
        title="Knowledge graph is being built"
        className="hidden shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1 text-[10.5px] text-[var(--ink-500)] sm:inline-flex"
      >
        <Loader2 className="h-3 w-3 animate-spin text-[var(--accent-600)]" />
        building
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        title="Knowledge graph build errored"
        className="hidden shrink-0 items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[10.5px] text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300 sm:inline-flex"
      >
        <Network className="h-3 w-3" />
        error
      </span>
    );
  }
  // ready
  return (
    <span
      title={`${evals} evaluation${evals === 1 ? "" : "s"} so far`}
      className="hidden shrink-0 items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10.5px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300 sm:inline-flex"
    >
      <Network className="h-3 w-3" />
      {evals === 0 ? "graph ready" : `${evals} eval${evals === 1 ? "" : "s"}`}
    </span>
  );
}
