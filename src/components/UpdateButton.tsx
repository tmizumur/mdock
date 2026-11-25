import { useEffect, useMemo, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpCircle } from "lucide-react";
import { renderMarkdown } from "../lib/markdown";
import { useSettings } from "../lib/settings";

/** 設定画面の「今すぐ確認」から呼ぶ。新しい版があればその番号、なければ null */
let manualCheck: (() => Promise<string | null>) | null = null;
export const checkForUpdateNow = () => (manualCheck ? manualCheck() : Promise.resolve(null));

type Props = {
  /** 再起動の前に、開いているフォルダや未保存の編集を確実に書き出す */
  beforeRestart: () => Promise<unknown>;
};

const CHECK_INTERVAL = 60 * 60 * 1000; // 1時間ごとに確認

/** 変更内容の「(#12)」を GitHub の PR へのリンクにする */
const linkPRs = (notes: string) =>
  notes.replace(/\(#(\d+)\)/g, (_, n) => `([#${n}](https://github.com/tmizumur/mdock/pull/${n}))`);

/** 公開日（"2026-11-22T11:31:28Z" や "2026-11-22 11:31:28.484 +00:00:00" など）を日付にする */
function parseDate(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * 新しい版があるときだけツールバーに出る「更新」ボタン。
 * 押すと新しい版の番号と変更内容を小さなポップオーバーで表示し、そこから「更新して再起動」できる。
 */
export default function UpdateButton({ beforeRestart }: Props) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();

  useEffect(() => {
    manualCheck = async () => {
      const u = await check(); // 失敗したら呼び出し元（設定画面）にエラーを返す
      if (u) setUpdate(u);
      return u ? u.version : null;
    };
    return () => {
      manualCheck = null;
    };
  }, []);

  // 自動確認（設定でオフにできる）
  useEffect(() => {
    if (!settings.autoUpdate) return;
    const run = () =>
      check()
        .then((u) => u && setUpdate(u))
        .catch((e) => console.warn("update check", e)); // オフラインなどは黙って次回に回す
    run();
    const t = window.setInterval(run, CHECK_INTERVAL);
    return () => window.clearInterval(t);
  }, [settings.autoUpdate]);

  // ポップオーバーの外をクリック・Esc で閉じる（更新中は閉じない）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (progress === null && !box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && progress === null && setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, progress]);

  const notesHtml = useMemo(() => (update?.body?.trim() ? renderMarkdown(linkPRs(update.body.trim())) : ""), [update?.body]);

  if (!update) return null;

  const install = async () => {
    setError(null);
    setProgress(0);
    try {
      let total = 0;
      let done = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          if (total) setProgress(Math.round((done / total) * 100));
        }
      });
      await beforeRestart();
      await relaunch();
    } catch (e) {
      setProgress(null);
      setError(String(e));
    }
  };

  const date = parseDate(update.date);

  return (
    <div className="popover-anchor" ref={box}>
      <button
        className="btn update-btn icon-text"
        onClick={() => setOpen(!open)}
        title={`v${update.version} が利用できます（クリックで変更内容）`}
      >
        <ArrowUpCircle size={14} />
        {progress !== null ? `更新中… ${progress}%` : `v${update.version} に更新`}
      </button>
      {open && (
        <div className="popover update-pop" role="dialog" aria-label="アップデート">
          <div className="update-head">
            <strong>v{update.version}</strong>
            <span className="menu-label">
              今の版 v{update.currentVersion}
              {date ? ` ・ ${date.toLocaleDateString("ja-JP")}` : ""}
            </span>
          </div>
          {notesHtml ? (
            <div
              className="update-notes markdown-body"
              dangerouslySetInnerHTML={{ __html: notesHtml }}
              onClick={(e) => {
                const a = (e.target as HTMLElement).closest("a");
                if (!a) return;
                e.preventDefault();
                const href = a.getAttribute("href");
                if (href && /^https?:/.test(href)) openUrl(href);
              }}
            />
          ) : (
            <div className="menu-label">変更内容はありません</div>
          )}
          {error && <div className="update-error">更新に失敗しました: {error}</div>}
          <div className="update-actions">
            {progress !== null && <progress max={100} value={progress} />}
            <span className="spacer" />
            <button className="btn primary" onClick={install} disabled={progress !== null}>
              {progress !== null ? `更新中… ${progress}%` : error ? "もう一度試す" : "更新して再起動"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
