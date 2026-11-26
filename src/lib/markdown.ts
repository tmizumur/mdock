import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import GithubSlugger from "github-slugger";
import type { HighlighterGeneric } from "shiki";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolvePath, safeDecode } from "./api";
import { isBlockedLink } from "./links";
import { sanitizeHtmlBlock, sanitizeMarkdown } from "./markdownSanitizer";

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
          // Shiki は CSS 変数を解決できないため、styles.css の --bg-code / --fg と同じ値を指定する。
          colors: { ...dark.colors, "editor.background": "#15161A", "editor.foreground": "#E7E8EB" },
          tokenColors: dark.tokenColors?.map((rule) => ({
            ...rule,
            settings: {
              ...rule.settings,
              foreground: ({
                "#F97583": "#C3A6FF", // --code-keyword
                "#B392F0": "#8AA4FF", // --accent
                "#9ECBFF": "#9FD8A8", // --code-string
                "#6A737D": "#A4A8B0", // --fg-muted
                "#79B8FF": "#8AA4FF", // --accent
                "#85E89D": "#7FD39A", // --git-added
                "#FFAB70": "#E5C07B", // --git-modified
                "#FDAEB7": "#F48771", // --danger
                "#E1E4E8": "#E7E8EB", // --fg
                "#DBEDFF": "#E7E8EB", // --fg
                "#D1D5DA": "#A4A8B0", // --fg-muted
              } as Record<string, string>)[rule.settings.foreground?.toUpperCase() ?? ""] ?? rule.settings.foreground,
              background: ({
                "#86181D": "#F4877129", // --diff-del (--danger, 16%)
                "#C24E00": "#E5C07B29", // --git-modified, 16%
              } as Record<string, string>)[rule.settings.background?.toUpperCase() ?? ""] ?? rule.settings.background,
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

type Env = { base?: string; sanitizeDocument?: boolean; slugger?: GithubSlugger };

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  if (isBlockedLink(String(token.attrGet("href") ?? ""))) token.attrs?.splice(token.attrIndex("href"), 1);
  return self.renderToken(tokens, idx, options);
};

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
      const styles = getComputedStyle(document.documentElement);
      md.use(plugin, {
        throwOnError: false,
        trust: false,
        errorColor: styles.getPropertyValue("--danger").trim(),
        enableMathBlockInHtml: true,
        enableMathInlineInHtml: true,
        enableFencedBlocks: true,
      });
      for (const name of ["math_block", "fence"]) {
        const render = md.renderer.rules[name]!;
        md.renderer.rules[name] = (tokens, idx, options, env, self) => {
          const html = render(tokens, idx, options, env, self);
          const token = tokens[idx];
          return token.map && token.level === 0
            ? html.replace(/^<p(?= class="katex-block\b)/, `<p data-line="${token.map[0]}"`)
            : html;
        };
      }
      mathPlugin = true;
    });
  }
  return mathLoading;
}

// コードブロック: 色付けは見えたときに行う（大きなファイルでも固まらないように）
md.renderer.rules.fence = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] ?? "";
  const code = token.content;
  const line = token.map ? ` data-line="${token.map[0]}"` : "";
  if (lang === "mermaid") {
    const svg = !(env as Env | undefined)?.sanitizeDocument && mermaidCache.get(code);
    if (svg) return `<div class="mermaid-block" data-processed="1"${line}>${svg}</div>`;
    return `<div class="mermaid-block"${line}><pre class="mermaid">${escapeHtml(code)}</pre></div>`;
  }
  // （```math は KaTeX プラグインが先に処理する）
  const cached = lang ? hlCache.get(hlKey(lang, code)) : undefined;
  const inner = cached ?? `<pre class="plain"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(code)}</code></pre>`;
  return `<div class="code-block"${line}>${COPY_BTN}${inner}</div>`;
};

md.use(footnote);
md.use(anchor, {
  slugifyWithState: (title, state) => {
    const env = state.env as Env;
    return (env.slugger ??= new GithubSlugger()).slug(title);
  },
  callback: (token, { slug, title }) => {
    const legacy = title.trim().toLowerCase().replace(/\s+/g, "-");
    if (legacy !== slug) token.attrSet("data-legacy-anchor", legacy);
  },
});

const frontMatterField = /^(?:(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')[ \t]*|((?!-[ \t])[^\s:#"'][^:]*)):(?:[ \t]+|$)(.*)$/;
const blockScalar = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:[ \t]+#.*)?$/;
type FrontMatterRow = [key: string, lines: string[]];

