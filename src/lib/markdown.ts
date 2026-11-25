import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import type { HighlighterGeneric } from "shiki";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolvePath, safeDecode } from "./api";

/** よく使う言語だけ先に読み込む。それ以外はプレーン表示。 */
const LANGS = [
  "ts", "tsx", "js", "jsx", "json", "jsonc", "yaml", "toml", "bash", "shell",
  "python", "rust", "go", "java", "kotlin", "swift", "c", "cpp", "csharp",
  "html", "css", "scss", "sql", "markdown", "diff", "dockerfile", "ruby", "php",
];

let highlighter: HighlighterGeneric<string, string> | null = null;
let loading: Promise<HighlighterGeneric<string, string>> | null = null;

/** Shiki は起動を遅くしないよう、コードブロックが見えたときに初めて読み込む */
export function loadHighlighter(): Promise<HighlighterGeneric<string, string>> {
  if (!loading) {
    loading = import("shiki").then(async ({ createHighlighter, bundledThemes }) => {
      const { default: dark } = await bundledThemes["github-dark"]();
      highlighter = (await createHighlighter({
        themes: [{
          ...dark,
          name: "mdock-dark",
          colors: { ...dark.colors, "editor.background": "#15161A", "editor.foreground": "#E7E8EB" },
          tokenColors: dark.tokenColors?.map((rule) => ({
            ...rule,
            settings: {
              ...rule.settings,
              foreground: ({
                "#F97583": "#C3A6FF",
                "#B392F0": "#8AA4FF",
                "#9ECBFF": "#9FD8A8",
              } as Record<string, string>)[rule.settings.foreground?.toUpperCase() ?? ""] ?? rule.settings.foreground,
            },
          })),
        }],
        langs: LANGS,
      })) as HighlighterGeneric<string, string>;
      return highlighter;
    });
  }
  return loading;
}

/**
 * 色付け済みの HTML と Mermaid の SVG のキャッシュ。
 * 編集中にプレビューを作り直しても、一度描いたものはすぐ同じものを出す（ちらつかない・速い）。
 */
class Cache {
  private map = new Map<string, string>();
  constructor(private limit: number) {}
  get(k: string) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: string) {
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!);
  }
}
const hlCache = new Cache(3000);
const mermaidCache = new Cache(300);

const hlKey = (lang: string, code: string) => `${lang}\u0000${code}`;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const COPY_BTN = `<button class="copy-btn" type="button" title="コードをコピー">コピー</button>`;

type Env = { base?: string };

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

// ---- 数式（KaTeX）: 数式を含むファイルを開いたときだけ読み込む ----

let mathPlugin = false;
let mathLoading: Promise<void> | null = null;

/** $...$ / $$...$$ / ```math を含みそうか（ざっくり判定。誤検出しても読み込むだけ） */
export const hasMath = (src: string) => /\$\$|\$[^\s$][^$\n]*\$|```\s*math/.test(src);

export const mathReady = () => mathPlugin;

export function loadMath(): Promise<void> {
  if (!mathLoading) {
    mathLoading = Promise.all([import("@vscode/markdown-it-katex"), import("katex/dist/katex.min.css")]).then(([m]) => {
      const mod = m as any;
      const plugin = typeof mod.default === "function" ? mod.default : mod.default?.default;
      md.use(plugin, { throwOnError: false, enableMathBlockInHtml: true, enableMathInlineInHtml: true, enableFencedBlocks: true });
      mathPlugin = true;
    });
  }
  return mathLoading;
}

// コードブロック: 色付けは見えたときに行う（大きなファイルでも固まらないように）
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] ?? "";
  const code = token.content;
  const line = token.map ? ` data-line="${token.map[0]}"` : "";
  if (lang === "mermaid") {
    const svg = mermaidCache.get(code);
    if (svg) return `<div class="mermaid-block" data-processed="1"${line}>${svg}</div>`;
    return `<div class="mermaid-block"${line}><pre class="mermaid">${escapeHtml(code)}</pre></div>`;
  }
  // （```math は KaTeX プラグインが先に処理する）
  const cached = lang ? hlCache.get(hlKey(lang, code)) : undefined;
  const inner = cached ?? `<pre class="plain"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(code)}</code></pre>`;
  return `<div class="code-block"${line}>${COPY_BTN}${inner}</div>`;
};

md.use(anchor, { slugify: (s: string) => encodeURIComponent(s.trim().toLowerCase().replace(/\s+/g, "-")) });

/** 相対パス（./img.png, ../a b.png, 日本語.png など）か */
export const isRelative = (src: string) => !!src && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(src);

