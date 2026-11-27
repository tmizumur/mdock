import createDOMPurify from "dompurify";
import { isBlockedLink, urlScheme } from "./links";

const purifier = createDOMPurify(window);
const imageData = /^data:image\/[a-z0-9.+-]+[;,]/i;
const unsafeSrcset = /(?:javascript|vbscript):|data:(?!image\/[a-z0-9.+-]+[;,])/i;

purifier.setConfig({
  RETURN_DOM: true,
  USE_PROFILES: { html: true, mathMl: true },
  ADD_TAGS: ["semantics", "annotation", "svg", "path", "line"],
  ADD_ATTR: ["viewBox", "preserveAspectRatio", "d", "stroke", "stroke-width", "x1", "x2", "y1", "y2"],
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "base", "meta", "link", "template"],
  FORBID_ATTR: ["autofocus", "accesskey", "download", "target", "ping", "form", "formaction"],
  ALLOWED_URI_REGEXP: /^(?!(?:javascript|vbscript|data):)|^data:image\/[a-z0-9.+-]+[;,]/i,
  ADD_URI_SAFE_ATTR: ["srcset"],
});

export function sanitizeMarkdown(html: string) {
  const body = purifier.sanitize(html, { RETURN_DOM: true });
  for (const input of body.querySelectorAll("input")) {
    if (input.type !== "checkbox" || !input.disabled) input.remove();
  }
  const style = document.createElement("span").style;
  for (const node of body.querySelectorAll("[style]")) {
    style.cssText = node.getAttribute("style") ?? "";
    // CSS 変数や継承で危険な position に変わる値も除く。
    const unsafePosition = style.position !== "" && style.position !== "relative" && style.position !== "static";
    if (!unsafePosition && !style.getPropertyValue("z-index")) continue;
    if (unsafePosition) {
      style.removeProperty("position");
      for (const name of Array.from(style)) {
        if (/^(?:inset(?:-.*)?|top|right|bottom|left)$/.test(name)) style.removeProperty(name);
      }
    }
    style.removeProperty("z-index");
    if (style.cssText) node.setAttribute("style", style.cssText);
    else node.removeAttribute("style");
  }
  for (const node of body.querySelectorAll("[href], [src], [srcset]")) {
    const href = node.getAttribute("href");
    if (href !== null && isBlockedLink(href)) node.removeAttribute("href");

    const src = node.getAttribute("src");
    if (src !== null) {
      const scheme = urlScheme(src);
      const isImageData = node.tagName === "IMG" && imageData.test(src);
      if (scheme && scheme !== "http:" && scheme !== "https:" && scheme !== "asset:" && !isImageData) {
        node.removeAttribute("src");
      }
    }

    const srcset = node.getAttribute("srcset");
    if (srcset !== null) {
      // 危険な候補を含む srcset は属性ごと除去する。
      // eslint-disable-next-line no-control-regex
      const compact = srcset.replace(/[\u0000-\u0020]/g, "");
      if ((node.tagName !== "IMG" && node.tagName !== "SOURCE") || unsafeSrcset.test(srcset) || unsafeSrcset.test(compact)) {
        node.removeAttribute("srcset");
      }
    }
  }
  return body.innerHTML;
}

export function sanitizeHtmlBlock(html: string) {
  // 終端が要素の中に取り込まれた場合は、後続のブロックとまとめて処理する。
  const end = '<span data-mdock-block-end=""></span>';
  if (/data-mdock-block-end/i.test(html)) return null;
  const clean = sanitizeMarkdown(html + end);
  return clean.endsWith(end) ? clean.slice(0, -end.length) : null;
}
