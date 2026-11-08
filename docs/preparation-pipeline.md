# 预处理管线与可移植产物：设计与分阶段实施计划

- 状态：设计稿（尚未开始实现）
- 分支：`feat/prepared-bundles`
- 日期：2026-11-08
- 范围：先落地「内容哈希 + 清单 + 文档产物包」；云端预处理走「远程模型端点」；后续阶段再补按任务路由、摘要树/向量索引、OCR、无界面 CLI。

---

## 1. 背景与问题

好的 LLM API 按 token 计费，长文档的读取又慢。当前 Get It. 的主要成本不在“解析 PDF”，而在**反复把大段文档塞进每次模型调用**：

- `lib/retrieval.ts` 在文档超过 12k token 时按相关性选块，默认最多 4 块 / 24k token（`RETRIEVAL_DEFAULTS`）。
- relevance 模式下，chat 每轮都会重发这批摘录（`app/api/chat/[docId]/route.ts:133-135`）。
- 概念检测、可视化、知识图谱各自在需要时才跑，且共享一个全局 provider。

用户的核心诉求是：用本地 CPU/GPU 或更便宜的模型做一次性预处理，把结果缓存下来；设备不够时租云端机器预处理，再把产物带回本地继续聊天、闪卡、测试。本质是**输入、缓存、输出的隔离**。

本设计把这句话进一步收敛为：

> 让昂贵的一次性加工与交互式学习在时间、算力、存储上解耦；算力位置（本地 / 租赁云端 / 不同 API）只是执行目标。

可移植性、可缓存性、可复现性比“在哪台机器上跑”更重要。

---

## 2. 设计主线

1. **三层显式切分**
   - **Ingest**（确定性、无 LLM）：PDF/EPUB/Markdown → 规范页模型；OCR 属于这一层，作为可插拔引擎。
   - **Prepare**（批量、昂贵、可缓存）：概念检测、可视化生成、知识图谱、章节摘要、向量索引。
   - **Study**（交互、低延迟）：chat / 闪卡 / 测试 / Feynman，只读产物，只发小请求。
2. **内容寻址**：所有缓存键都从 `documentHash` 派生，而不是页数、字符数或 prompt 文本。
3. **单一清单**：每份文档一个 `manifest.json`，记录每个阶段的输入哈希、prompt 版本、模型来源、耗时、token、进度与状态。
4. **可移植产物包**：`.getit`（ZIP）在机器之间搬运“已预处理文档”，而不是搬运整个 `userData` 目录。
5. **按任务路由模型**：`prepare.detect`、`prepare.kg.map`、`study.chat` 等任务键各自映射 `{provider, model, effort}`；本地 Ollama/vLLM、便宜 API、云端 GPU 都只是路由表的不同行。
6. **预计算文档纲要**：一次生成章节摘要树 + chunk 向量索引，学习时只发“相关小节摘要 + 少量原文页”，把单轮输入从 ~24k token 降一个数量级。这比 OCR 更影响长期成本。

---

## 3. 现状审计

### 已经具备的底子

- 每份文档自包含目录：`source.pdf`、`extracted.json`、`meta.json`、`workctx.json`、`kg.json`、`tags.json`、`chunks.json`（`lib/paths.ts:16-26`、`60-115`）。
- 规范化页模型：`ExtractedPdf { numPages, pages }`，每页含文本与字形坐标 `PdfTextItem`（`lib/pdf-extract.ts:61-88`），标签锚点依赖这些坐标（`locateAnchor`，`lib/pdf-extract.ts:206-263`）。
- 页对齐、带一页重叠的 chunk 缓存（`lib/doc-chunks.ts`）。
- 统一模型路由 `runJson` / `runJsonInThread`（`lib/codex.ts:208-283`），已支持 Codex / Gemini / Claude / Pi（Pi 可指向 Ollama）。
- 词法 BM25 检索（`lib/retrieval.ts:186-235`）。
- 所有落盘写入基本都走 tmp + rename 原子写。

