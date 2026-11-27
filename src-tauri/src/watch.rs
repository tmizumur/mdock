//! フォルダの監視。外部（AI・ほかのエディタ・git など）での変更を、なるべく早く画面に知らせる。
//!
//! notify の生のイベントを自前でまとめる（notify-debouncer-mini は使わない）。理由:
//! - debouncer-mini は「取りこぼしたので全体を読み直して」（FSEvents の MustScanSubDirs）を
//!   パスが無いイベントとして捨ててしまい、大量の変更（git checkout など）で反映されないことがあった
//! - 監視のエラー（フォルダが一旦消えた等）で止まったまま戻らなかった
//! - 実体のパス（/private/var/...）で届くので、開いたときのパス（/var/...）と結び付かなかった

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::{Duration, Instant};

/// まとめて知らせる変更
#[derive(Debug, Default, Clone)]
pub struct Batch {
    /// 変更のあったパス（開いたときのパスの形に直したもの）
    pub paths: Vec<PathBuf>,
    /// 取りこぼした可能性がある（全体を読み直してほしい）
    pub rescan: bool,
}

/// まとめ方。最後の変更から quiet 待つか、最初の変更から max 経ったら知らせる。
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub quiet: Duration,
    pub max: Duration,
    /// フォルダが消えていないかなどを確かめる間隔
    pub health: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            quiet: Duration::from_millis(40),
            max: Duration::from_millis(100),
            health: Duration::from_millis(1000),
        }
    }
}

/// 一度に知らせるパスの上限。これを超えたら「全体を読み直して」にする。
const MAX_PATHS: usize = 3000;

enum Msg {
    Fs(notify::Result<Event>),
    Files(Vec<PathBuf>),
    Stop,
}

/// 監視の本体。drop すると止まる。
pub struct FolderWatch {
    tx: Sender<Msg>,
}

impl Drop for FolderWatch {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
    }
}

impl FolderWatch {
    /// 監視を始める。root（開いたフォルダ）は再帰的に、extra（上にある .git など）も再帰的に、
    /// files は「その親フォルダ」を再帰せずに監視する（フォルダの外で開いたファイルのため）。
    pub fn start<F>(
        root: Option<PathBuf>,
        extra: Vec<PathBuf>,
        files: Vec<PathBuf>,
        timing: Timing,
        sink: F,
    ) -> Result<FolderWatch, String>
    where
        F: Fn(Batch) + Send + 'static,
    {
        let (tx, rx) = channel();
        let mut inner = Inner {
            root,
            extra,
            file_dirs: BTreeSet::new(),
            aliases: vec![],
            watcher: None,
            tx: tx.clone(),
        };
        inner.file_dirs = inner.dirs_for(&files);
        inner.connect()?;
        std::thread::Builder::new()
            .name("mdock-watch".into())
            .spawn(move || inner.run(rx, timing, sink))
            .map_err(|e| e.to_string())?;
        Ok(FolderWatch { tx })
    }

    /// 開いているファイルの一覧を伝える（フォルダの外にあるものも監視するため）
    pub fn set_files(&self, files: Vec<PathBuf>) {
        let _ = self.tx.send(Msg::Files(files));
    }
}

struct Inner {
    root: Option<PathBuf>,
    extra: Vec<PathBuf>,
    /// フォルダの外で開いているファイルの親フォルダ（再帰しない）
    file_dirs: BTreeSet<PathBuf>,
    /// (実体のパス, 開いたときのパス)。長いものから順に当てる
    aliases: Vec<(PathBuf, PathBuf)>,
    watcher: Option<RecommendedWatcher>,
    tx: Sender<Msg>,
}

