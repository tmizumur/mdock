import { useLayoutEffect, useRef } from "react";

export type OutlineHeading = { level: number; text: string };

export type OutlineState = {
  headings: OutlineHeading[];
  current: number;
  jump: (index: number) => void;
};

export default function Outline({ outline }: { outline: OutlineState | undefined }) {
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const scroller = list.current;
    const current = scroller?.querySelector("[aria-current]");
    if (!scroller || !current) return;
    const row = current.getBoundingClientRect();
    const area = scroller.getBoundingClientRect();
    if (row.top < area.top) scroller.scrollTop += row.top - area.top;
    else if (row.bottom > area.bottom) scroller.scrollTop += row.bottom - area.bottom;
  }, [outline?.headings, outline?.current]);

  return (
    <section className="outline" aria-labelledby="outline-label">
      <h2 className="sidebar-label" id="outline-label">アウトライン</h2>
      {outline?.headings.length ? (
        <ul className="outline-list" ref={list}>
          {outline.headings.map((heading, i) => (
            <li key={i}>
              <button
                type="button"
                aria-current={i === outline.current ? "location" : undefined}
                style={{ paddingInlineStart: 8 + (heading.level - 1) * 10 }}
                title={heading.text}
                onClick={() => outline.jump(i)}
              >
                {heading.text}
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="outline-empty">見出しがありません</p>}
    </section>
  );
}
