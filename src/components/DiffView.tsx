import { useMemo } from "react";
import { diffLines } from "diff";
import type { DiffTab } from "../lib/tabs";

type Cell = { n: number; text: string } | null;
type Row = { left: Cell; right: Cell; kind: "same" | "change" | "del" | "add" };

const splitLines = (s: string) => {
  const lines = s.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** 行単位の差分を、左右に並べる行の一覧にする（削除と追加が続くときは横に並べる） */
function buildRows(a: string, b: string): { rows: Row[]; added: number; removed: number } {
  const rows: Row[] = [];
  let ln = 1;
  let rn = 1;
  let added = 0;
  let removed = 0;
  let pending: string[] = [];
  const flush = () => {
    for (const text of pending) rows.push({ left: { n: ln++, text }, right: null, kind: "del" });
    pending = [];
  };
  for (const part of diffLines(a, b)) {
    const lines = splitLines(part.value);
    if (part.removed) {
      flush();
      pending = lines;
      removed += lines.length;
    } else if (part.added) {
      added += lines.length;
      lines.forEach((text, i) => {
        const l = pending[i];
        if (l !== undefined) rows.push({ left: { n: ln++, text: l }, right: { n: rn++, text }, kind: "change" });
        else rows.push({ left: null, right: { n: rn++, text }, kind: "add" });
      });
      pending = pending.slice(lines.length);
      flush();
    } else {
      flush();
      for (const text of lines) rows.push({ left: { n: ln++, text }, right: { n: rn++, text }, kind: "same" });
    }
  }
  flush();
  return { rows, added, removed };
}

/** 2つのファイルの差分を左右に並べて表示する */
export default function DiffView({ tab }: { tab: DiffTab }) {
  const { rows, added, removed } = useMemo(() => buildRows(tab.leftText, tab.rightText), [tab.leftText, tab.rightText]);
  const name = (p: string) => p.replace(/\\/g, "/").split("/").slice(-2).join("/");
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-file del" title={tab.left}>
          {name(tab.left)}
        </span>
        <span className="diff-stat">
          <span className="add">+{added}</span> <span className="del">−{removed}</span>
          {!added && !removed && " 差分はありません"}
        </span>
        <span className="diff-file add" title={tab.right}>
          {name(tab.right)}
        </span>
      </div>
      <table className="diff-table">
        <colgroup>
          <col className="diff-num" />
          <col />
          <col className="diff-num" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.kind}>
              <td className="num">{r.left?.n}</td>
              <td className={`code ${r.left ? "" : "empty"} ${r.kind === "del" || r.kind === "change" ? "del" : ""}`}>{r.left?.text}</td>
              <td className="num">{r.right?.n}</td>
              <td className={`code ${r.right ? "" : "empty"} ${r.kind === "add" || r.kind === "change" ? "add" : ""}`}>{r.right?.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