fn real(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// 実体のパスを、開いたときのパスの形に直す（/private/var/x → /var/x、シンボリックリンクのフォルダ）
pub fn map_path(aliases: &[(PathBuf, PathBuf)], p: &Path) -> PathBuf {
    for (real, given) in aliases {
        if let Ok(rest) = p.strip_prefix(real) {
            return if rest.as_os_str().is_empty() {
                given.clone()
            } else {
                given.join(rest)
            };
        }
    }
    p.to_path_buf()
}

impl Inner {
    /// フォルダの外にあるファイルの、親フォルダの一覧
    fn dirs_for(&self, files: &[PathBuf]) -> BTreeSet<PathBuf> {
        let root_real = self.root.as_deref().map(real);
        files
            .iter()
            .filter_map(|f| f.parent().map(Path::to_path_buf))
            .filter(|d| match (&self.root, &root_real) {
                (Some(r), Some(rr)) => !d.starts_with(r) && !real(d).starts_with(rr),
                _ => true,
            })
            .collect()
    }

    fn compute_aliases(&mut self) {
        let mut list: Vec<(PathBuf, PathBuf)> = vec![];
        let mut add = |given: &Path| {
            let r = real(given);
            if r != given {
                list.push((r, given.to_path_buf()));
            }
        };
        if let Some(r) = &self.root {
            add(r);
        }
        for d in &self.file_dirs {
            add(d);
        }
        // 長い（深い）ものから当てる
        list.sort_by_key(|a| std::cmp::Reverse(a.0.as_os_str().len()));
        self.aliases = list;
    }

    /// 監視を（作り直して）始める。開いたフォルダが無ければ Err
    fn connect(&mut self) -> Result<(), String> {
        self.watcher = None;
        let tx = self.tx.clone();
        let mut w = notify::recommended_watcher(move |res| {
            let _ = tx.send(Msg::Fs(res));
        })
        .map_err(|e| e.to_string())?;
        if let Some(r) = &self.root {
            w.watch(r, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())?;
        }
        for e in &self.extra {
            let _ = w.watch(e, RecursiveMode::Recursive);
        }
        for d in &self.file_dirs {
            let _ = w.watch(d, RecursiveMode::NonRecursive);
        }
        self.watcher = Some(w);
        self.compute_aliases();
        Ok(())
    }

    fn set_files(&mut self, files: Vec<PathBuf>) {
        let next = self.dirs_for(&files);
        if next == self.file_dirs {
            return;
        }
        if let Some(w) = self.watcher.as_mut() {
            for d in self.file_dirs.difference(&next) {
                let _ = w.unwatch(d);
            }
            for d in next.difference(&self.file_dirs) {
                let _ = w.watch(d, RecursiveMode::NonRecursive);
            }
        }
        self.file_dirs = next;
        self.compute_aliases();
    }

    fn run<F: Fn(Batch)>(mut self, rx: Receiver<Msg>, timing: Timing, sink: F) {
        let mut pending: HashSet<PathBuf> = HashSet::new();
        let mut rescan = false;
        // まだ知らせていない変更の、最初と最後の時刻
        let mut first: Option<Instant> = None;
        let mut last = Instant::now();
        let mut next_health = Instant::now() + timing.health;
        // 監視が止まっている（フォルダが消えた・エラー）
        let mut broken = false;

        loop {
            let now = Instant::now();
            let deadline = match first {
                Some(f) => (last + timing.quiet).min(f + timing.max).min(next_health),
                None => next_health,
            };
            let msg = rx.recv_timeout(deadline.saturating_duration_since(now));
            let touched = |first: &mut Option<Instant>, last: &mut Instant| {
                let t = Instant::now();
                first.get_or_insert(t);
                *last = t;
            };
            match msg {
                Ok(Msg::Fs(Ok(ev))) => {
                    if ev.need_rescan() {
                        rescan = true;
                    }
                    if !ev.paths.is_empty() || ev.need_rescan() {
                        for p in ev.paths {
                            if pending.len() >= MAX_PATHS {
                                rescan = true;
                                break;
                            }
                            pending.insert(map_path(&self.aliases, &p));
                        }
                        touched(&mut first, &mut last);
                    }
                }
                Ok(Msg::Fs(Err(_))) => {
                    // エラーのあとは作り直す。取りこぼしたかもしれないので全体を読み直してもらう
                    broken = true;
                    rescan = true;
                    touched(&mut first, &mut last);
                    next_health = Instant::now();
                }
                Ok(Msg::Files(files)) => self.set_files(files),
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => {}
            }

            let now = Instant::now();
            if let Some(f) = first
                && (now >= last + timing.quiet || now >= f + timing.max)
            {
                let mut paths: Vec<PathBuf> = pending.drain().collect();
                paths.sort();
                if rescan {
                    paths.clear();
                }
                sink(Batch { paths, rescan });
                rescan = false;
                first = None;
            }

            if now >= next_health {
                next_health = now + timing.health;
                if let Some(root) = self.root.clone() {
                    if !root.is_dir() {
                        // フォルダが消えた（移動・削除）。戻ってきたら監視し直す
                        if !broken {
                            broken = true;
                            self.watcher = None;
                            rescan = true;
                            touched(&mut first, &mut last);
                        }
                    } else if broken && self.connect().is_ok() {
                        broken = false;
                        rescan = true;
                        touched(&mut first, &mut last);
                    }
                } else if broken && self.connect().is_ok() {
                    broken = false;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;

    /// 一時フォルダ（/var/folders/... は /private/var/... へのシンボリックリンク）
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(name: &str) -> Tmp {
            let p = std::env::temp_dir().join(format!(
                "mdock-watch-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn start(root: Option<&Path>, files: Vec<PathBuf>) -> (FolderWatch, Receiver<Batch>) {
        let (tx, rx) = channel();
        let w = FolderWatch::start(
            root.map(Path::to_path_buf),
            vec![],
            files,
            Timing::default(),
            move |b| {
                let _ = tx.send(b);
            },
        )
        .unwrap();
        // FSEvents が動き出すまで少し待ち、始まる前のイベントを捨てる
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        (w, rx)
    }

    /// want がすべて届く（または rescan が届く）まで待つ。かかった時間を返す
    fn wait_for(rx: &Receiver<Batch>, want: &[&Path], timeout: Duration) -> Duration {
        let t0 = Instant::now();
        let mut rest: Vec<PathBuf> = want.iter().map(|p| p.to_path_buf()).collect();
        while !rest.is_empty() {
            let left = timeout
                .checked_sub(t0.elapsed())
                .unwrap_or_else(|| panic!("届かなかった: {rest:?}"));
            let b = rx
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("届かなかった: {rest:?}"));
            if b.rescan {
                return t0.elapsed();
            }
            rest.retain(|p| !b.paths.contains(p));
        }
        t0.elapsed()
    }

    const LIMIT: Duration = Duration::from_secs(3);
    /// 目標（変更から画面まで 200ms 以内）のうち、監視側で使ってよい時間
    const FAST: Duration = Duration::from_millis(400);

    #[test]
    fn maps_real_paths_back() {
        let aliases = vec![(PathBuf::from("/private/var/x"), PathBuf::from("/var/x"))];
        assert_eq!(
            map_path(&aliases, Path::new("/private/var/x/a/b.md")),
            PathBuf::from("/var/x/a/b.md")
        );
        assert_eq!(
            map_path(&aliases, Path::new("/private/var/x")),
            PathBuf::from("/var/x")
        );
        assert_eq!(
            map_path(&aliases, Path::new("/other/c.md")),
            PathBuf::from("/other/c.md")
        );
    }

    #[test]
    fn file_changes_arrive_quickly_with_given_paths() {
        let tmp = Tmp::new("files");
        let root = &tmp.0;
        let f = root.join("a.md");
        fs::write(&f, "1").unwrap();
        let (_w, rx) = start(Some(root), vec![]);

        // 追記（echo >>）
        let t = Instant::now();
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(&f)
            .unwrap()
            .write_all(b"2")
            .unwrap();
        let d = wait_for(&rx, &[&f], LIMIT);
        eprintln!("追記: {d:?}");
        assert!(
            d < FAST,
            "追記の通知が遅い: {d:?} (送ってから {:?})",
            t.elapsed()
        );

        // 普通の上書き
        fs::write(&f, "3").unwrap();
        let d = wait_for(&rx, &[&f], LIMIT);
        eprintln!("上書き: {d:?}");
        assert!(d < FAST);

        // atomic write（一時ファイルに書いて rename。VS Code・Claude Code など）
        let tmpf = root.join(".a.md.tmp123");
        fs::write(&tmpf, "4").unwrap();
        fs::rename(&tmpf, &f).unwrap();
        let d = wait_for(&rx, &[&f], LIMIT);
        eprintln!("atomic write: {d:?}");
        assert!(d < FAST);

        // 削除してすぐ同名で作り直す
        fs::remove_file(&f).unwrap();
        fs::write(&f, "5").unwrap();
        wait_for(&rx, &[&f], LIMIT);

        // 名前の変更（両方のパスが届く）
        let g = root.join("b.md");
        fs::rename(&f, &g).unwrap();
        wait_for(&rx, &[&f, &g], LIMIT);
    }

    #[test]
    fn folders_deep_paths_and_bulk_changes() {
        let tmp = Tmp::new("dirs");
        let root = &tmp.0;
        let (_w, rx) = start(Some(root), vec![]);

        // 深い階層
        let deep = root.join("a/b/c/d/e/f/g");
        fs::create_dir_all(&deep).unwrap();
        let df = deep.join("deep.md");
        fs::write(&df, "x").unwrap();
        wait_for(&rx, &[&df], LIMIT);

        // フォルダごとの移動（フォルダのパスだけが届くことがある → 画面側は上のフォルダの変更として扱う）
        let moved = root.join("moved");
        fs::rename(root.join("a"), &moved).unwrap();
        wait_for(&rx, &[&root.join("a"), &moved], LIMIT);

        // フォルダごとの削除
        fs::remove_dir_all(&moved).unwrap();
        wait_for(&rx, &[&moved], LIMIT);

        // 大量のファイルを一度に（git checkout のような変更）
        let bulk = root.join("bulk");
        fs::create_dir(&bulk).unwrap();
        let files: Vec<PathBuf> = (0..500).map(|i| bulk.join(format!("f{i}.md"))).collect();
        for f in &files {
            fs::write(f, "x").unwrap();
        }
        let refs: Vec<&Path> = files.iter().map(PathBuf::as_path).collect();
        wait_for(&rx, &refs, LIMIT);
    }

    #[test]
    fn files_outside_root_are_watched() {
        let tmp = Tmp::new("root");
        let other = Tmp::new("outside");
        let f = other.0.join("note.md");
        fs::write(&f, "1").unwrap();
        let (w, rx) = start(Some(&tmp.0), vec![]);
        w.set_files(vec![f.clone()]);
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        fs::write(&f, "2").unwrap();
        assert!(wait_for(&rx, &[&f], LIMIT) < FAST);

        // フォルダを開いていなくても、開いたファイルは監視する
        let (_w2, rx2) = start(None, vec![f.clone()]);
        fs::write(&f, "3").unwrap();
        wait_for(&rx2, &[&f], LIMIT);
    }

    #[test]
    fn recovers_when_root_disappears_and_returns() {
        let parent = Tmp::new("recover");
        let root = parent.0.join("docs");
        fs::create_dir(&root).unwrap();
        let (_w, rx) = start(Some(&root), vec![]);
        // フォルダを一旦どかして、戻す
        let away = parent.0.join("away");
        fs::rename(&root, &away).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        fs::rename(&away, &root).unwrap();
        // 戻ったあと（再接続のあと）の変更も届く
        let t0 = Instant::now();
        let mut got_rescan = false;
        while t0.elapsed() < Duration::from_secs(4) {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                got_rescan |= b.rescan;
            }
            if got_rescan {
                break;
            }
        }
        assert!(got_rescan, "フォルダが戻ったときに読み直しの通知が無い");
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        let f = root.join("after.md");
        fs::write(&f, "x").unwrap();
        let t0 = Instant::now();
        loop {
            let b = rx
                .recv_timeout(LIMIT.saturating_sub(t0.elapsed()))
                .expect("戻ったあとの変更が届かない");
            if b.paths.contains(&f) || b.rescan {
                break;
            }
        }
    }
}