### 关键缺口

| 缺口 | 位置 | 影响 |
|---|---|---|
| 没有 content hash | 全仓库 | 无法可靠去重、无法校验导入包、无法做内容寻址缓存 |
| chunk 指纹只有 `{pageCount, chars}`，且不含 `maxTokens` | `lib/doc-chunks.ts:94-105` | 改分块大小会静默命中旧缓存；字符数相同的内容碰撞 |
| 没有清单 / 产物版本 | — | 不知道某个产物由哪个 prompt、模型、版本生成，无法局部失效 |
| 只能导出 journal JSON，不能导入 | `app/api/work-context/[docId]/route.ts` | 无法把“已预处理文档”搬到另一台机器 |
| 没有按任务路由 | `lib/provider-types.ts`、`lib/codex.ts` | 只有全局 provider + fast/smart 两档 |
| Pi 忽略 `reasoning` | `lib/pi-coder.ts:531,561` | `runJson` 永远 fast、`runJsonInThread` 永远 smart，按功能配模型做不到 |
| KG 构建不可恢复 | `app/api/kg/[docId]/state/route.ts:26-33` | 重启后 `building` 被改写成 `error`，长文档预处理代价重来 |
| 检测由 viewer 挂载触发 | `app/viewer/[docId]/viewer-client.tsx:214-218` | 云端批量预处理没有 UI 时无法启动 |
| 没有 OCR / embedding / 摘要产物 | — | 扫描件被拒；检索只有词法；学习时上下文仍偏大 |
| `saveDoc` 重建 meta | `lib/store.ts:102-120` | 新增 meta 字段会被静默丢弃；也不保留 `lastOpenedAt` |

---

## 4. 目标架构

### 4.1 文档身份：`documentHash`

对规范化页模型做 SHA-256，规范形式纳入：

- `pageIndex`、`width`、`height`、`text`
- `items` 的 `str/x/y/width/height/eol`

纳入坐标的理由：标签锚点会回写到 `tags.json`，如果 pdfjs 升级或 OCR 改变了字形几何，只比较文本会漏掉失效。排除 `docId`、文件名、时间戳、`materialKind`、模型输出等易变字段。页数组按 `pageIndex` 排序后参与哈希，顺序变化不影响结果。

同时保留：

- `sourceHash`：原始 `source.pdf` 字节的 SHA-256，仅用于来源展示与快速去重。
- `stageInputHash = hash(documentHash + stage + pipelineVersion + promptVersion + params)`：每个阶段真正的缓存键。

哈希规范带版本号 `HASH_SPEC_VERSION`。版本变化时重算并失效缓存，绝不静默复用。

### 4.2 清单：`docs/<docId>/manifest.json`

```ts
type StageStatus = "pending" | "running" | "partial" | "ready" | "stale" | "error";

type StageEntry = {
  status: StageStatus;
  inputHash: string;
  promptVersion?: string;
  provider?: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
  progress?: { unit: "pages" | "chunks" | "tags"; done: number; total: number };
};

type Manifest = {
  v: 1;
  docId: string;
  documentHash: string;
  sourceHash?: string;
  hashSpecVersion: number;
  pipelineVersion: string;
  createdAt: number;
  updatedAt: number;
  provenance: {
    origin: "upload" | "sample" | "bundle";
    bundle?: { filename: string; exportedAt: number; appVersion: string };
    trust: "local" | "untrusted";
    trustedAt?: number;
  };
  stages: {
    chunks: StageEntry;
    detect: StageEntry;
    viz: StageEntry;
    kg: StageEntry;
    summary?: StageEntry;     // 预留
    embeddings?: StageEntry;  // 预留
  };
};
```

规则：

