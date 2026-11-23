import { useEffect, useRef, useState, type ReactNode } from "react";
import { Type } from "lucide-react";
import { DEFAULT_SETTINGS, FONT_MAX, FONT_MIN, WIDTH_LABEL, useSettings, type DocWidth } from "../lib/settings";

/** ツールバーの「表示」メニュー: 文字サイズ・本文幅・折り返し（アプリ全体の設定） */
export default function ViewMenu({ children }: { children?: ReactNode }) {
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="popover-anchor" ref={box}>
      <button className={`btn icon-text ${open ? "pressed" : ""}`} onClick={() => setOpen(!open)} title="表示の設定（文字サイズ・本文幅・折り返し）">
        <Type size={14} /> 表示
      </button>
      {open && (
        <div className="popover view-menu" role="dialog" aria-label="表示の設定">
          <div className="menu-row">
            <span className="menu-label">文字サイズ</span>
            <div className="segmented">
              <button onClick={() => update((s) => ({ fontSize: s.fontSize - 1 }))} disabled={settings.fontSize <= FONT_MIN} title="小さく (⌘-)">
                −
              </button>
              <button onClick={() => update({ fontSize: DEFAULT_SETTINGS.fontSize })} title="標準に戻す (⌘0)">
                {settings.fontSize}px
              </button>
              <button onClick={() => update((s) => ({ fontSize: s.fontSize + 1 }))} disabled={settings.fontSize >= FONT_MAX} title="大きく (⌘+)">
                ＋
              </button>
            </div>
          </div>
          <div className="menu-row">
            <span className="menu-label">本文の幅</span>
            <div className="segmented">
              {(Object.keys(WIDTH_LABEL) as DocWidth[]).map((w) => (
                <button key={w} className={settings.width === w ? "on" : ""} onClick={() => update({ width: w })}>
                  {WIDTH_LABEL[w]}
                </button>
              ))}
            </div>
          </div>
          <label className="menu-row check">
            <input type="checkbox" checked={settings.wrap} onChange={(e) => update({ wrap: e.target.checked })} />
            長い行を折り返す（エディタとコードブロック）
          </label>
          {children}
        </div>
      )}
    </div>
  );
}
