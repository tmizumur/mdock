import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { FIND_LIMIT } from "../lib/find";

const num = new Intl.NumberFormat("ja-JP");

type Props = {
  query: string;
  index: number;
  count: number;
  /** ⌘F を押すたびに変わる（入力欄を選択し直す） */
  focusSignal: number;
  onChange: (query: string) => void;
  onStep: (delta: number) => void;
  onClose: () => void;
};

/** プレビュー用のファイル内検索バー（⌘F） */
export default function FindBar({ query, index, count, focusSignal, onChange, onStep, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);

  const pos = count ? ((index % count) + count) % count : 0;
  return (
    <div className="find-bar find-skip" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={input}
        value={query}
        placeholder="ファイル内を検索"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className={`find-count ${query && !count ? "none" : ""}`}>
        {query ? (count ? `${num.format(pos + 1)} / ${num.format(count)}${count >= FIND_LIMIT ? "+" : ""}` : "見つかりません") : ""}
      </span>
      <button className="icon-btn" onClick={() => onStep(-1)} disabled={!count} title="前へ (⇧Enter)">
        <ChevronUp size={15} />
      </button>
      <button className="icon-btn" onClick={() => onStep(1)} disabled={!count} title="次へ (Enter)">
        <ChevronDown size={15} />
      </button>
      <button className="icon-btn" onClick={onClose} title="閉じる (Esc)">
        <X size={15} />
      </button>
    </div>
  );
}
