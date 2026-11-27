// @vitest-environment jsdom

import { clearMocks, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILES_CHANGED } from "../lib/liveReload";
import type { DocTab } from "../lib/tabs";
import Preview from "./Preview";
import PreviewPane from "./PreviewPane";

describe("Markdown プレビュー", () => {
  let host: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();
  const scroller = { current: null };
  const onOpenLink = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    scrollIntoView.mockClear();
    vi.unstubAllGlobals();
    clearMocks();
  });

  function show(content: string, anchor?: { id: string; nonce: number }, key = "preview") {
    act(() => root.render(
      <Preview key={key} id="preview" path="/workspace/note.md" content={content} anchor={anchor}
        scroller={scroller} onOpenLink={onOpenLink} immediate />,
    ));
  }

  it("見出しの描画を待ち、同じ nonce ではライブ反映後もスクロールしない", () => {
    const anchor = { id: "setup-install", nonce: 1 };
    show("", anchor);
    expect(scrollIntoView).not.toHaveBeenCalled();

    show("# Setup: Install", anchor);
    expect(scrollIntoView.mock.contexts).toEqual([host.querySelector("h1")]);

    show("# Setup: Install\n\n追記", { ...anchor });
    show("# Setup: Install\n\n再表示", anchor, "別のプレビュー");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    show("# Setup: Install", { ...anchor, nonce: 2 }, "別のプレビュー");
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("GitHub 形式と旧形式のリンク、脚注の往復リンクで移動できる", () => {
    show([
      "[GitHub](#日本語の-見出し) [旧形式](#c%2B%2B-%26-rust) 脚注[^1]",
      "# 日本語の 見出し", "# C++ & Rust", "[^1]: 脚注の本文",
    ].join("\n\n"));

    for (const link of host.querySelectorAll<HTMLAnchorElement>("a")) act(() => link.click());

    expect(scrollIntoView.mock.contexts.map((target) => (target as HTMLElement).id))
      .toEqual(["日本語の-見出し", "c--rust", "fn1", "fnref1"]);
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("同じプレビューを保ったまま履歴のスクロール位置へ移動する", () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    const tab: DocTab = { id: "note", kind: "doc", path: "/workspace/note.md", content: "# Note", saved: "# Note", mode: "view" };
    const noop = () => {};
    const showPane = (current: DocTab, key = current.id) => act(() => root.render(
      <PreviewPane key={key} id="preview" tab={current} initialScroll={0} onScroll={noop}
        find={{ open: false, query: "", index: 0, focus: 0 }} setFind={noop} onOutline={noop} onOpenLink={onOpenLink} />,
    ));

    showPane(tab);
    const body = host.querySelector<HTMLDivElement>(".pane-body")!;
    body.scrollTop = 180;
    showPane({ ...tab, scrollTo: { top: 0, nonce: 1 } });
    expect(host.querySelector(".pane-body")).toBe(body);
    expect(body.scrollTop).toBe(0);

    const restored = { ...tab, scrollTo: { top: 180, nonce: 2 } };
    showPane(restored);
    expect(body.scrollTop).toBe(180);
    showPane(restored, "remount");
    expect(host.querySelector<HTMLDivElement>(".pane-body")?.scrollTop).toBe(0);
  });

  it("変更されたローカル画像だけを更新し、Markdown の再描画後も新しい URL を使う", () => {
    mockConvertFileSrc("macos");
    const content = [
      "![猫](images/猫%20photo.png)", "![外部](https://example.com/image.png)",
      '<img alt="生 HTML" src="images/other.png">',
    ].join("\n\n");
    const src = (alt: string) => host.querySelector(`img[alt="${alt}"]`)?.getAttribute("src");
    const change = (...paths: string[]) => window.dispatchEvent(new CustomEvent(FILES_CHANGED, {
      detail: { paths, rescan: false },
    }));

    show(content);
    const original = src("猫");
    const other = src("生 HTML");
    change("/workspace/images/unused.png");
    expect(src("猫")).toBe(original);
    change("/workspace/images/猫 photo.png");
    const refreshed = src("猫");
    expect(refreshed).toMatch(/^asset:\/\/localhost\/[^?]+\?v=\d+$/);
    expect(src("生 HTML")).toBe(other);
    expect(src("外部")).toBe("https://example.com/image.png");

    show(content + "\n\n追記");
    expect(src("猫")).toBe(refreshed);
    change("/workspace/images/猫 photo.png", "/workspace/images/other.png");
    expect(src("猫")).not.toBe(refreshed);
    expect(src("生 HTML")).toMatch(/\?v=\d+$/);
  });

  it("別タブを表示している間の画像変更を、元のタブに戻ったときに反映する", () => {
    mockConvertFileSrc("macos");
    const content = "![写真](gallery/photo.png) ![別の写真](archive/other.png)";
    const src = (alt: string) => host.querySelector(`img[alt="${alt}"]`)?.getAttribute("src");
    const change = (paths: string[], rescan = false) => window.dispatchEvent(new CustomEvent(FILES_CHANGED, {
      detail: { paths, rescan },
    }));

    show(content);
    const original = src("写真");
    const other = src("別の写真");
    show("# 別タブ", undefined, "別タブ");
    change(["/workspace/Gallery"]);
    show(content);
    const refreshed = src("写真");
    expect(refreshed).toMatch(/\?v=\d+$/);
    expect(refreshed).not.toBe(original);
    expect(src("別の写真")).toBe(other);

    show("# 別タブ", undefined, "別タブ");
    change([], true);
    show(content);
    expect(src("写真")).not.toBe(refreshed);
    expect(src("別の写真")).toMatch(/\?v=\d+$/);
    expect(src("別の写真")).not.toBe(other);
  });
});
