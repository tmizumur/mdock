import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemePref } from "./settings";

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

/** 実際に使う配色（自動なら OS の設定） */
export const resolveTheme = (pref: ThemePref): "light" | "dark" =>
  pref === "auto" ? (media().matches ? "dark" : "light") : pref;

/** いまの画面がダーク配色か（Shiki・Mermaid の配色を合わせるのに使う） */
export const isDarkTheme = () => document.documentElement.dataset.theme === "dark";

/** 画面の配色を切り替える（<html data-theme>）。ウィンドウのタイトルバーも合わせる */
export function applyTheme(pref: ThemePref) {
  const t = resolveTheme(pref);
  const el = document.documentElement;
  el.dataset.theme = t;
  getCurrentWindow()
    .setTheme(pref === "auto" ? null : pref)
    .catch(() => {});
  return t;
}

/** OS の配色が変わったときに呼ぶ */
export function onSystemThemeChange(fn: () => void) {
  const m = media();
  m.addEventListener("change", fn);
  return () => m.removeEventListener("change", fn);
}
