use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// フォルダツリーの1要素
#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<Entry>,
}

/// 読み飛ばすフォルダ（大きくて md を含まないことが多いもの）
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", ".git", ".venv", "__pycache__"];

fn walk(dir: &Path, depth: usize) -> Vec<Entry> {
    if depth > 12 {
        return vec![];
    }
    let Ok(read) = fs::read_dir(dir) else { return vec![] };
    let mut entries: Vec<Entry> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let path = e.path();
            let is_dir = path.is_dir();
            if is_dir && SKIP_DIRS.contains(&name.as_str()) {
                return None;
            }
            let children = if is_dir { walk(&path, depth + 1) } else { vec![] };
            Some(Entry { name, path: path.to_string_lossy().to_string(), is_dir, children })
        })
        .collect();
    // フォルダが先、その後に名前順
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    entries
}

#[tauri::command]
fn read_tree(root: String) -> Result<Vec<Entry>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("フォルダが見つかりません".into());
    }
    Ok(walk(&root, 0))
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// アプリの状態（開いていたフォルダ・ファイルなど）の保存先。
/// アプリを更新しても消えない場所（~/Library/Application Support/com.mdock.app/）に置く。
fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
fn load_session(app: AppHandle) -> Result<Option<String>, String> {
    let path = session_path(&app)?;
    Ok(fs::read_to_string(path).ok())
}

#[tauri::command]
fn save_session(app: AppHandle, json: String) -> Result<(), String> {
    let path = session_path(&app)?;
    // 書き込み途中で終了しても壊れないよう、一時ファイルに書いてから置き換える
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 開いているフォルダの監視。新しいフォルダを開くと前の監視は止まる。
#[derive(Default)]
struct WatchState(Mutex<Option<Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>>);

#[tauri::command]
fn watch_folder(app: AppHandle, state: State<WatchState>, root: String) -> Result<(), String> {
    let mut debouncer = new_debouncer(Duration::from_millis(150), move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let paths: Vec<String> = events.iter().map(|e| e.path.to_string_lossy().to_string()).collect();
            let _ = app.emit("fs-change", paths);
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // ウィンドウの位置・サイズ・最大化状態を保存して、次の起動時に戻す
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // アプリ内アップデート（GitHub Releases から新しい版を取得）と、更新後の再起動
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(WatchState::default())
        .invoke_handler(tauri::generate_handler![read_tree, read_text, write_text, watch_folder, load_session, save_session])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
