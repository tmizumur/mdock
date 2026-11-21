import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Props = {
  /** 再起動の前に、開いているフォルダや未保存の編集を確実に書き出す */
  beforeRestart: () => Promise<unknown>;
};

const CHECK_INTERVAL = 60 * 60 * 1000; // 1時間ごとに確認

/** 新しい版があるときだけツールバーに出る「更新して再起動」ボタン */
export default function UpdateButton({ beforeRestart }: Props) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = () =>
      check()
        .then((u) => u && setUpdate(u))
        .catch((e) => console.warn("update check", e)); // オフラインなどは黙って次回に回す
    run();
    const t = window.setInterval(run, CHECK_INTERVAL);
    return () => window.clearInterval(t);
  }, []);

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

  return (
    <button
      className="btn update-btn"
      onClick={install}
      disabled={progress !== null}
      title={error ? `更新に失敗しました: ${error}` : update.body || `v${update.version} に更新します`}
    >
      {progress !== null
        ? `更新中… ${progress}%`
        : error
          ? "更新を再試行"
          : `v${update.version} に更新して再起動`}
    </button>
  );
}
