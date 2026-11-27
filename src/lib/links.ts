import { isMarkdown, resolvePath, safeDecode } from "./api";

const schemePattern = /^[a-z][a-z0-9+.-]*:/i;
const externalSchemes = new Set(["http:", "https:", "mailto:"]);
const blockedSchemes = new Set(["javascript:", "vbscript:", "data:"]);
const riskyExtensions = /\.(app|command|sh|tool|terminal|workflow|pkg|dmg|jar|scpt|applescript|action|exe|bat)$/i;

const normalizeUrl = (url: string) =>
  // URL パーサーが取り除く ASCII 制御文字を判定前に除く。
  // eslint-disable-next-line no-control-regex
  url.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\r\n]/g, "");

export const urlScheme = (url: string) => schemePattern.exec(normalizeUrl(url))?.[0].toLowerCase();

export function isBlockedLink(url: string) {
  return blockedSchemes.has(urlScheme(url) ?? "");
}

export function classifyLink(href: string, base: string) {
  const url = normalizeUrl(href);
  if (url.startsWith("#")) return { kind: "anchor", hash: url.slice(1) } as const;
  const scheme = urlScheme(url);
  if (scheme && scheme !== "file:") {
    if (blockedSchemes.has(scheme)) return { kind: "blocked" } as const;
    return { kind: externalSchemes.has(scheme) ? "external" : "confirm-url", url } as const;
  }
  const [file, hash] = url.replace(/^file:(?:\/\/)?/i, "").split("#");
  const path = resolvePath(base, safeDecode(file.split("?")[0]));
  return { kind: "local", path, hash } as const;
}

export function localLinkAction(path: string, stat: { is_dir: boolean; is_executable?: boolean }) {
  if (stat.is_dir) return "reveal";
  if (isMarkdown(path)) return "markdown";
  if (riskyExtensions.test(path) || stat.is_executable) return "reveal";
  return "open";
}
