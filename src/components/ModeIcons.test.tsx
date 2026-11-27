// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EditModeIcon, SplitModeIcon, ViewModeIcon } from "./ModeIcons";

it.each([ViewModeIcon, EditModeIcon, SplitModeIcon])("%s を共通の SVG 属性で描画する", (Icon) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<Icon />);
  const svg = host.firstElementChild;

  expect(svg).toBeInstanceOf(SVGElement);
  expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(svg?.getAttribute("stroke")).toBe("currentColor");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("width")).toBe("16");
  expect(svg?.getAttribute("height")).toBe("16");
});
