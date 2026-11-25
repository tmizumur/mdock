//! ツリーに出す git の変更状態。`git status --porcelain=v1 -z` を実行して読む。
//! git が無い環境（Xcode のコマンドラインツールが未インストールなど）では静かに無効になる。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// ファイル1つの状態（VS Code と同じ記号）
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    /// 変更あり
    M,
    /// 新規（ステージ済み）
    A,
    /// 未追跡
    U,
    /// 競合
    C,
    /// 無視（.gitignore）
    I,
}

/// git status の1行（パスはリポジトリのルートからの相対パス。フォルダは末尾が "/"）
#[derive(Debug, PartialEq, Eq)]
pub struct Item {
    pub path: String,
    pub mark: Mark,
}

/// 画面に返す1件（絶対パス）
#[derive(Serialize)]
pub struct GitEntry {
    pub path: String,
    pub mark: Mark,
    /// 未追跡・無視されたフォルダ（中身もすべて同じ扱い）
    pub dir: bool,
}

/// XY の2文字から状態を決める。
fn mark_of(x: u8, y: u8) -> Option<Mark> {
    match (x, y) {
        (b'?', b'?') => Some(Mark::U),
        (b'!', b'!') => Some(Mark::I),
        // 競合（unmerged）
        (b'D', b'D') | (b'A', b'U') | (b'U', b'D') | (b'U', b'A') | (b'D', b'U') | (b'A', b'A') | (b'U', b'U') => Some(Mark::C),
        (b'A', _) | (_, b'A') => Some(Mark::A),
        _ if [x, y].iter().any(|c| matches!(c, b'M' | b'T' | b'R' | b'C' | b'D')) => Some(Mark::M),
        _ => None,
    }
}

/// `git status --porcelain=v1 -z` の出力を読む。
/// 各項目は "XY path\0"。名前の変更・コピー（X か Y が R/C）は続けて元のパスが "\0" 区切りで付く。
pub fn parse_porcelain(out: &[u8]) -> Vec<Item> {
    let mut items = Vec::new();
    let mut parts = out.split(|b| *b == 0);
    while let Some(rec) = parts.next() {
        if rec.len() < 4 || rec[2] != b' ' {
            continue;
        }
        let (x, y) = (rec[0], rec[1]);
        // 名前の変更・コピーは元のパスが次に来るので読み飛ばす
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            parts.next();
        }
        let Some(mark) = mark_of(x, y) else { continue };
        items.push(Item { path: String::from_utf8_lossy(&rec[3..]).into_owned(), mark });
    }
    items
}

/// リポジトリ基準のパスを、開いているフォルダ（root）の下の絶対パスにする。
/// `rel` は root のリポジトリ内での位置（root がリポジトリのルートなら ""）。root の外のものは None。
pub fn to_abs(root: &str, rel: &str, item: &Item) -> Option<GitEntry> {
    let dir = item.path.ends_with('/');
    let p = item.path.trim_end_matches('/');
    let sub = if rel.is_empty() {
        p
    } else if let Some(s) = p.strip_prefix(rel).and_then(|s| s.strip_prefix('/')) {
        s
    } else {
        return None;
    };
    if sub.is_empty() {
        return None;
    }
    Some(GitEntry { path: format!("{}/{}", root.trim_end_matches('/'), sub), mark: item.mark, dir })
}

/// 使える git の場所。macOS の /usr/bin/git はコマンドラインツールが無いとインストールの案内を出してしまうので、
/// 実体があるときだけ使う。アプリから起動すると PATH が短いので、Homebrew の場所も探す。
fn git_bin() -> Option<&'static PathBuf> {
    static BIN: OnceLock<Option<PathBuf>> = OnceLock::new();
    BIN.get_or_init(|| {
        for c in ["/opt/homebrew/bin/git", "/usr/local/bin/git"] {
            if Path::new(c).is_file() {
                return Some(PathBuf::from(c));
            }
        }
        #[cfg(target_os = "macos")]
        {
            let dev = Command::new("/usr/bin/xcode-select").arg("-p").output().ok()?;
            if !dev.status.success() {
                return None;
            }
            let dir = String::from_utf8_lossy(&dev.stdout).trim().to_string();
            let git = Path::new(&dir).join("usr/bin/git");
            if git.is_file() {
                return Some(git);
            }
            None
        }
        #[cfg(not(target_os = "macos"))]
        {
            Command::new("git").arg("--version").output().ok().filter(|o| o.status.success()).map(|_| PathBuf::from("git"))
        }
    })
    .as_ref()
}

fn git(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new(git_bin()?)
        .current_dir(dir)
        // status でインデックスを書き換えない（書き換えると監視が反応して何度も読み直してしまう）
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args)
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

/// root を含むリポジトリの .git フォルダ（root より上にあるときの監視用）。git を実行せずに探す。
pub fn find_git_dir(root: &Path) -> Option<PathBuf> {
    root.ancestors().map(|d| d.join(".git")).find(|g| g.is_dir())
}

/// 現在のブランチ。detached HEAD ではコミットの短いハッシュを返す。
pub fn branch(root: &str) -> Option<String> {
    let dir = Path::new(root);
    let name = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .or_else(|| git(dir, &["rev-parse", "--short", "HEAD"]))?;
    Some(String::from_utf8_lossy(&name).trim_end().to_owned())
}

