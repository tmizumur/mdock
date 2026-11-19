import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import type { HighlighterGeneric } from "shiki";

/** よく使う言語だけ先に読み込む。それ以外はプレーン表示。 */
const LANGS = [
  "ts", "tsx", "js", "jsx", "json", "jsonc", "yaml", "toml", "bash", "shell",
  "python", "rust", "go", "java", "kotlin", "swift", "c", "cpp", "csharp",
  "html", "css", "scss", "sql", "markdown", "diff", "dockerfile", "ruby", "php",
];

let highlighter: HighlighterGeneric<string, string> | null = null;
let loading: Promise<void> | null = null;

/** Shiki は起動を遅くしないよう、初回表示の後で読み込む */
export function loadHighlighter(): Promise<void> {
  if (!loading) {
    loading = import("shiki").then(async ({ createHighlighter }) => {
      highlighter = (await createHighlighter({
        themes: ["github-light", "github-dark"],
        langs: LANGS,
      })) as HighlighterGeneric<string, string>;
    });
  }
  return loading;
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight(code: string, lang: string): string {
    if (lang === "mermaid") {
      return `<pre class="mermaid">${md.utils.escapeHtml(code)}</pre>`;
    }
    if (highlighter && lang && highlighter.getLoadedLanguages().includes(lang)) {
      return highlighter.codeToHtml(code, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      });
    }
    return `<pre class="plain"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

md.use(anchor, { slugify: (s: string) => encodeURIComponent(s.trim().toLowerCase().replace(/\s+/g, "-")) });

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

export const renderMarkdown = (src: string) => md.render(src);

let mermaidLoaded: Promise<typeof import("mermaid").default> | null = null;

/** Mermaid 図があるときだけ読み込んで描画する */
export async function renderMermaid(root: HTMLElement) {
  const nodes = root.querySelectorAll<HTMLElement>("pre.mermaid:not([data-processed])");
  if (!nodes.length) return;
  if (!mermaidLoaded) {
    mermaidLoaded = import("mermaid").then((m) => {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      m.default.initialize({ startOnLoad: false, theme: dark ? "dark" : "default" });
      return m.default;
    });
  }
  const mermaid = await mermaidLoaded;
  try {
    await mermaid.run({ nodes: Array.from(nodes) });
  } catch (e) {
    console.warn("mermaid", e);
  }
}