// 先頭のフロントマターを元の行番号のまま取り込む。
md.block.ruler.before("table", "front_matter", (state, start, end, silent) => {
  const lineAt = (i: number) => state.src.slice(state.bMarks[i], state.eMarks[i]);
  if (start !== 0 || state.level !== 0 || !/^\uFEFF?---[ \t]*$/.test(lineAt(0))) return false;
  const rows: FrontMatterRow[] = [];
  let row: FrontMatterRow | undefined;
  let inScalar = false;
  for (let i = 1; i < end; i++) {
    const line = lineAt(i);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      if (!row) return false;
      if (silent) return true;
      const token = state.push("front_matter", "details", 0);
      token.map = [0, i + 1];
      token.meta = { rows };
      state.line = i + 1;
      return true;
    }
    if (!line.trim()) {
      if (inScalar) row?.[1].push(line);
      continue;
    }
    const field = frontMatterField.exec(line);
    if (field) {
      const [, doubleQuoted, singleQuoted, plain, value] = field;
      const key = doubleQuoted?.replace(/\\(["\\])/g, "$1") ?? singleQuoted?.replace(/''/g, "'") ?? plain.trimEnd();
      inScalar = blockScalar.test(value.trimEnd());
      row = [key, inScalar || !value ? [] : [value]];
      rows.push(row);
    } else if (!row) {
      return false;
    } else if (/^[ \t]/.test(line)) {
      row[1].push(line);
    } else if (/^-[ \t]/.test(line)) {
      inScalar = false;
      row[1].push(line);
    } else if (line.startsWith("#")) {
      inScalar = false;
    } else {
      return false;
    }
  }
  return false;
});

md.renderer.rules.front_matter = (tokens, idx) => {
  const rows = tokens[idx].meta!.rows as FrontMatterRow[];
  const body = rows.map(([key, lines]) => `<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(lines.join("\n"))}</td></tr>`).join("");
  return `<details class="front-matter" data-line="0"><summary>フロントマター</summary><table><tbody>${body}</tbody></table></details>\n`;
};

const alertIcons = {
  note: "ⓘ",
  tip: "✦",
  important: "‼",
  warning: "⚠︎",
  caution: "⛔︎",
};

// 注記の記号だけを取り除き、本文は通常どおりインライン解析する。
md.core.ruler.before("inline", "markdown-alert", ({ tokens }) => {
  const levels = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "blockquote_close" && levels.delete(token.level)) {
      token.tag = "div";
    }
    if (token.type !== "blockquote_open" || token.level !== 0 || tokens[i + 1]?.type !== "paragraph_open") continue;
    const inline = tokens[i + 2];
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i.exec(inline.content);
    if (!match) continue;
    const kind = match[1].toLowerCase() as keyof typeof alertIcons;
    levels.add(token.level);
    token.type = "alert_open";
    token.tag = "div";
    token.content = kind;
    token.attrSet("class", `markdown-alert markdown-alert-${kind}`);
    inline.content = inline.content.slice(match[0].length);
    if (!inline.content) tokens.splice(i + 1, 3);
  }
});

