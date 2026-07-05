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

  if (result.bookLike) {
    return {
      id: crypto.randomUUID(),
      category: "引用・参考文献",
      severity: "info",
      location,
      title: "書籍のため自動照合の対象外です",
      original: reference.text,
      suggestion:
        "書籍は論文データベース（Crossref・CiNii）に載っていないことが多く、自動照合できません。Google Scholarや出版社ページで書誌情報を確認してください。",
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

export async function verifyBibliography(references, { onProgress } = {}) {
  const findings = [];
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(
    window.location.hostname,
  );
  const apiAvailable =
    import.meta.env.VITE_BIBLIOGRAPHY_API_ENABLED === "true" ||
    (!import.meta.env.DEV && !isLocalHost);

  if (!apiAvailable) {
    return [
      {
        id: crypto.randomUUID(),
        category: "引用・参考文献",
        severity: "info",
        location: "参考文献一覧",
        title: "書誌照合は公開環境で実行されます",
        original: `${references.length}件の参考文献を読み取りました。`,
        suggestion:
          "Vercel公開版ではCrossrefとCiNii Researchで照合し、差異がある項目だけを表示します。",
        reason:
          "通常のローカル開発サーバーには書誌照合APIがないため、ここではまとめて案内しています。",
      },
    ];
  }

  for (const [index, reference] of references.entries()) {
    if (index > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
    onProgress?.(index + 1, references.length);
    try {
      const response = await fetch("/api/bibliography", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: reference.text }),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (response.status === 404 || !contentType.includes("json")) {
        // APIそのものが存在しない環境（静的ホスティング等）。残りの照会を中止する
        findings.push(apiUnavailableFinding(references.length));
        break;
      }
      if (!response.ok) throw new Error("lookup unavailable");
      const result = await response.json();
      const finding = bibliographyFinding(reference, result);
      if (finding) findings.push(finding);
    } catch {
      findings.push({
        id: crypto.randomUUID(),
        category: "引用・参考文献",
        severity: "info",
        location: `参考文献 ${reference.id.replace("ref", "")}`,
        title: "書誌データベースへ接続できませんでした",
        original: reference.text,
        suggestion: "公開環境で再実行するか、CiNii Researchで手動確認してください。",
        reason: "基本チェックは完了していますが、外部書誌照合APIを利用できませんでした。",
      });
    }
  }
  return findings;
}