- 缺失或版本不识别时返回 `null`，由调用方从现有产物推导状态；不破坏性迁移。
- 读路径不写清单；只有上传、prepare、导入、显式修改才创建。
- 同一文档的读改写用 promise 链串行化，避免检测（并发 3）与 viz（并发 4）互相覆盖；文件本身仍原子写。
- prompt 版本不手工维护：对 `systemPrompt(tool, kind)` 的字符串做 SHA-256 取前 16 位（`prompt/registry.ts`），改 prompt 自动改变 `inputHash`。

### 4.3 可移植产物包 `.getit`

单文件 ZIP，扁平结构，便于校验与防御：

```
bundle.json      # 描述符（zod 校验）
source.pdf       # 必需：viewer 通过 /api/pdf/<docId> 读取
extracted.json
manifest.json    # 已清洗：不含 docId、本地路径、密钥
tags.json        # 可选，默认包含；含 LLM 生成的代码
kg.json          # 可选，默认包含
workctx.json     # 可选，默认不包含；导出时剥掉 provider thread id
```

描述符记录 `format/v/exportedAt/appVersion/pipelineVersion/doc{filename,numPages,materialKind,documentHash,sourceHash}`、包含项与每个文件的 `bytes + sha256`。

导出前确保 `documentHash` 与 `sourceHash` 已计算；拒绝导出缺失 `source.pdf` 的文档。导入时：

1. 原始 body 上传 + 显式字节上限（Next 16 的 `serverActions.bodySizeLimit` 不作用于 Route Handler）。
2. `ZipReader` 的“先看声明大小再解压”限制继续生效；entry 名必须在扁平白名单内，未知文件直接拒绝而不是忽略。
3. 校验每个文件的 sha256、`documentHash`、页数、页上限与结构上限。
4. 按 `documentHash` 去重；命中则返回已有 `docId`，不写盘。
5. 永远分配新 UUID，不接受包内 id；显示文件名做净化。
6. 失败时删除已创建目录，避免孤儿文档。

### 4.4 信任边界

`lib/viz-runtime.ts` 用 `new Function` 执行 LLM 生成的 viz 代码。本地生成时这是可信输入；导入包会打破这个前提。因此：

- 导入的带 `spec` 的标签一律 `quarantined: true`，代码只存不执行。
- 用户在 UI 中显式确认后调用 `POST /api/bundle/[docId]/trust`，才清空隔离并置 `ready`。
- 导入的 KG 节点清零四维评分、清空 `evaluatorNote`（那是另一台机器上的个人状态）。
- 导入文本会进入后续 prompt，按不可信数据处理：显示来源，隔离期间不喂给模型。
- 导出/导入都剥离 `codexThreadId` / `threadProvider`。

### 4.5 远程模型端点（后续阶段）

新增 `remote` provider，直连 OpenAI-compatible `POST <baseUrl>/chat/completions`，配合 vLLM / Ollama / LM Studio。与 Pi（编码代理 CLI）相比更适合批量 JSON 调用：可并发、无 CLI 进程开销、可用 `response_format: {type:"json_object"}`。

任务路由（`lib/model-tasks.ts`）：

```ts
type ModelTask =
  | "prepare.detect" | "prepare.kg.build" | "prepare.kg.map"
  | "prepare.kg.reduce" | "prepare.viz" | "prepare.summary"
  | "study.chat" | "study.eval";
type ModelRoute = {
  provider: ProviderName;
  tier: "fast" | "smart";
  model?: string;
  reasoning: "low" | "medium" | "high";
};
```

解析优先级：任务显式覆盖 → 档位默认 → provider 默认。第一阶段只建立任务键与用量归因，不切换行为。

---

## 5. 第一阶段实施步骤（P1：哈希 + 清单 + 产物包）

每个步骤以验证门结束，不通过不进入下一步。

### Step 0 — 模块骨架

新增：

