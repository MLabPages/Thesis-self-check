import { useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Books,
  CaretDown,
  CaretRight,
  Check,
  ClipboardText,
  Clock,
  FileDoc,
  FileMagnifyingGlass,
  Funnel,
  GearSix,
  Info,
  ListChecks,
  LockKey,
  MagnifyingGlass,
  Quotes,
  ShieldCheck,
  Table,
  TextAa,
  TreeStructure,
  UploadSimple,
  Warning,
  X,
  ChartBar,
} from "@phosphor-icons/react";
import { parseDocx } from "./lib/docxParser";
import { runLocalChecks } from "./lib/localChecks";
import { requestAiReview } from "./lib/aiClient";
import { verifyBibliography } from "./lib/bibliographyClient";

const MAX_FILE_SIZE = 100 * 1024 * 1024;

const CHECKS = [
  {
    id: "format",
    label: "書式・提出形式",
    short: "書式",
    description: "Wordの見出しスタイルと見出しレベルの飛びを確認",
    details: ["見出しスタイルの有無", "見出しレベルの飛び", "ページ番号・目次・表紙・フォント・提出要件は本人が確認"],
    icon: FileDoc,
  },
  {
    id: "writing",
    label: "誤字脱字・文章表現",
    short: "文章",
    description: "助詞・句読点の重複、表記ゆれ、文体の混在などの修正候補を確認",
    details: ["助詞・句読点の重複、全角・半角の混在", "登録した用語の表記ゆれ、文体の混在", "構造が複雑な文の候補（誤字や文法全般の網羅的な検査ではありません）"],
    icon: TextAa,
  },
  {
    id: "logic",
    label: "構成・論理展開",
    short: "構成",
    description: "研究目的や結論・考察に関する語の有無を確認",
    details: ["研究目的に関する語の有無", "結論・考察に関する語の有無", "目的と結論の対応・論理の妥当性は本人が確認"],
    icon: TreeStructure,
  },
  {
    id: "figures",
    label: "図表",
    short: "図表",
    description: "図表番号の欠番候補とキャプション付近の出典表記を確認",
    details: ["本文中の図表番号の欠番候補（章別番号は対象外）", "キャプション前後の出典・自作表記", "図表の配置・内容と本文の対応は本人が確認"],
    icon: ChartBar,
  },
  {
    id: "citations",
    label: "引用・参考文献",
    short: "引用",
    description: "参考文献一覧・発行年の有無と、書誌情報・Web原典を照合",
    details: [
      "参考文献一覧の認識、発行年の記載候補",
      "Crossref・CiNii Researchとの書誌情報照合（外部送信あり）",
      "URL付きWeb資料・PDFの題名、発行元、年を原典と比較（n.d.対応）",
      "一致を確認できなくても、文献が存在しないとは判定しません",
      "本文の引用と一覧の対応・引用形式・閲覧日は本人が確認",
    ],
    icon: Quotes,
  },
  {
    id: "ethics",
    label: "研究倫理・個人情報",
    short: "倫理",
    description: "メールアドレス・電話番号・学籍番号の候補を検出",
    details: ["メールアドレス・電話番号・学籍番号の候補", "氏名・掲載同意・匿名化の適切さは本人が確認", "剽窃・転載許可・生成AI利用の申告は自動判定しません"],
    icon: ShieldCheck,
  },
  {
    id: "completion",
    label: "研究内容・妥当性",
    short: "妥当性",
    description: "特定の語や表現を手がかりに、研究内容を見直す確認事項を提示",
    details: [
      "先行研究・調査設計・考察に関する語の有無",
      "箇条書きや個人的経験の表現に関する確認候補",
      "研究内容の正しさ・新規性・妥当性は自動判定しません",
    ],
    icon: ClipboardText,
  },
];

function Checkbox({ checked, onChange, label }) {
  return (
    <button
      className={`checkbox ${checked ? "is-checked" : ""}`}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
    >
      {checked && <Check size={17} weight="bold" />}
    </button>
  );
}

