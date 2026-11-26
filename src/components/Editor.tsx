import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { openSearchPanel } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { styleTags, tags } from "@lezer/highlight";
import { useSettings } from "../lib/settings";
import type { markdownHeadings } from "../lib/markdown";
import { editorTopLine, scrollEditorToLine } from "../lib/scrollSync";
import type { OutlineState } from "./Outline";
import OverviewRuler, { type Heading } from "./OverviewRuler";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** 開いたときのスクロール位置 */
  initialScroll?: number;
  onScroll?: (top: number) => void;
  headings?: ReturnType<typeof markdownHeadings>;
  onOutline?: (outline: OutlineState) => void;
};

export type EditorHandle = {
  /** 検索パネル（⌘F）を開く */
  openSearch: () => void;
  view: () => EditorView | null;
};

/** CodeMirror の検索パネルなどの文言を日本語にする */
const JA = EditorState.phrases.of({
  Find: "検索",
  Replace: "置換",
  next: "次へ",
  previous: "前へ",
  all: "すべて",
  "match case": "大文字と小文字を区別",
  "by word": "単語単位",
  regexp: "正規表現",
  replace: "置換",
  "replace all": "すべて置換",
  close: "閉じる",
  "current match": "現在の一致",
  "replaced $ matches": "$ 件置換しました",
  "replaced match on line $": "$ 行目を置換しました",
  "on line": "行目",
  "Go to line": "行へ移動",
  go: "移動",
});

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--fg)", colorScheme: "dark" },
  ".cm-scroller .cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-faint)" },
  ".cm-scroller .cm-gutters-before": { borderInlineEnd: "1px solid var(--border-soft)" },
  ".cm-gutters .cm-gutter, .cm-gutters .cm-lineNumbers": { backgroundColor: "var(--bg)", color: "var(--fg-faint)" },
  ".cm-gutters .cm-activeLineGutter": { backgroundColor: "var(--bg-elev)", color: "var(--fg)" },
  ".cm-line": { paddingInline: "40px" },
  ".cm-content .cm-activeLine": { backgroundColor: "var(--bg-elev)" },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { background: "var(--accent-soft)" },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-searchMatch": { backgroundColor: "var(--find)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--accent)", color: "var(--bg)" },
  ".cm-searchMatch-selected span": { color: "inherit" },
  ".cm-scroller .cm-content": { caretColor: "var(--accent)" },
  ".cm-scroller .cm-cursor, .cm-scroller .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-foldGutter span": { color: "var(--fg-faint)" },
  ".cm-foldGutter span:hover": { color: "var(--fg)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-elev)", border: "1px solid var(--border)", color: "var(--fg-muted)" },
  ".cm-panels": { backgroundColor: "var(--bg-side)", color: "var(--fg)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-textfield, .cm-button": {
    backgroundColor: "var(--bg-elev)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-small)",
  },
  ".cm-button, .cm-button:active": { backgroundImage: "none" },
  ".cm-button:active": { backgroundColor: "var(--bg-hover)" },
  ".cm-panel button[name=close]": { color: "var(--fg-muted)" },
  ".cm-panel button[name=close]:hover": { color: "var(--fg)" },
  ".cm-panel label": { color: "var(--fg-muted)" },
  ".cm-panel input[type=checkbox]": { accentColor: "var(--accent)" },
  ".cm-textfield::placeholder": { color: "var(--fg-faint)", opacity: "1" },
  ".cm-textfield:focus": { borderColor: "var(--accent)", outline: "none" },
  ".cm-tooltip, .cm-tooltip-autocomplete": { backgroundColor: "var(--bg-side)", border: "1px solid var(--border)", color: "var(--fg)" },
  ".cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--fg)" },
  ".cm-completionDetail, .cm-completionMatchedText": { color: "var(--fg-muted)" },
  ".cm-tooltip-above .cm-tooltip-arrow::before": { borderTopColor: "var(--border)" },
  ".cm-tooltip-above .cm-tooltip-arrow::after": { borderTopColor: "var(--bg-side)" },
  ".cm-tooltip-below .cm-tooltip-arrow::before": { borderBottomColor: "var(--border)" },
  ".cm-tooltip-below .cm-tooltip-arrow::after": { borderBottomColor: "var(--bg-side)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--accent-soft)" },
  "&.cm-focused .cm-nonmatchingBracket": {
    backgroundColor_fallback: "var(--diff-del)",
    backgroundColor: "color-mix(in srgb, var(--danger) 20%, transparent)",
  },
  ".cm-specialChar": { color: "var(--danger)" },
}, { dark: true });

