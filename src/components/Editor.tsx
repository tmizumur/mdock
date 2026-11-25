import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { openSearchPanel } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { useSettings } from "../lib/settings";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** 開いたときのスクロール位置 */
  initialScroll?: number;
  onScroll?: (top: number) => void;
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

/** CodeMirror 6 の Markdown エディタ */
const Editor = forwardRef<EditorHandle, Props>(function Editor({ value, onChange, initialScroll, onScroll }, handle) {
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
          basicSetup,
          JA,
          markdown({ codeLanguages: languages }),
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

  return <div className={`editor font-${settings.editorFont}`} ref={host} />;
});

export default Editor;
