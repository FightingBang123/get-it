/**
 * Server-side background jobs for a doc.
 *
 * Two job kinds, both keyed by docId, both idempotent (calling
 * `ensureDetection`/`ensureVizQueue` while the same doc's job is already
 * running is a no-op):
 *
 *   • Detection job — walks pages that aren't yet in
 *     `tags.json#pagesAnalyzed`, calls the concept-detection agent for
 *     each, locates anchors against the extracted pdf items, persists
 *     new tags incrementally. When `autoGenerate` is on (settings.json
 *     → autoGenerate), every new tag is marked `generating: true` so
 *     the viz queue picks it up automatically.
 *
 *   • Viz queue — processes every tag with `generating: true && !error`,
 *     producing the spec via the viz agent. Carries the retry budget
 *     (settings.maxRetries) and the runtime-error repair path that
 *     used to live in the viewer. After each call the result lands in
 *     tags.json before we move on, so a client that has lost the
 *     connection picks up the work on its next poll.
 *
 * Rate-limit recovery: every Codex error of kind="rate_limit" carries a
 * retryAt timestamp; on hit we set a timer to re-enter the job once the
 * window clears. Auth-lost errors don't auto-retry — the user gets the
 * top-bar banner and walks back through the wizard.
 *
 * Both job runners write to disk via tags-store's atomic
 * (write+rename) helper, so concurrent reads from the viewer poll and
 * the library poll never see torn JSON.
 */

import { CodexError } from "./codex";
import { detectConceptsForPages } from "./agents/detect";
import { generateVizSpec } from "./agents/viz";
import { locateAnchor } from "./pdf-extract";
import { loadSettings } from "./settings-store";
import { getDoc } from "./store";
import {
  loadTags,
  saveTags,
  type PersistedTagServer,
  type PersistedTagsFile,
} from "./tags-store";
import type { DetectedConcept, VizType } from "./schemas";

// Number of detection batches running concurrently. Each batch is one Codex
// call covering up to DETECTION_BATCH_PAGES pages, so up to
// CONCURRENCY * BATCH_PAGES pages are in flight at once — fast on long docs
// without a burst big enough to trip the usage window.
const DETECTION_CONCURRENCY = 3;
const DETECTION_BATCH_PAGES = 5;
/** Give up on a page after this many generic (non rate-limit) failures so a
 *  persistently bad page can never wedge the job in a retry loop. */
const MAX_DETECTION_ATTEMPTS = 2;
const VIZ_CONCURRENCY = 4;
const MIN_PAGE_TEXT_LEN = 120;

// ── small helpers ───────────────────────────────────────────────────────

function ensureTagsFile(docId: string): PersistedTagsFile {
  const f = loadTags(docId);
  if (f) return f;
  saveTags(docId, { tags: [], activeTagId: null, pagesAnalyzed: [] });
  return loadTags(docId)!;
}

function docTitleFromFilename(filename: string): string {
  const FILENAME_TO_TITLE: Record<string, string> = {
    "anatomy.pdf": "Anatomy & Physiology",
    "physics.pdf": "Classical Mechanics",
    "costituzione.pdf": "Costituzione Italiana",
    "calculus.pdf": "Differential & Integral Calculus",
    "chemistry.pdf": "Organic Chemistry",
  };
  return FILENAME_TO_TITLE[filename] ?? filename.replace(/\.(pdf|epub|md|markdown|mdown|mkd|mdwn)$/i, "");
}

function mergeTagsFile(
  docId: string,
  mutator: (file: PersistedTagsFile) => PersistedTagsFile,
): PersistedTagsFile {
  const before = ensureTagsFile(docId);
  const after = mutator(before);
  saveTags(docId, {
    tags: after.tags,
    activeTagId: after.activeTagId,
    pagesAnalyzed: after.pagesAnalyzed,
  });
  return loadTags(docId)!;
}

// ── Detection job ───────────────────────────────────────────────────────

const detectionInFlight = new Map<string, Promise<void>>();
const detectionErrors = new Map<string, string>();

export function isDetectionRunning(docId: string): boolean {
  return detectionInFlight.has(docId);
}

export function ensureDetection(docId: string): void {
  if (detectionInFlight.has(docId)) return;
  const p = runDetection(docId)
    .catch((e) =>
      console.warn("[jobs/detect]", docId, e instanceof Error ? e.message : e),
    )
    .finally(() => {
      detectionInFlight.delete(docId);
    });
  detectionInFlight.set(docId, p);
}

