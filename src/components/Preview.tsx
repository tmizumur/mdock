import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { slug } from "github-slugger";
import { ask } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  hasMath,
  highlightBlock,
  isRelative,
  loadMath,
  localSrc,
  mathReady,
  markdownChunks,
  RENDER_ALL,
  renderMermaidBlock,
} from "../lib/markdown";
import { confirmOpenUrl, copyText, safeDecode, statPaths } from "../lib/api";
import { clearFindHighlights, findRanges, setFindHighlights } from "../lib/find";
import { handledSearchLocations, previewMatchIndex, previewSearchBlock, SEARCH_HIGHLIGHT_MS, sourceMatch } from "../lib/folderSearch";
import type { SearchLocation } from "../lib/folderSearch";
import { classifyLink, localLinkAction } from "../lib/links";
import { BEFORE_JUMP } from "../lib/navHistory";
import { FILES_CHANGED, pathKey } from "../lib/liveReload";
import { useSettings } from "../lib/settings";
import Lightbox, { type LightboxMedia } from "./Lightbox";

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
  onAnchorScrolled?: () => void;
  line?: SearchLocation;
  find?: FindQuery;
  onFindResult?: (r: FindResult) => void;
  /** 描画し直したとき（見出しの位置などが変わったとき）に呼ぶ */
  onRendered?: () => void;
  /** 待たずにすぐ反映する（入力中でないとき。外部での変更をすぐ表示するため） */
  immediate?: boolean;
  /** 長い文書でも毎回まとめて描く */
  eager?: boolean;
  /** 前回のスクロール位置へ戻すため、初回はまとめて描く */
  eagerOnMount?: boolean;
};

/** これより長い文書は、見える先頭から少しずつ描く（固まらないように） */
const PROGRESSIVE_MIN = 100_000;
/** 1回にまとめて描く時間の目安（ms）。これを超えたら次のフレームへ */
const SLICE_MS = 12;

/**
 * 入力のたびに描き直さないよう、少し待ってから反映する。
 * ファイルを切り替えたとき・入力中でないとき（外部での変更の再読み込みなど）はすぐ反映。
 */
function useSettledContent(path: string, content: string, immediate: boolean) {
  const [state, setState] = useState({ path, content });
  useEffect(() => {
    if (state.path !== path || immediate) {
      if (state.path === path && state.content === content) return;
      setState({ path, content });
      return;
    }
    if (state.content === content) return;
    const delay = content.length > 200_000 ? 400 : content.length > 30_000 ? 200 : 80;
    const t = window.setTimeout(() => setState({ path, content }), delay);
    return () => window.clearTimeout(t);
  }, [path, content, state, immediate]);
  return state.path === path && !immediate ? state.content : content;
}

/** 見出しの id から要素を探す（エンコードの違いを吸収） */
function findAnchor(root: HTMLElement, raw: string): HTMLElement | null {
  if (!raw) return null;
  const decoded = safeDecode(raw);
  for (const c of new Set([raw, decoded, encodeURIComponent(decoded)])) {
    const el = root.querySelector<HTMLElement>(`[id="${CSS.escape(c)}"], a[name="${CSS.escape(c)}"]`);
    if (el) return el;
  }
  const legacy = CSS.escape(decoded.trim().toLowerCase().replace(/\s+/g, "-"));
  const github = CSS.escape(slug(decoded));
  return root.querySelector<HTMLElement>(`[data-legacy-anchor="${legacy}"]`) ??
    root.querySelector<HTMLElement>(`[id="${github}"]`);
}

// タブや表示モードを切り替えても、同じリンクの要求には戻らない。
const handledAnchors = new WeakSet<NonNullable<Props["anchor"]>>();

