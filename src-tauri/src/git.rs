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
    /// 新規（ステージ済み）・名前の変更
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

/// XY の2文字から状態を決める。削除されたものは表示しないので None。
fn mark_of(x: u8, y: u8) -> Option<Mark> {
    match (x, y) {
        (b'?', b'?') => Some(Mark::U),
        (b'!', b'!') => Some(Mark::I),
        // 競合（unmerged）
        (b'D', b'D')
        | (b'A', b'U')
        | (b'U', b'D')
        | (b'U', b'A')
        | (b'D', b'U')
        | (b'A', b'A')
        | (b'U', b'U') => Some(Mark::C),
        (b'D', _) | (_, b'D') => None,
        (b'A', _) | (b'R', _) | (b'C', _) | (_, b'A') => Some(Mark::A),
        _ if matches!(x, b'M' | b'T') || matches!(y, b'M' | b'T' | b'R' | b'C') => Some(Mark::M),
        _ => None,
    }
}

/// `git status --porcelain=v1 -z` の出力を読む。
/// 各項目は "XY path\0"。名前の変更・コピー（X か Y が R/C）は続けて元のパスが "\0" 区切りで付く。
fn porcelain_records(out: &[u8]) -> impl Iterator<Item = (u8, u8, &[u8])> {
    let mut parts = out.split(|b| *b == 0);
    std::iter::from_fn(move || {
        let rec = parts.find(|rec| rec.len() >= 4 && rec[2] == b' ')?;
        let (x, y) = (rec[0], rec[1]);
        // 名前の変更・コピーは元のパスが次に来るので読み飛ばす
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            parts.next();
        }
        Some((x, y, &rec[3..]))
    })
}

pub fn parse_porcelain(out: &[u8]) -> Vec<Item> {
    porcelain_records(out)
        .filter_map(|(x, y, path)| {
            let mark = mark_of(x, y)?;
            Some(Item {
                path: String::from_utf8_lossy(path).into_owned(),
                mark,
            })
        })
        .collect()
}

/// リポジトリ基準のパスを、開いているフォルダ（root）の下の絶対パスにする。
/// `rel` は root のリポジトリ内での位置（root がリポジトリのルートなら ""）。root の外のものは None。
pub fn to_abs(root: &str, rel: &str, item: &Item) -> Option<GitEntry> {
    let dir = item.path.ends_with('/');
    let sub = path_in_root(rel, &item.path)?;
    Some(GitEntry {
        path: format!("{}/{}", root.trim_end_matches('/'), sub),
        mark: item.mark,
        dir,
    })
}

fn path_in_root<'a>(rel: &str, path: &'a str) -> Option<&'a str> {
    let path = path.trim_end_matches('/');
    let sub = if rel.is_empty() {
        path
    } else {
        path.strip_prefix(rel)?.strip_prefix('/')?
    };
    (!sub.is_empty()).then_some(sub)
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
            let dev = Command::new("/usr/bin/xcode-select")
                .arg("-p")
                .output()
                .ok()?;
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
            Command::new("git")
                .arg("--version")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|_| PathBuf::from("git"))
        }
    })
    .as_ref()
}

fn git_command(dir: &Path) -> Option<Command> {
    let mut command = Command::new(git_bin()?);
    command
        .current_dir(dir)
        .env_remove("GIT_CONFIG")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env_remove("GIT_EXTERNAL_DIFF")
        .env("GIT_PAGER", "cat")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_NO_LAZY_FETCH", "1")
        // status でインデックスを書き換えない（書き換えると監視が反応して何度も読み直してしまう）
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args([
            "--no-pager",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "diff.external=",
            "-c",
            "core.pager=cat",
            "-c",
            "credential.helper=",
            "-c",
            "protocol.allow=never",
            "-c",
            "core.sshCommand=false",
        ]);
    Some(command)
}

fn git(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    git_with(&|| git_command(dir), args)
}

fn git_with(make_command: &impl Fn() -> Option<Command>, args: &[&str]) -> Option<Vec<u8>> {
    let mut command = make_command()?;
    if args.first() == Some(&"status") {
        // 変更確認中にリポジトリの設定で外部フィルターを起動させない。
        let keys = git_with(
            make_command,
            &[
                "config",
                "--show-scope",
                "--includes",
                "--null",
                "--name-only",
                "--list",
            ],
        )?;
        let mut fields = std::str::from_utf8(&keys).ok()?.split_terminator('\0');
        while let Some(scope) = fields.next() {
            let key = fields.next()?;
            if !matches!(scope, "local" | "worktree") {
                continue;
            }
            let Some((_, setting)) = key
                .strip_prefix("filter.")
                .and_then(|key| key.rsplit_once('.'))
            else {
                continue;
            };
            let value = match setting {
                "clean" | "smudge" | "process" => "",
                "required" => "false",
                _ => continue,
            };
            if key.contains('=') {
                return None;
            }
            command.arg("-c").arg(format!("{key}={value}"));
        }
    }
    let out = command.args(args).output().ok()?;
    // safe.directory で拒否された場合も表示を省く。
    out.status.success().then_some(out.stdout)
}