/// root の git の状態。git リポジトリでない・git が無いときは None。
pub fn status(root: &str, include_ignored: bool, count_files: bool) -> Option<Vec<GitEntry>> {
    let dir = Path::new(root);
    let top = git(dir, &["rev-parse", "--show-toplevel"])?;
    let top = PathBuf::from(String::from_utf8_lossy(&top).trim());
    let real_root = std::fs::canonicalize(dir).ok()?;
    let real_top = std::fs::canonicalize(&top).unwrap_or(top);
    let rel = real_root.strip_prefix(&real_top).ok()?.to_string_lossy().replace('\\', "/");
    // 件数を表示するときは、未追跡フォルダの中もファイル単位で数える。
    let mut args = vec!["status", "--porcelain=v1", "-z"];
    if include_ignored {
        args.push("--ignored=matching");
    }
    args.push(if count_files { "--untracked-files=all" } else { "--untracked-files=normal" });
    args.push(".");
    let out = git(dir, &args)?;
    Some(parse_porcelain(&out).iter().filter_map(|i| to_abs(root, &rel, i)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(path: &str, mark: Mark) -> Item {
        Item { path: path.into(), mark }
    }

    #[test]
    fn parses_basic_states() {
        let out = b" M src/a.md\0M  b.md\0MM c.md\0A  new.md\0AM new2.md\0?? untracked.md\0?? dir/\0!! node_modules/\0!! .env\0";
        assert_eq!(
            parse_porcelain(out),
            vec![
                item("src/a.md", Mark::M),
                item("b.md", Mark::M),
                item("c.md", Mark::M),
                item("new.md", Mark::A),
                item("new2.md", Mark::A),
                item("untracked.md", Mark::U),
                item("dir/", Mark::U),
                item("node_modules/", Mark::I),
                item(".env", Mark::I),
            ]
        );
    }

    #[test]
    fn counts_deletions_and_skips_rename_source() {
        let out = b" D gone.md\0D  gone2.md\0R  new name.md\0old name.md\0 M after.md\0";
        assert_eq!(
            parse_porcelain(out),
            vec![item("gone.md", Mark::M), item("gone2.md", Mark::M), item("new name.md", Mark::M), item("after.md", Mark::M)]
        );
    }

    #[test]
    fn parses_conflicts() {
        let out = b"UU both.md\0AA added.md\0DU x.md\0";
        assert_eq!(
            parse_porcelain(out),
            vec![item("both.md", Mark::C), item("added.md", Mark::C), item("x.md", Mark::C)]
        );
    }

    #[test]
    fn handles_non_ascii_and_empty() {
        assert_eq!(parse_porcelain(b""), vec![]);
        assert_eq!(parse_porcelain(" M 日本語/メモ.md\0".as_bytes()), vec![item("日本語/メモ.md", Mark::M)]);
    }

    #[test]
    fn maps_to_absolute_paths() {
        let i = item("docs/a.md", Mark::M);
        assert_eq!(to_abs("/r", "", &i).unwrap().path, "/r/docs/a.md");
        assert_eq!(to_abs("/r/docs", "docs", &i).unwrap().path, "/r/docs/a.md");
        assert!(to_abs("/r/other", "other", &i).is_none());
        // 名前の前方一致だけでは中とみなさない
        assert!(to_abs("/r/doc", "doc", &i).is_none());
        let d = to_abs("/r/", "", &item("tmp/", Mark::U)).unwrap();
        assert_eq!((d.path.as_str(), d.dir), ("/r/tmp", true));
    }

    /// 一時リポジトリで実際に git を実行する（git が無い環境では何もしない）
    #[test]
    fn status_in_temp_repo() {
        if git_bin().is_none() {
            return;
        }
        let base = std::env::temp_dir().join(format!("mdock-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let sub = base.join("docs");
        std::fs::create_dir_all(&sub).unwrap();
        let run = |args: &[&str]| assert!(git(&base, args).is_some(), "git {args:?}");
        run(&["init", "-q"]);
        run(&["symbolic-ref", "HEAD", "refs/heads/main"]);
        assert_eq!(branch(sub.to_str().unwrap()).as_deref(), Some("main"));
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(base.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(sub.join("a.md"), "a").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);
        std::fs::write(sub.join("a.md"), "changed").unwrap();
        std::fs::write(sub.join("b.md"), "new").unwrap();
        std::fs::write(sub.join("x.log"), "ignored").unwrap();
        std::fs::create_dir_all(sub.join("tmp")).unwrap();
        std::fs::write(sub.join("tmp/c.md"), "c").unwrap();

        let root = sub.to_string_lossy().to_string();
        let mut got: Vec<(String, Mark, bool)> =
            status(&root, true, false).unwrap().into_iter().map(|e| (e.path[root.len() + 1..].to_string(), e.mark, e.dir)).collect();
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            got,
            vec![
                ("a.md".into(), Mark::M, false),
                ("b.md".into(), Mark::U, false),
                ("tmp".into(), Mark::U, true),
                ("x.log".into(), Mark::I, false),
            ]
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