- `lib/hash.ts`：底层哈希（`hashBytes` / `hashString` / `combine`），不依赖 fs。
- `lib/doc-hash.ts`：`hashExtraction`、`getDocumentHash`、懒回填、内存缓存。
- `lib/atomic-json.ts`：`readJson`、`writeJsonAtomic`。
- `lib/manifest-types.ts` / `lib/manifest.ts`：清单类型与读写/合成/串行更新。
- `lib/pipeline-version.ts`：`PIPELINE_VERSION`、`HASH_SPEC_VERSION`、`CHUNK_BUILDER_VERSION`。
- `lib/model-tasks.ts`：任务键与路由解析（仅铺路）。
- `lib/zip-writer.ts`：零依赖 ZIP 写入（`node:zlib.deflateRawSync`）。
- `lib/bundle/{types,export,import}.ts`。
- `lib/kg-parts.ts`、`lib/prepare.ts`。
- 测试：`scripts/test-doc-hash.ts`、`test-manifest.ts`、`test-bundle.ts`、`test-kg-resume.ts`。

验证：`npx tsc --noEmit`。（本机 `npm run lint` 会 OOM，不要用。）

### Step 1 — 内容哈希与 meta 合并

- 在 `lib/store.ts` 扩展 `DocMeta`：`documentHash?`、`sourceHash?`、`hashSpecVersion?`、`importedFrom?`；`docs.json` 仍是 `v:1`。
- **修正 `saveDoc`**：与已有 meta 合并，而不是重建，避免丢掉新字段和 `lastOpenedAt`。
- 新增 `updateDocMeta(docId, patch)`，同时更新 `meta.json` 与 `docs.json`。
- 懒回填：`getDocumentHash` 依次查内存 → `meta.json` → `manifest.json` → 从 `getDoc().extracted` 计算并持久化；**绝不重写 `extracted.json`**。
- `lib/paths.ts` 增加 `manifestPath`、`kgPartsDir`、缓存目录。

验证：同一次提取两次哈希一致；改一个 item 坐标会变；只改文件名/`materialKind` 不变；页数组重排不变；回填只写 meta/docs，不动 `extracted.json`。

### Step 2 — Prompt 指纹与用量归因

- `prompt/registry.ts` 增加 `promptFingerprint(tool, kind)`。
- `lib/codex.ts` 的 `RunOptions` 增加 `task?: ModelTask`、`onUsage?`；调用方未传 `reasoning` 时按路由解析。
- `lib/usage-store.ts` 的每日桶增加 `byTask`，现有总量字段不变。
- 第一阶段 `resolveRoute` 保持今天的档位（detect/viz → fast/low，KG → smart/medium），只为清单来源与费用归因服务。

验证：`npm run test:prompts` 通过；prompt 指纹稳定且改文本会变；`tsc`。

### Step 3 — 清单落地

- `lib/manifest.ts`：`loadManifest`、`ensureManifest`、`updateManifest`、`deriveStages`。
- 合成规则：chunks 看 `chunks.json` v2 指纹；detect 看 `pagesAnalyzed.length / numPages`；viz 看 `spec` 覆盖率；kg 映射 `kg.json.status`。
- `ensureManifest({create})` 默认不写盘；viewer/library 只读时仅推导。
- 版本不识别返回 `null`，不改文件。

验证：合成、部分完成、未知版本、并发更新四个用例。

### Step 4 — Chunk 缓存 v2

`lib/doc-chunks.ts` 的缓存头改为：

```ts
type CacheFile = {
  v: 2;
  documentHash: string;
  maxTokens: number;
  builderVersion: number;
  pageCount: number;
  chunks: DocChunk[];
};
```

`loadDocChunks(docId, pages, maxTokens, documentHash)` 要求 `documentHash` 必传；两个生产调用方（`lib/kg-runner.ts`、`lib/retrieval.ts`）传入 `getDocumentHash`。v1 缓存直接忽略并重写一次（代价远小于一次模型调用）。

