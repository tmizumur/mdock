mod git;
mod text_file;
mod watch;

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use text_file::{FileError, TextInfo};

/// フォルダツリーの1要素
#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<Entry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loaded: Option<bool>,
}

/// ツリーから除外するフォルダ（依存関係、ビルド成果物、Git の管理データなど）
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".git",
    ".venv",
    "__pycache__",
    ".next",
    ".cache",
    ".turbo",
    ".svn",
    ".hg",
];
/// ツリーから除外するファイル
const SKIP_FILES: &[&str] = &[".DS_Store"];

/// 除外対象を飛ばし、隠しファイル・フォルダを含めてツリーを読み込む。
fn walk(dir: &Path, depth: usize) -> Vec<Entry> {
    walk_dir(dir, depth, &mut Vec::new(), None)
}

const TREE_DEPTH: usize = 13;

fn walk_dir(
    dir: &Path,
    depth: usize,
    ancestors: &mut Vec<PathBuf>,
    max_depth: Option<usize>,
) -> Vec<Entry> {
    if depth >= TREE_DEPTH || max_depth.is_some_and(|limit| depth >= limit) {
        return vec![];
    }
    let Ok(real) = dir.canonicalize() else {
        return vec![];
    };
    if ancestors.contains(&real) {
        return vec![];
    }
    let Ok(read) = fs::read_dir(dir) else {
        return vec![];
    };
    ancestors.push(real);
    let mut entries: Vec<Entry> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if SKIP_FILES.contains(&name.as_str()) {
                return None;
            }
            let path = e.path();
            let is_dir = path.is_dir();
            if is_dir && SKIP_DIRS.contains(&name.as_str()) {
                return None;
            }
            let deferred = is_dir
                && depth + 1 < TREE_DEPTH
                && max_depth.is_some_and(|limit| depth + 1 >= limit);
            let children = if is_dir && !deferred {
                walk_dir(&path, depth + 1, ancestors, max_depth)
            } else {
                vec![]
            };
            Some(Entry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                children,
                loaded: deferred.then_some(false),
            })
        })
        .collect();
    ancestors.pop();
    // フォルダが先、その後に名前順
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

// 読み込みは画面（メインスレッド）を止めないよう、別スレッドで行う

