import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { X } from "lucide-react";
import {
  DEFAULT_SETTINGS,
  EDITOR_FONT_LABEL,
  FONT_MAX,
  FONT_MIN,
  THEME_LABEL,
  WIDTH_LABEL,
  useSettings,
  type EditorFont,
  type Settings,
  type ThemePref,
  type DocWidth,
} from "../lib/settings";
import { checkForUpdateNow } from "./UpdateButton";

/** 主なショートカット（設定画面の一覧） */
const SHORTCUTS: [string, string][] = [
  ["⌘ ,", "設定を開く"],
  ["⌘ O", "フォルダを開く"],
  ["⌘ N", "新規ウインドウ"],
  ["⌘ S", "保存"],
  ["⌘ W", "タブを閉じる"],
  ["⌘ E", "表示 / 編集の切り替え"],
  ["⌘ F", "ファイル内を検索"],
  ["⌘ \\", "右に分割"],
  ["⌘ 1〜9", "n 番目のペインへ（1 つ先なら新しいペインを作る）"],
  ["⌘ ⇧ [  /  ⌘ ⇧ ]", "前 / 次のタブ"],
  ["⌘ +  /  ⌘ −  /  ⌘ 0", "文字を大きく / 小さく / 標準に"],
  ["⌘ クリック", "ツリーのファイルを隣のペインで開く"],
  ["⌥ クリック", "ツリーのファイルを新しいタブで開く"],
  ["↑ ↓ ← → / Enter", "ツリーの移動・開閉・開く"],
  ["⌘ ⌫", "ツリーで選んだものをゴミ箱に入れる"],
];

function Segmented<T extends string>({ value, labels, onChange }: { value: T; labels: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {(Object.keys(labels) as T[]).map((k) => (
        <button key={k} role="radio" aria-checked={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {labels[k]}
        </button>
      ))}
    </div>
  );
}

function Row({ label, note, children, htmlFor }: { label: string; note?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="settings-row">
      <div>
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
        {note && <small>{note}</small>}
      </div>
      {children}
    </div>
  );
}

function Check({ id, k, label, note }: { id: string; k: keyof Settings; label: string; note?: string }) {
  const { settings, update } = useSettings();
  return (
    <Row label={label} note={note} htmlFor={id}>
      <input id={id} type="checkbox" checked={settings[k] as boolean} onChange={(e) => update({ [k]: e.target.checked })} />
    </Row>
  );
}

/** 設定画面（⌘, ・ツールバーの歯車・アプリメニューの「設定…」）。変更はすぐ反映し、settings.json に保存する */
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, update } = useSettings();
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion, () => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const checkNow = async () => {
    setChecking("確認中…");
    try {
      const v = await checkForUpdateNow();
      setChecking(v ? `v${v} があります（ツールバーの更新ボタンから）` : "最新の版です");
    } catch (e) {
      setChecking(`確認できませんでした: ${e}`);
    }
  };

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="設定">
        <div className="settings-head">
          <h2>設定</h2>
          <button className="icon-btn" onClick={onClose} title="閉じる (Esc)" aria-label="閉じる">
            <X size={16} />
          </button>
        </div>
        <div className="settings-body">
          <section className="settings-section">
            <h3>表示</h3>
            <Row label="テーマ" note="自動は macOS の外観に合わせます">
              <Segmented<ThemePref> value={settings.theme} labels={THEME_LABEL} onChange={(theme) => update({ theme })} />
            </Row>
            <Row label="文字サイズ" note="⌘+ / ⌘− / ⌘0 でも変えられます">
              <div className="segmented">
                <button onClick={() => update((s) => ({ fontSize: s.fontSize - 1 }))} disabled={settings.fontSize <= FONT_MIN} aria-label="小さく">
                  −
                </button>
                <button onClick={() => update({ fontSize: DEFAULT_SETTINGS.fontSize })} title="標準に戻す">
                  {settings.fontSize}px
                </button>
                <button onClick={() => update((s) => ({ fontSize: s.fontSize + 1 }))} disabled={settings.fontSize >= FONT_MAX} aria-label="大きく">
                  ＋
                </button>
              </div>
            </Row>
            <Row label="本文の幅">
              <Segmented<DocWidth> value={settings.width} labels={WIDTH_LABEL} onChange={(width) => update({ width })} />
            </Row>
            <Check id="set-wrap" k="wrap" label="長い行を折り返す" note="エディタとコードブロック" />
          </section>

          <section className="settings-section">
            <h3>エディタ</h3>
            <Row label="フォント">
              <Segmented<EditorFont> value={settings.editorFont} labels={EDITOR_FONT_LABEL} onChange={(editorFont) => update({ editorFont })} />
            </Row>
          </section>

          <section className="settings-section">
            <h3>ファイル</h3>
            <Check id="set-md" k="mdOnly" label="Markdown ファイルだけを表示" note=".md / .markdown / .mdx 以外と、それを含まないフォルダを隠します" />
            <Check id="set-hidden" k="showHidden" label="隠しファイルを表示" note=". で始まるファイル・フォルダ" />
            <Check
              id="set-git"
              k="gitStatus"
              label="git の変更状態を表示"
              note="変更 M・新規 A・未追跡 U・競合 ! を色と記号で。.gitignore で無視されたものは薄く"
            />
          </section>

          <section className="settings-section">
            <h3>更新</h3>
            <Check id="set-update" k="autoUpdate" label="新しい版を自動で確認する" note="起動時と 1 時間ごと" />
            <Row label={version ? `今の版 v${version}` : "今の版"} note={checking ?? undefined}>
              <button className="btn" onClick={checkNow} disabled={checking === "確認中…"}>
                今すぐ確認
              </button>
            </Row>
          </section>

          <section className="settings-section">
            <h3>ショートカット</h3>
            <dl className="shortcut-list">
              {SHORTCUTS.map(([k, d]) => [<dt key={`k${k}`}>{k}</dt>, <dd key={`d${k}`}>{d}</dd>])}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