验证：`npm run test:budget`、`test:retrieval`；新增 maxTokens/documentHash 变化必须重建、手写 v1 必须被忽略的用例。

### Step 5 — 显式 Prepare 与可恢复 KG

- `lib/prepare.ts`：`prepareDoc(docId, {stages?, force?})`，顺序：清单与哈希 → chunk 预热 → 并行 `ensureDetection` + `buildKG` → `ensureVizQueue`；以产物状态而非 promise 成功写阶段状态。
- `ensureDetection` / `ensureVizQueue` 返回在途 promise（现有调用方忽略返回值，兼容）。
- KG 分片：`docs/<docId>/kg-parts/chunk-<index>.json`，内容 `{v, chunkIndex, inputHash, result, at}`；命中则跳过模型调用，成功 reduce 后清理分片。
- `app/api/kg/[docId]/state/route.ts` 的响应增加 `resumable`，不扩展 `KnowledgeGraphStatus`。
- 新路由 `app/api/prepare/[docId]/route.ts`：`POST` 立即返回、`GET` 返回状态。

验证：`npm run test:kg-resume`（5 个 chunk，第 2 个失败一次；重试只调第 2 个；成功后分片清空）；手动杀进程重启后重试。

### Step 6 — ZIP 写入

`lib/zip-writer.ts`：`writeZip(entries)`；CRC32 查表；method 8 用于 JSON、method 0 用于 PDF；UTF-8 名称；无 ZIP64；entry 数、名称字符集、总大小硬限制。

验证：写出的 ZIP 能被现有 `ZipReader.open` 读回；独立计算 CRC 与 fixture 对比。

### Step 7 — 导出

`GET /api/bundle/[docId]?workctx=0|1`：

- `ensureManifest` + 计算两个哈希；缺失 `source.pdf` 拒绝。
- 清洗 manifest（去 `docId`、路径、密钥）；workctx 默认不含，包含时剥 thread id。
- `Content-Type: application/zip`，`Content-Disposition: attachment; filename="<safe>.getit"`。
- `runtime = "nodejs"`，`maxDuration = 300`。

验证：临时数据目录导出 → `ZipReader` 打开 → 描述符文件清单与校验和一致 → 默认无 workctx → 无 `docId`/绝对路径/API key 子串。

### Step 8 — 导入与信任

`POST /api/bundle/import`（raw body，`application/vnd.getit.bundle`）：

1. `Content-Length` 与 `arrayBuffer` 后双重上限（建议 256 MB）。
2. `ZipReader` 限制：32 个 entry、单 entry 与总解压上限。
3. 扁平白名单；未知 entry 拒绝。
4. zod 校验描述符；校验每个文件大小与 sha256；要求 `source.pdf` + `extracted.json`。
5. 重算 `hashExtraction` 与描述符比对；页数/页上限/单页结构上限。
6. 按 `documentHash` 去重；必要时只对候选懒计算哈希。
7. 新 UUID 落盘：`source.pdf`、`extracted.json`、净化后的 meta、`manifest.json`（`origin:"bundle"`、`trust:"untrusted"`）、可选产物。
8. `tags.json` 带 `spec` 的标签写 `quarantined:true`；`kg.json` 评分清零；workctx 仅在显式请求时导入。
9. 失败清理目录。
10. 返回 `{docId, deduped, filename, numPages, documentHash, trust, warnings}`；错误码 `413/415/422`，细分 `bad_zip | untrusted_path | missing_file | checksum_mismatch | hash_mismatch | too_many_pages`。

`POST /api/bundle/[docId]/trust`：清除隔离、置 `ready`、更新 `provenance.trust`。

验证：round-trip、二次导入去重、翻转一个字节触发 `hash_mismatch`、未知 entry 拒绝、解压上限触发 `ZipLimitError`、默认隔离、信任后可用、KG 评分清零。

### Step 9 — UI

