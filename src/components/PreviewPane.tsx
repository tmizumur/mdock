import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Preview, { type FindResult } from "./Preview";
import FindBar from "./FindBar";
import OverviewRuler, { type Heading, useOutline } from "./OverviewRuler";
import type { OutlineState } from "./Outline";
import type { DocTab } from "../lib/tabs";

export type FindState = { open: boolean; query: string; index: number; focus: number };

type Props = {
  id: string;
  tab: DocTab;
  initialScroll: number;
  onScroll: (top: number) => void;
  find: FindState;
  setFind: (f: (s: FindState) => FindState) => void;
  onOutline: (outline: OutlineState) => void;
  onOpenLink: (path: string, anchor?: string, newTab?: boolean) => void;
  /** スクロールする要素（編集＋プレビューの同期で使う） */
  scrollerRef?: React.RefObject<HTMLDivElement | null>;
};

/** プレビューと、右端の帯・検索バーをまとめたもの */
export default function PreviewPane({ id, tab, initialScroll, onScroll, find, setFind, onOutline, onOpenLink, scrollerRef }: Props) {
  const own = useRef<HTMLDivElement>(null);
  const body = scrollerRef ?? own;
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<FindResult>({ count: 0, tops: [] });
  const { headings, metrics, current } = useOutline(body, version);
  const [jumped, setJumped] = useState<{ heading: Heading; top: number }>();
  const jumpedIndex = jumped ? headings.indexOf(jumped.heading) : -1;

  const restoreTimer = useRef<number>(undefined);
  const cancelRestore = useCallback(() => window.clearTimeout(restoreTimer.current), []);
  // タブを開いたときに前回のスクロール位置へ戻す。図や色付けで高さが変わるので少し後にもう一度。
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !initialScroll) return;
    el.scrollTop = initialScroll;
    restoreTimer.current = window.setTimeout(() => (el.scrollTop = initialScroll), 300);
    return cancelRestore;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 末尾まで読んでいるときは、外部で追記されたら末尾に付いていく（ログのように）
  const stick = useRef(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current && !scrollerRef) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const scrollTo = useCallback((top: number) => {
    if (body.current) body.current.scrollTop = top;
  }, [body]);
  const jump = useCallback((i: number) => {
    const heading = headings[i];
    scrollTo(heading.top - 8);
    setJumped({ heading, top: body.current?.scrollTop ?? 0 });
  }, [body, headings, scrollTo]);
  useEffect(() => {
    onOutline({ headings, current: jumpedIndex < 0 ? current : jumpedIndex, jump });
  }, [headings, current, jumpedIndex, jump, onOutline]);

  return (
    <div className="pane-main">
      {find.open && (
        <FindBar
          query={find.query}
          index={find.index}
          count={result.count}
          focusSignal={find.focus}
          onChange={(query) => setFind((f) => ({ ...f, query, index: 0 }))}
          onStep={(d) => setFind((f) => ({ ...f, index: f.index + d }))}
          onClose={() => setFind((f) => ({ ...f, open: false }))}
        />
      )}
      <div
        className="pane-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (jumped && Math.abs(jumped.top - el.scrollTop) > 1) setJumped(undefined);
          stick.current = el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
          onScroll(el.scrollTop);
        }}
      >
        <Preview
          id={id}
          path={tab.path}
          content={tab.content}
          scroller={body}
          onOpenLink={onOpenLink}
          anchor={tab.anchor}
          onAnchorScrolled={cancelRestore}
          find={find.open ? { query: find.query, index: find.index } : undefined}
          onFindResult={setResult}
          onRendered={() => setVersion((v) => v + 1)}
          immediate={tab.content === tab.saved}
        />
      </div>
      <OverviewRuler headings={headings} metrics={metrics} marks={find.open ? result.tops : undefined} onScrollTo={scrollTo} />
    </div>
  );
}
