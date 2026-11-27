import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ListFilter, X } from "lucide-react";
import { type OutlineHeading, outlineRows, visibleCurrent } from "../lib/outline";

export type { OutlineHeading };

export type OutlineState = {
  headings: OutlineHeading[];
  current: number;
  jump: (index: number) => void;
};

/** タブごとの折りたたみ状態（メモリ上だけ。保存はしない） */
const collapsedByTab = new Map<string, Set<number>>();

export default function Outline({ outline, tabKey }: { outline: OutlineState | undefined; tabKey?: string }) {
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [filtering, setFiltering] = useState(false);
  const [filter, setFilter] = useState("");
  // 折りたたみを変えたら描き直す（状態そのものは collapsedByTab に持つ）
  const [, setVersion] = useState(0);
  const collapsed = (tabKey && collapsedByTab.get(tabKey)) || new Set<number>();
  const headings = useMemo(() => outline?.headings ?? [], [outline?.headings]);
  const rows = outlineRows(headings, filtering ? filter : "", collapsed);
  const current = visibleCurrent(headings, rows, outline?.current ?? -1);

  const toggle = (i: number) => {
    if (!tabKey) return;
    const next = new Set(collapsed);
    if (!next.delete(i)) next.add(i);
    collapsedByTab.set(tabKey, next);
    setVersion((v) => v + 1);
  };
  const closeFilter = () => {
    setFilter("");
    setFiltering(false);
  };

  useLayoutEffect(() => {
    const scroller = list.current;
    const row = scroller?.querySelector("[aria-current]");
    if (!scroller || !row) return;
    const r = row.getBoundingClientRect();
    const area = scroller.getBoundingClientRect();
    if (r.top < area.top) scroller.scrollTop += r.top - area.top;
    else if (r.bottom > area.bottom) scroller.scrollTop += r.bottom - area.bottom;
  }, [headings, current]);

  return (
    <section className="outline" aria-labelledby="outline-label">
      <div className="outline-head">
        <h2 className="sidebar-label" id="outline-label">アウトライン</h2>
        {filtering ? (
          <input
            ref={input}
            className="outline-filter"
            value={filter}
            placeholder="見出しを絞り込む"
            aria-label="見出しを絞り込む"
            spellCheck={false}
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                if (filter) setFilter("");
                else closeFilter();
              }
            }}
          />
        ) : null}
        <button
          className="icon-btn"
          type="button"
          title={filtering ? "絞り込みをやめる" : "見出しを絞り込む"}
          aria-label={filtering ? "絞り込みをやめる" : "見出しを絞り込む"}
          onClick={() => (filtering ? closeFilter() : setFiltering(true))}
        >
          {filtering ? <X size={13} /> : <ListFilter size={13} />}
        </button>
      </div>
      {rows.length ? (
        <ul className="outline-list" ref={list}>
          {rows.map(({ index: i, hasChildren, dim }) => {
            const heading = headings[i];
            const folded = !filtering && collapsed.has(i);
            const Chevron = folded ? ChevronRight : ChevronDown;
            return (
              <li key={i} className={dim ? "dim" : undefined} style={{ paddingInlineStart: (heading.level - 1) * 10 }}>
                {hasChildren && !filtering ? (
                  <button
                    type="button"
                    className="outline-toggle"
                    aria-label={folded ? "開く" : "折りたたむ"}
                    aria-expanded={!folded}
                    onClick={() => toggle(i)}
                  >
                    <Chevron size={12} />
                  </button>
                ) : (
                  <span className="outline-toggle" />
                )}
                <button
                  type="button"
                  className="outline-item"
                  aria-current={i === current ? "location" : undefined}
                  title={heading.text}
                  onClick={() => outline?.jump(i)}
                >
                  {heading.text}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="outline-empty">{headings.length ? "一致する見出しがありません" : "見出しがありません"}</p>
      )}
    </section>
  );
}
