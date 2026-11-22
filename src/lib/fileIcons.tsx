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

export type IconDef = { Icon: LucideIcon; color: string };

const C = {
  md: "#4C8DFF",
  ts: "#3B82F6",
  js: "#EAB308",
  py: "#22A6B3",
  rust: "#E07A3F",
  go: "#00ADD8",
  web: "#E44D26",
  style: "#A855F7",
  data: "#F59E0B",
  config: "#8B95A3",
  image: "#22C55E",
  media: "#EC4899",
  archive: "#B45309",
  doc: "#64748B",
  shell: "#10B981",
  lock: "#94A3B8",
  db: "#0EA5E9",
  git: "#F05033",
  key: "#EAB308",
  license: "#D4A017",
  folder: "#8B95A3",
  folderSpecial: "#4C8DFF",
};

const def = (Icon: LucideIcon, color: string): IconDef => ({ Icon, color });

function table(groups: [string[], IconDef][]): Record<string, IconDef> {
  const out: Record<string, IconDef> = {};
  for (const [keys, d] of groups) for (const k of keys) out[k] = d;
  return out;
}

/** ファイル名（小文字）で判定。拡張子より優先 */
const BY_NAME = table([
  [["readme.md", "readme", "changelog.md"], def(BookOpen, C.md)],
  [["license", "license.md", "license.txt"], def(Scale, C.license)],
  [["package.json"], def(Package, C.shell)],
  [
    ["package-lock.json", "cargo.lock", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "poetry.lock"],
    def(FileLock, C.lock),
  ],
  [["cargo.toml"], def(Package, C.rust)],
  [[".gitignore", ".gitattributes", ".gitmodules"], def(GitBranch, C.git)],
  [["dockerfile"], def(Package, C.go)],
  [["makefile"], def(FileTerminal, C.shell)],
  [[".env"], def(KeyRound, C.key)],
  [[".editorconfig", ".prettierrc", ".npmrc"], def(FileCog, C.config)],
]);

/** 拡張子で判定 */
const BY_EXT = table([
  [["md", "markdown", "mdx"], def(FileText, C.md)],
  [["txt", "rst", "rtf"], def(FileText, C.doc)],
  [["log"], def(FileText, C.config)],
  [["pdf"], def(FileText, C.web)],
  [["doc", "docx"], def(FileText, C.ts)],
  [["ppt", "pptx"], def(Presentation, C.rust)],
  [["key"], def(Presentation, C.ts)],
  [["csv", "tsv", "xls", "xlsx", "numbers"], def(FileSpreadsheet, C.image)],
  [["json", "jsonc", "json5", "ndjson"], def(FileJson, C.data)],
  [["yaml", "yml", "toml", "ini", "conf", "cfg"], def(FileCog, C.config)],
  [["env", "pem", "crt", "pub"], def(KeyRound, C.key)],
  [["lock"], def(FileLock, C.lock)],
  [["xml"], def(FileCode, C.web)],
  [["sql", "db", "sqlite", "sqlite3", "parquet"], def(Database, C.db)],
  [["ts", "tsx", "mts", "cts"], def(FileCode, C.ts)],
  [["js", "jsx", "mjs", "cjs"], def(FileCode, C.js)],
  [["py"], def(FileCode, C.py)],
  [["ipynb", "rs", "java", "swift"], def(FileCode, C.rust)],
  [["go", "c", "dart"], def(FileCode, C.go)],
  [["kt", "kts", "h", "hpp", "cs", "php"], def(FileCode, C.style)],
  [["cpp", "cc", "lua", "r"], def(FileCode, C.ts)],
  [["rb", "scala"], def(FileCode, C.git)],
  [["vue"], def(FileCode, C.image)],
  [["svelte", "astro"], def(FileCode, C.rust)],
  [["graphql", "gql"], def(Braces, C.media)],
  [["proto"], def(Braces, C.config)],
  [["html", "htm"], def(Globe, C.web)],
  [["css", "less"], def(Palette, C.style)],
  [["scss", "sass"], def(Palette, C.media)],
  [["sh", "bash", "zsh", "fish", "bat", "cmd"], def(FileTerminal, C.shell)],
  [["ps1"], def(FileTerminal, C.ts)],
  [["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "bmp", "ico", "icns"], def(FileImage, C.image)],
  [["svg"], def(FileImage, C.data)],
  [["psd"], def(FileImage, C.ts)],
  [["fig"], def(FileImage, C.style)],
  [["mp4", "mov", "webm", "mkv", "avi"], def(FileVideo, C.media)],
  [["mp3", "wav", "m4a", "flac", "ogg"], def(FileAudio, C.media)],
  [["ttf", "otf", "woff", "woff2"], def(FileType, C.web)],
  [["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg"], def(FileArchive, C.archive)],
]);

/** どれにも当てはまらないファイル */
const DEFAULT_FILE = def(File, C.config);

export function fileIcon(name: string): IconDef {
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

const SPECIAL_FOLDERS = new Set([
  "src", "docs", "doc", "app", "lib", "components", "pages", "public", "assets",
  "test", "tests", "__tests__", "spec", "scripts", "config", ".github", ".vscode",
  "notes", "design", "specs", "plans",
]);

export function folderIcon(name: string, open: boolean): IconDef {
  const color = SPECIAL_FOLDERS.has(name.toLowerCase()) ? C.folderSpecial : C.folder;
  return def(open ? FolderOpen : Folder, color);
}

export function TreeIcon({ def }: { def: IconDef }) {
  const { Icon, color } = def;
  return <Icon className="tree-icon" size={15} strokeWidth={1.9} color={color} aria-hidden />;
}
