// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/settings";
import SettingsDialog from "./SettingsDialog";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.0") }));
vi.mock("./UpdateButton", () => ({ checkForUpdateNow: vi.fn() }));

async function withSettingsDialog(check: (container: HTMLDivElement) => void) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const dialog = HTMLDialogElement.prototype;
  const methods = ["showModal", "close"] as const;
  for (const method of methods) {
    if (!dialog[method]) Object.defineProperty(dialog, method, { value: vi.fn(), configurable: true });
  }
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(() => root.render(<SettingsDialog onClose={vi.fn()} />));
    check(container);
  } finally {
    act(() => root.unmount());
    for (const method of methods) {
      if (vi.isMockFunction(dialog[method])) Reflect.deleteProperty(dialog, method);
    }
    vi.unstubAllGlobals();
  }
}

it("設定のショートカット一覧にタブとウインドウを閉じるキーを表示する", async () => {
  await withSettingsDialog((container) => {
    const shortcuts = [...container.querySelectorAll("nav button")]
      .find((button) => button.textContent === "ショートカット");
    expect(shortcuts).toBeDefined();
    act(() => { shortcuts?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const rows = [...container.querySelectorAll("dt")].map((label) => [
      label.nextElementSibling?.querySelector("kbd")?.textContent,
      label.textContent,
    ]);
    expect(rows).toContainEqual(["⌘ W", "タブを閉じる（タブがなければウインドウを閉じる）"]);
    expect(rows).toContainEqual(["⌘ ⇧ W", "ウインドウを閉じる"]);
  });
});

it("ファイル設定に既定でオンの「仮のタブを使う」スイッチを表示する", async () => {
  expect(DEFAULT_SETTINGS.previewTabs).toBe(true);
  await withSettingsDialog((container) => {
    const files = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find((button) => button.textContent === "ファイル");
    act(() => files?.click());
    const label = [...container.querySelectorAll("label")].find((el) => el.textContent === "仮のタブを使う");
    const control = label?.control as HTMLInputElement | undefined;
    expect(control?.getAttribute("role")).toBe("switch");
    expect(control?.checked).toBe(true);
  });
});
