function differenceText(differences) {
  return differences
    .map(
      (difference) =>
        `${difference.field}\n記載：${difference.provided || "なし"}\n照合先：${difference.database || "なし"}`,
    )
    .join("\n\n");
}

function bibliographyFinding(reference, result) {
  const location = `参考文献 ${reference.id.replace("ref", "")}`;

  if (result.status === "verified") return null;

  if (result.status?.startsWith("source_")) {
    const sourceName = result.referenceType === "report" ? "報告書・PDF" : "Web資料";
    const titles = {
      source_verified: `${sourceName}の書誌情報が一致しました`,
      source_partial: `${sourceName}の書誌情報を一部確認しました`,
      source_mismatch: `${sourceName}の書誌情報に差異があります`,
      source_unavailable: `${sourceName}の原典を自動取得できませんでした`,
    };
    const errors = {
      blocked_url: "自動取得できる公開URLの条件を満たしていません。",
      timeout: "原典の取得に時間がかかり、通信を終了しました。",
      too_large: "自動取得のサイズ上限を超えています。",
      unsupported_format: "HTML・PDFとして読み取れない形式でした。",
      redirect_failed: "転送先の取得を完了できませんでした。",
      parse_failed: "資料の文字情報を読み取れませんでした。",
      access_restricted: "原典サイトの自動取得制限により、ページ情報を確認できませんでした。",
      http_404: "記載されたURLではページが見つかりませんでした（404）。",
      http_403: "原典サイトが自動取得を拒否しました（403）。",
      http_401: "原典サイトの認証が必要です（401）。",
    };
    const yearUnknown = result.comparisons?.some((row) => /年$/.test(row.field) && row.state === "unknown") && !result.metadata?.year;
    const dateAdvice = yearUnknown
      ? "公開・発行年は取得できませんでした。原典に年の記載がない場合は n.d. とし、閲覧日は別に記載してください。著作権年や閲覧年を公開年に置き換えないでください。"
      : result.dateState === "missing" ? "原典の公開／発行年の記載を参考文献に反映してください。閲覧日は別に記載してください。" : "閲覧日と引用形式は、提出先の指定に合わせて確認してください。";
    return {
      id: crypto.randomUUID(), category: "引用・参考文献", location,
      severity: result.status === "source_mismatch" ? "warning" : "info",
      title: titles[result.status], original: reference.text,
      suggestion: result.status === "source_unavailable"
        ? "「原典を開く」から、題名・作成者（団体）・公開／発行年を確認してください。"
        : result.status === "source_mismatch"
          ? `下の比較で「差異あり」の項目を原典で確認してください。${dateAdvice}`
          : result.status === "source_verified" ? `題名・作成者／発行元・公開／発行年の3項目を原典と照合しました。${dateAdvice}` : `取得できた項目を下に表示しています。「要確認」の項目を原典で確認してください。${dateAdvice}`,
      reason: result.status === "source_unavailable"
        ? `${errors[result.sourceError] ?? "原典への接続または読み取りを完了できませんでした。"}資料が存在しないという判定ではありません。`
        : `記載URLの原典から取得した情報との比較です。内容の正しさや引用の妥当性は判定していません。${(result.metadata?.notes ?? []).join(" ")}`,
      bibliography: result,
    };
  }

  if (result.status === "manual_source") {
    const isReport = result.referenceType === "report";
    return {
      id: crypto.randomUUID(),
      category: "引用・参考文献",
      severity: "info",
      location,
      title: isReport ? "Web上の報告書・PDFは原典で確認してください" : "Web資料は原典サイトで確認してください",
      original: reference.text,
      suggestion: "「原典を開く」から、資料名・作成者（団体）・公開年・URL・閲覧日を確認してください。閲覧年と公開年は区別して記載してください。",
      reason: "企業サイトやWeb上の報告書は、論文データベースの照合対象と区別しています。リンクの接続や内容の一致を自動確認した結果ではありません。",
      bibliography: result,
    };
  }

  if (result.status === "lookup_incomplete") {
    return {
      id: crypto.randomUUID(),
      category: "引用・参考文献",
      severity: "info",
      location,
      title: "書誌データベースの照合を一部または全部実行できませんでした",
      original: reference.text,
      suggestion: "時間をおいて再実行するか、原典や検索リンクで確認してください。",
      reason: `${(result.providerErrors ?? []).join("・")}への照会が完了していません。文献が見つからないという判定ではありません。`,
      bibliography: result,
    };
  }

  if (result.status === "mismatch") {
    return {
      id: crypto.randomUUID(),
      category: "引用・参考文献",
      severity: "warning",
      location,
      title: "書誌情報に差異があります",
      original: reference.text,
      suggestion: differenceText(result.differences),
      reason: `${result.bestMatch.provider}の候補と照合しました。記載順は判定せず、値が異なる項目だけを表示しています。データベース側が別の版・別の文献の可能性もあるため、「原典候補」リンクの内容も確認してください。`,
      bibliography: result,
    };
  }

  if (result.status === "doi_unconfirmed") {
    return {
      id: crypto.randomUUID(),
      category: "引用・参考文献",
      severity: "warning",
      location,
      title: "DOIを確認できませんでした",
      original: reference.text,
      suggestion:
        "DOIの文字列に入力ミスがないか確認し、DOIリンクまたは原典ページを開いてください。",
      reason:
        "記載されたDOIと完全一致する文献をCrossrefまたはCiNii Researchで確認できませんでした。データベース側の一時的な問題もあるため、誤りとは断定しません。",
      bibliography: result,
    };
  }

  if (result.bookLike) {
    return {
      id: crypto.randomUUID(),
      category: "引用・参考文献",
      severity: "info",
      location,
      title: "書籍の書誌情報を確定できませんでした",
      original: reference.text,
      suggestion:
        "書籍はCiNiiの横断検索でも書誌情報を確定できない場合があります。出版社ページや図書館の蔵書検索で確認してください。",
      reason:
        "文献が存在しない、または記載が誤っているという判定ではありません。書籍と判定した文献は照合結果を警告として表示しません。",
      bibliography: result,
    };
  }

  return {
    id: crypto.randomUUID(),
    category: "引用・参考文献",
    severity: "info",
    location,
    title: "自動照合で一致候補を確定できませんでした",
    original: reference.text,
    suggestion:
      "表記の誤りがないか確認し、CiNii ResearchまたはGoogle Scholarの検索結果を手動で確認してください。検索語を短くすると見つかる場合があります。",
    reason:
      "CrossrefとCiNii Researchの候補からは十分に確実な一致を選べませんでした。文献が存在しないという判定ではありません。",
    bibliography: result,
  };
}