#[tauri::command]
async fn read_tree(root: String, max_depth: Option<usize>) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(root);
        if !root.is_dir() {
            return Err("フォルダが見つかりません".into());
        }
        Ok(match max_depth {
            Some(limit) => walk_dir(&root, 0, &mut Vec::new(), Some(limit)),
            None => walk(&root, 0),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 変更のあったフォルダだけを読み直す（ツリー全体を読み直すと重いため）。
/// フォルダごとに中身（サブツリー）を返す。フォルダが無くなっていれば null。
#[tauri::command]
async fn read_dirs(dirs: Vec<String>, root: String) -> Result<Vec<Option<Vec<Entry>>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        dirs.iter()
            .map(|d| read_subtree(Path::new(d), Path::new(&root)))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

fn read_subtree(dir: &Path, root: &Path) -> Option<Vec<Entry>> {
    if !dir.is_dir() || !dir.starts_with(root) {
        return None;
    }
    let mut ancestors = Vec::new();
    let parents: Vec<_> = dir
        .ancestors()
        .skip(1)
        .take_while(|p| p.starts_with(root))
        .collect();
    let depth = parents.len();
    for parent in parents.into_iter().rev() {
        let real = parent.canonicalize().ok()?;
        if ancestors.contains(&real) {
            return Some(vec![]);
        }
        ancestors.push(real);
    }
    Some(walk_dir(dir, depth, &mut ancestors, None))
}

#[cfg(test)]
mod tests {
    use super::{fs, walk};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn walk_marks_unread_folders_at_max_depth() {
        let root = super::text_file::tests::TempDir::new();
        fs::create_dir_all(root.0.join("a/b")).unwrap();
        fs::write(root.0.join("a/note.md"), "").unwrap();
        fs::write(root.0.join("a/b/deep.md"), "").unwrap();

        let shallow = super::walk_dir(&root.0, 0, &mut Vec::new(), Some(2));
        let entries = &shallow[0].children;
        assert_eq!(shallow[0].loaded, None);
        assert_eq!(entries[0].name, "b");
        assert_eq!(entries[0].loaded, Some(false));
        assert!(entries[0].children.is_empty());
        assert_eq!(entries[1].name, "note.md");
        assert_eq!(entries[1].loaded, None);
        assert_eq!(serde_json::to_value(&entries[0]).unwrap()["loaded"], false);

        let full = walk(&root.0, 0);
        assert_eq!(full[0].children[0].loaded, None);
        assert_eq!(full[0].children[0].children[0].name, "deep.md");
    }

    #[test]
    fn walk_includes_hidden_entries_and_skips_exclusions() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mdock-tree-{}-{timestamp}", std::process::id()));
        fs::create_dir(&root).unwrap();
        for dir in [".github", ".git", "node_modules/x"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in [
            ".env",
            ".github/workflow.yml",
            "a.md",
            "b.txt",
            ".git/config",
            "node_modules/x/index.js",
            ".DS_Store",
        ] {
            fs::write(root.join(file), "").unwrap();
        }

        let entries = walk(&root, 0);
        fs::remove_dir_all(&root).unwrap();

        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, [".github", ".env", "a.md", "b.txt"]);
        let github = &entries[0];
        assert!(github.is_dir);
        assert_eq!(github.children.len(), 1);
        assert_eq!(github.children[0].name, "workflow.yml");
    }

    #[cfg(unix)]
    #[test]
    fn walk_stops_at_ancestor_links() {
        use std::os::unix::fs::symlink;

        let root = super::text_file::tests::TempDir::new();
        let dir = root.0.join("a");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("note.md"), "").unwrap();
        symlink("..", dir.join("link")).unwrap();
        symlink("a", root.0.join("alias")).unwrap();

        let entries = walk(&root.0, 0);
        for entry in &entries {
            assert!(entry.children[0].is_dir);
            assert_eq!(entry.children[0].name, "link");
            assert!(entry.children[0].children.is_empty());
            assert_eq!(entry.children[1].name, "note.md");
        }
        assert_eq!(entries.len(), 2);
        let subtree = super::read_subtree(&dir, &root.0).unwrap();
        assert!(subtree[0].children.is_empty());
        assert!(
            super::read_subtree(&dir.join("link"), &root.0)
                .unwrap()
                .is_empty()
        );
    }
}

#[tauri::command]
async fn read_text(path: String, force: Option<bool>) -> Result<TextInfo, FileError> {
    tauri::async_runtime::spawn_blocking(move || {
        text_file::read(Path::new(&path), force.unwrap_or(false))
    })
    .await
    .map_err(FileError::other)?
}

/// ファイルの状態（外部での変更の確認に使う）
#[derive(Serialize)]
struct Stat {
    exists: bool,
    is_dir: bool,
    is_executable: bool,
    /// 更新時刻（ミリ秒）
    mtime: f64,
    size: u64,
}

