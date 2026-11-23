import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  hasMath,
  highlightBlock,
  isRelative,
  loadMath,
  localSrc,
  mathReady,
  renderMarkdown,
  renderMermaidBlock,
} from "../lib/markdown";
import { isMarkdown, resolvePath, safeDecode } from "../lib/api";
import { clearFindHighlights, findRanges, setFindHighlights } from "../lib/find";
import { useSettings } from "../lib/settings";

export type FindQuery = { query: string; index: number };
/** 検索結果。tops は一致箇所の位置（本文の先頭からの px。読んでいる位置の帯に印を付ける） */
export type FindResult = { count: number; tops: number[] };

type Props = {
  /** 検索の登録などに使うペインの ID */
  id: string;
  path: string;
  content: string;
  /** スクロールする要素（ペインの本文部分） */
  scroller: React.RefObject<HTMLDivElement | null>;
  onOpenLink: (path: string, anchor?: string, newTab?: boolean) => void;
  /** 開いたら移動したい見出し（別ファイルの #見出し へのリンク） */
  anchor?: { id: string; nonce: number };
  find?: FindQuery;
  onFindResult?: (r: FindResult) => void;
  /** 描画し直したとき（見出しの位置などが変わったとき）に呼ぶ */
  onRendered?: () => void;
};

/** 入力のたびに描き直さないよう、少し待ってから反映する。ファイルを切り替えたときはすぐ反映。 */
function useSettledContent(path: string, content: string) {
  const [state, setState] = useState({ path, content });
  useEffect(() => {
    if (state.path !== path) {
      setState({ path, content });
      return;
    }
    if (state.content === content) return;
    const delay = content.length > 200_000 ? 400 : content.length > 30_000 ? 200 : 80;
    const t = window.setTimeout(() => setState({ path, content }), delay);
    return () => window.clearTimeout(t);
  }, [path, content, state]);
  return state.path === path ? state.content : content;
}

/** 見出しの id から要素を探す（エンコードの違いを吸収） */
function findAnchor(root: HTMLElement, raw: string): HTMLElement | null {
  const decoded = safeDecode(raw);
  const cands = [raw, decoded, encodeURIComponent(decoded), encodeURIComponent(decoded.trim().toLowerCase().replace(/\s+/g, "-"))];
  for (const c of cands) {
    const el = root.querySelector<HTMLElement>(`[id="${CSS.escape(c)}"], a[name="${CSS.escape(c)}"]`);
    if (el) return el;
  }
  return null;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.parentNode?.removeChild(ta);
  }
}

/** Markdown のプレビュー。再描画してもスクロール位置は保たれる。 */
function Preview({ id, path, content, scroller, onOpenLink, anchor, find, onFindResult, onRendered }: Props) {
  const ref = useRef<HTMLElement>(null);
  const { settings } = useSettings();
  const source = useSettledContent(path, content);
  const [mathOn, setMathOn] = useState(mathReady());
  // 描き直した回数（DOM が変わったら検索や見出し位置を計算し直す）
  const [domVersion, setDomVersion] = useState(0);

  const needMath = useMemo(() => !mathOn && hasMath(source), [mathOn, source]);
  useEffect(() => {
    if (needMath) loadMath().then(() => setMathOn(true), (e) => console.warn("katex", e));
  }, [needMath]);

  const html = useMemo(() => renderMarkdown(source, path), [source, path, mathOn]);

  // 描画後: 生 HTML の相対パス画像を直し、コード・図は見えたときに描く
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const img of root.querySelectorAll<HTMLImageElement>("img:not([data-local])")) {
      const src = img.getAttribute("src") ?? "";
      if (isRelative(src)) img.src = localSrc(path, src);
      img.dataset.local = "1";
    }
    setDomVersion((v) => v + 1);
    onRendered?.();

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          io.unobserve(el);
          const done = el.classList.contains("mermaid-block") ? renderMermaidBlock(el) : highlightBlock(el);
          done.then(() => {
            setDomVersion((v) => v + 1);
            onRendered?.();
          });
        }
      },
      // 見えている範囲の少し先まで先に描いておく
      { root: scroller.current, rootMargin: "800px 0px" },
    );
    root.querySelectorAll("pre[data-lang]:not([data-hl]), .mermaid-block:not([data-processed])").forEach((el) => io.observe(el));
    // 画像が読み込まれると高さが変わる
    const onLoad = () => onRendered?.();
    root.addEventListener("load", onLoad, true);
    return () => {
      io.disconnect();
      root.removeEventListener("load", onLoad, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  // 別ファイルの見出しへのリンクで開いたとき、その見出しへ移動
  useEffect(() => {
    if (!anchor || !ref.current) return;
    findAnchor(ref.current, anchor.id)?.scrollIntoView({ block: "start" });
  }, [anchor?.nonce, html]);

  // ファイル内検索
  const query = find?.query ?? "";
  const ranges = useMemo(
    () => (ref.current && query ? findRanges(ref.current, query) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, domVersion],
  );
  const current = ranges.length ? ((find!.index % ranges.length) + ranges.length) % ranges.length : -1;
  useEffect(() => {
    setFindHighlights(id, ranges, current);
    const sc = scroller.current;
    const base = sc ? sc.getBoundingClientRect().top - sc.scrollTop : 0;
    onFindResult?.({ count: ranges.length, tops: ranges.slice(0, 2000).map((r) => r.getBoundingClientRect().top - base) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranges, current]);
  // 今の一致箇所が見えるようにスクロール（検索語や「次へ」が変わったときだけ）
  useEffect(() => {
    const sc = scroller.current;
    const r = ranges[current];
    if (!sc || !r) return;
    const box = r.getBoundingClientRect();
    const view = sc.getBoundingClientRect();
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40) {
      sc.scrollTop += box.top - view.top - sc.clientHeight / 3;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, find?.index]);
  useEffect(() => () => clearFindHighlights(id), [id]);

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>(".copy-btn");
    if (btn) {
      const code = btn.parentElement?.querySelector("pre")?.textContent ?? "";
      copyText(code).then(() => {
        btn.textContent = "コピーしました";
        btn.classList.add("done");
        window.setTimeout(() => {
          btn.textContent = "コピー";
          btn.classList.remove("done");
        }, 1200);
      });
      return;
    }
    const a = target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    e.preventDefault();
    if (href.startsWith("#")) {
      if (ref.current) findAnchor(ref.current, href.slice(1))?.scrollIntoView({ block: "start" });
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:")) {
      openUrl(href);
    } else {
      const raw = href.replace(/^file:\/\//, "");
      const [file, hash] = raw.split("#");
      const abs = resolvePath(path, safeDecode(file.split("?")[0]));
      if (isMarkdown(abs)) onOpenLink(abs, hash, e.metaKey || e.ctrlKey); // ⌘+クリックで新しいタブ
      else openPath(abs).catch((err) => console.warn("open", err)); // md 以外は既定のアプリで開く
    }
  };

  return (
    <article
      className={`markdown-body width-${settings.width} ${settings.wrap ? "wrap-code" : ""}`}
      ref={ref}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default memo(Preview);
