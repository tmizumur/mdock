import { useCallback, useEffect, useRef, useState } from "react";
import type { OutlineHeading } from "./Outline";

export type Heading = OutlineHeading & { top: number };

/**
 * プレビューの見出し一覧と、今読んでいる見出しを追う。
 * version が変わったとき（描き直し・画像の読み込み）と、大きさが変わったときに位置を測り直す。
 */
export function useOutline(scroller: React.RefObject<HTMLDivElement | null>, version: number) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [metrics, setMetrics] = useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 });
  const raf = useRef(0);

  const measure = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const sc = scroller.current;
      if (!sc) return;
      const base = sc.getBoundingClientRect().top - sc.scrollTop;
      const hs = Array.from(sc.querySelectorAll<HTMLElement>(".markdown-body :is(h1, h2, h3, h4, h5, h6)")).map((el) => ({
        level: Number(el.tagName[1]),
        text: el.textContent?.trim() ?? "",
        top: el.getBoundingClientRect().top - base,
      }));
      setHeadings(hs);
      setMetrics({ scrollTop: sc.scrollTop, scrollHeight: Math.max(1, sc.scrollHeight), clientHeight: sc.clientHeight });
    });
  }, [scroller]);

  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    measure();
    const onScroll = () =>
      setMetrics({ scrollTop: sc.scrollTop, scrollHeight: Math.max(1, sc.scrollHeight), clientHeight: sc.clientHeight });
    sc.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    const body = sc.querySelector(".markdown-body");
    if (body) ro.observe(body);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf.current);
    };
  }, [scroller, measure, version]);

  // 画面上端までに通過した見出しを使う。末尾では、上端まで届かない最後の見出しも拾う。
  const atBottom = metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 2 && metrics.scrollTop > 0;
  const line = atBottom ? metrics.scrollHeight : metrics.scrollTop + 12;
  let current = -1;
  for (let i = 0; i < headings.length && headings[i].top <= line; i++) current = i;
  if (current < 0 && headings[0]?.top < metrics.clientHeight) current = 0;
  return { headings, metrics, current };
}

type Props = {
  headings: Heading[];
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number };
  /** 検索の一致箇所（本文の先頭からの px） */
  marks?: number[];
  onScrollTo: (top: number) => void;
};

/**
 * VS Code の概要ルーラーのような、プレビュー右端の細い帯。
 * 見出しの位置に目盛り、今見えている範囲に半透明の枠。クリック・ドラッグでその位置へ移動する。
 */
export default function OverviewRuler({ headings, metrics, marks, onScrollTo }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ y: number; text: string } | null>(null);
  const dragging = useRef(false);
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  const pct = (px: number) => `${(px / scrollHeight) * 100}%`;

  const toScroll = (clientY: number) => {
    const r = bar.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    onScrollTo(ratio * scrollHeight - clientHeight / 2);
  };

  const onMove = (e: React.PointerEvent) => {
    if (dragging.current) {
      toScroll(e.clientY);
      setHover(null);
      return;
    }
    const r = bar.current!.getBoundingClientRect();
    const y = e.clientY - r.top;
    // マウスに近い見出し（5px 以内）の名前を出す
    let best: Heading | null = null;
    let dist = 6;
    for (const h of headings) {
      const d = Math.abs((h.top / scrollHeight) * r.height - y);
      if (d < dist) {
        dist = d;
        best = h;
      }
    }
    setHover(best ? { y: (best.top / scrollHeight) * r.height, text: best.text } : null);
  };

  if (scrollHeight <= clientHeight + 1 && !headings.length) return <div className="ruler" />;

  return (
    <div
      className="ruler"
      ref={bar}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        toScroll(e.clientY);
      }}
      onPointerMove={onMove}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onLostPointerCapture={() => { dragging.current = false; }}
      onPointerLeave={() => setHover(null)}
      aria-hidden
    >
      {marks?.map((t, i) => <div key={`m${i}`} className="ruler-find" style={{ top: pct(t) }} />)}
      {headings.map((h, i) => (
        <div key={i} className={`ruler-h l${h.level}`} style={{ top: pct(h.top) }} />
      ))}
      <div
        className="ruler-view"
        style={{ top: `min(calc(100% - 4px), ${pct(scrollTop)})`, height: `max(4px, ${pct(Math.min(scrollHeight, clientHeight))})` }}
      />
      {hover && (
        <div className="ruler-tip" style={{ top: hover.y }}>
          {hover.text}
        </div>
      )}
    </div>
  );
}
