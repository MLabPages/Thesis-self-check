# Prototype Instructions

Run the local server yourself and open the preview in the in-app browser. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Product decisions (2026-09-30)

- 公開版では、AIの案内はAI機能を公開するときに表示する。未公開のAI機能の説明を常時表示しない。
- 参考文献の外部照合では、参考文献の記載をサーバーへ送信し、Crossref・CiNii Researchへ照会することを開始前に明記する。説明はスマートフォンでも表示する。
- 基本チェックの説明は実装した検出範囲に合わせる。指摘ゼロを論文全体の品質評価にしない。
- 基本結果を先に表示し、書誌照合の結果を順次追加する。結果は優先度順で表示する。
- 今回の改善は別ブランチで管理し、変更前の状態へ戻せるようにする。
