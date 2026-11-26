use crate::{SKIP_DIRS, text_file};
use ignore::{WalkBuilder, WalkState};
use regex::RegexBuilder;
use serde::Serialize;
use std::borrow::Cow;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const SNIFF_BYTES: u64 = 8 * 1024;
pub(crate) const DEFAULT_MAX_RESULTS: usize = 5000;

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResults {
    files: Vec<FileMatches>,
    count: usize,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMatches {
    path: String,
    relative_path: String,
    matches: Vec<LineMatch>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LineMatch {
    line: usize,
    text: String,
    start: usize,
    end: usize,
    column: usize,
    length: usize,
}

fn read_text(path: &Path) -> Option<String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return None;
    }

    let mut bytes = Vec::new();
    (&mut file).take(SNIFF_BYTES).read_to_end(&mut bytes).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let remaining = MAX_BYTES + 1 - bytes.len() as u64;
    file.take(remaining).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    text_file::decode(&bytes)
        .ok()
        .map(|decoded| decoded.text.into_owned())
}

fn snippet(
    line: usize,
    text: &str,
    start: usize,
    end: usize,
    column: usize,
    length: usize,
) -> LineMatch {
    // 省略記号を含めて最大 300 文字に収める。
    let left = text[..start]
        .char_indices()
        .rev()
        .take(80)
        .last()
        .map_or(start, |(i, _)| i);
    let prefix = if left > 0 { "…" } else { "" };
    let prefix_len = usize::from(left > 0);
    let right = text[left..]
        .char_indices()
        .nth(298)
        .map_or(text.len(), |(i, _)| left + i);
    let suffix = if right < text.len() { "…" } else { "" };
    LineMatch {
        line,
        text: format!("{prefix}{}{suffix}", &text[left..right]),
        start: prefix_len + text[left..start].encode_utf16().count(),
        end: prefix_len + text[left..end.min(right)].encode_utf16().count(),
        column,
        length,
    }
}

