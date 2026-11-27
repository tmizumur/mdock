import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { X } from "lucide-react";
import {
  DEFAULT_SETTINGS,
  EDITOR_FONT_LABEL,
  FONT_MAX,
  FONT_MIN,
  WIDTH_LABEL,
  useSettings,
  type EditorFont,
  type Settings,
  type DocWidth,
} from "../lib/settings";
import { checkForUpdateNow } from "./UpdateButton";

/** 主なショートカット（設定画面の一覧） */
const SHORTCUTS: [string, string][] = [
  ["⌘ ,", "設定を開く"],
  ["⌘ O", "フォルダを開く"],
  ["⌘ N", "新規ウインドウ"],
  ["⌘ S", "保存"],
  ["⌘ W", "タブを閉じる（タブがなければウインドウを閉じる）"],
  ["⌘ ⇧ W", "ウインドウを閉じる"],
  ["⌘ E", "表示 / 編集の切り替え"],
  ["⌘ F", "ファイル内を検索"],
  ["⌘ \\", "右に分割"],
  ["⌘ ⌥ \\", "上下に分割 / 1画面に戻す"],
  ["⌘ 1〜9", "n 番目のペインへ（1 つ先なら新しいペインを作る）"],
  ["⌘ ⇧ [  /  ⌘ ⇧ ]", "前 / 次のタブ"],
  ["⌘ +  /  ⌘ −  /  ⌘ 0", "文字を大きく / 小さく / 標準に"],
  ["⌘ クリック", "ツリーのファイルを隣のペインで開く"],
  ["⌥ クリック", "ツリーのファイルを新しいタブで開く"],
  ["↑ ↓ ← → / Enter", "ツリーの移動・開閉・開く"],
  ["⌘ ⌫", "ツリーで選んだものをゴミ箱に入れる"],
];

const SECTIONS = {
  display: "表示",
  editor: "エディタ",
  files: "ファイル",
  updates: "更新",
  shortcuts: "ショートカット",
} as const;
type Section = keyof typeof SECTIONS;
type ToggleSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function Segmented<T extends string>({ label, value, labels, onChange }: { label: string; value: T; labels: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {(Object.keys(labels) as T[]).map((k) => (
        <button key={k} aria-pressed={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {labels[k]}
        </button>
      ))}
    </div>
  );
}

function Row({ label, note, children, htmlFor }: { label: string; note: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
        <small id={htmlFor && `${htmlFor}-note`}>{note}</small>
      </div>
      {children}
    </div>
  );
}

function Toggle({ k, label, note }: { k: ToggleSetting; label: string; note: string }) {
  const id = useId();
  const { settings, update } = useSettings();
  return (
    <Row label={label} note={note} htmlFor={id}>
      <input id={id} type="checkbox" role="switch" aria-describedby={`${id}-note`} checked={settings[k]} onChange={(e) => update({ [k]: e.target.checked })} />
    </Row>
  );
}

/** 設定画面（⌘, ・ツールバーの歯車・アプリメニューの「設定…」）。変更はすぐ反映し、settings.json に保存する */
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, update } = useSettings();
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<Section>("display");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);

  const checkNow = async () => {
    setBusy(true);
    setChecking("確認中…");
    try {
      const v = await checkForUpdateNow();
      setChecking(v ? `v${v} があります（ツールバーの更新ボタンから）` : "最新の版です");
    } catch (e) {
      setChecking(`確認できませんでした: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="dialog-surface settings"
      aria-labelledby="settings-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="settings-head">
        <h2 id="settings-title">設定</h2>
        <button className="icon-btn" onClick={onClose} title="閉じる (Esc)" aria-label="閉じる">
          <X size={16} />
        </button>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="設定の分類">
          {(Object.keys(SECTIONS) as Section[]).map((key) => (
            <button key={key} aria-pressed={section === key} aria-controls="settings-panel" onClick={() => setSection(key)}>
              {SECTIONS[key]}
            </button>
          ))}
        </nav>
        <section className="settings-body" id="settings-panel" aria-labelledby="settings-section-title" key={section}>
          <h3 id="settings-section-title">{SECTIONS[section]}</h3>
          {section === "display" && (
            <>
              <Toggle k="statusBar" label="ステータスバー" note="ウィンドウ下部にファイルと Git の情報を表示します" />
              <Toggle k="animations" label="アニメーション" note="画面の切り替えやボタンの動きを表示します" />
              <Row label="文字サイズ" note="⌘+ / ⌘− / ⌘0 でも変えられます">
                <div className="segmented settings-stepper" role="group" aria-label="文字サイズ">
                  <button onClick={() => update((s) => ({ fontSize: s.fontSize - 1 }))} disabled={settings.fontSize <= FONT_MIN} aria-label="小さく">
                    −
                  </button>
                  <button onClick={() => update({ fontSize: DEFAULT_SETTINGS.fontSize })} title="標準に戻す" aria-label={`${settings.fontSize}px。標準に戻す`}>
                    {settings.fontSize}px
                  </button>
                  <button onClick={() => update((s) => ({ fontSize: s.fontSize + 1 }))} disabled={settings.fontSize >= FONT_MAX} aria-label="大きく">
                    ＋
                  </button>
                </div>
              </Row>
              <Row label="本文の幅" note="Markdown プレビューの横幅を調整します">
                <Segmented<DocWidth> label="本文の幅" value={settings.width} labels={WIDTH_LABEL} onChange={(width) => update({ width })} />
              </Row>
            </>
          )}

          {section === "editor" && (
            <>
              <Row label="フォント" note="編集時の書体を選びます">
                <Segmented<EditorFont> label="フォント" value={settings.editorFont} labels={EDITOR_FONT_LABEL} onChange={(editorFont) => update({ editorFont })} />
              </Row>
              <Toggle k="wrap" label="長い行を折り返す" note="エディタとプレビュー内のコードブロックに適用します" />
            </>
          )}

          {section === "files" && (
            <>
              <Toggle
                k="gitStatus"
                label="ツリーに Git の変更状態を表示"
                note="変更は M、新規・名前変更・未追跡は U、競合は ! で示します。無視された項目は薄く表示します"
              />
            </>
          )}

          {section === "updates" && (
            <>
              <Toggle k="autoUpdate" label="新しい版を自動で確認する" note="起動時と 1 時間ごとに確認します" />
              <Row label={version ? `今の版 v${version}` : "今の版"} note="利用できる更新を確認します">
                <button className="btn" onClick={checkNow} disabled={busy}>
                  今すぐ確認
                </button>
              </Row>
              <div className="update-status" role="status">{checking}</div>
            </>
          )}

          {section === "shortcuts" && (
            <dl className="shortcut-list">
              {SHORTCUTS.map(([key, description]) => (
                <Fragment key={key}>
                  <dt>{description}</dt>
                  <dd><kbd>{key}</kbd></dd>
                </Fragment>
              ))}
            </dl>
          )}
        </section>
      </div>
    </dialog>
  );
}