#[tauri::command]
async fn stat_paths(paths: Vec<String>) -> Result<Vec<Stat>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| match fs::metadata(p) {
                Ok(m) => Stat {
                    exists: true,
                    is_dir: m.is_dir(),
                    #[cfg(unix)]
                    is_executable: m.is_file() && m.permissions().mode() & 0o111 != 0,
                    #[cfg(not(unix))]
                    is_executable: false,
                    mtime: m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64() * 1000.0)
                        .unwrap_or(0.0),
                    size: m.len(),
                },
                Err(_) => Stat {
                    exists: false,
                    is_dir: false,
                    is_executable: false,
                    mtime: 0.0,
                    size: 0,
                },
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn confirm_open_url(window: WebviewWindow, url: String) -> Result<(), String> {
    let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if matches!(
        url.scheme(),
        "http" | "https" | "mailto" | "file" | "javascript" | "vbscript" | "data"
    ) {
        return Err("このコマンドで開けない URL です".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // opener の許可範囲を広げず、承認された URL だけ開く。
        let mut dialog = window
            .dialog()
            .message(format!("このリンクを開きますか？\n{url}"))
            .buttons(MessageDialogButtons::OkCancel);
        #[cfg(desktop)]
        {
            dialog = dialog.parent(&window);
        }
        if dialog.blocking_show() {
            window
                .opener()
                .open_url(url.to_string(), None::<&str>)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_text(
    path: String,
    content: String,
    encoding: Option<String>,
    bom: Option<bool>,
) -> Result<(), FileError> {
    tauri::async_runtime::spawn_blocking(move || {
        text_file::write(
            Path::new(&path),
            &content,
            encoding.as_deref(),
            bom.unwrap_or(false),
        )
    })
    .await
    .map_err(FileError::other)?
}

// ---- ファイル操作（ツリーの右クリックメニュー） ----

/// ウィンドウごとに開いているフォルダ。ファイル操作はこの中だけに限る。
#[derive(Default)]
struct Roots(Mutex<HashMap<String, PathBuf>>);

/// `..` などを取り除いた絶対パスにする（まだ存在しないパスにも使える）
fn clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// path がこのウィンドウで開いているフォルダの中（フォルダ自身は含まない）か確かめる
fn inside_root(roots: &Roots, window: &WebviewWindow, path: &Path) -> Result<PathBuf, String> {
    let root = roots
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or("フォルダが開かれていません")?;
    let root = fs::canonicalize(&root).unwrap_or(root);
    let p = clean(path);
    // シンボリックリンクなどで外を指していないか、存在する部分は実体で確かめる
    let real = match fs::canonicalize(&p) {
        Ok(r) => r,
        Err(_) => match (
            p.parent().and_then(|d| fs::canonicalize(d).ok()),
            p.file_name(),
        ) {
            (Some(d), Some(n)) => d.join(n),
            _ => p.clone(),
        },
    };
    if real != root && real.starts_with(&root) {
        Ok(p)
    } else {
        Err("開いているフォルダの外は操作できません".into())
    }
}

/// 新しい名前として使えるか（区切り文字や . / .. を含まない）
fn check_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty()
        || n == "."
        || n == ".."
        || n.contains('/')
        || n.contains('\\')
        || n.contains('\0')
    {
        return Err("その名前は使えません".into());
    }
    Ok(())
}

#[tauri::command]
fn create_entry(
    window: WebviewWindow,
    roots: State<Roots>,
    dir: String,
    name: String,
    is_dir: bool,
) -> Result<String, String> {
    check_name(&name)?;
    let target = Path::new(&dir).join(name.trim());
    let target = inside_root(&roots, &window, &target)?;
    if target.exists() {
        return Err("同じ名前のファイルかフォルダがあります".into());
    }
    if is_dir {
        fs::create_dir(&target).map_err(|e| e.to_string())?;
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
    }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn rename_entry(
    window: WebviewWindow,
    roots: State<Roots>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    check_name(&new_name)?;
    let from = inside_root(&roots, &window, Path::new(&path))?;
    let to = from.with_file_name(new_name.trim());
    let to = inside_root(&roots, &window, &to)?;
    if to == from {
        return Ok(to.to_string_lossy().to_string());
    }
    // 大文字小文字だけの変更（a.md → A.md）は同じファイルとして扱われるので、存在確認をしない
    let same_file = from.to_string_lossy().to_lowercase() == to.to_string_lossy().to_lowercase();
    if to.exists() && !same_file {
        return Err("同じ名前のファイルかフォルダがあります".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(to.to_string_lossy().to_string())
}

/// ゴミ箱へ移動する（完全には削除しない）
#[tauri::command]
fn trash_entry(window: WebviewWindow, roots: State<Roots>, path: String) -> Result<(), String> {
    let p = inside_root(&roots, &window, Path::new(&path))?;
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    // Finder 経由（既定）だと「Finder を操作する許可」を求められて止まることがあるので、NSFileManager を使う
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(&p).map_err(|e| e.to_string())
}

// ---- 状態と設定の保存 ----

/// アプリの状態（開いていたフォルダ・ファイルなど）や設定の保存先。
/// アプリを更新しても消えない場所（~/Library/Application Support/com.mdock.app/）に置く。
fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// 書き込み途中で終了しても壊れないよう、一時ファイルに書いてから置き換える
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// ウィンドウごとのセッションファイル。最初のウィンドウは以前と同じ session.json。
fn session_name(label: &str) -> String {
    if label == "main" {
        "session.json".into()
    } else {
        format!("session-{label}.json")
    }
}

#[tauri::command]
fn load_session(app: AppHandle, window: WebviewWindow) -> Result<Option<String>, String> {
    let path = config_file(&app, &session_name(window.label()))?;
    Ok(fs::read_to_string(path).ok())
}

#[tauri::command]
fn save_session(app: AppHandle, window: WebviewWindow, json: String) -> Result<(), String> {
    write_atomic(&config_file(&app, &session_name(window.label()))?, &json)
}

/// 文字サイズ・本文幅・折り返しなど、アプリ全体の設定（settings.json）。変わったら全ウィンドウに知らせる。
#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    let path = config_file(&app, "settings.json")?;
    Ok(fs::read_to_string(path).ok())
}

#[tauri::command]
fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    write_atomic(&config_file(&app, "settings.json")?, &json)?;
    let _ = app.emit("settings-changed", json);
    Ok(())
}

// ---- フォルダの監視 ----

/// 開いているフォルダの監視（ウィンドウごと）。新しいフォルダを開くと前の監視は止まる。
struct WindowWatch {
    watch: watch::FolderWatch,
    /// 開いているファイル（フォルダの外のものも監視するため。フォルダを開き直しても引き継ぐ）
    files: Vec<PathBuf>,
}

#[derive(Default)]
struct WatchState(Mutex<HashMap<String, WindowWatch>>);

/// 画面に送る変更の知らせ
#[derive(Serialize, Clone)]
struct FsChange {
    paths: Vec<String>,
    /// 取りこぼした可能性がある（監視の再接続など）。開いているものを全部確かめ直す
    rescan: bool,
}

fn start_watch(
    app: &AppHandle,
    label: &str,
    root: Option<&Path>,
    files: Vec<PathBuf>,
) -> Result<watch::FolderWatch, String> {
    // 開いたフォルダがリポジトリの途中なら、上にある .git も監視する（コミットやステージでも git の状態を更新するため）
    let extra: Vec<PathBuf> = root
        .and_then(git::find_git_dir)
        .filter(|gd| root.is_some_and(|r| !gd.starts_with(r)))
        .into_iter()
        .collect();
    let app = app.clone();
    let target = label.to_string();
    watch::FolderWatch::start(
        root.map(Path::to_path_buf),
        extra,
        files,
        watch::Timing::default(),
        move |b| {
            let ev = FsChange {
                paths: b
                    .paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect(),
                rescan: b.rescan,
            };
            let _ = app.emit_to(target.as_str(), "fs-change", ev);
        },
    )
}

#[tauri::command]
fn watch_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<WatchState>,
    roots: State<Roots>,
    root: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    roots
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), PathBuf::from(&root));
    let mut map = state.0.lock().unwrap();
    let files = map.remove(&label).map(|w| w.files).unwrap_or_default();
    let w = start_watch(&app, &label, Some(Path::new(&root)), files.clone())?;
    map.insert(label, WindowWatch { watch: w, files });
    Ok(())
}

/// 開いているファイルの一覧を伝える。フォルダの外のファイル（ドロップで開いたものなど）も監視する。
#[tauri::command]
fn watch_files(
    app: AppHandle,
    window: WebviewWindow,
    state: State<WatchState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let mut map = state.0.lock().unwrap();
    if let Some(w) = map.get_mut(&label) {
        w.watch.set_files(files.clone());
        w.files = files;
    } else if !files.is_empty() {
        // フォルダを開いていないウィンドウ
        let w = start_watch(&app, &label, None, files.clone())?;
        map.insert(label, WindowWatch { watch: w, files });
    }
    Ok(())
}

// ---- git の変更状態 ----

/// 開いているフォルダの git の状態。リポジトリでない・git が無いときは null。
/// 大きなリポジトリでも画面を止めないよう、別スレッドで実行する。
#[derive(serde::Serialize)]
struct GitStatus {
    branch: String,
    entries: Vec<git::GitEntry>,
    modified: usize,
    added: usize,
}

#[tauri::command]
async fn git_status(
    root: String,
    include_entries: bool,
    include_counts: bool,
) -> Result<Option<GitStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = git::branch(&root)?;
        let (mut entries, mut modified) = if include_entries || include_counts {
            git::status(&root, include_entries, include_counts).unwrap_or_default()
        } else {
            (Vec::new(), 0)
        };
        let mut added = 0;
        if include_counts {
            for entry in &entries {
                match entry.mark {
                    git::Mark::M | git::Mark::C => modified += 1,
                    git::Mark::A | git::Mark::U => added += 1,
                    git::Mark::I => {}
                }
            }
        }
        if !include_entries {
            entries.clear();
        }
        Some(GitStatus {
            branch,
            entries,
            modified,
            added,
        })
    })
    .await
    .map_err(|e| e.to_string())
}

