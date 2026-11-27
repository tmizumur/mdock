// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import Preview from "./Preview";

it("プレビューのリンクを優先し、拡大表示中のキー操作とフォーカスを管理する", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const shortcuts = vi.fn();
  window.addEventListener("keydown", shortcuts);
  const dialog = () => document.querySelector<HTMLDialogElement>("dialog[open]");
  const key = (key: string, metaKey = false) => act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey, bubbles: true, cancelable: true }));
  });

  // jsdom ではネイティブのモーダル表示を代用する。
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });

  try {
    const content = [
      "# 目印",
      "![画像](https://example.com/image.png)",
      "[![リンク](https://example.com/link.png)](#目印)",
      "```mermaid\nflowchart LR\nA --> B\n```",
    ].join("\n\n");
    act(() => root.render(<Preview id="preview" path="/note.md" content={content} immediate scroller={{ current: null }} onOpenLink={vi.fn()} />));
    const scroll = vi.fn();
    host.querySelector("h1")!.scrollIntoView = scroll;
    act(() => host.querySelector<HTMLImageElement>('img[alt="リンク"]')!.click());
    expect(scroll).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();

    const image = host.querySelector<HTMLImageElement>('img[alt="画像"]')!;
    act(() => image.click());
    expect(dialog()?.querySelector("img")?.src).toBe(image.src);
    expect(document.activeElement).toBe(dialog()?.querySelector("button"));
    key("f", true);
    key("Escape");
    expect(shortcuts).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(image);

    host.querySelector(".mermaid-block")!.innerHTML = `
      <svg viewBox="0 0 30 20"><defs><marker id="arrow"></marker></defs>
        <path marker-end="url(${document.URL}#arrow)"></path></svg>
    `;
    act(() => host.querySelector("svg path")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const src = dialog()?.querySelector("img")?.src ?? "";
    expect(src).toMatch(/^data:image\/svg\+xml,/);
    const svg = new DOMParser().parseFromString(decodeURIComponent(src.split(",")[1]), "image/svg+xml");
    expect(svg.querySelector("path")?.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(svg.querySelector("marker")?.id).toBe("arrow");
    expect(document.querySelectorAll("#arrow")).toHaveLength(1);
    act(() => dialog()?.click());
    expect(dialog()).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    window.removeEventListener("keydown", shortcuts);
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    vi.unstubAllGlobals();
  }
});
