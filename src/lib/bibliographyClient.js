function bibliographyFinding(reference, result) {
  const location = `参考文献 ${reference.id.replace("ref", "")}`;

  if (result.status === "verified") {
    const match = result.bestMatch;
    return {
      id: crypto.randomUUID(),
      category: "引用・参考文献",
      severity: "info",
      location,
      title: "書誌情報と一致する文献が見つかりました",
      original: reference.text,
      suggestion: [
        `題名：${match.title || "不明"}`,
        `著者：${match.authors || "不明"}`,
        `掲載誌：${match.journal || "不明"}`,
        `発行年：${match.year || "不明"}`,
        `DOI：${match.doi || "なし"}`,
      ].join("\n"),
      reason:
        "Crossrefの書誌情報と高い一致が確認されました。最終的にはリンク先の原典も確認してください。",
      bibliography: result,
    };
  }

  if (result.status === "possible") {
    const match = result.bestMatch;
    return {
      id: crypto.randomUUID(),
      category: "引用・参考文献",
      severity: "warning",
      location,
      title: "類似する文献が見つかりました",
      original: reference.text,
      suggestion: [
        `候補題名：${match.title || "不明"}`,
        `候補著者：${match.authors || "不明"}`,
        `掲載誌：${match.journal || "不明"}`,
        `発行年：${match.year || "不明"}`,
        `DOI：${match.doi || "なし"}`,
      ].join("\n"),
      reason:
        "一部の書誌情報だけが一致しています。著者名、年、題名、掲載誌を原典と照合してください。",
      bibliography: result,
    };
  }

  return {
    id: crypto.randomUUID(),
    category: "引用・参考文献",
    severity: "important",
    location,
    title: "Crossrefでは一致する文献を確認できませんでした",
    original: reference.text,
    suggestion:
      "表記の誤りがないか確認し、日本語文献はCiNii Researchや国立国会図書館サーチでも検索してください。",
    reason:
      "見つからないことは架空文献を意味しません。Crossref未収録の紀要、書籍、日本語文献などがあります。",
    bibliography: result,
  };
}

export async function verifyBibliography(references) {
  const findings = [];
  const apiAvailable =
    !import.meta.env.DEV || import.meta.env.VITE_BIBLIOGRAPHY_API_ENABLED === "true";

  for (const reference of references) {
    if (!apiAvailable) {
      findings.push({
        id: crypto.randomUUID(),
        category: "引用・参考文献",
        severity: "info",
        location: `参考文献 ${reference.id.replace("ref", "")}`,
        title: "書誌照合は公開環境で実行されます",
        original: reference.text,
        suggestion: "Vercel公開版ではCrossrefの照合結果と原典候補を表示します。",
        reason: "通常のローカル開発サーバーには書誌照合APIがないため、外部通信を行っていません。",
      });
      continue;
    }
    try {
      const response = await fetch("/api/bibliography", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: reference.text }),
      });
      if (!response.ok) throw new Error("lookup unavailable");
      const result = await response.json();
      findings.push(bibliographyFinding(reference, result));
    } catch {
      findings.push({
        id: crypto.randomUUID(),
        category: "引用・参考文献",
        severity: "info",
        location: `参考文献 ${reference.id.replace("ref", "")}`,
        title: "書誌データベースへ接続できませんでした",
        original: reference.text,
        suggestion: "公開環境で再実行するか、Crossref・CiNii Researchで手動確認してください。",
        reason: "基本チェックは完了していますが、外部書誌照合APIを利用できませんでした。",
      });
    }
  }
  return findings;
}