async function runDetection(docId: string) {
  const doc = getDoc(docId);
  if (!doc) return;
  ensureTagsFile(docId);
  const settings = loadSettings();
  const autoGenerate = settings.autoGenerate;

  const inFlightPages = new Set<number>();
  // Per-page generic-failure counter (a backend Codex error doesn't count). A
  // page that keeps failing is given up on (marked analyzed) once it hits the
  // cap so the job can never spin forever.
  const attempts = new Map<number, number>();
  // Any account-level Codex error (rate-limit / auth / binary / unsupported
  // model) stops detection immediately. We do NOT auto-retry: the health
  // banner explains why, and detection resumes on its own the next time the
  // doc is opened (the bootstrap re-kicks it and analyzed pages are skipped).
  let terminalCodexError: CodexError | null = null;

  // Grab the next batch of pages still needing a pass. Read fresh each tick so
  // a concurrent poll never blocks us from picking up the next pages. Pages
  // given up on are already in pagesAnalyzed, so they're naturally skipped.
  const pickNextBatch = (): number[] => {
    const file = loadTags(docId);
    const analyzed = new Set(file?.pagesAnalyzed ?? []);
    const batch: number[] = [];
    for (let i = 0; i < doc.extracted.numPages && batch.length < DETECTION_BATCH_PAGES; i++) {
      if (!analyzed.has(i) && !inFlightPages.has(i)) batch.push(i);
    }
    return batch;
  };

  await new Promise<void>((resolve) => {
    let active = 0;
    let done = false;

    const finish = () => {
      if (active === 0 && !done) {
        done = true;
        resolve();
      }
    };

    const pump = () => {
      while (active < DETECTION_CONCURRENCY) {
        if (terminalCodexError) {
          finish();
          return;
        }
        const batch = pickNextBatch();
        if (batch.length === 0) {
          finish();
          return;
        }
        for (const p of batch) inFlightPages.add(p);
        active++;
        analyzeBatch(docId, batch, autoGenerate)
          .catch((e) => {
            if (e instanceof CodexError && e.kind !== "generic") {
              // Account-level error (rate-limit / auth / binary / unsupported
              // model): stop the whole job. No auto-retry.
              terminalCodexError = e;
            } else {
              // Generic failure: count it against every page in the batch and
              // give up on those that hit the cap so we don't loop forever.
              const msg = e instanceof Error ? e.message : String(e);
              console.warn("[jobs/detect-batch]", docId, batch.join(","), msg);
              detectionErrors.set(docId, msg);
              for (const p of batch) {
                const n = (attempts.get(p) ?? 0) + 1;
                attempts.set(p, n);
                if (n >= MAX_DETECTION_ATTEMPTS) {
                  appendDetectionResult(docId, p, [], autoGenerate);
                }
              }
            }
          })
          .finally(() => {
            for (const p of batch) inFlightPages.delete(p);
            active--;
            if (terminalCodexError) {
              finish();
              return;
            }
            pump();
          });
      }
    };

    pump();
  });

  // Surface the terminal error so ensureDetection logs it; the health mailbox
  // already carries it for the banner. We never schedule an auto-retry.
  if (terminalCodexError) {
    throw terminalCodexError;
  }
}

/**
 * Detect concepts for one batch of pages in a single Codex call, then persist
 * each page's tags. Short pages skip the model entirely (still marked analyzed
 * so we never revisit them). On success every page in the batch is marked
 * analyzed — even those the agent returned nothing for — so detection always
 * makes forward progress. Throws on a Codex error so the runner can apply its
 * rate-limit / give-up policy.
 */
async function analyzeBatch(
  docId: string,
  pageIndices: number[],
  autoGenerate: boolean,
) {
  const doc = getDoc(docId);
  if (!doc) return;

  const rich: Array<{ pageIndex: number; text: string }> = [];
  for (const idx of pageIndices) {
    const page = doc.extracted.pages[idx];
    if (!page || page.text.length < MIN_PAGE_TEXT_LEN) {
      // Out of range or too short to be worth a model call — mark analyzed.
      appendDetectionResult(docId, idx, [], autoGenerate);
    } else {
      rich.push({ pageIndex: idx, text: page.text });
    }
  }
  if (rich.length === 0) return;

  const richSet = new Set(rich.map((r) => r.pageIndex));
  detectionErrors.delete(docId); // Reset prior errors on fresh run
  const result = await detectConceptsForPages(
    rich,
    undefined,
    getDoc(docId)?.materialKind,
  );

  // Route each concept back to its page; drop any the model mis-tagged with a
  // page outside this batch.
  const byPage = new Map<number, DetectedConcept[]>();
  for (const c of result.concepts) {
    if (!richSet.has(c.page)) continue;
    const { page, ...rest } = c;
    const list = byPage.get(page) ?? [];
    list.push(rest);
    byPage.set(page, list);
  }

  for (const { pageIndex } of rich) {
    const page = doc.extracted.pages[pageIndex]!;
    const concepts = byPage.get(pageIndex) ?? [];
    const newTags: PersistedTagServer[] = concepts
      .map((c, idx) => {
        const a = locateAnchor(page, c.anchor);
        if (!a) return null;
        return {
          id: `${pageIndex}-${idx}`,
          page: pageIndex,
          endX: a.endX,
          endY: a.endY,
          fontHeight: a.fontHeight,
          type: c.type as VizType,
          label: c.label,
          ready: false,
          generating: autoGenerate,
          concept: c,
        };
      })
      .filter((t): t is PersistedTagServer => t !== null);
    appendDetectionResult(docId, pageIndex, newTags, autoGenerate);
  }
}