pub(crate) fn search(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    regex: bool,
    limit: usize,
    generation: &AtomicU64,
    current: u64,
) -> Result<SearchResults, String> {
    let cancelled = || generation.load(Ordering::Relaxed) != current;
    if query.is_empty() || cancelled() {
        return Ok(SearchResults::default());
    }
    let pattern = if regex {
        Cow::Borrowed(query)
    } else {
        Cow::Owned(regex::escape(query))
    };
    let matcher = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| format!("正規表現が正しくありません。\n{error}"))?;

    let files = Mutex::new(Vec::new());
    let count = AtomicUsize::new(0);
    WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .follow_links(false)
        .max_filesize(Some(MAX_BYTES))
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_some_and(|kind| {
                    kind.is_dir()
                        && entry
                            .file_name()
                            .to_str()
                            .is_some_and(|name| SKIP_DIRS.contains(&name))
                })
        })
        .build_parallel()
        .run(|| {
            let matcher = matcher.clone();
            let count = &count;
            let files = &files;
            Box::new(move |entry| {
                if cancelled() || count.load(Ordering::Relaxed) > limit {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    return WalkState::Continue;
                }
                let Some(text) = read_text(entry.path()) else {
                    return WalkState::Continue;
                };
                let mut matches = Vec::new();
                let text = if text.contains('\r') {
                    Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
                } else {
                    Cow::Borrowed(text.as_str())
                };
                let mut state = WalkState::Continue;
                'lines: for (line, text) in text.split('\n').enumerate() {
                    if cancelled() || count.load(Ordering::Relaxed) > limit {
                        state = WalkState::Quit;
                        break;
                    }
                    let mut offset = 0;
                    let mut column = 0;
                    for hit in matcher.find_iter(text) {
                        if cancelled()
                            || count.load(Ordering::Relaxed) > limit
                            || count.fetch_add(1, Ordering::Relaxed) >= limit
                        {
                            state = WalkState::Quit;
                            break 'lines;
                        }
                        column += text[offset..hit.start()].encode_utf16().count();
                        let length = hit.as_str().encode_utf16().count();
                        matches.push(snippet(line, text, hit.start(), hit.end(), column, length));
                        column += length;
                        offset = hit.end();
                    }
                }
                if !matches.is_empty() && !cancelled() {
                    let path = entry.path();
                    files.lock().unwrap().push(FileMatches {
                        path: path.to_string_lossy().into_owned(),
                        relative_path: path
                            .strip_prefix(root)
                            .unwrap_or(path)
                            .to_string_lossy()
                            .into_owned(),
                        matches,
                    });
                }
                state
            })
        });
    if cancelled() {
        return Ok(SearchResults::default());
    }
    let mut files = files.into_inner().unwrap();
    files.sort_unstable_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let count = count.into_inner();
    Ok(SearchResults {
        files,
        count: count.min(limit),
        truncated: count > limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text_file::tests::TempDir;
    use std::fs;

    fn run(
        root: &Path,
        query: &str,
        case_sensitive: bool,
        regex: bool,
        limit: usize,
    ) -> Result<SearchResults, String> {
        search(
            root,
            query,
            case_sensitive,
            regex,
            limit,
            &AtomicU64::new(1),
            1,
        )
    }

    #[test]
    fn respects_workspace_ignores_and_skips_binary_large_and_symlink_files() {
        let dir = TempDir::new();
        let root = &dir.0;
        fs::write(root.join(".gitignore"), "ignored.md\n").unwrap();
        fs::write(root.join(".ignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("ignored.md"), "hit").unwrap();
        fs::write(root.join("ignored.txt"), "hit").unwrap();
        fs::write(root.join("binary"), b"hit\0").unwrap();
        for name in [".git", "node_modules"] {
            fs::create_dir(root.join(name)).unwrap();
            fs::write(root.join(name).join("hidden.md"), "hit").unwrap();
        }
        let large = root.join("large.md");
        fs::write(&large, "hit").unwrap();
        OpenOptions::new()
            .write(true)
            .open(large)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        fs::write(root.join(".visible.md"), "hit").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join(".visible.md"), root.join("link.md")).unwrap();

        let result = run(root, "hit", true, false, 5000).unwrap();
        assert_eq!(result.count, 1);
        assert_eq!(result.files[0].relative_path, ".visible.md");
    }

    #[test]
    fn supports_case_and_regex_and_reports_invalid_patterns() {
        let dir = TempDir::new();
        fs::write(dir.0.join("note.md"), "Aa1 aa2 aa3\n.*").unwrap();
        assert_eq!(run(&dir.0, "Aa", true, false, 5000).unwrap().count, 1);
        assert_eq!(run(&dir.0, "Aa", false, false, 5000).unwrap().count, 3);
        assert_eq!(run(&dir.0, r"aa[12]", false, true, 5000).unwrap().count, 2);
        assert_eq!(run(&dir.0, ".*", true, false, 5000).unwrap().count, 1);
        assert!(run(&dir.0, "[", false, true, 5000).is_err());
    }

    #[test]
    fn truncates_only_when_another_match_exists() {
        let dir = TempDir::new();
        for n in 0..10 {
            fs::write(dir.0.join(format!("{n}.md")), "hit hit").unwrap();
        }
        let result = run(&dir.0, "hit", true, false, 3).unwrap();
        assert!(result.truncated);
        assert_eq!(result.count, 3);
        assert_eq!(
            result
                .files
                .iter()
                .map(|file| file.matches.len())
                .sum::<usize>(),
            3
        );
        assert!(!run(&dir.0, "hit", true, false, 20).unwrap().truncated);
        assert!(
            search(&dir.0, "hit", true, false, 20, &AtomicU64::new(2), 1)
                .unwrap()
                .files
                .is_empty()
        );
    }

    #[test]
    fn returns_utf16_positions_in_the_source_and_trimmed_snippet() {
        let dir = TempDir::new();
        fs::write(
            dir.0.join("note.md"),
            format!(
                "最初\r\n{}日😀一致一致{}",
                "前".repeat(320),
                "後".repeat(320)
            ),
        )
        .unwrap();
        let result = run(&dir.0, "一致", true, false, 5000).unwrap();
        let hits = &result.files[0].matches;
        assert_eq!(
            (hits[0].line, hits[0].column, hits[1].column),
            (1, 323, 325)
        );
        for hit in hits {
            assert!(
                hit.text.chars().count() <= 300
                    && hit.text.starts_with('…')
                    && hit.text.ends_with('…')
            );
            let units: Vec<_> = hit.text.encode_utf16().collect();
            assert_eq!(
                String::from_utf16(&units[hit.start..hit.end]).unwrap(),
                "一致"
            );
            assert_eq!(hit.length, 2);
        }
    }
}
