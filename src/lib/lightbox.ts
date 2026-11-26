type Point = { x: number; y: number };
export type LightboxView = Point & { scale: number };

export function fitScale(width: number, height: number, availableWidth: number, availableHeight: number) {
  return Math.min(1, availableWidth / width, availableHeight / height);
}

// カーソルの下の点が拡大縮小後も同じ位置に来るようにする。
export function zoomAt(view: LightboxView, point: Point, scale: number): LightboxView {
  const ratio = scale / view.scale;
  return {
    x: point.x + (view.x - point.x) * ratio,
    y: point.y + (view.y - point.y) * ratio,
    scale,
  };
}
