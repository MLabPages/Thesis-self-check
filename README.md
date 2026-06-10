# 論文セルフチェック

卒業論文の `.docx` をブラウザ内で解析し、提出前の確認結果をサイト上に表示する
React/Viteアプリです。

## 現在動く機能

- Word本文・見出し・表・脚注・参考文献のブラウザ内抽出
- チェック分類の選択
- 書式、文章、構成、図表、引用、個人情報の基本チェック
- 指摘箇所、修正案、理由のサイト表示
- AI送信前のメールアドレス・電話番号・学籍番号候補のマスク
- Crossref書誌照合用API

元のWordファイルはサーバーへ送信しません。

## ローカル起動

```bash
npm install
npm run dev
```

## AI詳細チェック

Vercelなどのサーバー環境で次を設定します。

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
VITE_AI_REVIEW_ENABLED=true
CROSSREF_MAILTO=管理者のメールアドレス
```

APIキーはフロントエンドやGitHubへ記載しないでください。`/api/review` は
マスク済みの構造化テキストだけをOpenAI Responses APIへ送信し、`store: false`
を指定します。

OpenAI APIでは入力内容は標準で学習に使用されませんが、通常のAPI利用では
不正利用監視ログが最大30日保持される場合があります。厳密な非保持が必要な場合は
Zero Data Retentionの承認、または大学内で動作するAI基盤を利用してください。

## 公開

Vercelへこのリポジトリをインポートします。ビルド設定はViteとして自動認識されます。
AIを利用する場合は、VercelのEnvironment Variablesへ上記3変数を設定します。

GitHub Pagesは静的サイトのみのため、`api/`のAI・書誌照合機能は動作しません。

Vercel公開版では、参考文献をCrossrefへ照会し、題名・著者・掲載誌・発行年・
DOIと原典候補へのリンクを結果画面に表示します。Crossrefで見つからない場合は、
架空文献とは断定せず、CiNii Researchなどでの再確認を促します。
