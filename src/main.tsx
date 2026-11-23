import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsProvider, readSettings } from "./lib/settings";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// 文字サイズなどの設定を読んでから描画する（読み込み後に表示が跳ねないように）
readSettings().then((settings) =>
  root.render(
    <React.StrictMode>
      <SettingsProvider initial={settings}>
        <App />
      </SettingsProvider>
    </React.StrictMode>,
  ),
);