/// root を含むリポジトリの .git フォルダ（root より上にあるときの監視用）。git を実行せずに探す。
pub fn find_git_dir(root: &Path) -> Option<PathBuf> {
    root.ancestors()
        .map(|d| d.join(".git"))
        .find(|g| g.is_dir())
}

/// 現在のブランチ。detached HEAD ではコミットの短いハッシュを返す。
pub fn branch(root: &str) -> Option<String> {
    let dir = Path::new(root);
    let name = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .or_else(|| git(dir, &["rev-parse", "--short", "HEAD"]))?;
    Some(String::from_utf8_lossy(&name).trim_end().to_owned())
}

/// root の Git の状態と、ステータスバー用の削除件数。
pub fn status(
    root: &str,
    include_ignored: bool,
    count_files: bool,
) -> Option<(Vec<GitEntry>, usize)> {
    let dir = Path::new(root);
    let top = git(dir, &["rev-parse", "--show-toplevel"])?;
    let top = PathBuf::from(String::from_utf8_lossy(&top).trim());
    let real_root = std::fs::canonicalize(dir).ok()?;
    let real_top = std::fs::canonicalize(&top).unwrap_or(top);
    let rel = real_root
        .strip_prefix(&real_top)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    // 件数を表示するときは、未追跡フォルダの中もファイル単位で数える。
    let mut args = vec![
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=dirty",
    ];
    if include_ignored {
        args.push("--ignored=matching");
    }
    args.push(if count_files {
        "--untracked-files=all"
    } else {
        "--untracked-files=normal"
    });
    args.push(".");
    let out = git(dir, &args)?;
    let entries = parse_porcelain(&out)
        .iter()
        .filter_map(|i| to_abs(root, &rel, i))
        .collect();
    let deleted = if count_files {
        porcelain_records(&out)
            .filter(|&(x, y, path)| {
                (x == b'D' || y == b'D')
                    && mark_of(x, y).is_none()
                    && path_in_root(&rel, &String::from_utf8_lossy(path)).is_some()
            })
            .count()
    } else {
        0
    };
    Some((entries, deleted))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(path: &str, mark: Mark) -> Item {
        Item {
            path: path.into(),
            mark,
        }
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
    fn skips_deleted_and_rename_source() {
        let out = b" D gone.md\0D  gone2.md\0R  new name.md\0old name.md\0 M after.md\0";
        assert_eq!(
            parse_porcelain(out),
            vec![item("new name.md", Mark::A), item("after.md", Mark::M)]
        );
    }

    #[test]
    fn parses_conflicts() {
        let out = b"UU both.md\0AA added.md\0DU x.md\0";
        assert_eq!(
            parse_porcelain(out),
            vec![
                item("both.md", Mark::C),
                item("added.md", Mark::C),
                item("x.md", Mark::C)
            ]
        );
    }

    #[test]
    fn handles_non_ascii_and_empty() {
        assert_eq!(parse_porcelain(b""), vec![]);
        assert_eq!(
            parse_porcelain(" M 日本語/メモ.md\0".as_bytes()),
            vec![item("日本語/メモ.md", Mark::M)]
        );
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
        std::fs::write(sub.join("gone.md"), "gone").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);
        std::fs::write(sub.join("a.md"), "changed").unwrap();
        std::fs::remove_file(sub.join("gone.md")).unwrap();
        std::fs::write(sub.join("b.md"), "new").unwrap();
        std::fs::write(sub.join("x.log"), "ignored").unwrap();
        std::fs::create_dir_all(sub.join("tmp")).unwrap();
        std::fs::write(sub.join("tmp/c.md"), "c").unwrap();

        let root = sub.to_string_lossy().to_string();
        let (entries, deleted) = status(&root, true, false).unwrap();
        assert_eq!(deleted, 0);
        let mut got: Vec<(String, Mark, bool)> = entries
            .into_iter()
            .map(|e| (e.path[root.len() + 1..].to_string(), e.mark, e.dir))
            .collect();
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
        let (entries, deleted) = status(&root, true, true).unwrap();
        assert_eq!(deleted, 1);
        assert!(!entries.iter().any(|e| e.path.ends_with("/gone.md")));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn status_disables_external_programs() {
        use std::fs::{self, FileTimes, Permissions};
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, SystemTime};

        if git_bin().is_none() {
            return;
        }
        let base = std::env::temp_dir().join(format!("mdock-git-safety-{}", std::process::id()));
        fs::create_dir(&base).unwrap();
        let run = |args: &[&str]| git(&base, args).unwrap_or_else(|| panic!("git {args:?}"));
        run(&["init", "-q", "--template="]);
        let file = base.join("a.md");
        fs::write(&file, "a").unwrap();
        run(&["add", "a.md"]);
        // 内容を変えず、Git が比較のためにフィルターを使う状態にする。
        fs::File::open(&file)
            .unwrap()
            .set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(60)))
            .unwrap();

        fs::create_dir(base.join(".git/hooks")).unwrap();
        for (script, marker) in [
            (".git/fsmonitor", "fsmonitor-ran"),
            (".git/hooks/post-index-change", "hook-ran"),
            (".git/clean", "filter-ran"),
        ] {
            let script = base.join(script);
            fs::write(&script, format!("#!/bin/sh\n: > .git/{marker}\n")).unwrap();
            fs::set_permissions(script, Permissions::from_mode(0o700)).unwrap();
        }
        run(&["config", "core.fsmonitor", "./.git/fsmonitor"]);
        run(&["config", "core.hooksPath", ".git/hooks"]);
        run(&["config", "filter.test.clean", "./.git/clean"]);
        run(&["config", "filter.test.required", "true"]);
        fs::write(base.join(".gitattributes"), "a.md filter=test\n").unwrap();

        let root = base.to_str().unwrap();
        let index = fs::read(base.join(".git/index")).unwrap();
        let (entries, _) = status(root, false, false).unwrap();
        assert!(
            entries
                .iter()
                .any(|entry| entry.path.ends_with("/a.md") && entry.mark == Mark::A)
        );
        run(&["config", "--unset", "filter.test.clean"]);
        run(&["config", "filter.test.process", "./.git/clean"]);
        assert!(status(root, false, false).is_some());
        assert_eq!(fs::read(base.join(".git/index")).unwrap(), index);
        assert_eq!(
            run(&["rev-parse", "--git-path", "hooks/post-index-change"]),
            b"/dev/null/post-index-change\n"
        );
        for marker in ["fsmonitor-ran", "hook-ran", "filter-ran"] {
            assert!(!base.join(".git").join(marker).exists(), "{marker}");
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn status_keeps_global_filters_unless_defined_in_repo() {
        use std::fs::{self, FileTimes};
        use std::time::{Duration, SystemTime};

        if git_bin().is_none() {
            return;
        }
        let base = std::env::temp_dir().join(format!("mdock-git-global-{}", std::process::id()));
        fs::create_dir(&base).unwrap();
        let global = base.join("global.gitconfig");
        let make_command = || {
            let mut command = git_command(&base)?;
            command.env("GIT_CONFIG_GLOBAL", &global);
            Some(command)
        };
        let run =
            |args: &[&str]| git_with(&make_command, args).unwrap_or_else(|| panic!("git {args:?}"));
        run(&["init", "-q", "--template="]);
        fs::write(
            &global,
            "[filter \"test\"]\n\tclean = sed s/working/stored/\n",
        )
        .unwrap();
        fs::create_dir(base.join(".git/info")).unwrap();
        fs::write(base.join(".git/info/attributes"), "a.md filter=test\n").unwrap();
        let file = base.join("a.md");
        fs::write(&file, "working\n").unwrap();
        run(&["add", "a.md"]);
        fs::File::open(&file)
            .unwrap()
            .set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(60)))
            .unwrap();

        let status = ["status", "--porcelain=v1", "-z", "--", "a.md"];
        assert_eq!(run(&status), b"A  a.md\0");

        let filter = "[filter \"test\"]\n\tclean = : > .git/filter-ran; cat\n";
        fs::write(base.join(".git/filters"), filter).unwrap();
        run(&["config", "include.path", "filters"]);
        assert_eq!(run(&status), b"AM a.md\0");
        run(&["config", "--unset", "include.path"]);

        run(&["config", "extensions.worktreeConfig", "true"]);
        fs::write(base.join(".git/config.worktree"), filter).unwrap();
        assert_eq!(run(&status), b"AM a.md\0");
        assert!(!base.join(".git/filter-ran").exists());
        fs::remove_dir_all(base).unwrap();
    }
}