- `GET /api/library` 行增加短哈希、`prepareStatus`、`importedFrom`、`quarantinedCount`。
- Library：**Import bundle** 按钮（`.getit`）；行操作增加 **Export bundle**、**Prepare**；来源 chip。
- 右栏更多菜单：**Export bundle (.getit)**，与现有 “Download work context (JSON)” 并列。
- Viewer：存在隔离标签时显示横幅，**Enable visuals** 调信任路由，**Keep off** 仅本会话关闭；绝不自动执行。

验证：`npm run build`；手动全流程。

### Step 10 — 文档与回归

- README 更新数据布局（`manifest.json`、`kg-parts/`）、`.getit` 格式、导入/导出、信任提示。
- 新增脚本：`test:hash`、`test:manifest`、`test:bundle`、`test:kg-resume`、`test:artifacts`。
- 回归：`test:budget`、`test:retrieval`、`test:errors`、`test:epub`、`test:md`、`test:pi`、`smoke`、`smoke-all`。

---

## 6. 后续阶段

### P2 — 按任务路由 + 直连远程端点

- `lib/providers/remote-provider.ts`：OpenAI-compatible chat/completions，JSON 提取兜底、超时/abort、用量映射、无状态 thread。
- `ProviderName` 增加 `remote`，补全所有映射表（label/binary/package/auth/docs/health/settings 校验/UI）。
- settings 增加 `remoteUrl/remoteApiKey/remoteModelFast/Smart/remoteTimeoutMs` 与 `routes`。
- `prepare.*` 指向租赁 GPU（vLLM/Ollama），`study.chat` 保持本地或高质量 API。
- 修复 Pi 的 `reasoning` 映射，避免任务路由被吞掉。

### P3 — 摘要树 + 向量索引（成本主杠杆）

- `summary.json`：章节/小节树（标题、页范围、token、摘要、children），`prepare.summary` 用 map-reduce 生成；章节边界先用字号聚类 + 标题启发式。
- 每 chunk 向量；`lib/embedding-provider.ts` 接口（远程 `/embeddings` 或本地 ONNX/Ollama）；全局内容寻址缓存 `DATA_DIR/cache/embeddings/<modelId>/<chunkHash>.json`。
- `lib/retrieval.ts` 增加 “summary-first” 模式：始终带小摘要树，再选相关原文块；目标基础上下文 3–6k token，缺 embedding 时回退现有词法。

### P4 — OCR 入口插件

- `lib/ingest/ocr.ts`：`OcrEngine { name, version, langs, recognize(page) }`，可选加载 Tesseract.js / RapidOCR（onnxruntime）。
- OCR word box 映射成合成 `PdfTextItem`，保持 `locateAnchor` 可用；页级 `textSource: "text-layer" | "ocr"` + 引擎版本。
- 置信度不进入 `documentHash`（非确定性）；文本、来源、引擎版本进入。
- 仅在质量门拒绝且用户开启时 OCR；清单记录引擎。

### P5 — 无界面 CLI（租赁机器）

- `cli/getit.ts`：`prepare` / `export` / `import` / `verify`，复用 `lib/prepare` + `lib/bundle`，不启动 Electron/Next UI。
- `GETIT_DATA_DIR` 指向临时目录，`GETIT_REMOTE_URL/KEY/MODEL` 指向 vLLM。
- `.getit` 成为交换格式：GPU 云机器产出，笔记本导入后继续学习。

---

## 7. 安全与迁移风险

### 安全