md.renderer.rules.alert_open = (tokens, idx, options, _env, self) => {
  const kind = tokens[idx].content as keyof typeof alertIcons;
  const title = kind[0].toUpperCase() + kind.slice(1);
  return self.renderToken(tokens, idx, options) +
    `<p class="markdown-alert-title"><span aria-hidden="true">${alertIcons[kind]}</span> ${title}</p>\n`;
};

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
for (const name of ["paragraph_open", "heading_open", "bullet_list_open", "ordered_list_open", "table_open", "blockquote_open", "alert_open", "hr", "html_block", "code_block"]) {
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
md.renderer.rules.task_checkbox = (tokens, idx) =>
  `<input type="checkbox" disabled ${tokens[idx].content ? "checked" : ""}> `;

md.core.ruler.after("inline", "task-list", (state) => {
  for (let i = 0; i < state.tokens.length; i++) {
    if (state.tokens[i].type !== "list_item_open" || state.tokens[i + 1]?.type !== "paragraph_open") continue;
    const token = state.tokens[i + 2];
    if (!token.children?.length) continue;
    const first = token.children[0];
    const m = first.type === "text" ? /^\[([ xX])\]\s/.exec(first.content) : null;
    if (!m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("task_checkbox", "", 0);
    box.content = m[1].trim();
    token.children.unshift(box);
  }
  return true;
});

export type MarkdownChunk = {
  /** 同じなら同じ HTML になる目印（元の Markdown の該当部分と、その開始行など） */
  key: string;
  /** その部分の HTML（必要になったときに作る） */
  html: () => string;
};

/** トークンの範囲を HTML にする。生 HTML を含む最上位のブロックだけを無害化する */
function renderRange(tokens: ReturnType<typeof md.parse>, from: number, to: number, base?: string) {
  const render = (a: number, b: number, sanitizeDocument = false) =>
    md.renderer.render(tokens.slice(a, b), md.options, { base, sanitizeDocument } satisfies Env);
  let html = "";
  let start = from;
  let blockStart = from;
  let depth = 0;
  let hasRawHtml = false;
  for (let i = from; i < to; i++) {
    const token = tokens[i];
    hasRawHtml ||= token.type === "html_block" ||
      (token.children?.some((child) => child.type === "html_inline") ?? false);
    depth += token.nesting;
    if (depth !== 0) continue;
    const end = i + 1;
    if (hasRawHtml) {
      html += render(start, blockStart);
      const clean = sanitizeHtmlBlock(render(blockStart, end, true));
      // HTML が後ろのブロックまで続いている: この範囲の残りをまとめて無害化する
      if (clean === null) return html + sanitizeMarkdown(render(blockStart, to, true));
      html += clean;
      start = end;
      hasRawHtml = false;
    }
    blockStart = end;
  }
  return html + render(start, to);
}

export function renderMarkdown(src: string, base?: string) {
  const tokens = md.parse(src, { base });
  return renderRange(tokens, 0, tokens.length, base);
}

/**
 * 長い文書を少しずつ描くために、Markdown を最上位のブロックの区切りで塊に分ける。
 * 解析は全体で1回だけ行い、各塊の HTML は必要になったときに作る。
 * 塊は前から数えて chunkTokens 個ほどのトークンごとに区切るので、末尾への追記では前の塊の key は変わらない
 * （最後の塊は脚注などを含むため毎回作り直す）。
 * 各塊は別々の要素に innerHTML で入れること（無害化は塊ごとに完結している）。
 */
export function markdownChunks(src: string, base?: string, chunkTokens = 1500): MarkdownChunk[] {
  const env: Record<string, unknown> = { base };
  const tokens = md.parse(src, env);
  const lineStarts = [0];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const offset = (line: number) => (line < lineStarts.length ? lineStarts[line] : src.length);
  // 参照リンクの定義や脚注は文書のどこにあっても前の部分の表示に効くので、その一覧も目印に含める
  const refs = Object.keys((env.references as object | undefined) ?? {}).join("\u0000");
  const notes = JSON.stringify((env.footnotes as { refs?: object } | undefined)?.refs ?? {});
  const prefix = `${mathPlugin ? 1 : 0}|${base ?? ""}|${refs}|${notes}|`;
  const ranges: [number, number][] = [];
  let chunkStart = 0;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    depth += tokens[i].nesting;
    if (depth === 0 && i + 1 - chunkStart >= chunkTokens) {
      ranges.push([chunkStart, i + 1]);
      chunkStart = i + 1;
    }
  }
  if (chunkStart < tokens.length || !ranges.length) ranges.push([chunkStart, tokens.length]);
  const firstLine = (a: number, b: number) => {
    for (let i = a; i < b; i++) if (tokens[i].map) return tokens[i].map![0];
    return undefined;
  };
  return ranges.map(([a, b], k) => {
    let cache: string | undefined;
    const last = k === ranges.length - 1;
    const from = firstLine(a, b);
    const to = last ? undefined : firstLine(ranges[k + 1][0], ranges[k + 1][1]);
    const key = last || from === undefined || to === undefined
      ? `${prefix}last:${Math.random()}`
      : `${prefix}${from}:${src.slice(offset(from), offset(to))}`;
    return { key, html: () => (cache ??= renderRange(tokens, a, b, base)) };
  });
}

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
      const styles = getComputedStyle(document.documentElement);
      const cssValue = (name: string) => styles.getPropertyValue(name).trim();
      const bg = cssValue("--bg");
      const bgSide = cssValue("--bg-side");
      const bgElev = cssValue("--bg-elev");
      const bgHover = cssValue("--bg-hover");
      const fg = cssValue("--fg");
      const fgFaint = cssValue("--fg-faint");
      const accent = cssValue("--accent");
      const danger = cssValue("--danger");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          darkMode: true,
          background: bg,
          primaryColor: bgElev,
          primaryTextColor: fg,
          primaryBorderColor: fgFaint,
          lineColor: fgFaint,
          arrowheadColor: fgFaint,
          secondaryColor: bgHover,
          secondaryTextColor: fg,
          tertiaryColor: bgSide,
          tertiaryTextColor: fg,
          noteBkgColor: bgSide,
          noteTextColor: fg,
          textColor: fg,
          fontFamily: cssValue("--font-ui"),
          // Gantt
          sectionBkgColor: bgHover,
          altSectionBkgColor: bgSide,
          sectionBkgColor2: bgElev,
          excludeBkgColor: bgSide,
          taskBkgColor: bgElev,
          activeTaskBkgColor: bgHover,
          activeTaskBorderColor: accent,
          doneTaskBkgColor: bgSide,
          doneTaskBorderColor: fgFaint,
          critBkgColor: bgHover,
          critBorderColor: danger,
          todayLineColor: danger,
          vertLineColor: fgFaint,
          taskTextColor: fg,
          taskTextOutsideColor: fg,
          taskTextLightColor: fg,
          taskTextDarkColor: fg,
          taskTextClickableColor: accent,
          gridColor: fgFaint,
          xyChart: {
            backgroundColor: bg,
            xAxisTickColor: fgFaint,
            xAxisLineColor: fgFaint,
            yAxisTickColor: fgFaint,
            yAxisLineColor: fgFaint,
            plotColorPalette: [accent, cssValue("--git-added"), cssValue("--git-modified"), danger, fgFaint].join(","),
          },
        },
        secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "theme", "themeVariables", "themeCSS", "dompurifyConfig"],
      });
      return mermaid;
    });
  }
  const mermaid = await mermaidLoaded;
  const id = `mermaid-${++mermaidSeq}`;
  try {
    let svg = mermaidCache.get(code);
    if (!svg) {
      // strict モードで無害化された SVG を保存する。
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