const localImageUrl = /^asset:\/\/localhost\/([^?#]+)/i;
const lightboxTrigger = "img:not(a img), .mermaid-block svg:not(svg svg, a svg)";

// プレビューを閉じている間も、変更されたパスの更新番号を覚えておく。
const imageVersions = new Map<string, number>();
const imageRefreshers = new Set<() => void>();
let imageVersion = 0;
let imageRescanVersion = 0;

function onFilesChanged({ detail }: WindowEventMap[typeof FILES_CHANGED]) {
  imageVersion = Math.max(Date.now(), imageVersion + 1);
  if (detail.rescan) {
    imageVersions.clear();
    imageRescanVersion = imageVersion;
  } else {
    for (const path of detail.paths) imageVersions.set(pathKey(path), imageVersion);
  }
  for (const refresh of imageRefreshers) refresh();
}

window.addEventListener(FILES_CHANGED, onFilesChanged);
import.meta.hot?.dispose(() => window.removeEventListener(FILES_CHANGED, onFilesChanged));

function versionForImage(key: string) {
  let version = imageRescanVersion;
  while (key) {
    version = Math.max(version, imageVersions.get(key) ?? 0);
    const slash = key.lastIndexOf("/");
    if (slash < 1) break;
    key = key.slice(0, slash);
  }
  return version;
}

function prepareLightboxTriggers(root: HTMLElement) {
  for (const image of root.querySelectorAll(lightboxTrigger)) {
    image.setAttribute("tabindex", "0");
    image.setAttribute("role", "button");
    if (!image.getAttribute("alt") && !image.hasAttribute("aria-label") && !image.hasAttribute("aria-labelledby")) {
      image.setAttribute("aria-label", image instanceof HTMLImageElement ? "画像を拡大" : "Mermaid 図を拡大");
    }
  }
}

function lightboxMedia(image: HTMLImageElement | SVGSVGElement, animations: boolean): LightboxMedia {
  const bounds = image.getBoundingClientRect();
  if (image instanceof HTMLImageElement) {
    return {
      src: image.currentSrc || image.src,
      alt: image.alt,
      width: image.naturalWidth || bounds.width || 1,
      height: image.naturalHeight || bounds.height || 1,
    };
  }

  // 画像として読み込み、図内の id と参照を元の図から隔離する。
  const svg = image.cloneNode(true) as SVGSVGElement;
  const width = image.viewBox?.baseVal.width || bounds.width || 1;
  const height = image.viewBox?.baseVal.height || bounds.height || 1;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.style.removeProperty("max-width");
  const pageRef = `${document.URL.split("#")[0]}#`;
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    for (const attribute of element.attributes) {
      if (attribute.value.includes(pageRef)) attribute.value = attribute.value.split(pageRef).join("#");
    }
  }
  const motion = document.createElementNS(svg.namespaceURI, "style");
  const noMotion = "*, *::before, *::after { animation: none !important; transition: none !important; }";
  motion.textContent = animations ? `@media (prefers-reduced-motion: reduce) { ${noMotion} }` : noMotion;
  svg.append(motion);
  const xml = new XMLSerializer().serializeToString(svg);
  return {
    src: `data:image/svg+xml,${encodeURIComponent(xml)}`,
    alt: image.querySelector("title")?.textContent || "Mermaid 図",
    width,
    height,
  };
}

/** Markdown のプレビュー。再描画してもスクロール位置は保たれる。 */
function Preview({ id, path, content, scroller, onOpenLink, anchor, onAnchorScrolled, line, find, onFindResult, onRendered, immediate = false, eager = false, eagerOnMount = false }: Props) {
  const ref = useRef<HTMLElement>(null);
  const lastAnchorNonce = useRef<number>(undefined);
  const { settings } = useSettings();
  const source = useSettledContent(path, content, immediate);
  const [mathOn, setMathOn] = useState(mathReady());
  const [lightbox, setLightbox] = useState<LightboxMedia | null>(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);
  // 描き直した回数（DOM が変わったら検索や見出し位置を計算し直す）
  const [domVersion, setDomVersion] = useState(0);

  const needMath = useMemo(() => !mathOn && hasMath(source), [mathOn, source]);
  useEffect(() => {
    if (needMath) loadMath().then(() => setMathOn(true), (e) => console.warn("katex", e));
  }, [needMath]);

  // 最上位のブロックの区切りで小分けにした HTML。長い文書は先頭から少しずつ DOM に入れ、
  // 描き直すときは前と同じ塊はそのまま残す（末尾への追記なら、変わった末尾の塊だけ入れ替わる）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const chunks = useMemo(() => markdownChunks(source, path), [source, path, mathOn]);
  /** 全部の塊を DOM に入れ終えるたびに増える（見出しへの移動などはこれを待つ） */
  const [rendered, setRendered] = useState(0);
  const dom = useRef<{ els: HTMLElement[]; keys: string[]; complete: boolean; finishAll: () => void }>({
    els: [], keys: [], complete: true, finishAll: () => {},
  });
  const eagerOnMountRef = useRef(eagerOnMount);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  // 描画後: 生 HTML の相対パス画像を直し、コード・図は見えたときに描く
  const io = useRef<IntersectionObserver | null>(null);
  useLayoutEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          observer.unobserve(el);
          const isMermaid = el.classList.contains("mermaid-block");
          const done = isMermaid ? renderMermaidBlock(el) : highlightBlock(el);
          done.then(() => {
            if (isMermaid) prepareLightboxTriggers(el);
            setDomVersion((v) => v + 1);
            onRenderedRef.current?.();
          });
        }
      },
      // 見えている範囲の少し先まで先に描いておく
      { root: scroller.current, rootMargin: "800px 0px" },
    );
    io.current = observer;
    const root = ref.current;
    // 画像が読み込まれると高さが変わる
    const onLoad = () => onRenderedRef.current?.();
    root?.addEventListener("load", onLoad, true);
    const refreshImages = () => {
      if (!root) return;
      for (const img of root.querySelectorAll<HTMLImageElement>("img[data-local]")) {
        const asset = localImageUrl.exec(img.getAttribute("src") ?? "");
        if (!asset) continue;
        const version = versionForImage(pathKey(safeDecode(asset[1])));
        if (!version) continue;
        const src = `${asset[0]}?v=${version}`;
        if (img.getAttribute("src") !== src) img.src = src;
      }
    };
    imageRefreshers.add(refreshImages);
    // 既に入っている塊（スクロール要素が変わったときなど）も見張る
    root?.querySelectorAll("pre[data-lang]:not([data-hl]), .mermaid-block:not([data-processed])").forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
      io.current = null;
      root?.removeEventListener("load", onLoad, true);
      imageRefreshers.delete(refreshImages);
    };
  }, [scroller]);

  /** DOM に入れた塊の後始末（画像のパス、拡大表示、コード・図の遅延描画） */
  const setupChunk = (el: HTMLElement) => {
    prepareLightboxTriggers(el);
    for (const img of el.querySelectorAll<HTMLImageElement>("img")) {
      const src = img.getAttribute("src") ?? "";
      if (!img.hasAttribute("data-local") && (isRelative(src) || /^\/(?!\/)/.test(src))) {
        img.src = localSrc(path, src);
        img.dataset.local = "1";
      }
      const asset = img.dataset.local === "1" && localImageUrl.exec(img.getAttribute("src") ?? "");
      if (!asset) continue;
      const version = versionForImage(pathKey(safeDecode(asset[1])));
      if (version) img.src = `${asset[0]}?v=${version}`;
    }
    el.querySelectorAll("pre[data-lang]:not([data-hl]), .mermaid-block:not([data-processed])").forEach((x) => io.current?.observe(x));
  };

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const state = dom.current;
    // 前と同じ塊はそのまま。最初に違う塊から後ろを入れ替える
    let from = 0;
    while (from < state.keys.length && from < chunks.length && state.keys[from] === chunks[from].key) from++;
    for (const el of state.els.splice(from)) el.remove();
    state.keys.splice(from);
    let next = from;
    const insert = () => {
      const el = document.createElement("div");
      el.className = "md-chunk";
      el.innerHTML = chunks[next].html();
      root.appendChild(el);
      state.els.push(el);
      state.keys.push(chunks[next].key);
      setupChunk(el);
      next++;
    };
    let timer: number | undefined;
    state.complete = false;
    root.dataset.rendering = "1";
    const finish = () => {
      window.clearTimeout(timer);
      if (state.complete) return;
      state.complete = true;
      delete root.dataset.rendering;
      setDomVersion((v) => v + 1);
      setRendered((v) => v + 1);
      onRenderedRef.current?.();
    };
    state.finishAll = () => {
      while (next < chunks.length) insert();
      finish();
    };
    if (source.length < PROGRESSIVE_MIN || eager || eagerOnMountRef.current) {
      state.finishAll();
    } else {
      // まず見える分（時間の目安まで）を描き、残りは画面を止めないよう少しずつ
      const step = () => {
        const t0 = performance.now();
        while (next < chunks.length) {
          insert();
          if (performance.now() - t0 >= SLICE_MS) break;
        }
        if (next < chunks.length) timer = window.setTimeout(step, 0);
        else finish();
      };
      step();
      // 見出しの位置などは途中でも分かる範囲で知らせる
      onRenderedRef.current?.();
    }
    eagerOnMountRef.current = false;
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks, eager]);

  /** まだ入れていない塊があれば、すぐに全部入れる */
  const renderAll = useCallback(() => {
    if (!dom.current.complete) dom.current.finishAll();
  }, []);

  useLayoutEffect(() => {
    const onRenderAll = (event: Event) => {
      const paneId = (event as CustomEvent<string | null>).detail;
      if (paneId == null || ref.current?.closest(".pane")?.getAttribute("data-pane") === paneId) renderAll();
    };
    window.addEventListener(RENDER_ALL, onRenderAll);
    return () => window.removeEventListener(RENDER_ALL, onRenderAll);
  }, [renderAll]);

  // 別ファイルの見出しへのリンクで開いたとき、その見出しへ移動
  useEffect(() => {
    if (!anchor || lastAnchorNonce.current === anchor.nonce || handledAnchors.has(anchor) || !ref.current) return;
    renderAll();
    const target = findAnchor(ref.current, anchor.id);
    if (!target) return;
    lastAnchorNonce.current = anchor.nonce;
    handledAnchors.add(anchor);
    target.scrollIntoView({ block: "start" });
    onAnchorScrolled?.();
  }, [anchor, rendered, onAnchorScrolled, renderAll]);

  // フォルダ検索で開いた行へ移動し、一致箇所を一時的に強調する。
  useEffect(() => {
    if (!line || handledSearchLocations.has(line)) return;
    let clear: (() => void) | undefined;
    let timer: number | undefined;
    const frame = requestAnimationFrame(() => {
      if (!ref.current) return;
      renderAll();
      const target = previewSearchBlock(ref.current, line.line);
      if (!target) return;
      handledSearchLocations.add(line);
      const { block, blockLine } = target;
      const lines = source.split(/\r\n?|\n/);
      const match = sourceMatch(lines[line.line] ?? "", line) ? line.matchText : "";
      const index = previewMatchIndex(lines, blockLine, line, match);
      const highlightId = `${id}-folder-search`;
      const highlight = () => {
        const ranges = findRanges(block, match, true);
        const range = ranges[Math.min(index, ranges.length - 1)];
        setFindHighlights(highlightId, range ? [range] : [], 0);
        block.classList.toggle("folder-search-jump", !range || typeof Highlight === "undefined");
        return range;
      };
      const range = highlight();
      if (range && block instanceof HTMLDetailsElement) block.open = true;
      const sc = scroller.current;
      if (sc) {
        const top = (range?.getBoundingClientRect() ?? block.getBoundingClientRect()).top;
        sc.scrollTop += top - sc.getBoundingClientRect().top - sc.clientHeight / 3;
      }
      onAnchorScrolled?.();

      // コードの色付けでテキストノードが置き換わる場合にも強調を保つ。
      const observer = new MutationObserver(highlight);
      observer.observe(block, { childList: true, subtree: true, characterData: true });
      clear = () => {
        observer.disconnect();
        block.classList.remove("folder-search-jump");
        clearFindHighlights(highlightId);
      };
      timer = window.setTimeout(clear, SEARCH_HIGHLIGHT_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      clear?.();
    };
  }, [id, line, source, scroller, onAnchorScrolled, renderAll]);

  // ファイル内検索
  const query = find?.query ?? "";
  const index = find?.index ?? 0;
  // 検索は全文が必要（長い文書の描画途中なら残りをすぐ描く）
  useLayoutEffect(() => {
    if (query) renderAll();
  }, [query, chunks, renderAll]);
  const ranges = useMemo(
    () => (ref.current && query && !ref.current.dataset.rendering ? findRanges(ref.current, query) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, domVersion],
  );
  const current = ranges.length ? ((index % ranges.length) + ranges.length) % ranges.length : -1;
  useEffect(() => {
    setFindHighlights(id, ranges, current);
    const sc = scroller.current;
    const base = sc ? sc.getBoundingClientRect().top - sc.scrollTop : 0;
    onFindResult?.({ count: ranges.length, tops: ranges.slice(0, 2000).map((r) => r.getBoundingClientRect().top - base) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranges, current]);
  // 検索語や移動先が変わったら、一致箇所がそろうまで移動を待つ。
  const pendingFindScroll = useRef(false);
  useEffect(() => {
    pendingFindScroll.current = !!query;
  }, [query, index]);
  useEffect(() => {
    const sc = scroller.current;
    const r = ranges[current];
    if (!pendingFindScroll.current || !sc || !r) return;
    pendingFindScroll.current = false;
    const box = r.getBoundingClientRect();
    const view = sc.getBoundingClientRect();
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40) {
      sc.scrollTop += box.top - view.top - sc.clientHeight / 3;
    }
  }, [query, index, ranges, current, scroller]);
  useEffect(() => () => clearFindHighlights(id), [id]);

  const openLightbox = (target: Element) => {
    const image = target.closest<HTMLImageElement | SVGSVGElement>(lightboxTrigger);
    if (!image) return false;
    const media = lightboxMedia(image, settings.animations);
    if (!media.src) return false;
    image.focus({ preventScroll: true });
    setLightbox(media);
    return true;
  };

  const onClick = async (e: React.MouseEvent) => {
    const target = e.target as Element;
    const btn = target.closest<HTMLButtonElement>("button.copy-btn");
    if (btn) {
      e.preventDefault();
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
    const a = target.closest("a, area");
    if (!a) {
      if (openLightbox(target)) e.preventDefault();
      return;
    }
    const href = a.getAttribute("href");
    if (href === null) return;
    e.preventDefault();
    if (!href) return;
    const link = classifyLink(href, path);
    const newTab = e.metaKey || e.ctrlKey;
    try {
      if (link.kind === "anchor") {
        renderAll();
        const jumpTo = ref.current && findAnchor(ref.current, link.hash);
        if (jumpTo) {
          // 「戻る」で戻れるよう、移る前の位置を記録してもらう（ペインが受け取る）
          ref.current?.dispatchEvent(new CustomEvent(BEFORE_JUMP, { bubbles: true }));
          jumpTo.scrollIntoView({ block: "start" });
        }
      } else if (link.kind === "external") {
        await openUrl(link.url);
      } else if (link.kind === "confirm-url") {
        await confirmOpenUrl(link.url);
      } else if (link.kind === "local") {
        const [stat] = await statPaths([link.path]);
        const action = localLinkAction(link.path, stat);
        if (action === "markdown") {
          onOpenLink(link.path, link.hash, newTab);
        } else if (stat.exists && action === "reveal") {
          if (await ask(`この項目を Finder で表示しますか？\n${link.path}`)) await revealItemInDir(link.path);
        } else if (stat.exists) {
          await openPath(link.path);
        }
      }
    } catch (err) {
      console.warn("open", err);
    }
  };

  return (
    <>
      <article
        className={`markdown-body width-${settings.width} ${settings.wrap ? "wrap-code" : ""}`}
        ref={ref}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.repeat || e.metaKey || e.ctrlKey || (e.key !== "Enter" && e.key !== " ")) return;
          if (openLightbox(e.target as Element)) e.preventDefault();
        }}
        onAuxClick={(e) => {
          if ((e.target as Element).closest("a, area")) e.preventDefault();
        }}
      />
      {lightbox && <Lightbox media={lightbox} onClose={closeLightbox} />}
    </>
  );
}

export default memo(Preview);
