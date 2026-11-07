/**
 * Tests for the prompt layer: material-kind detection and the registry.
 *
 * Run: npm run test:prompts
 *
 * Pure: no provider, no network.
 */

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function checkEqual(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, expected ${String(expected)}`);
}

const page = (text: string) => ({ pageIndex: 0, text });

async function main() {
  const { analyseMaterial, classifyMaterial, detectMaterialKind } = await import("../lib/material-kind");
  const { systemPrompt } = await import("../prompt/registry");
  const { materialGuidance } = await import("../prompt/materials");

  // 1) Fiction: dialogue-heavy prose.
  {
    const lines = Array.from(
      { length: 40 },
      () => "“你为什么要来这里？”她问。“我不知道，”他说，“我只是想弄明白自己为什么存在。”",
    );
    const kind = detectMaterialKind([page(lines.join("\n"))]);
    checkEqual("dialogue-heavy text → novel", kind, "novel");
    const stats = analyseMaterial([page(lines.join("\n"))]);
    check("novel has dialogue signal", stats.dialogueChars > 20, String(stats.dialogueChars));
  }

  // 2) Programming book: code lines.
  {
    const lines = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? `const value${i} = compute(${i});` : `function helper${i}(input) {`,
    );
    const kind = detectMaterialKind([page(lines.join("\n"))]);
    checkEqual("code-heavy text → technical", kind, "technical");
  }

  // 3) Textbook: chapter headings + formulas.
  {
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(`第${i}章 章节标题`);
      lines.push("Photosynthesis converts light energy into chemical energy.");
      lines.push("The equation E = mc2 relates mass and energy, with ∫ f(x) dx.");
    }
    const kind = detectMaterialKind([page(lines.join("\n"))]);
    checkEqual("headings + formulas → textbook", kind, "textbook");
  }

  // 4) Plain prose with no signals falls back to default.
  {
    const lines = Array.from({ length: 30 }, () =>
      "Plants need sunlight and water to grow, and the process happens slowly over time.",
    );
    const kind = detectMaterialKind([page(lines.join("\n"))]);
    checkEqual("no signals → default", kind, "default");
  }

  // 5) classifyMaterial is deterministic and stats are sane.
  {
    const stats = analyseMaterial([page("alpha beta gamma")]);
    check("analysis counts lines", stats.lines >= 1);
    check("analysis counts chars", stats.sampleChars > 0);
    checkEqual("classification is deterministic", classifyMaterial(stats), classifyMaterial(stats));
  }

  // 6) Registry: default prompts carry no material guidance.
  {
    const prompt = systemPrompt("chat", "default");
    check("default prompt has no MATERIAL TYPE", !prompt.includes("MATERIAL TYPE"));
    check("default prompt keeps its base", prompt.includes("study companion"));
  }

  // 7) Registry: every tool picks up the material guidance.
  {
    const tools = [
      "chat",
      "flashcards",
      "quizzes",
      "feynman-child",
      "feynman-summary",
      "kg-build",
      "kg-map",
      "kg-reduce",
      "kg-evaluate",
      "detect",
    ] as const;
    let allTagged = true;
    for (const tool of tools) {
      const prompt = systemPrompt(tool, "technical");
      if (!prompt.includes("MATERIAL TYPE: technical")) {
        allTagged = false;
        console.log(`  missing guidance: ${tool}`);
      }
    }
    check("every tool includes material guidance", allTagged);
  }

  // 8) Guidance differs per kind.
  {
    check("novel guidance mentions characters", materialGuidance("novel").includes("characters"));
    check("technical guidance mentions code", materialGuidance("technical").includes("code"));
    check("textbook guidance mentions formulas", materialGuidance("textbook").includes("formulas"));
    checkEqual("default guidance is empty", materialGuidance("default"), "");
  }

  // 9) Feynman summary interpolates its turn count.
  {
    const prompt = systemPrompt("feynman-summary", "default", { maxTurns: 7 });
    check("summary includes the turn count", prompt.includes("child asked\n7 prompts"), prompt.slice(0, 120));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
