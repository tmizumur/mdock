import {
  BookOpen,
  Braces,
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  KeyRound,
  Package,
  Palette,
  Presentation,
  Scale,
  type LucideIcon,
} from "lucide-react";

function table(groups: [string[], LucideIcon][]): Record<string, LucideIcon> {
  const out: Record<string, LucideIcon> = {};
  for (const [keys, d] of groups) for (const k of keys) out[k] = d;
  return out;
}

/** ファイル名（小文字）で判定。拡張子より優先 */
const BY_NAME = table([
  [["readme.md", "readme", "changelog.md"], BookOpen],
  [["license", "license.md", "license.txt"], Scale],
  [["package.json"], Package],
  [
    ["package-lock.json", "cargo.lock", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "poetry.lock"],
    FileLock,
  ],
  [["cargo.toml"], Package],
  [[".gitignore", ".gitattributes", ".gitmodules"], GitBranch],
  [["dockerfile"], Package],
  [["makefile"], FileTerminal],
  [[".env"], KeyRound],
  [[".editorconfig", ".prettierrc", ".npmrc"], FileCog],
]);

/** 拡張子で判定 */
const BY_EXT = table([
  [["md", "markdown", "mdx"], FileText],
  [["txt", "rst", "rtf"], FileText],
  [["log"], FileText],
  [["pdf"], FileText],
  [["doc", "docx"], FileText],
  [["ppt", "pptx"], Presentation],
  [["key"], Presentation],
  [["csv", "tsv", "xls", "xlsx", "numbers"], FileSpreadsheet],
  [["json", "jsonc", "json5", "ndjson"], FileJson],
  [["yaml", "yml", "toml", "ini", "conf", "cfg"], FileCog],
  [["env", "pem", "crt", "pub"], KeyRound],
  [["lock"], FileLock],
  [["xml"], FileCode],
  [["sql", "db", "sqlite", "sqlite3", "parquet"], Database],
  [["ts", "tsx", "mts", "cts"], FileCode],
  [["js", "jsx", "mjs", "cjs"], FileCode],
  [["py"], FileCode],
  [["ipynb", "rs", "java", "swift"], FileCode],
  [["go", "c", "dart"], FileCode],
  [["kt", "kts", "h", "hpp", "cs", "php"], FileCode],
  [["cpp", "cc", "lua", "r"], FileCode],
  [["rb", "scala"], FileCode],
  [["vue"], FileCode],
  [["svelte", "astro"], FileCode],
  [["graphql", "gql"], Braces],
  [["proto"], Braces],
  [["html", "htm"], Globe],
  [["css", "less"], Palette],
  [["scss", "sass"], Palette],
  [["sh", "bash", "zsh", "fish", "bat", "cmd"], FileTerminal],
  [["ps1"], FileTerminal],
  [["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "bmp", "ico", "icns"], FileImage],
  [["svg"], FileImage],
  [["psd"], FileImage],
  [["fig"], FileImage],
  [["mp4", "mov", "webm", "mkv", "avi"], FileVideo],
  [["mp3", "wav", "m4a", "flac", "ogg"], FileAudio],
  [["ttf", "otf", "woff", "woff2"], FileType],
  [["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg"], FileArchive],
]);

/** どれにも当てはまらないファイル */
const DEFAULT_FILE = File;

export function fileIcon(name: string): LucideIcon {
  const lower = name.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return named;
  if (lower.startsWith(".env")) return BY_NAME[".env"];
  if (lower.startsWith("dockerfile")) return BY_NAME["dockerfile"];
  if (lower.startsWith("license")) return BY_NAME["license"];
  const dot = lower.lastIndexOf(".");
  if (dot >= 0) {
    const byExt = BY_EXT[lower.slice(dot + 1)];
    if (byExt) return byExt;
  }
  return DEFAULT_FILE;
}

export function folderIcon(open: boolean): LucideIcon {
  return open ? FolderOpen : Folder;
}

export function TreeIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="tree-icon" size={15} strokeWidth={1.9} aria-hidden />;
}
