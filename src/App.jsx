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

const MAX_FILE_SIZE = 100 * 1024 * 1024;

const CHECKS = [
  {
    id: "format",
    label: "書式・提出形式",
    short: "書式",
    description: "体裁、章立て、ページ番号、図表番号、提出要件などを確認",
    details: ["見出しや章番号の整合", "ページ番号・目次・表紙", "フォントや段落などの体裁"],
    icon: FileDoc,
  },
  {
    id: "writing",
    label: "誤字脱字・文章表現",
    short: "文章",
    description: "誤字脱字、用語のゆれ、文法、表記の統一、冗長表現を確認",
    details: ["誤字脱字・助詞の誤り", "用語・表記・時制の統一", "長すぎる文や曖昧な表現"],
    icon: TextAa,
  },
  {
    id: "logic",
    label: "構成・論理展開",
    short: "構成",
    description: "構成の整合性、段落のつながり、論理の飛躍、重複を確認",
    details: ["研究目的と結論の対応", "章・節・段落のつながり", "根拠不足や論理の飛躍"],
    icon: TreeStructure,
  },
  {
    id: "figures",
    label: "図表",
    short: "図表",
    description: "図表の番号・タイトル、本文との対応、参照漏れを確認",
    details: ["番号・タイトル・出典", "本文からの参照", "図表の配置と説明"],
    icon: ChartBar,
  },
  {
    id: "citations",
    label: "引用・参考文献",
    short: "引用",
    description: "引用形式、出典、参考文献との整合性、文献の実在性を確認",
    details: [
      "直接引用・間接引用の区別",
      "本文と参考文献一覧の照合",
      "DOI・論文名・著者・掲載誌の書誌情報照合",
      "Web資料の閲覧日やURL",
    ],
    icon: Quotes,
  },
  {
    id: "ethics",
    label: "研究倫理・個人情報",
    short: "倫理",
    description: "不適切な表現、剽窃の疑い、個人情報の記載の有無を確認",
    details: ["個人情報と匿名化", "転載・剽窃への注意", "生成AI利用の申告確認"],
    icon: ShieldCheck,
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

function ResultsScreen({ documentData, findings, onBack }) {
  const [filter, setFilter] = useState("すべて");
  const categories = ["すべて", ...new Set(findings.map((finding) => finding.category))];
  const visible =
    filter === "すべて"
      ? findings
      : findings.filter((finding) => finding.category === filter);
  const important = findings.filter((finding) => finding.severity === "important").length;

  return (
    <div className="app-shell">
      <SiteHeader />
      <main className="results-page">
        <button className="back-button" type="button" onClick={onBack}>
          <ArrowLeft size={19} />
          設定に戻る
        </button>

        <div className="results-heading">
          <div>
            <span className="eyebrow">チェック完了</span>
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

        <div className="results-layout">
          <aside className="filter-panel">
            <div className="filter-title">
              <Funnel size={20} />
              表示する項目
            </div>
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
                現在は端末内で実行できる基本チェックです。AI詳細チェックを接続する場合も、
                氏名・メール・学籍番号候補をマスクしてから必要な段落だけを送信します。
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
                <strong>この分類で指摘はありません</strong>
                <p>最終確認は必ず学生本人と指導教員が行ってください。</p>
              </div>
            ) : (
              visible.map((finding) => (
                <article className={`finding-card severity-${finding.severity}`} key={finding.id}>
                  <div className="finding-meta">
                    <span>{finding.category}</span>
                    <b>{finding.location}</b>
                  </div>
                  <h4>{finding.title}</h4>
                  <div className="comparison">
                    <div>
                      <span>検出内容</span>
                      <p>{finding.original}</p>
                    </div>
                    <ArrowRight size={20} />
                    <div>
                      <span>修正・確認案</span>
                      <p>{finding.suggestion}</p>
                    </div>
                  </div>
                  <p className="finding-reason">
                    <Info size={16} />
                    {finding.reason}
                  </p>
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
  const [file, setFile] = useState(null);
  const [selected, setSelected] = useState(() => CHECKS.map((item) => item.id));
  const [expanded, setExpanded] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(0);
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
    setError("");
    setStatus("parsing");
    setProgress(0);
    setDocumentData(null);
    setFindings([]);
    if (!nextFile) return;

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
    setStatus("processing");
    setProgress(20);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    setProgress(60);
    const localFindings = runLocalChecks(documentData, selected);
    let combinedFindings = localFindings;
    if (useAi && aiEnabled) {
      try {
        const aiResult = await requestAiReview(documentData, selected);
        combinedFindings = [...localFindings, ...(aiResult.findings ?? [])];
      } catch (aiError) {
        combinedFindings = [
          ...localFindings,
          {
            id: crypto.randomUUID(),
            category: "AI詳細チェック",
            severity: "info",
            location: "文書全体",
            title: "AI詳細チェックを実行できませんでした",
            original: aiError.message,
            suggestion: "基本チェックの結果を確認し、公開環境のAPI設定を管理者へ確認してください。",
            reason: "Wordファイルや未マスクの個人情報は外部へ送信されていません。",
          },
        ];
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    setProgress(100);
    setFindings(combinedFindings);
    setStatus("complete");
  }

  if (status === "complete") {
    return (
      <ResultsScreen
        documentData={documentData}
        findings={findings}
        onBack={() => setStatus("ready")}
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
            <h2>Wordファイルをアップロード</h2>
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
                  元のWordではなく、個人情報候補をマスクした必要な段落だけを外部AIへ送信します。
                </small>
              </span>
            </label>
          )}

          <div className="section-heading checks-heading">
            <span>2.</span>
            <h2>チェック項目を選択</h2>
            <p>（すべてオンの状態でチェックされます）</p>
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
                <strong>文書をチェックしています…</strong>
                <span>{progress}%</span>
              </div>
              <div className="progress-track">
                <div style={{ width: `${progress}%` }} />
              </div>
              <p>ファイルはこのブラウザのメモリ上だけで処理されています。</p>
            </div>
          )}

          <button
            className="primary-button run-button"
            type="button"
            disabled={status === "processing" || status === "parsing"}
            onClick={startCheck}
          >
            <FileMagnifyingGlass size={29} />
            サイト上で結果を確認
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
              <h3>チェックの流れ（目安）</h3>
              <div className="flow-steps">
                {[
                  ["1", "アップロード", "30秒〜1分"],
                  ["2", "自動チェック", "2〜5分"],
                  ["3", "結果の生成", "1〜2分"],
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
