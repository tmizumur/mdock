# Mdock

AI が書いた Markdown を、VS Code より速く・快適に読むためのデスクトップアプリです。
フォルダを開いてツリーからファイルを選び、2 画面に並べて読み比べられます。ちょっとした編集もできます。

## 主な機能

- フォルダを開く（メニュー / ⌘O / ウィンドウにドロップ）
- 左にファイルツリー（「.md のみ」で Markdown だけに絞り込み）
- Markdown のプレビュー（表・チェックボックス・コードハイライト・Mermaid 図）
- 左右 2 ペインの画面分割。境界をドラッグして幅を調整
- ペインごとに「表示 / 編集」を切り替え、⌘S で保存
- ファイルが外から書き換わったら自動で再表示（未保存の編集は上書きしません）
- 前回開いていたフォルダとファイルを起動時に復元

## 操作

| 操作 | キー |
| --- | --- |
| フォルダを開く | ⌘O |
| ツリーのファイルをもう片方のペインに開く | ⌘+クリック |
| 1 画面 / 2 画面 切り替え | ⌘\ |
| 左 / 右ペインを選ぶ | ⌘1 / ⌘2 |
| 表示 / 編集 切り替え | ⌘E |
| 保存 | ⌘S |

## 開発

必要なもの: Node.js 20 以上、Rust（`rustup`）、Xcode Command Line Tools

```bash
npm install
npm run tauri dev      # 開発モードで起動
npm run tauri build    # .app / .dmg を作成（src-tauri/target/release/bundle/）
```

## 技術構成

- [Tauri 2](https://tauri.app/)（Rust）: ファイル読み書き、フォルダ監視（notify）
- React + TypeScript + Vite
- markdown-it / Shiki / Mermaid（Shiki と Mermaid は必要になってから読み込み）
- CodeMirror 6（編集モードにしたときだけ読み込み）
- react-resizable-panels