// ---- 複数ウィンドウ ----

/// 開いているウィンドウの一覧（windows.json）。再起動のときに全部開き直す。
fn load_window_list(app: &AppHandle) -> Vec<String> {
    let list: Vec<String> = config_file(app, "windows.json")
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if list.is_empty() {
        vec!["main".into()]
    } else {
        list
    }
}

fn save_window_list(app: &AppHandle, list: &[String]) {
    if let Ok(p) = config_file(app, "windows.json") {
        let _ = write_atomic(&p, &serde_json::to_string(list).unwrap_or_default());
    }
}

/// ⌘Q などで終了中か（終了で閉じたウィンドウは、次回も開き直すため一覧から消さない）
#[derive(Default)]
struct Quitting(AtomicBool);

#[tauri::command]
fn cancel_quit(quitting: State<Quitting>) {
    quitting.0.store(false, Ordering::SeqCst);
}

fn create_window(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    let mut cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .unwrap_or_default();
    cfg.label = label.to_string();
    cfg.create = true;
    WebviewWindowBuilder::from_config(app, &cfg)?.build()
}

/// ⌘N: 新しいウィンドウを開く（ウィンドウごとに別のフォルダを開ける）
fn new_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let label = format!(
        "w{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let w = create_window(app, &label)?;
    let mut list: Vec<String> = app.webview_windows().keys().cloned().collect();
    list.sort();
    save_window_list(app, &list);
    Ok(w)
}