function appendDetectionResult(
  docId: string,
  pageIndex: number,
  newTags: PersistedTagServer[],
  autoGenerate: boolean,
) {
  let added = 0;
  mergeTagsFile(docId, (file) => {
    const existingIds = new Set(file.tags.map((t) => t.id));
    const fresh = newTags.filter((t) => !existingIds.has(t.id));
    added = fresh.length;
    const merged: PersistedTagsFile = {
      ...file,
      tags: [...file.tags, ...fresh],
      pagesAnalyzed: Array.from(new Set([...file.pagesAnalyzed, pageIndex])),
    };
    return merged;
  });
  if (autoGenerate && added > 0) ensureVizQueue(docId);
}

// ── Viz queue ───────────────────────────────────────────────────────────

const vizInFlight = new Map<string, Promise<void>>();

export function isVizQueueRunning(docId: string): boolean {
  return vizInFlight.has(docId);
}

/**
 * Drop the `generating` spinner from every tag still waiting on the queue,
 * returning them to an idle, click-to-retry state. Tags that already have a
 * spec (done) or a per-concept `error` are left untouched. Called when the
 * queue stops on an account-level Codex error so the viewer never shows a
 * spinner that will never resolve.
 */
function clearPendingVizGeneration(docId: string): void {
  mergeTagsFile(docId, (file) => ({
    ...file,
    tags: file.tags.map((t) =>
      t.generating && !t.spec ? { ...t, generating: false } : t,
    ),
  }));
}

export function ensureVizQueue(docId: string): void {
  if (vizInFlight.has(docId)) return;
  const p = runVizQueue(docId)
    .catch((e) =>
      console.warn("[jobs/viz]", docId, e instanceof Error ? e.message : e),
    )
    .finally(() => {
      vizInFlight.delete(docId);
    });
  vizInFlight.set(docId, p);
}

/**
 * Mark a tag as needing (re)generation and kick the queue.
 *
 * Called by the viewer's click handler (no runtimeError) and by the
 * sandbox's runtime-error reporter (with the captured message). Honors
 * the retry budget: tags that exhausted their attempts get a permanent
 * `error` and won't be re-queued.
 */
export function requestVizGeneration(
  docId: string,
  tagId: string,
  runtimeError?: string,
): void {
  const maxRetries = loadSettings().maxRetries;
  mergeTagsFile(docId, (file) => ({
    ...file,
    tags: file.tags.map((t) => {
      if (t.id !== tagId) return t;
      const attemptsSoFar = t.attempts ?? 0;
      // A runtime error feeds the failing code back to the agent for a repair
      // pass (processViz reads `spec` + `lastRuntimeError` as previousAttempt).
      // Once the retry budget is exhausted, give up with a permanent error.
      if (runtimeError && attemptsSoFar > maxRetries) {
        return {
          ...t,
          ready: false,
          generating: false,
          error: `Couldn't render this concept — the agent's code kept failing after ${attemptsSoFar} attempts.`,
          lastRuntimeError: runtimeError,
        };
      }
      return {
        ...t,
        ready: false,
        generating: true,
        error: undefined,
        // Preserve the runtime error so the repair pass has context; on a
        // plain (re)generate click, keep whatever was already recorded.
        lastRuntimeError: runtimeError ?? t.lastRuntimeError,
      };
    }),
  }));
  ensureVizQueue(docId);
}

export function requestRetryFailedViz(docId: string): number {
  let requeued = 0;
  mergeTagsFile(docId, (file) => ({
    ...file,
    tags: file.tags.map((t) => {
      if (!t.error) return t;
      requeued++;
      return {
        ...t,
        ready: false,
        generating: true,
        error: undefined,
      };
    }),
  }));
  if (requeued > 0) ensureVizQueue(docId);
  return requeued;
}