// Markdown の見出し記号を、ほかの処理記号と別の色にする。
const headingMark = tags.special(tags.processingInstruction);
const editorHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--fg)", fontWeight: "bold" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: [tags.comment, tags.quote, tags.processingInstruction, tags.meta, tags.punctuation], color: "var(--fg-muted)" },
  { tag: tags.keyword, color: "var(--code-keyword)" },
  { tag: [tags.string, tags.regexp], color: "var(--code-string)" },
  { tag: [tags.number, tags.atom, tags.bool, tags.null, tags.constant(tags.name), tags.typeName, tags.className], color: "var(--git-modified)" },
  { tag: [headingMark, tags.url, tags.function(tags.name)], color: "var(--accent)" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

/** CodeMirror 6 の Markdown エディタ */
const Editor = forwardRef<EditorHandle, Props>(function Editor({ value, onChange, initialScroll, onScroll, headings, onOutline }, handle) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const wrapping = useRef(new Compartment());
  const { settings } = useSettings();

  useImperativeHandle(handle, () => ({
    openSearch: () => {
      const v = view.current;
      if (v) openSearchPanel(v);
    },
    view: () => view.current,
  }));

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(syntaxHighlighting(editorHighlightStyle)),
          basicSetup,
          editorTheme,
          JA,
          markdown({
            codeLanguages: languages,
            extensions: { props: [styleTags({ HeaderMark: headingMark })] },
          }),
          wrapping.current.of(settings.wrap ? EditorView.lineWrapping : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    v.focus();
    if (initialScroll) requestAnimationFrame(() => (v.scrollDOM.scrollTop = initialScroll));
    const scrolled = () => onScrollRef.current?.(v.scrollDOM.scrollTop);
    v.scrollDOM.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      v.scrollDOM.removeEventListener("scroll", scrolled);
      view.current = null;
      v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 折り返しの設定を切り替えたとき
  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.current.reconfigure(settings.wrap ? EditorView.lineWrapping : []) });
  }, [settings.wrap]);

  // 外部でファイルが書き換わったときなど、値が変わったら反映する
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur === value) return;
    // 変わった部分だけ置き換える（カーソルとスクロール位置を保つため）
    let a = 0;
    const max = Math.min(cur.length, value.length);
    while (a < max && cur.charCodeAt(a) === value.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === value.charCodeAt(value.length - 1 - b)) b++;
    v.dispatch({ changes: { from: a, to: cur.length - b, insert: value.slice(a, value.length - b) } });
  }, [value]);

  const [rulerHeadings, setRulerHeadings] = useState<Heading[]>([]);
  const [metrics, setMetrics] = useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 });
  const [current, setCurrent] = useState(-1);
  const jumped = useRef<{ heading: NonNullable<Props["headings"]>[number]; top: number } | undefined>(undefined);

  useEffect(() => {
    const v = view.current;
    if (!v || !headings) return;
    const sc = v.scrollDOM;
    let frame = 0;
    const readPosition = () => {
      const { scrollTop, scrollHeight, clientHeight } = sc;
      const atBottom = scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2;
      const line = atBottom ? v.state.doc.lines : editorTopLine(v);
      let index = -1;
      for (let i = 0; i < headings.length && headings[i].line <= line; i++) index = i;
      if (jumped.current && Math.abs(jumped.current.top - scrollTop) > 1) jumped.current = undefined;
      const jumpedIndex = jumped.current ? headings.indexOf(jumped.current.heading) : -1;
      setCurrent(jumpedIndex < 0 ? index : jumpedIndex);
      setMetrics({ scrollTop, scrollHeight: Math.max(1, scrollHeight), clientHeight });
    };
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const doc = v.state.doc;
        setRulerHeadings(headings.map((h) => ({
          ...h,
          top: v.lineBlockAt(doc.line(Math.min(h.line + 1, doc.lines)).from).top,
        })));
        readPosition();
      });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(sc);
    resize.observe(v.contentDOM);
    sc.addEventListener("scroll", readPosition, { passive: true });
    measure();
    return () => {
      sc.removeEventListener("scroll", readPosition);
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [headings]);

  const jump = useCallback((i: number) => {
    const v = view.current;
    if (!v || !headings) return;
    scrollEditorToLine(v, headings[i].line);
    jumped.current = { heading: headings[i], top: v.scrollDOM.scrollTop };
    setCurrent(i);
  }, [headings]);
  useEffect(() => {
    if (headings && onOutline) onOutline({ headings, current, jump });
  }, [headings, current, jump, onOutline]);

  return (
    <div className="editor-layout">
      <div className={`editor font-${settings.editorFont}`} ref={host} />
      {headings && <OverviewRuler headings={rulerHeadings} metrics={metrics} onScrollTo={(top) => {
        const sc = view.current?.scrollDOM;
        if (sc) sc.scrollTop = top;
      }} />}
    </div>
  );
});

export default Editor;