// ウィンドウの作成は、同期コマンドの中だとデッドロックすることがあるので async にする
#[tauri::command]
async fn open_new_window(app: AppHandle) -> Result<(), String> {
    new_window(&app).map(|_| ()).map_err(|e| e.to_string())
}

/// 印刷（macOS の印刷ダイアログから PDF にも保存できる）
#[tauri::command]
fn print_window(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

// ---- Finder から開かれたファイル（関連付け・このアプリで開く） ----

/// まだ画面が受け取っていない「開いて」と頼まれたパス
#[derive(Default)]
struct PendingOpen(Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_opens(pending: State<PendingOpen>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

/// いま前面にあるウィンドウ（なければどれか）
fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next())
        .cloned()
}

// ---- メニュー ----

/// アプリのメニュー。⌘W は「タブを閉じる」にして、画面側に知らせる。
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let app_menu = SubmenuBuilder::new(app, "Mdock")
        .about(None)
        .separator()
        .item(
            &MenuItemBuilder::with_id("settings", "設定…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "ファイル")
        .item(
            &MenuItemBuilder::with_id("new-window", "新規ウインドウ")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open-file", "ファイルを開く…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open-folder", "フォルダを開く…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "保存")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("print", "印刷 / PDF に書き出し…").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("close-tab", "タブを閉じる")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .close_window_with_text("ウインドウを閉じる")
        .build()?;
    let edit = SubmenuBuilder::new(app, "編集")
        .undo_with_text("取り消す")
        .redo_with_text("やり直す")
        .separator()
        .cut_with_text("カット")
        .copy_with_text("コピー")
        .paste_with_text("ペースト")
        .select_all_with_text("すべてを選択")
        .build()?;
    let view = SubmenuBuilder::new(app, "表示")
        .fullscreen_with_text("フルスクリーン")
        .build()?;
    let window = SubmenuBuilder::new(app, "ウインドウ")
        .minimize_with_text("しまう")
        .maximize_with_text("拡大/縮小")
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window])
        .build()
}

