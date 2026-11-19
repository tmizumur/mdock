import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadHighlighter, renderMarkdown, renderMermaid } from "../lib/markdown";
import { resolvePath } from "../lib/api";

type Props = {
  path: string;
  content: string;
  onOpenLink: (path: string) => void;
};

/** Markdown のプレビュー。再描画してもスクロール位置は保たれる。 */
export default function Preview({ path, content, onOpenLink }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hlReady, setHlReady] = useState(false);

  useEffect(() => {
    loadHighlighter().then(() => setHlReady(true));
  }, []);

  const html = useMemo(() => renderMarkdown(content), [content, hlReady]);

  useEffect(() => {
    if (ref.current) renderMermaid(ref.current);
  }, [html]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    e.preventDefault();
    if (href.startsWith("#")) {
      ref.current?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView();
    } else if (/^[a-z]+:/i.test(href)) {
      openUrl(href);
    } else {
      onOpenLink(resolvePath(path, decodeURI(href.split("#")[0])));
    }
  };

  return <article className="markdown-body" ref={ref} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
