// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { type DocTab } from "../lib/tabs";
import TabBar from "./TabBar";

it("仮のタブの名前だけを斜体にし、ダブルクリックで固定を求める", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const onPin = vi.fn();
  const noop = () => {};
  const preview: DocTab = { id: "a", kind: "doc", path: "/a.md", content: "", saved: "", mode: "view", preview: true };
  const pinned = { ...preview, id: "b", path: "/b.md", preview: undefined };
  try {
    act(() => root.render(<TabBar paneId="p0" pane={{ tabs: [preview, pinned], active: 0 }}
      onActivate={noop} onClose={noop} onContextMenu={noop} onPin={onPin} />));

    expect([...host.querySelectorAll(".tab.preview .tab-name")].map((el) => el.textContent)).toEqual(["a.md"]);
    act(() => {
      for (const name of host.querySelectorAll(".tab-name")) name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onPin).toHaveBeenCalledExactlyOnceWith(preview.id);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