/// メニューの操作を、いま前面にあるウィンドウに "menu" イベントで知らせる
fn on_menu(app: &AppHandle, id: &str) {
    if id == "new-window" {
        let _ = new_window(app);
        return;
    }
    if let Some(w) = focused_window(app) {
        let _ = w.emit_to(w.label(), "menu", id.to_string());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // ウィンドウの位置・サイズ・最大化状態を保存して、次の起動時に戻す（ウィンドウごと）
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // アプリ内アップデート（GitHub Releases から新しい版を取得）と、更新後の再起動
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(WatchState::default())
        .manage(Roots::default())
        .manage(Quitting::default())
        .manage(PendingOpen::default())
        .menu(build_menu)
        .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
        .setup(|app| {
            // 前回開いていたウィンドウを全部開き直す
            for label in load_window_list(app.handle()) {
                create_window(app.handle(), &label)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let label = window.label().to_string();
                app.state::<WatchState>().0.lock().unwrap().remove(&label);
                app.state::<Roots>().0.lock().unwrap().remove(&label);
                // 終了ではなくウィンドウを閉じただけなら、そのウィンドウは次回開き直さない（最後の1枚は残す）
                if !app.state::<Quitting>().0.load(Ordering::SeqCst) {
                    let mut rest: Vec<String> = app
                        .webview_windows()
                        .keys()
                        .filter(|l| **l != label)
                        .cloned()
                        .collect();
                    if !rest.is_empty() {
                        rest.sort();
                        save_window_list(app, &rest);
                        if let Ok(p) = config_file(app, &session_name(&label))
                            && label != "main"
                        {
                            let _ = fs::remove_file(p);
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_tree,
            read_dirs,
            read_text,
            stat_paths,
            confirm_open_url,
            watch_files,
            write_text,
            watch_folder,
            load_session,
            save_session,
            load_settings,
            save_settings,
            create_entry,
            rename_entry,
            trash_entry,
            open_new_window,
            cancel_quit,
            print_window,
            take_pending_opens,
            git_status
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match &event {
            // ⌘Q で終了するとき: すぐには終わらず、各ウィンドウに「閉じる」を送る。
            // 画面側で未保存の変更を確認し（保存 / 保存しない / キャンセル）、全部閉じたら終了する。
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                let windows = app.webview_windows();
                if windows.is_empty() {
                    return;
                }
                app.state::<Quitting>().0.store(true, Ordering::SeqCst);
                if code.is_none() {
                    api.prevent_exit();
                    for w in windows.values() {
                        let _ = w.close();
                    }
                }
            }
            // Finder でダブルクリック・「このアプリで開く」・Dock へのドロップ
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                if paths.is_empty() {
                    return;
                }
                app.state::<PendingOpen>().0.lock().unwrap().extend(paths);
                // 起動中なら前面のウィンドウに知らせる（起動直後は画面側が take_pending_opens で受け取る）
                if let Some(w) = focused_window(app) {
                    let _ = w.emit_to(w.label(), "open-paths", ());
                    let _ = w.set_focus();
                }
            }
            _ => {}
        });
}
