import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { fitScale, zoomAt, type LightboxView } from "../lib/lightbox";

const padding = 24;
const centered = (scale: number): LightboxView => ({ x: 0, y: 0, scale });

export type LightboxMedia = { src: string; alt: string; width: number; height: number };

export default function Lightbox({ media, onClose }: { media: LightboxMedia; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [size, setSize] = useState({ width: media.width, height: media.height });
  const [view, setView] = useState<LightboxView | null>(null);
  const fit = fitScale(size.width, size.height, Math.max(1, viewport.width - padding * 2), Math.max(1, viewport.height - padding * 2));
  const { x, y, scale } = view ?? centered(fit);

  useLayoutEffect(() => {
    const element = dialog.current!;
    const focused = document.activeElement;
    element.showModal();
    closeButton.current?.focus();
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && !e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("resize", resize);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey, true);
      element.close();
      if (focused instanceof HTMLElement || focused instanceof SVGElement) focused.focus({ preventScroll: true });
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const element = dialog.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { left, top, width, height } = element.getBoundingClientRect();
      const point = { x: e.clientX - left - width / 2, y: e.clientY - top - height / 2 };
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1);
      setView((previous) => {
        const current = previous ?? centered(fit);
        const next = Math.max(fit / 2, Math.min(8, current.scale * Math.exp(-delta * 0.002)));
        return next === current.scale ? previous : zoomAt(current, point, next);
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [fit]);

  return createPortal(
    <dialog
      className="lightbox"
      ref={dialog}
      aria-label="拡大表示"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <img
        src={media.src}
        alt={media.alt}
        draggable={false}
        style={{ ...size, transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})` }}
        onLoad={({ currentTarget: image }) => {
          if (image.naturalWidth && image.naturalHeight) setSize({ width: image.naturalWidth, height: image.naturalHeight });
        }}
        onDoubleClick={() => setView((previous) => previous ? null : centered(1))}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (start?.id !== e.pointerId) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (dx === 0 && dy === 0) return;
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
          setView((previous) => {
            const current = previous ?? centered(fit);
            return { ...current, x: current.x + dx, y: current.y + dy };
          });
        }}
        onLostPointerCapture={(e) => {
          if (drag.current?.id === e.pointerId) drag.current = null;
        }}
      />
      <button type="button" className="icon-btn lightbox-close" ref={closeButton} aria-label="閉じる" onClick={onClose}>
        <X size={20} aria-hidden="true" />
      </button>
    </dialog>,
    document.body,
  );
}