function apiUnavailableFinding(referenceCount) {
  return {
    id: crypto.randomUUID(),
    category: "引用・参考文献",
    severity: "info",
    location: "参考文献一覧",
    title: "この公開環境では書誌照合を利用できません",
    original: `${referenceCount}件の参考文献を読み取りました。`,
    suggestion:
      "書誌照合APIが見つからないため、照合を中止しました。Vercel公開版で再実行するか、CiNii ResearchやGoogle Scholarで手動確認してください。",
    reason:
      "GitHub Pagesなどの静的ホスティングには書誌照合APIがありません。基本チェックの結果には影響しません。",
  };
}

export async function verifyBibliography(references, { onProgress, onFinding, signal } = {}) {
  const indexedFindings = [];
  signal?.throwIfAborted();
  function addFinding(index, finding) {
    if (signal?.aborted) return;
    indexedFindings.push({ index, finding });
    onFinding?.(finding);
  }
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(
    window.location.hostname,
  );
  const apiAvailable =
    import.meta.env.VITE_BIBLIOGRAPHY_API_ENABLED === "true" ||
    (!import.meta.env.DEV && !isLocalHost);

  if (!apiAvailable) {
    const findings = [
      {
        id: crypto.randomUUID(),
        category: "引用・参考文献",
        severity: "info",
        location: "参考文献一覧",
        title: "書誌照合は公開環境で実行されます",
        original: `${references.length}件の参考文献を読み取りました。`,
        suggestion:
          "Vercel公開版では論文をCrossref・CiNii Researchで照合し、URL付きWeb資料・PDFは原典から取得した情報を比較します。",
        reason:
          "通常のローカル開発サーバーには書誌照合APIがないため、ここではまとめて案内しています。",
      },
    ];
    findings.forEach((finding) => onFinding?.(finding));
    onProgress?.(references.length, references.length);
    return findings;
  }

  let cursor = 0;
  let completed = 0;
  let stopLookups = false;

  async function worker() {
    while (!stopLookups && !signal?.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= references.length) return;
      const reference = references[index];
      let failureStatus = null;
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      signal?.addEventListener("abort", abortRequest, { once: true });
      const timeout = window.setTimeout(abortRequest, 30_000);
      try {
        const response = await fetch("/api/bibliography", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: reference.text }),
          signal: requestController.signal,
        });
        const contentType = response.headers.get("content-type") ?? "";
        if (response.status === 404 || !contentType.includes("json")) {
          if (!stopLookups) {
            addFinding(-1, apiUnavailableFinding(references.length));
          }
          stopLookups = true;
          return;
        }
        if (!response.ok) {
          failureStatus = response.status;
          throw new Error("lookup unavailable");
        }
        const result = await response.json();
        const finding = bibliographyFinding(reference, result);
        if (finding) addFinding(index, finding);
      } catch {
        if (signal?.aborted) return;
        addFinding(index, {
            id: crypto.randomUUID(),
            category: "引用・参考文献",
            severity: "info",
            location: `参考文献 ${reference.id.replace("ref", "")}`,
            title: failureStatus === 403
              ? "このURLからの書誌照合は許可されていません"
              : "書誌データベースへ接続できませんでした",
            original: reference.text,
            suggestion: failureStatus === 403
              ? "管理者に、この公開URLの書誌照合APIの許可設定を確認してもらってください。基本チェックの結果はそのまま利用できます。"
              : "公開環境で再実行するか、CiNii Researchで手動確認してください。",
            reason: failureStatus === 403
              ? "本サービスのAPIがアクセスを拒否しました（403）。文献が存在しない、または書誌データベースが停止しているという判定ではありません。"
              : "基本チェックは完了していますが、外部書誌照合APIを利用できませんでした。",
        });
      } finally {
        window.clearTimeout(timeout);
        signal?.removeEventListener("abort", abortRequest);
        completed += 1;
        if (!signal?.aborted) onProgress?.(completed, references.length);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, references.length) }, () => worker()));
  signal?.throwIfAborted();
  return indexedFindings
    .sort((left, right) => left.index - right.index)
    .map((item) => item.finding);
}
