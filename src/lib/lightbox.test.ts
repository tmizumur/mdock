import { describe, expect, it } from "vitest";
import { fitScale, zoomAt } from "./lightbox";

describe("拡大表示の倍率", () => {
  it("縦横比を保ち、幅と高さの厳しい方に合わせる", () => {
    expect(fitScale(1200, 400, 600, 800)).toBe(0.5);
    expect(fitScale(400, 1200, 800, 300)).toBe(0.25);
  });

  it("収まる画像は等倍で表示する", () => {
    expect(fitScale(100, 100, 800, 600)).toBe(1);
  });

  it("移動した画像もカーソル下の点を保って拡大縮小する", () => {
    const original = { x: 40, y: -30, scale: 0.5 };
    const point = { x: 100, y: -50 };
    const zoomed = zoomAt(original, point, 2);
    expect(zoomed).toEqual({ x: -140, y: 30, scale: 2 });
    expect(zoomAt(zoomed, point, 0.5)).toEqual(original);
  });
});
