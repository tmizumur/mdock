import { useCallback, useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, X } from "lucide-react";
import { MAX_SEARCH_RESULTS, searchFolder, splitMatch, type FolderSearchResults, type SearchLocation } from "../lib/folderSearch";

type Props = {
  root: string | null;
  onClose: () => void;
  onOpen: (path: string, location: Omit<SearchLocation, "nonce">, otherPane: boolean) => void;
};

export default function FolderSearch({ root, onClose, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [response, setResponse] = useState<{ key: string; results?: FolderSearchResults; error?: string }>();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const requests = useRef<{ timer?: number; id: number }>({ id: 0 });

  const key = JSON.stringify([query, caseSensitive, regex]);
  const run = useCallback(() => {
    const pending = requests.current;
    window.clearTimeout(pending.timer);
    if (!root || !query) return;
    const id = ++pending.id;
    setResponse({ key });
    searchFolder(root, query, caseSensitive, regex).then(
      (results) => { if (pending.id === id) setResponse({ key, results }); },
      (error) => { if (pending.id === id) setResponse({ key, error: String(error) }); },
    );
  }, [root, query, caseSensitive, regex, key]);

  useEffect(() => {
    const pending = requests.current;
    pending.timer = window.setTimeout(run, 250);
    return () => {
      window.clearTimeout(pending.timer);
      pending.id++;
    };
  }, [run]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const current = query && response?.key === key ? response : undefined;
  const results = current?.results;
  const error = current?.error;

  return (
    <section className="folder-search" aria-label="検索">
      <div className="sidebar-head">
        <h2 className="sidebar-label">検索</h2>
        <div className="explorer-actions">
          <button className="icon-btn" type="button" onClick={onClose} title="検索を閉じる (Esc)" aria-label="検索を閉じる">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="folder-search-controls">
        <input ref={input} type="text" aria-label="フォルダ内を検索" placeholder="フォルダ内を検索"
          value={query} spellCheck={false} autoComplete="off" aria-invalid={error ? true : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              run();
            } else if (e.key === "ArrowDown") {
              const first = list.current?.querySelector<HTMLButtonElement>(".folder-search-match");
              if (first) {
                e.preventDefault();
                first.focus();
              }
            }
          }}
        />
        <button className="icon-btn" type="button" onClick={() => setCaseSensitive(!caseSensitive)}
          aria-pressed={caseSensitive} title="大文字と小文字を区別" aria-label="大文字と小文字を区別">
          <CaseSensitive size={17} />
        </button>
        <button className="icon-btn" type="button" onClick={() => setRegex(!regex)}
          aria-pressed={regex} title="正規表現" aria-label="正規表現">
          <Regex size={16} />
        </button>
      </div>
      <div className="folder-search-status" role={error ? "alert" : "status"}>
        {!root ? "フォルダを開くと検索できます" : error || (results ? (
          <>
            <div>{results.files.length} ファイル、{results.count} 件の一致</div>
            {results.truncated && <div>最初の {MAX_SEARCH_RESULTS} 件を表示</div>}
          </>
        ) : query ? "検索中…" : null)}
      </div>
      <div className="folder-search-results" ref={list} onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".folder-search-match"));
        const index = rows.indexOf(e.target as HTMLButtonElement);
        if (index < 0) return;
        e.preventDefault();
        if (index === 0 && e.key === "ArrowUp") input.current?.focus();
        else rows[index + (e.key === "ArrowUp" ? -1 : 1)]?.focus();
      }}>
        {results?.files.map(({ path, relativePath, matches }) => {
          const folded = collapsed.has(path);
          const Chevron = folded ? ChevronRight : ChevronDown;
          const filename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
          return (
            <div className="folder-search-group" key={path}>
              <button className="folder-search-file" type="button" aria-expanded={!folded}
                title={relativePath} onClick={() => setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(path)) next.add(path);
                  return next;
                })}>
                <Chevron size={14} />
                <span className="folder-search-filename">{filename}</span>
                {relativePath !== filename && <span className="folder-search-path">{relativePath}</span>}
                <span className="folder-search-count">{matches.length}</span>
              </button>
              {!folded && matches.map((hit) => {
                const { before, match, after } = splitMatch(hit);
                // 右から左の省略表示では末尾の空白が消えるので、空白は外に出す
                const gap = /\s*$/.exec(before)?.[0] ?? "";
                return (
                  <button className="folder-search-match" type="button" key={`${hit.line}:${hit.column}`}
                    title={hit.text} onClick={(e) => onOpen(path, {
                      line: hit.line, column: hit.column, length: hit.length, query, matchText: match,
                    }, e.metaKey)}>
                    <span className="folder-search-before"><bdi>{before.slice(0, before.length - gap.length)}</bdi></span>
                    {gap && <span className="folder-search-gap">{gap}</span>}
                    <mark>{match}</mark>
                    <span className="folder-search-after">{after}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