/** md ファイルからの相対パス（または絶対パス）を、WebView から読める asset:// の URL にする */
export function localSrc(base: string, src: string): string {
  const [path] = src.split(/[?#]/);
  return convertFileSrc(resolvePath(base, safeDecode(path)));
}

const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = String(token.attrGet("src") ?? "");
  const base = (env as Env | undefined)?.base;
  if (base && (isRelative(src) || /^\/(?!\/)/.test(src))) {
    token.attrSet("src", localSrc(base, src));
    token.attrSet("data-local", "1");
  }
  token.attrSet("loading", "lazy");
  return defaultImage(tokens, idx, options, env, self);
};

// ブロック要素に元の Markdown の行番号を付ける（スクロール同期用）
for (const name of ["paragraph_open", "heading_open", "bullet_list_open", "ordered_list_open", "table_open", "blockquote_open", "hr", "html_block"]) {
  const orig = md.renderer.rules[name];
  md.renderer.rules[name] = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    if (t.map && t.level === 0) {
      if (name === "html_block") {
        const html = orig ? orig(tokens, idx, options, env, self) : t.content;
        return `<div data-line="${t.map[0]}">${html}</div>`;
      }
      t.attrSet("data-line", String(t.map[0]));
    }
    return orig ? orig(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

// GFM のチェックボックス（- [ ] / - [x]）を表示用に変換
md.core.ruler.after("inline", "task-list", (state: any) => {
  for (const token of state.tokens) {
    if (token.type !== "inline" || !token.children?.length) continue;
    const first = token.children[0];
    const m = first.type === "text" ? /^\[([ xX])\]\s/.exec(first.content) : null;
    if (!m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled ${m[1] !== " " ? "checked" : ""}> `;
    token.children.unshift(box);
  }
  return true;
});

export const renderMarkdown = (src: string, base?: string) => md.render(src, { base } satisfies Env);

/** Markdown の見出しと元の行番号（編集モードのアウトライン用）。 */
export function markdownHeadings(src: string) {
  const tokens = md.parse(src, {});
  return tokens.flatMap((token, i) => {
    if (token.type !== "heading_open" || !token.map) return [];
    const inline = tokens[i + 1];
    const text = inline.children?.filter((t) => t.type === "text" || t.type === "code_inline").map((t) => t.content).join("").trim();
    return [{ level: Number(token.tag[1]), text: text || inline.content, line: token.map[0] }];
  });
}

// ---- 見えた部分から順に描画（Shiki・Mermaid） ----

/** プレーン表示のコードブロックを Shiki で色付けする。色付けできない言語なら何もしない。 */
export async function highlightBlock(pre: HTMLElement): Promise<void> {
  const lang = pre.dataset.lang;
  if (!lang || pre.dataset.hl) return;
  pre.dataset.hl = "1";
  const hl = highlighter ?? (await loadHighlighter());
  if (!hl.getLoadedLanguages().includes(lang)) return;
  const code = pre.textContent ?? "";
  const key = hlKey(lang, code);
  let html = hlCache.get(key);
  if (!html) {
    html = hl.codeToHtml(code, { lang, theme: "mdock-dark" });
    hlCache.set(key, html);
  }
  if (pre.isConnected) pre.outerHTML = html;
}

let mermaidLoaded: Promise<typeof import("mermaid").default> | null = null;
let mermaidSeq = 0;

/** Mermaid 図を描画する（初めて図が見えたときにライブラリを読み込む） */
export async function renderMermaidBlock(block: HTMLElement): Promise<void> {
  if (block.dataset.processed) return;
  block.dataset.processed = "1";
  const pre = block.querySelector("pre.mermaid");
  if (!pre) return;
  const code = pre.textContent ?? "";
  if (!mermaidLoaded) {
    mermaidLoaded = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "theme", "themeVariables", "themeCSS"],
      });
      return mermaid;
    });
  }
  const mermaid = await mermaidLoaded;
  const id = `mermaid-${++mermaidSeq}`;
  try {
    let svg = mermaidCache.get(code);
    if (!svg) {
      svg = (await mermaid.render(id, code)).svg;
      mermaidCache.set(code, svg);
    }
    if (block.isConnected) block.innerHTML = svg;
  } catch (e) {
    console.warn("mermaid", e);
    block.classList.add("mermaid-error");
    // 描画に失敗したとき mermaid が body に残すエラー表示を片付ける
    const leftover = document.getElementById(`d${id}`);
    leftover?.parentNode?.removeChild(leftover);
  }
}

/** 印刷の前に、まだ描いていないコードの色付け・図・画像をすべて描いておく */
export async function renderAllPending(root: HTMLElement): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  root.querySelectorAll<HTMLElement>("pre[data-lang]:not([data-hl])").forEach((el) => jobs.push(highlightBlock(el)));
  root.querySelectorAll<HTMLElement>(".mermaid-block:not([data-processed])").forEach((el) => jobs.push(renderMermaidBlock(el)));
  root.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    img.loading = "eager";
    if (!img.complete) jobs.push(new Promise((r) => ((img.onload = r), (img.onerror = r))));
  });
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 5000))]);
}