async function runVizQueue(docId: string) {
  const doc = getDoc(docId);
  if (!doc) return;
  const docTitle = docTitleFromFilename(doc.filename);
  // Set when a call fails with an account-level Codex error (rate-limit / auth
  // / binary / unsupported model). Those hit every call, so we stop the whole
  // queue rather than march through the rest re-hitting the same wall — that
  // was the old infinite-retry loop. No auto-retry: the user re-clicks a tag
  // to try again once the banner clears.
  let stopError: CodexError | null = null;
  const inFlightTagIds = new Set<string>();

  const pickNextTag = (): PersistedTagServer | null => {
    const file = loadTags(docId);
    if (!file) return null;
    for (const t of file.tags) {
      if (t.generating && !t.error && !inFlightTagIds.has(t.id)) return t;
    }
    return null;
  };

  await new Promise<void>((resolve) => {
    let active = 0;
    let done = false;

    const finish = () => {
      if (active === 0 && !done) {
        done = true;
        resolve();
      }
    };

    const pump = () => {
      while (active < VIZ_CONCURRENCY) {
        if (stopError) {
          finish();
          return;
        }
        const tag = pickNextTag();
        if (!tag) {
          finish();
          return;
        }
        inFlightTagIds.add(tag.id);
        active++;
        processViz(docId, tag.id, docTitle)
          .catch((e) => {
            if (e instanceof CodexError && e.kind !== "generic") {
              // Account-level failure: stop the queue. processViz left the
              // tag's `generating` flag in place (it didn't mark a per-tag
              // error), so we clear all pending spinners below.
              stopError = e;
            } else {
              // Generic per-concept failure is already recorded on the tag by
              // processViz (so it won't be re-picked); just log and move on.
              console.warn(
                "[jobs/viz-tag]",
                docId,
                tag.id,
                e instanceof Error ? e.message : e,
              );
            }
          })
          .finally(() => {
            inFlightTagIds.delete(tag.id);
            active--;
            if (stopError) {
              finish();
              return;
            }
            pump();
          });
      }
    };

    pump();
  });

  // Account-level stop: clear the spinner from every tag still queued so the
  // viewer shows them as idle/click-to-retry instead of spinning forever.
  if (stopError) {
    clearPendingVizGeneration(docId);
  }
}

async function processViz(docId: string, tagId: string, docTitle: string) {
  // Re-read the tag fresh — it may have been mutated by a runtime-error
  // report or another concurrent request between pickNextTag and now.
  const file = loadTags(docId);
  if (!file) return;
  const tag = file.tags.find((t) => t.id === tagId);
  if (!tag || !tag.generating || tag.error) return;

  const previousAttempt =
    tag.spec && tag.lastRuntimeError
      ? { spec: tag.spec, runtimeError: tag.lastRuntimeError }
      : undefined;

  try {
    const spec = await generateVizSpec({
      type: tag.type,
      label: tag.concept.label,
      context: tag.concept.context,
      docTitle,
      previousAttempt,
    });
    mergeTagsFile(docId, (f) => ({
      ...f,
      tags: f.tags.map((t) =>
        t.id === tagId
          ? {
              ...t,
              spec,
              ready: true,
              generating: false,
              attempts: (t.attempts ?? 0) + 1,
              lastRuntimeError: undefined,
              error: undefined,
            }
          : t,
      ),
    }));
  } catch (e) {
    if (e instanceof CodexError && e.kind !== "generic") {
      // Account-level failure (rate-limit / auth / binary / unsupported
      // model). Don't pin it on this concept — re-throw so the queue stops
      // and clears every pending spinner. The tag stays `generating` so the
      // queue-level cleanup returns it to an idle, click-to-retry state.
      throw e;
    }
    const msg = e instanceof Error ? e.message : "viz generation failed";
    mergeTagsFile(docId, (f) => ({
      ...f,
      tags: f.tags.map((t) =>
        t.id === tagId
          ? {
              ...t,
              ready: false,
              generating: false,
              attempts: (t.attempts ?? 0) + 1,
              error: msg,
            }
          : t,
      ),
    }));
  }
}

// ── Status snapshot ─────────────────────────────────────────────────────

export function getJobStatus(docId: string): {
  detectionRunning: boolean;
  vizQueueRunning: boolean;
  detectionError?: string;
} {
  return {
    detectionRunning: isDetectionRunning(docId),
    vizQueueRunning: isVizQueueRunning(docId),
    detectionError: detectionErrors.get(docId),
  };
}
