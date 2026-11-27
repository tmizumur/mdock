import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { computeDiff } from "../lib/diffClient";
import { countLines, foldRows, type Result, type Row } from "../lib/diffRows";
import type { DiffTab } from "../lib/tabs";

/** 2つのファイルの差分を左右に並べて表示する */
export default function DiffView({ tab }: { tab: DiffTab }) {
  const { leftText, rightText } = tab;
  const [completed, setCompleted] = useState<{ leftText: string; rightText: string; result: Result }>();
  const result = completed?.leftText === leftText && completed.rightText === rightText ? completed.result : undefined;
  // 再計算の間は前の差分を出したままにする（ファイルの更新でスクロール位置が先頭に戻らないように）
  const previous = !result && completed && "rows" in completed.result ? completed.result : undefined;
  const diff = result && "rows" in result ? result : previous;

  useEffect(() => {
    let active = true;
    const { promise, cancel } = computeDiff(leftText, rightText);
    const publish = (result: Result) => {
      if (active) setCompleted({ leftText, rightText, result });
    };
    void promise.then(publish, () => publish({ error: "差分を表示できませんでした" }));
    return () => {
      active = false;
      cancel();
    };
  }, [leftText, rightText]);

  const name = (p: string) => p.replace(/\\/g, "/").split("/").slice(-2).join("/");
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-file del" title={tab.left}>
          {name(tab.left)}
        </span>
        <span className="diff-stat">
          {diff && (
            <>
              <span className="add">+{diff.added}</span> <span className="del">−{diff.removed}</span>
              {!diff.added && !diff.removed && " 差分はありません"}
            </>
          )}
        </span>
        <span className="diff-file add" title={tab.right}>
          {name(tab.right)}
        </span>
      </div>
      {diff ? (
        <DiffRows rows={diff.rows} />
      ) : (
        <div className="diff-body">
          <div className="diff-status" role="status">
            {!result ? "差分を計算しています…" : "tooLarge" in result
              ? `差分が大きすぎます（合計 ${countLines(leftText) + countLines(rightText)} 行）`
              : "差分を表示できませんでした"}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffRows({ rows }: { rows: Row[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  // 展開状態は、差分（rows）が変わったら空に戻す
  const [state, setState] = useState<{ rows: Row[]; expanded: ReadonlySet<number> }>(() => ({ rows, expanded: new Set() }));
  const expanded = useMemo(() => state.rows === rows ? state.expanded : new Set<number>(), [state, rows]);
  const items = useMemo(() => foldRows(rows, 3, expanded), [rows, expanded]);
  const getItemKey = useCallback((index: number) => {
    const item = items[index];
    if (item.type === "fold") return `fold:${item.id}`;
    return item.row.left ? `left:${item.row.left.n}` : `right:${item.row.right?.n}`;
  }, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getItemKey,
    getScrollElement: () => scroller.current,
    estimateSize: () => 19,
    overscan: 20,
  });

  return (
    <div className="diff-body" ref={scroller}>
      <div className="diff-rows" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(({ index, key, start }) => {
          const item = items[index];
          const style = { transform: `translateY(${start}px)` };
          if (item.type === "fold") {
            return (
              <button type="button" className="diff-fold" key={key} style={style}
                data-index={index} ref={virtualizer.measureElement}
                onClick={() => setState({ rows, expanded: new Set([...expanded, item.id]) })}>
                ⋯ {item.count} 行の変更なし
              </button>
            );
          }

          const { left, right, kind } = item.row;
          return (
            <div className="diff-row" key={key} style={style} data-index={index} ref={virtualizer.measureElement}>
              <div className="num">{left?.n}</div>
              <div className={`code ${left ? "" : "empty"} ${kind === "del" || kind === "change" ? "del" : ""}`}>{left?.text}</div>
              <div className="num">{right?.n}</div>
              <div className={`code ${right ? "" : "empty"} ${kind === "add" || kind === "change" ? "add" : ""}`}>{right?.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