1. 导入的 viz 代码是可执行代码：默认隔离，显式信任后才运行；沙箱只是纵深防御，不是授权边界。
2. 导入的 KG note / tag context / 未来的摘要会进入 prompt：按不可信数据处理，隔离期不喂给模型。
3. Zip-slip：`ZipReader` 已拒绝 `..` 与绝对路径；导入再加扁平白名单，且绝不用包内文件名当路径。
4. Zip bomb：声明大小前置限制 + `maxOutputLength` + 请求体上限 + 页/条目上限。
5. 篡改：逐文件校验和 + 重算 `documentHash`，任一不符即在写盘前终止。
6. 标识符与文件名由导入方控制：只用新 UUID，显示名净化，源文件固定存为 `source.pdf`。
7. 个人信息：导出/导入都剥 thread id；workctx 需显式选择；导入 KG 评分清零。
8. 密钥：清单只记模型名；测试断言不出现 `piApiKey`/`geminiApiKey`/带 token 的 URL。
9. Markdown：保持不启用 `rehype-raw`，导入的 `2d-text` 内容按纯 Markdown 渲染。
10. 并发：清单读改写按文档串行；所有落盘原子。

### 迁移

1. `saveDoc` 合并 meta，避免丢字段。
2. 现有文档没有哈希：首次访问懒回填，不批量重写 `extracted.json`。
3. `chunks.json v:1` 一次性重建，无用户可见损失。
4. `tags.json` / `kg.json` 保持 `v:1`，只加可选字段；升 `v` 会被现有 loader 丢弃。
5. P1 不扩展 `KnowledgeGraphStatus`，只在 state 响应里加 `resumable`。
6. 清单缺失/损坏绝不能影响 viewer/library，回退到推导状态。
7. 哈希规范冻结并版本化；不匹配就重算失效，绝不静默复用。
8. 导入失败清理半成品目录；`scripts/cleanup-orphans.mjs` 认识 `kg-parts/` 与 `manifest.json`。

---

## 8. 验证矩阵

| 门 | 命令 | 覆盖 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | 全部新增/修改模块（替代会 OOM 的 lint） |
| 构建 | `npm run build` | Next 16 路由/页面类型检查 |
| 哈希 | `npm run test:hash` | 稳定性、敏感性、懒回填写入 |
| 清单 | `npm run test:manifest` | 合成、部分状态、未知版本、并发 |
| 分块 | `npm run test:budget` | maxTokens/hash/builderVersion 失效、v1 忽略 |
| 检索 | `npm run test:retrieval` | 新签名下行为不变 |
| KG 恢复 | `npm run test:kg-resume` | 分片持久化、跳过已完成、reduce 一次、清理 |
| 产物包 | `npm run test:bundle` | 导出形状、round-trip、去重、校验和不符、zip-slip、bomb、隔离/信任 |
| 回归 | `test:errors` / `test:epub` / `test:md` / `test:pi` | 导入路径不回归 |
| 冒烟 | `npm run smoke`、`npm run smoke-all` | viewer 启动、标签/viz 仍正常 |
| 手动 | 上传样例 → 导出 `.getit` → 删除文档 → 导入 → 打开 → 启用 viz → 再导出 | 端到端 |

建议合并顺序：Step 1–3（身份 + 清单）一个 PR；Step 4–5（缓存 + prepare/恢复）一个；Step 6–9（产物包 + 信任 + UI）一个。哈希规范尽早冻结。

---

## 9. 待确认的取舍

1. **包内是否带 `source.pdf`**：建议带。viewer 依赖 `/api/pdf/<docId>`，只带 extracted 需要额外重排 PDF 的路径。
2. **workctx 默认是否随包**：建议默认不带，避免把个人对话历史带进“材料包”；需要时显式选择并剥 thread id。
3. **信任交互**：建议“隔离 + 显式启用”，而不是导入时静默重算 viz（重算要花钱，违背预处理初衷）。
4. **章节结构**：EPUB 目前被压平成 PDF，章节信息丢失。P3 的摘要树先靠字号/标题启发式；是否在 Ingest 引入 canonical document model（保留章节）留到 P3 评估。
5. **远程端点鉴权**：租赁机器的 URL/Key 是否允许保存明文（与现有 Pi 配置一致），还是走系统钥匙串；P2 再定。