function SiteHeader() {
  return (
    <header className="site-header">
      <div className="brand">
        <h1>論文セルフチェック</h1>
        <p>提出前に、自分の論文を客観的にチェックできます。</p>
      </div>
      <div className="header-privacy">
        <ShieldCheck size={29} />
        <p>
          <strong>プライバシー保護：</strong>
          Wordファイルはブラウザ内で解析し、
          <br />
          元ファイルを外部へ送信・保存しません。
        </p>
      </div>
    </header>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-button"
      type="button"
      title="コピーした文をWordの検索（Ctrl+F）に貼り付けると該当箇所へ移動できます"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          /* クリップボードが使えない環境では何もしない */
        }
      }}
    >
      <ClipboardText size={14} />
      {copied ? "コピーしました" : "原文をコピー"}
    </button>
  );
}

function HighlightedText({ text, ranges }) {
  if (!Array.isArray(ranges) || ranges.length === 0) return text;
  const parts = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end > text.length) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark className="finding-highlight" key={start}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts;
}

function ResultGuidance({ findings, pending, incomplete }) {
  const important = findings.filter((finding) => finding.severity === "important").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const infos = findings.filter((finding) => finding.severity === "info").length;
  const actionable = findings.filter((finding) => finding.severity !== "info");
  const priorityCategories = [...new Set(
    actionable
      .sort((left, right) => (left.severity === "important" ? 0 : 1) - (right.severity === "important" ? 0 : 1))
      .map((finding) => finding.category),
  )].slice(0, 3);

  return (
    <section className="result-guidance">
      <div>
        <span className="guidance-icon">
          <Check size={22} weight="bold" />
        </span>
      </div>
      <div>
        <h3>{pending ? "基本結果を表示しています" : incomplete ? "照合済みの範囲の結果を表示しています" : findings.length === 0 ? "選択したチェックでは指摘がありません" : actionable.length === 0 ? "補足情報・照合結果を確認してください" : "一度に全部直さなくて大丈夫です"}</h3>
        <p>
          {findings.length === 0
            ? (pending ? "基本チェックでは指摘がありません。追加チェックの完了まで、結果は更新されます。" : "自動検出できる範囲での結果です。未選択の分類や、ページ番号・引用の対応・研究内容などは自分で確認してください。")
            : `まずは優先確認 ${important}件、次に修正候補 ${warnings}件を見ます。補足情報 ${infos}件は、余裕があるときに確認してください。`}
        </p>
        {priorityCategories.length > 0 && (
          <p className="guidance-next">
            先に見るとよい順番：
            <strong>{priorityCategories.join(" → ")}</strong>
          </p>
        )}
      </div>
    </section>
  );
}

