# 2026-10-07 開発サーバーとビルド依存の更新
- Viteを6.4.2から6.4.4へ更新し、Windowsの代替パスによるserver.fs.deny回避とUNCパス処理に関する警告を解消した。
- 同じ互換範囲のsource-map-js/PostCSS/nanoid/Browserslist関連の依存を更新した。
- npm run verify:rules、npm run verify:bibliography、npm run verify:sources、npm run build、git diff --check成功。
- npm auditの最終結果は0件。これは当日の依存データベースに基づく結果で、アプリ全体の安全保証ではない。
- 論文データ、照合ルール、公開AI導線は今回変更していない。
