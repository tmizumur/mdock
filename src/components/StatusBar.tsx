import { useMemo } from "react";
import { isMarkdown } from "../lib/api";
import type { Tab } from "../lib/tabs";

type Props = {
  live: boolean;
  branch: string | null;
  modified: number;
  added: number;
  tab: Tab | undefined;
  fontSize: number;
};

const format = new Intl.NumberFormat("ja-JP");

export default function StatusBar({ live, branch, modified, added, tab, fontSize }: Props) {
  const content = tab?.kind === "doc" ? tab.content : undefined;
  const count = useMemo(() => content === undefined ? null : Array.from(content.replace(/\s/g, "")).length, [content]);
  const path = tab?.kind === "doc" ? tab.path : tab && `${tab.left} ↔ ${tab.right}`;

  return (
    <footer className="status-bar" aria-label="ステータスバー">
      <span className="live-status"><i className={live ? "on" : ""} aria-hidden="true" />{live ? "ライブ反映中" : "ライブ反映なし"}</span>
      {branch && (
        <>
          <span className="status-branch" title={branch}>{branch}</span>
          <span className="status-modified" title="変更・削除・競合したファイル">M {modified}</span>
          <span className="status-added" title="新規・名前変更・未追跡のファイル">U {added}</span>
        </>
      )}
      <span className="spacer" />
      {path && <span className="status-path" title={path}><bdi>{path}</bdi></span>}
      {count !== null && <span title="空白を除いた文字数。読了時間は毎分400文字での目安">{format.format(count)} 文字 · 約 {Math.ceil(count / 400)} 分</span>}
      {tab?.kind === "doc" && <span>{isMarkdown(tab.path) ? "Markdown · UTF-8" : "UTF-8"}</span>}
      <span>{fontSize} px</span>
    </footer>
  );
}
