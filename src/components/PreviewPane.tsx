import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Preview, { type FindResult } from "./Preview";
import FindBar from "./FindBar";
import OverviewRuler, { type Heading, useOutline } from "./OverviewRuler";
import type { DocTab } from "../lib/tabs";

export type FindState = { open: boolean; query: string; index: number; focus: number };

type Props = {
  id: string;
  tab: DocTab;
  initialScroll: number;
  onScroll: (top: number) => void;
  find: FindState;
  setFind: (f: (s: FindState) => FindState) => void;
  onTrail: (trail: Heading[], scrollTo: (top: number) => void) => void;
  onOpenLink: (path: string, anchor?: string, newTab?: boolean) => void;
  /** スクロールする要素（編集＋プレビューの同期で使う） */
  scrollerRef?: React.RefObject<HTMLDivElement | null>;
};

/** プレビューと、右端の帯・検索バーをまとめたもの */
export default function PreviewPane({ id, tab, initialScroll, onScroll, find, setFind, onTrail, onOpenLink, scrollerRef }: Props) {
  const own = useRef<HTMLDivElement>(null);
  const body = scrollerRef ?? own;
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<FindResult>({ count: 0, tops: [] });
  const { headings, metrics, trail } = useOutline(body, version, true);

  // タブを開いたときに前回のスクロール位置へ戻す。図や色付けで高さが変わるので少し後にもう一度。
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !initialScroll) return;
    el.scrollTop = initialScroll;
    const t = window.setTimeout(() => (el.scrollTop = initialScroll), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 末尾まで読んでいるときは、外部で追記されたら末尾に付いていく（ログのように）
  const stick = useRef(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current && !scrollerRef) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const scrollTo = (top: number) => body.current && (body.current.scrollTop = top);
  const trailKey = trail.map((h) => h.text).join("\u0000");
  useEffect(() => {
    onTrail(trail, scrollTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailKey]);

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
