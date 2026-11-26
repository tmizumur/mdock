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
  renderMarkdown,
  renderMermaidBlock,
} from "../lib/markdown";
import { confirmOpenUrl, copyText, safeDecode, statPaths } from "../lib/api";
import { clearFindHighlights, findRanges, setFindHighlights } from "../lib/find";
import { classifyLink, localLinkAction } from "../lib/links";
import { FILES_CHANGED, changeMatcher, pathKey } from "../lib/liveReload";
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
  find?: FindQuery;
  onFindResult?: (r: FindResult) => void;
  /** 描画し直したとき（見出しの位置などが変わったとき）に呼ぶ */
  onRendered?: () => void;
  /** 待たずにすぐ反映する（入力中でないとき。外部での変更をすぐ表示するため） */
  immediate?: boolean;
};

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
function Preview({ id, path, content, scroller, onOpenLink, anchor, onAnchorScrolled, find, onFindResult, onRendered, immediate = false }: Props) {
  const ref = useRef<HTMLElement>(null);
  const lastAnchorNonce = useRef<number>(undefined);
  const imageVersions = useRef({ version: 0, paths: new Map<string, number>() });
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => renderMarkdown(source, path), [source, path, mathOn]);
  const innerHTML = useMemo(() => ({ __html: html }), [html]);

  // 描画後: 生 HTML の相対パス画像を直し、コード・図は見えたときに描く
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    prepareLightboxTriggers(root);
    const images: { img: HTMLImageElement; path: string; url: string }[] = [];
    for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
      const src = img.getAttribute("src") ?? "";
      if (!img.hasAttribute("data-local") && (isRelative(src) || /^\/(?!\/)/.test(src))) {
        img.src = localSrc(path, src);
        img.dataset.local = "1";
      }
      const asset = img.dataset.local === "1" && localImageUrl.exec(img.getAttribute("src") ?? "");
      if (!asset) continue;
      const file = safeDecode(asset[1]);
      const version = imageVersions.current.paths.get(pathKey(file));
      if (version !== undefined) img.src = `${asset[0]}?v=${version}`;
      images.push({ img, path: file, url: asset[0] });
    }
    const onFilesChanged = ({ detail }: WindowEventMap[typeof FILES_CHANGED]) => {
      const matches = changeMatcher(detail);
      const versions = imageVersions.current;
      const version = versions.version = Math.max(Date.now(), versions.version + 1);
      for (const { img, path, url } of images) {
        if (!matches(path)) continue;
        versions.paths.set(pathKey(path), version);
        img.src = `${url}?v=${version}`;
      }
    };
    if (images.length) window.addEventListener(FILES_CHANGED, onFilesChanged);
    setDomVersion((v) => v + 1);
    onRendered?.();

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          io.unobserve(el);
          const isMermaid = el.classList.contains("mermaid-block");
          const done = isMermaid ? renderMermaidBlock(el) : highlightBlock(el);
          done.then(() => {
            if (isMermaid) prepareLightboxTriggers(el);
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
      window.removeEventListener(FILES_CHANGED, onFilesChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, path]);

  // 別ファイルの見出しへのリンクで開いたとき、その見出しへ移動
  useEffect(() => {
    if (!anchor || lastAnchorNonce.current === anchor.nonce || handledAnchors.has(anchor) || !ref.current) return;
    const target = findAnchor(ref.current, anchor.id);
    if (!target) return;
    lastAnchorNonce.current = anchor.nonce;
    handledAnchors.add(anchor);
    target.scrollIntoView({ block: "start" });
    onAnchorScrolled?.();
  }, [anchor, html, onAnchorScrolled]);

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
        if (ref.current) findAnchor(ref.current, link.hash)?.scrollIntoView({ block: "start" });
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
        dangerouslySetInnerHTML={innerHTML}
      />
      {lightbox && <Lightbox media={lightbox} onClose={closeLightbox} />}
    </>
  );
}

export default memo(Preview);
