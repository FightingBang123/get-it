/**
 * JSON schemas for the knowledge-graph and learning-tool agents.
 * Same shape conventions as lib/schemas.ts — strict, every property required.
 */

// ── Knowledge graph: build (one-shot, runs at upload) ─────────────────

/** One concept node. Shared by the single-call and map-phase schemas. */
const kgNodeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "summary", "pageHints"],
  properties: {
    id: { type: "string", minLength: 2, maxLength: 60 },
    label: { type: "string", minLength: 2, maxLength: 80 },
    summary: { type: "string", minLength: 10, maxLength: 280 },
    pageHints: {
      type: "array",
      maxItems: 12,
      items: { type: "integer", minimum: 1 },
    },
  },
} as const;

/** One directed relation. Shared by the single-call and map-phase schemas. */
const kgEdgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "target", "relation"],
  properties: {
    source: { type: "string", minLength: 2, maxLength: 60 },
    target: { type: "string", minLength: 2, maxLength: 60 },
    relation: { type: "string", minLength: 2, maxLength: 80 },
  },
} as const;

export const kgBuildSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nodes", "edges", "globalNote"],
  properties: {
    nodes: {
      type: "array",
      minItems: 4,
      maxItems: 30,
      items: kgNodeSchema,
    },
    edges: {
      type: "array",
      maxItems: 80,
      items: kgEdgeSchema,
    },
    globalNote: { type: "string", minLength: 10, maxLength: 600 },
  },
} as const;

/**
 * Map phase for long documents: candidate concepts + relations from ONE
 * chunk, with no global note (that is the reduce phase's job).
 */
export const kgMapSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nodes", "edges"],
  properties: {
    nodes: {
      type: "array",
      maxItems: 16,
      items: kgNodeSchema,
    },
    edges: {
      type: "array",
      maxItems: 30,
      items: kgEdgeSchema,
    },
  },
} as const;

export type KGMapResult = {
  nodes: Array<{ id: string; label: string; summary: string; pageHints: number[] }>;
  edges: Array<{ source: string; target: string; relation: string }>;
};

export type KGBuildResult = {
  nodes: Array<{ id: string; label: string; summary: string; pageHints: number[] }>;
  edges: Array<{ source: string; target: string; relation: string }>;
  globalNote: string;
};

// ── Knowledge graph: evaluate (runs after each interaction) ────────────

export const kgEvaluateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["updates", "globalNote"],
  properties: {
    updates: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "evaluation", "evaluatorNote"],
        properties: {
          id: { type: "string", minLength: 2, maxLength: 60 },
          evaluation: {
            type: "object",
            additionalProperties: false,
            required: ["memory", "comprehension", "structure", "application"],
            properties: {
              memory: { type: "integer", minimum: 0, maximum: 100 },
              comprehension: { type: "integer", minimum: 0, maximum: 100 },
              structure: { type: "integer", minimum: 0, maximum: 100 },
              application: { type: "integer", minimum: 0, maximum: 100 },
            },
          },
          evaluatorNote: { type: "string", minLength: 0, maxLength: 280 },
        },
      },
    },
    globalNote: { type: "string", minLength: 10, maxLength: 600 },
  },
} as const;

export type KGEvaluateResult = {
  updates: Array<{
    id: string;
    evaluation: {
      memory: number;
      comprehension: number;
      structure: number;
      application: number;
    };
    evaluatorNote: string;
  }>;
  globalNote: string;
};

// ── Chat: assistant reply (1-shot per user message) ────────────────────

export const chatReplySchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply"],
  properties: {
    reply: { type: "string", minLength: 1, maxLength: 4000 },
  },
} as const;

export type ChatReplyResult = { reply: string };

// ── Flashcards: deck generation ────────────────────────────────────────

export const flashcardsGenerateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      minItems: 4,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["q", "a"],
        properties: {
          q: { type: "string", minLength: 5, maxLength: 280 },
          a: { type: "string", minLength: 2, maxLength: 600 },
        },
      },
    },
  },
} as const;

export type FlashcardsGenerateResult = {
  cards: Array<{ q: string; a: string }>;
};

// ── Quizzes: deck generation ───────────────────────────────────────────

export const quizGenerateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 4,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stem", "options", "correctIndex", "explanation"],
        properties: {
          stem: { type: "string", minLength: 8, maxLength: 320 },
          options: {
            type: "array",
            minItems: 4,
            maxItems: 4,
            items: { type: "string", minLength: 1, maxLength: 240 },
          },
          correctIndex: { type: "integer", minimum: 0, maximum: 3 },
          explanation: { type: "string", minLength: 4, maxLength: 500 },
        },
      },
    },
  },
} as const;

export type QuizGenerateResult = {
  questions: Array<{
    stem: string;
    options: string[];
    correctIndex: number;
    explanation: string;
  }>;
};

// ── Feynman: child prompt + (optional) end-of-session summary ──────────

export const feynmanChildPromptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["childPrompt"],
  properties: {
    childPrompt: { type: "string", minLength: 4, maxLength: 280 },
  },
} as const;

export type FeynmanChildPromptResult = { childPrompt: string };

export const feynmanSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", minLength: 20, maxLength: 1000 },
  },
} as const;

export type FeynmanSummaryResult = { summary: string };