function ResultsScreen({ documentData, findings, checkedIds, bibliography, stageText, onStop, onBack }) {
  const [filter, setFilter] = useState("すべて");
  const [onlyImportant, setOnlyImportant] = useState(false);
  const pending = bibliography.status === "running" || Boolean(stageText);
  const incomplete = ["cancelled", "failed"].includes(bibliography.status);
  const severityOrder = { important: 0, warning: 1, info: 2 };
  const categories = ["すべて", ...new Set(findings.map((finding) => finding.category))];
  const visible = findings
    .filter((finding) => (filter === "すべて" || finding.category === filter) && (!onlyImportant || finding.severity === "important"))
    .sort((left, right) => (severityOrder[left.severity] ?? 2) - (severityOrder[right.severity] ?? 2));
  const important = findings.filter((finding) => finding.severity === "important").length;

  return (
    <div className="app-shell">
      <SiteHeader />
      <main className="results-page">
        <div className="results-toolbar">
          <button className="back-button" type="button" onClick={onBack}>
            <ArrowLeft size={19} />
            設定に戻る
          </button>
          <button
            className="print-button"
            type="button"
            onClick={() => {
              setFilter("すべて");
              setOnlyImportant(false);
              window.setTimeout(() => window.print(), 100);
            }}
          >
            <FileDoc size={17} />
            結果を印刷 / PDFに保存
          </button>
        </div>

        <div className="results-heading">
          <div>
            <span className="eyebrow">{pending ? "基本チェック完了・追加チェック中" : incomplete ? "基本チェック完了・書誌照合は未完了" : "チェック完了"}</span>
            <h2>{documentData.fileName}</h2>
            <p>元のWordファイルは外部へ送信されていません。</p>
          </div>
          <div className="result-kpis">
            <div>
              <strong>{findings.length}</strong>
              <span>指摘・確認事項</span>
            </div>
            <div>
              <strong>{important}</strong>
              <span>優先して確認</span>
            </div>
            <div>
              <strong>{documentData.stats.characters.toLocaleString()}</strong>
              <span>本文文字数</span>
            </div>
          </div>
        </div>

        <section className="document-overview">
          {[
            [TreeStructure, "見出し", documentData.stats.headings],
            [TextAa, "本文段落", documentData.stats.paragraphs],
            [ChartBar, "図", documentData.stats.figures ?? 0],
            [Table, "表", documentData.stats.tables],
            [Info, "脚注", documentData.stats.footnotes],
            [Books, "参考文献", documentData.stats.references],
          ].map(([Icon, label, value]) => (
            <div key={label}>
              <Icon size={22} />
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </section>

        <section className="checked-scope">
          <strong>今回実行した分類：</strong>
          {CHECKS.filter((item) => checkedIds.includes(item.id)).map((item) => item.label).join("・")}
          <p>自動チェックは修正・確認の候補を提示します。指摘がないことは、提出要件の充足や研究内容の正しさを保証するものではありません。</p>
        </section>

        {bibliography.status !== "idle" && (
          <section className="bibliography-progress" aria-live="polite">
            <p>
              {bibliography.status === "running"
                ? `参考文献を照合しています… ${bibliography.done} / ${bibliography.total}件。基本結果は下で確認できます。`
                : bibliography.status === "cancelled"
                  ? "参考文献の照合を中止しました。未照合の文献が残っています。表示済みの結果は確認できます。"
                  : bibliography.status === "failed"
                    ? "参考文献の照合を完了できませんでした。基本結果と表示済みの照合結果を確認してください。"
                    : "参考文献の照合処理が終了しました。一致・未確認・接続エラーの扱いは各確認事項をご覧ください。"}
            </p>
            {bibliography.status === "running" && <button type="button" onClick={onStop}>照合を中止</button>}
          </section>
        )}
        {stageText && <p className="parsing-note" aria-live="polite">{stageText}</p>}

        <ResultGuidance findings={findings} pending={pending} incomplete={incomplete} />

        <div className="results-layout">
          <aside className="filter-panel">
            <div className="filter-title">
              <Funnel size={20} />
              表示する項目
            </div>
            <label className="priority-filter">
              <input type="checkbox" checked={onlyImportant} onChange={(event) => setOnlyImportant(event.target.checked)} />
              優先確認だけ表示
            </label>
            {categories.map((category) => (
              <button
                className={filter === category ? "is-active" : ""}
                type="button"
                key={category}
                onClick={() => setFilter(category)}
              >
                {category}
                <span>
                  {category === "すべて"
                    ? findings.length
                    : findings.filter((finding) => finding.category === category).length}
                </span>
              </button>
            ))}
            <div className="ai-note">
              <ShieldCheck size={20} />
              <p>
                基本チェックは端末内で実行します。「引用・参考文献」を選ぶと、参考文献の記載を本サービスのサーバーへ送信します。論文・書籍はCrossref・CiNii Researchへ照会し、URL付きWeb資料・PDFは記載URLへ接続して原典の情報を取得します。原典サイトへ参考文献の記載全体は送信しません。元のWordファイルは送信しません。
              </p>
            </div>
          </aside>

          <section className="finding-list">
            <div className="finding-list-title">
              <ListChecks size={23} />
              <h3>{filter}</h3>
              <span>{visible.length}件</span>
            </div>
            {visible.length === 0 ? (
              <div className="empty-findings">
                <Check size={28} weight="bold" />
                <strong>{onlyImportant ? "この表示条件で優先確認はありません" : pending ? "現在、この分類の指摘はありません" : "この分類で指摘はありません"}</strong>
                <p>最終確認は必ず学生本人と指導教員が行ってください。</p>
              </div>
            ) : (
              visible.map((finding) => (
                <article className={`finding-card severity-${finding.severity}`} key={finding.id}>
                  <div className="finding-meta">
                    <span>{finding.category}</span>
                    <span className="severity-label">{finding.bibliography?.status === "source_verified" ? "照合済み" : { important: "優先確認", warning: "修正候補", info: "補足情報" }[finding.severity] ?? "補足情報"}</span>
                    <b>{finding.location}</b>
                  </div>
                  <h4>{finding.title}</h4>
                  <div className="comparison">
                    <div>
                      <div className="comparison-label">
                        <span>確認した箇所</span>
                        <CopyButton text={finding.original} />
                      </div>
                      <p>
                        <HighlightedText text={finding.original} ranges={finding.ranges} />
                      </p>
                    </div>
                    <ArrowRight size={20} />
                    <div>
                      <span>次にやること</span>
                      <p>{finding.suggestion}</p>
                    </div>
                  </div>
                  {finding.bibliography?.comparisons && (
                    <div className="source-comparisons" aria-label="原典との書誌情報比較">
                      {finding.bibliography.comparisons.map((row) => (
                        <div className={`source-comparison state-${row.state}`} key={row.field}>
                          <div className="source-comparison-heading"><b>{row.field}</b><span>{{ match: "一致", different: "差異あり", unknown: "要確認" }[row.state]}</span></div>
                          <dl>
                            <div><dt>参考文献の記載</dt><dd>{row.provided}</dd></div>
                            <div><dt>原典から取得</dt><dd>{row.source}{row.evidence && <small>根拠：{row.evidence}</small>}</dd></div>
                          </dl>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="finding-reason">
                    <Info size={16} />
                    {finding.reason}
                  </p>
                  {finding.bibliography?.links && (
                    <div className="bibliography-links">
                      {finding.bibliography.links.source && (
                        <a href={finding.bibliography.links.source} target="_blank" rel="noreferrer">
                          {finding.bibliography.status === "manual_source" || finding.bibliography.status?.startsWith("source_") ? "原典を開く" : "原典候補"}
                          <ArrowRight size={15} />
                        </a>
                      )}
                      {finding.bibliography.links.doi && (
                        <a href={finding.bibliography.links.doi} target="_blank" rel="noreferrer">
                          DOIを確認
                          <ArrowRight size={15} />
                        </a>
                      )}
                      {finding.bibliography.links.cinii && (
                        <a href={finding.bibliography.links.cinii} target="_blank" rel="noreferrer">
                          CiNii Research
                          <ArrowRight size={15} />
                        </a>
                      )}
                      {finding.bibliography.links.scholar && (
                        <a href={finding.bibliography.links.scholar} target="_blank" rel="noreferrer">
                          Google Scholarで手動確認
                          <ArrowRight size={15} />
                        </a>
                      )}
                    </div>
                  )}
                </article>
              ))
            )}
          </section>
        </div>
      </main>
      <footer>
        <ShieldCheck size={18} />
        解析結果はブラウザを閉じると消去されます
      </footer>
    </div>
  );
}

export function App() {
  const inputRef = useRef(null);
  const reviewControllerRef = useRef(null);
  const [checkedIds, setCheckedIds] = useState([]);
  const [bibliography, setBibliography] = useState({ status: "idle", done: 0, total: 0 });
  const [file, setFile] = useState(null);
  const [selected, setSelected] = useState(() => CHECKS.map((item) => item.id));
  const [expanded, setExpanded] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState("idle");
  const [stageText, setStageText] = useState("");
  const [error, setError] = useState("");
  const [documentData, setDocumentData] = useState(null);
  const [findings, setFindings] = useState([]);
  const [useAi, setUseAi] = useState(false);
  const aiEnabled = import.meta.env.VITE_AI_REVIEW_ENABLED === "true";

  const allSelected = selected.length === CHECKS.length;
  const selectedChecks = useMemo(
    () => CHECKS.filter((item) => selected.includes(item.id)),
    [selected],
  );

  async function chooseFile(nextFile) {
    if (!nextFile) return;
    setError("");
    setStatus("parsing");
    setStageText("");
    setDocumentData(null);
    setFile(null);
    setFindings([]);

    const isDocx =
      nextFile.name.toLowerCase().endsWith(".docx") ||
      nextFile.type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    if (!isDocx) {
      setError("Wordファイル（.docx）を選択してください。");
      setStatus("idle");
      return;
    }
    if (nextFile.size > MAX_FILE_SIZE) {
      setError("ファイルサイズは100MB以下にしてください。");
      setStatus("idle");
      return;
    }
    try {
      const parsed = await parseDocx(nextFile);
      setFile(nextFile);
      setDocumentData(parsed);
      setStatus("ready");
    } catch (parseError) {
      setFile(null);
      setStatus("idle");
      setError(parseError.message || "Wordファイルを解析できませんでした。");
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function toggleCheck(id) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
    setStatus("idle");
  }

  function toggleAll() {
    setSelected(allSelected ? [] : CHECKS.map((item) => item.id));
    setStatus("idle");
  }

  function toggleDetails(id) {
    setExpanded((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  async function startCheck() {
    if (!file) {
      setError("チェックするWordファイルを選択してください。");
      inputRef.current?.focus();
      return;
    }
    if (selected.length === 0) {
      setError("チェック項目を1つ以上選択してください。");
      return;
    }

    setError("");
    if (!documentData) {
      setError("Wordファイルの解析が完了していません。");
      return;
    }
    reviewControllerRef.current?.abort();
    const controller = new AbortController();
    reviewControllerRef.current = controller;
    const isCurrent = () => reviewControllerRef.current === controller && !controller.signal.aborted;
    const runIds = [...selected];
    setCheckedIds(runIds);
    setFindings(runLocalChecks(documentData, runIds));
    const shouldVerify = runIds.includes("citations") && documentData.references.length > 0;
    setBibliography({ status: shouldVerify ? "running" : "idle", done: 0, total: documentData.references.length });
    setStageText("");
    setStatus("complete");
    window.scrollTo({ top: 0 });

    if (shouldVerify) {
      try {
        await verifyBibliography(documentData.references, {
          signal: controller.signal,
          onFinding: (finding) => {
            if (isCurrent()) setFindings((current) => [...current, finding]);
          },
          onProgress: (done, total) => {
            if (isCurrent()) setBibliography({ status: "running", done, total });
          },
        });
        if (isCurrent()) setBibliography((current) => ({ ...current, status: "done" }));
      } catch {
        if (isCurrent()) setBibliography((current) => ({ ...current, status: "failed" }));
      }
    }
    if (!isCurrent()) return;
    if (useAi && aiEnabled) {
      setStageText("AI詳細チェックを実行しています…（数十秒かかることがあります）");
      try {
        const aiResult = await requestAiReview(documentData, runIds, controller.signal);
        if (isCurrent()) setFindings((current) => [...current, ...(aiResult.findings ?? [])]);
      } catch (aiError) {
        if (isCurrent()) setFindings((current) => [...current, {
          id: crypto.randomUUID(),
          category: "AI詳細チェック",
          severity: "info",
          location: "文書全体",
          title: "AI詳細チェックを実行できませんでした",
          original: aiError.message,
          suggestion: "基本チェックの結果を確認し、公開環境のAPI設定を管理者へ確認してください。",
          reason: "元のWordファイルは外部へ送信されていません。",
        }]);
      } finally {
        if (isCurrent()) setStageText("");
      }
    }
  }

  function stopReview() {
    reviewControllerRef.current?.abort();
    reviewControllerRef.current = null;
    setBibliography((current) => current.status === "running" ? { ...current, status: "cancelled" } : current);
    setStageText("");
  }

  if (status === "complete") {
    return (
      <ResultsScreen
        documentData={documentData}
        findings={findings}
        checkedIds={checkedIds}
        bibliography={bibliography}
        stageText={stageText}
        onStop={stopReview}
        onBack={() => { stopReview(); setStatus("ready"); }}
      />
    );
  }

  return (
    <div className="app-shell">
      <SiteHeader />

      <main className="workspace">
        <section className="main-column">
          <div className="section-heading">
            <span>1.</span>
            <h2>Wordファイルを選択</h2>
          </div>

          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(event) => chooseFile(event.target.files?.[0])}
          />

          <div
            className={`drop-zone ${isDragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              event.preventDefault();
              if (event.currentTarget === event.target) setIsDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              chooseFile(event.dataTransfer.files?.[0]);
            }}
          >
            {file ? (
              <div className="file-selected">
                <span className="file-icon">
                  <FileDoc size={32} />
                </span>
                <div>
                  <strong>{file.name}</strong>
                  <span>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="選択したファイルを削除"
                  onClick={() => {
                    setFile(null);
                    setStatus("idle");
                    setDocumentData(null);
                    setFindings([]);
                    if (inputRef.current) inputRef.current.value = "";
                  }}
                >
                  <X size={22} />
                </button>
              </div>
            ) : (
              <>
                <UploadSimple size={49} weight="light" />
                <p>
                  ここに Word ファイル（.docx）をドラッグ＆ドロップ
                  <br />
                  または
                </p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => inputRef.current?.click()}
                >
                  ファイルを選択
                </button>
              </>
            )}
          </div>

          <div className="file-help">
            <Info size={18} />
            <span>対応形式：.docx（Word 2013以降）</span>
            <i />
            <span>ファイルサイズ：100MBまで</span>
          </div>

          {status === "parsing" && (
            <div className="parsing-note" aria-live="polite">
              <MagnifyingGlass size={19} />
              Wordファイルをブラウザ内で解析しています…
            </div>
          )}

          {documentData && (
            <div className="parsed-summary">
              <strong>文書を読み取りました</strong>
              <span>本文 {documentData.stats.paragraphs}段落</span>
              <span>見出し {documentData.stats.headings}件</span>
              <span>図 {documentData.stats.figures ?? 0}件</span>
              <span>表 {documentData.stats.tables}件</span>
              <span>脚注 {documentData.stats.footnotes}件</span>
              <span>参考文献 {documentData.stats.references}件</span>
            </div>
          )}

          {aiEnabled && documentData && (
            <label className="ai-consent">
              <input
                type="checkbox"
                checked={useAi}
                onChange={(event) => setUseAi(event.target.checked)}
              />
              <span>
                <strong>AIによる詳細チェックを利用する</strong>
                <small>
                  元のWordではなく、個人情報候補をマスクした本文の抽出テキストを外部AIへ送信します。
                  引用・参考文献を選んだ場合は参考文献一覧も対象です。
                </small>
              </span>
            </label>
          )}

          <div className="section-heading checks-heading">
            <span>2.</span>
            <h2>チェック項目を選択</h2>
            <p>（初期状態はすべて選択）</p>
          </div>

          <div className="master-row">
            <div className="master-control">
              <Checkbox checked={allSelected} onChange={toggleAll} label="すべてチェック" />
              <strong>すべてチェック</strong>
            </div>
            <button
              className="details-control"
              type="button"
              onClick={() =>
                setExpanded(
                  expanded.length === CHECKS.length ? [] : CHECKS.map((item) => item.id),
                )
              }
            >
              <GearSix size={21} />
              詳細を調整
            </button>
          </div>

          <div className="check-list">
            {CHECKS.map((item) => {
              const Icon = item.icon;
              const isSelected = selected.includes(item.id);
              const isExpanded = expanded.includes(item.id);
              return (
                <div className="check-item" key={item.id}>
                  <div
                    className="check-item-main"
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleCheck(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleCheck(item.id);
                      }
                    }}
                  >
                    <Checkbox
                      checked={isSelected}
                      onChange={() => toggleCheck(item.id)}
                      label={`${item.label}をチェック`}
                    />
                    <span className="category-icon">
                      <Icon size={28} />
                    </span>
                    <strong>{item.label}</strong>
                    <p>{item.description}</p>
                    <button
                      className="expand-button"
                      type="button"
                      aria-label={`${item.label}の詳細`}
                      aria-expanded={isExpanded}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleDetails(item.id);
                      }}
                    >
                      {isExpanded ? <CaretDown size={20} /> : <CaretRight size={20} />}
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="check-details">
                      {item.details.map((detail) => (
                        <span key={detail}>
                          <Check size={14} weight="bold" />
                          {detail}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {error && (
            <div className="error-message" role="alert">
              <Warning size={19} weight="fill" />
              {error}
            </div>
          )}

          {status === "processing" && (
            <div className="processing" aria-live="polite">
              <div>
                <FileMagnifyingGlass size={22} />
                <strong>{stageText || "文書をチェックしています…"}</strong>
              </div>
              <div className="progress-track">
                <div className="progress-indeterminate" />
              </div>
              <p>ファイルはこのブラウザのメモリ上だけで処理されています。</p>
            </div>
          )}

          <div className="external-disclosure">
            <ShieldCheck size={20} />
            <p><strong>データの処理について</strong><br />
              基本チェックは端末内で実行し、元のWordファイルは送信しません。
              「引用・参考文献」を選ぶと、参考文献の記載を本サービスのサーバーへ送信します。論文・書籍はCrossref・CiNii Researchへ照会し、URL付きWeb資料・PDFは記載URLへ接続して原典の情報を取得します。原典サイトへ参考文献の記載全体は送信しません。本文は書誌照合のために送信しません。
            </p>
          </div>

          <button
            className="primary-button run-button"
            type="button"
            disabled={status === "processing" || status === "parsing"}
            onClick={startCheck}
          >
            <FileMagnifyingGlass size={29} />
            チェックを開始
            <ArrowRight size={25} />
          </button>
          <p className="duration-note">基本チェックは端末内で処理されます。</p>
        </section>

        <aside className="summary-panel">
          <div className="summary-title">
            <ClipboardText size={31} />
            <h2>今回のチェック</h2>
          </div>

          <div className="selected-summary">
            <span>選択中のチェック項目</span>
            <div>
              <strong>{selected.length}</strong>
              <b>/ {CHECKS.length} 項目</b>
            </div>
            <p>
              {selected.length === CHECKS.length
                ? "すべての項目をチェックします。"
                : selected.length === 0
                  ? "チェック項目が選択されていません。"
                  : `${selectedChecks.map((item) => item.short).join("・")}をチェックします。`}
            </p>
          </div>

          <div className="summary-section privacy-section">
            <span className="summary-icon">
              <LockKey size={28} />
            </span>
            <div>
              <h3>Wordファイルは外部へ送りません</h3>
              <p>
                Wordファイルはこのブラウザのメモリ上で展開・解析され、
                サーバーへアップロードされません。
                <br />
                ブラウザを閉じると解析内容も消去されます。
              </p>
            </div>
          </div>

          <div className="summary-section flow-section">
            <span className="summary-icon">
              <Clock size={28} />
            </span>
            <div className="flow-content">
              <h3>チェックの流れ（目安・基本チェック時）</h3>
              <div className="flow-steps">
                {[
                  ["1", "ファイル選択", "数秒"],
                  ["2", "自動チェック", "数秒〜1分"],
                  ["3", "結果の表示", "すぐ"],
                ].map(([number, label, time], index) => (
                  <div className="flow-step" key={number}>
                    <span>{number}</span>
                    <strong>{label}</strong>
                    <small>{time}</small>
                    {index < 2 && <ArrowRight className="flow-arrow" size={22} />}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="summary-section return-section">
            <span className="summary-icon">
              <FileDoc size={27} />
            </span>
            <div>
              <h3>サイト上に表示される内容</h3>
              <ul>
                <li>
                  <span className="mark correction" />
                  <strong>修正候補</strong>
                  <p>表記ゆれや誤りに対する修正案を表示</p>
                </li>
                <li>
                  <span className="mark comment" />
                  <strong>コメント</strong>
                  <p>理由や補足説明を指摘ごとに表示</p>
                </li>
                <li>
                  <Warning className="warning-mark" size={21} weight="fill" />
                  <strong>確認が必要な箇所</strong>
                  <p>実在性を確認できない文献などをハイライト</p>
                </li>
              </ul>
            </div>
          </div>

          <div className="notice">
            <Info size={21} weight="bold" />
            <div>
              <strong>ご利用にあたっての注意</strong>
              <p>
                本サービスは、客観的な観点からのチェック結果を提供するものです。
                研究内容の妥当性や新規性、学術的な評価など、主観的な判断を要する
                事項については、あくまで提案としてご活用ください。
                <br />
                最終的な責任は著者ご自身にあります。
              </p>
            </div>
          </div>
        </aside>
      </main>

      <footer>
        <ShieldCheck size={18} />
        Wordファイルはブラウザ内だけで解析されます
      </footer>
    </div>
  );
}
