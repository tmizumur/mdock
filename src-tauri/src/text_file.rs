use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, ISO_2022_JP, UTF_8, UTF_16BE, UTF_16LE};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const READ_LIMIT: u64 = 5 * 1024 * 1024;
const FORCE_LIMIT: u64 = 100 * 1024 * 1024;
const SAVE_TEMP_MARKER: &str = ".mdock-tmp-";

pub(crate) fn is_save_temp(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name.starts_with('.') && name.contains(SAVE_TEMP_MARKER)
}

#[derive(Debug, Serialize)]
pub(crate) struct FileError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

impl FileError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            size: None,
        }
    }

    pub(crate) fn other(detail: impl std::fmt::Display) -> Self {
        Self::new(
            "other",
            format!("ファイルの操作中にエラーが発生しました（{detail}）。"),
        )
    }

    fn too_large(size: u64, force: bool) -> Self {
        let mut error = if force {
            Self::new(
                "too_large",
                "ファイルが大きすぎます（上限は 100 MB です）。",
            )
        } else {
            Self::new("large_file", "大きなファイルです。")
        };
        error.size = Some(size);
        error
    }
}

impl From<io::Error> for FileError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::new("not_found", "ファイルが見つかりません。"),
            io::ErrorKind::PermissionDenied => Self::new(
                "permission_denied",
                "ファイルへのアクセス権限がありません。",
            ),
            io::ErrorKind::IsADirectory => Self::new("is_directory", "フォルダです。"),
            _ => Self::other(error),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct DiskStamp {
    mtime: i64,
    size: u64,
}

impl DiskStamp {
    fn from_metadata(metadata: &Metadata) -> io::Result<Self> {
        let modified = metadata.modified()?;
        let mtime = match modified.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as i64,
            Err(error) => -(error.duration().as_millis() as i64),
        };
        Ok(Self {
            mtime,
            size: metadata.len(),
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextInfo {
    text: String,
    encoding: &'static str,
    bom: bool,
    lossy: bool,
    disk_stamp: DiskStamp,
}

#[derive(Debug)]
pub(crate) struct DecodedText<'a> {
    pub(crate) text: Cow<'a, str>,
    encoding: &'static str,
    bom: bool,
    lossy: bool,
}

fn check_file(metadata: &Metadata) -> Result<(), FileError> {
    if metadata.is_dir() {
        return Err(FileError::new("is_directory", "フォルダです。"));
    }
    if metadata.is_file() {
        return Ok(());
    }
    let kind = "特殊ファイル";
    #[cfg(unix)]
    let kind = {
        use std::os::unix::fs::FileTypeExt;

        let file_type = metadata.file_type();
        if file_type.is_fifo() {
            "名前付きパイプ"
        } else if file_type.is_socket() {
            "ソケット"
        } else if file_type.is_char_device() {
            "キャラクターデバイス"
        } else if file_type.is_block_device() {
            "ブロックデバイス"
        } else {
            kind
        }
    };
    Err(FileError::new(
        "not_regular_file",
        format!("{kind}のため開けません。"),
    ))
}

fn check_size(size: u64, limit: u64) -> Result<(), FileError> {
    if size > limit {
        Err(FileError::too_large(size, limit == FORCE_LIMIT))
    } else {
        Ok(())
    }
}

pub(crate) fn read(path: &Path, force: bool) -> Result<TextInfo, FileError> {
    let limit = if force { FORCE_LIMIT } else { READ_LIMIT };
    let metadata = fs::metadata(path)?;
    check_file(&metadata)?;
    check_size(metadata.len(), limit)?;

    let mut options = OpenOptions::new();
    options.read(true);
    // 確認後にパイプへ置き換わっても、open で待たない。
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    check_file(&opened)?;
    check_size(opened.len(), limit)?;

    // 開いた後にファイルが増えても上限を超えて読み込まない。
    let disk_stamp = DiskStamp::from_metadata(&opened)?;
    let mut bytes = Vec::new();
    let mut reader = file.take(limit + 1);
    reader.read_to_end(&mut bytes)?;
    let size = bytes.len() as u64;
    if size > limit {
        check_size(size.max(reader.get_ref().metadata()?.len()), limit)?;
    }
    let decoded = decode(&bytes)?;
    Ok(TextInfo {
        text: decoded.text.into_owned(),
        encoding: decoded.encoding,
        bom: decoded.bom,
        lossy: decoded.lossy,
        disk_stamp,
    })
}

fn detect(bytes: &[u8]) -> &'static Encoding {
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    detector.guess(None, Utf8Detection::Deny)
}

pub(crate) fn decode(bytes: &[u8]) -> Result<DecodedText<'_>, FileError> {
    let (encoding, skip) = if let Some(bom) = Encoding::for_bom(bytes) {
        bom
    } else {
        match std::str::from_utf8(bytes) {
            // ISO-2022-JP のエスケープ列も UTF-8 として有効。
            Ok(text)
                if !text.as_bytes().contains(&0x1b) || detect(text.as_bytes()) != ISO_2022_JP =>
            {
                return Ok(DecodedText {
                    text: Cow::Borrowed(text),
                    encoding: UTF_8.name(),
                    bom: false,
                    lossy: false,
                });
            }
            Ok(_) => (ISO_2022_JP, 0),
            Err(_) => (detect(bytes), 0),
        }
    };
    let (text, had_errors) = encoding.decode_without_bom_handling(&bytes[skip..]);
    if had_errors {
        let mut count = 0;
        let mut replacements = 0;
        for ch in text.chars() {
            count += 1;
            replacements += usize::from(ch == '\u{fffd}');
        }
        if replacements * 100 > count {
            return Err(FileError::new(
                "invalid_encoding",
                "文字コードを判定できません。",
            ));
        }
    }
    Ok(DecodedText {
        text,
        encoding: encoding.name(),
        bom: skip != 0,
        lossy: had_errors,
    })
}

pub(crate) fn write(
    path: &Path,
    text: &str,
    encoding: Option<&str>,
    bom: bool,
    expected: Option<DiskStamp>,
) -> Result<DiskStamp, FileError> {
    let encoding = match encoding {
        Some(name) => Encoding::for_label_no_replacement(name.as_bytes()).ok_or_else(|| {
            FileError::new("other", format!("未対応の文字コードです（{name}）。"))
        })?,
        None => UTF_8,
    };
    let unrepresentable = || {
        FileError::new(
            "unrepresentable",
            format!("この文字は {} で保存できません。", encoding.name()),
        )
    };
    let mut buffer = Vec::new();
    let bytes;
    if encoding == UTF_16LE || encoding == UTF_16BE {
        let little_endian = encoding == UTF_16LE;
        if bom {
            buffer.extend(if little_endian {
                [0xff, 0xfe]
            } else {
                [0xfe, 0xff]
            });
        }
        // encoding_rs の encode は UTF-16 を指定すると UTF-8 を返す。
        for unit in text.encode_utf16() {
            buffer.extend(if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        bytes = Cow::Owned(buffer);
    } else {
        let (encoded, _, had_errors) = encoding.encode(text);
        if had_errors {
            return Err(unrepresentable());
        }
        if encoding == UTF_8 && bom {
            buffer.extend([0xef, 0xbb, 0xbf]);
            buffer.extend_from_slice(&encoded);
            bytes = Cow::Owned(buffer);
        } else {
            bytes = encoded;
        }
    }
    if !decode(&bytes).is_ok_and(|decoded| decoded.text == text) {
        return Err(unrepresentable());
    }

    let target = resolve_save_target(path)?;
    replace_with(&target, &bytes, expected, File::write_all)
}

fn changed_on_disk() -> FileError {
    FileError::new("changed_on_disk", "ファイルが外部で変更されました。")
}

fn save_metadata(path: &Path) -> io::Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn resolve_save_target(path: &Path) -> Result<PathBuf, FileError> {
    let mut target = path.to_path_buf();
    for followed in 0..=40 {
        if !save_metadata(&target)?.is_some_and(|metadata| metadata.is_symlink()) {
            return Ok(target);
        }
        if followed == 40 {
            break;
        }
        let link = fs::read_link(&target)?;
        target = target.with_file_name(link);
    }
    Err(FileError::other("シンボリックリンクが多すぎます。"))
}

struct SaveTemp {
    path: PathBuf,
    renamed: bool,
}

impl Drop for SaveTemp {
    fn drop(&mut self) {
        if !self.renamed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn create_save_temp(target: &Path, options: &OpenOptions) -> io::Result<(SaveTemp, File)> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let filename = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "ファイル名がありません。"))?;
    let mut prefix = OsString::from(".");
    // 長い名前でも上限（255 バイト）を超えないよう、元の名前は先頭 100 バイトまでにする。
    let mut short = String::new();
    for c in filename.to_string_lossy().chars() {
        if short.len() + c.len_utf8() > 100 {
            break;
        }
        short.push(c);
    }
    if short.len() == filename.len() {
        prefix.push(filename);
    } else {
        prefix.push(short);
    }
    prefix.push(SAVE_TEMP_MARKER);
    let pid = std::process::id();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    loop {
        let next = NEXT.fetch_add(1, Ordering::Relaxed);
        let mut name = prefix.clone();
        name.push(format!("{pid:x}-{now:x}-{next:x}"));
        let path = target.with_file_name(name);
        match options.open(&path) {
            Ok(file) => {
                return Ok((
                    SaveTemp {
                        path,
                        renamed: false,
                    },
                    file,
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

fn replace_with(
    target: &Path,
    bytes: &[u8],
    expected: Option<DiskStamp>,
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> Result<DiskStamp, FileError> {
    let original = match save_metadata(target)? {
        Some(metadata) => {
            check_file(&metadata)?;
            let file = open_for_overwrite(target)?;
            let metadata = file.metadata()?;
            check_file(&metadata)?;
            if let Some(expected) = expected
                && DiskStamp::from_metadata(&metadata)? != expected
            {
                return Err(changed_on_disk());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() > 1 {
                    return overwrite(file, bytes, write);
                }
            }
            Some(metadata)
        }
        None => None,
    };

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if original.is_some() {
        use std::os::unix::fs::OpenOptionsExt;
        // 元の権限を写すまでは所有者だけが読めるようにする。
        options.mode(0o600);
    }
    let (mut temp, mut file) = match create_save_temp(target, &options) {
        Ok(created) => created,
        // フォルダに書き込めない（ファイル自体には書ける）ときは、従来どおり直接上書きする。
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied && original.is_some() => {
            return overwrite(open_for_overwrite(target)?, bytes, write);
        }
        Err(error) => return Err(error.into()),
    };
    write(&mut file, bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    if let Some(metadata) = &original {
        file.set_permissions(metadata.permissions())?;
    }
    let stamp = DiskStamp::from_metadata(&file.metadata()?)?;
    drop(file);

    let mut linked = false;
    if let Some(expected) = expected {
        if original.is_some() {
            let current = save_metadata(target)?.ok_or_else(changed_on_disk)?;
            if !current.is_file() || DiskStamp::from_metadata(&current)? != expected {
                return Err(changed_on_disk());
            }
        } else {
            match fs::hard_link(&temp.path, target) {
                Ok(()) => linked = true,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    return Err(changed_on_disk());
                }
                Err(_) if save_metadata(target)?.is_some() => return Err(changed_on_disk()),
                Err(_) => {}
            }
        }
    }
    if !linked {
        fs::rename(&temp.path, target)?;
        temp.renamed = true;
    }
    drop(temp);
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let _ = File::open(parent).and_then(|dir| dir.sync_all());
    Ok(stamp)
}

fn open_for_overwrite(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn overwrite(
    mut file: File,
    bytes: &[u8],
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> Result<DiskStamp, FileError> {
    file.set_len(0)?;
    write(&mut file, bytes)?;
    Ok(DiskStamp::from_metadata(&file.metadata()?)?)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use encoding_rs::{EUC_JP, SHIFT_JIS};
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    pub(crate) struct TempDir(pub(crate) PathBuf);

    impl TempDir {
        pub(crate) fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "mdock-test-{}-{now}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn assert_no_save_temps(dir: &Path) {
        assert!(
            fs::read_dir(dir)
                .unwrap()
                .all(|entry| !is_save_temp(&entry.unwrap().file_name()))
        );
    }

    #[test]
    fn replaces_contents_and_returns_current_stamp() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        fs::write(&path, "original").unwrap();

        let stamp = write(&path, "saved", None, false, None).unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"saved");
        assert_eq!(
            stamp,
            DiskStamp::from_metadata(&fs::metadata(&path).unwrap()).unwrap()
        );
        assert_no_save_temps(&dir.0);
    }

    #[test]
    fn failed_partial_write_preserves_original() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        fs::write(&path, "original").unwrap();

        let error = replace_with(&path, b"saved", None, |file, bytes| {
            file.write_all(&bytes[..2])?;
            Err(io::Error::other("書き込み失敗"))
        })
        .unwrap_err();

        assert_eq!(error.code, "other");
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_no_save_temps(&dir.0);
    }

    #[test]
    fn checks_expected_again_before_replacing() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        fs::write(&path, "original").unwrap();
        let expected = read(&path, false).unwrap().disk_stamp;

        let error = replace_with(&path, b"saved", Some(expected), |file, bytes| {
            file.write_all(bytes)?;
            fs::write(&path, "changed externally")
        })
        .unwrap_err();

        assert_eq!(error.code, "changed_on_disk");
        assert_eq!(fs::read(&path).unwrap(), b"changed externally");
        assert_no_save_temps(&dir.0);
    }

    #[test]
    fn refuses_to_overwrite_concurrently_recreated_target() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        fs::write(&path, "original").unwrap();
        let expected = read(&path, false).unwrap().disk_stamp;
        fs::remove_file(&path).unwrap();

        let error = replace_with(&path, b"saved", Some(expected), |file, bytes| {
            file.write_all(bytes)?;
            fs::write(&path, "created externally")
        })
        .unwrap_err();

        assert_eq!(error.code, "changed_on_disk");
        assert_eq!(fs::read(&path).unwrap(), b"created externally");
        assert_no_save_temps(&dir.0);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_existing_file_modes() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        fs::write(&path, "original").unwrap();
        for mode in [0o640, 0o755] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            write(&path, "saved", None, false, None).unwrap();
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
                mode
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn saves_through_absolute_relative_and_dangling_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = TempDir::new();
        let target = dir.0.join("note.md");
        let absolute = dir.0.join("absolute");
        let subdir = dir.0.join("subdir");
        let relative = subdir.join("relative");
        fs::create_dir(&subdir).unwrap();
        fs::write(&target, "original").unwrap();
        symlink(&target, &absolute).unwrap();
        symlink("../absolute", &relative).unwrap();

        write(&absolute, "saved through absolute", None, false, None).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"saved through absolute");
        write(&relative, "saved through relative", None, false, None).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"saved through relative");
        let expected = read(&relative, false).unwrap().disk_stamp;
        fs::remove_file(&target).unwrap();
        write(&relative, "recreated", None, false, Some(expected)).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"recreated");

        for link in [&absolute, &relative] {
            assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
        }
        assert_no_save_temps(&dir.0);
        assert_no_save_temps(&subdir);
    }

    #[cfg(unix)]
    #[test]
    fn follows_at_most_forty_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = TempDir::new();
        fs::write(dir.0.join("0"), "original").unwrap();
        for step in 1..=41 {
            symlink((step - 1).to_string(), dir.0.join(step.to_string())).unwrap();
        }
        write(&dir.0.join("40"), "saved", None, false, None).unwrap();
        assert!(write(&dir.0.join("41"), "too far", None, false, None).is_err());
        assert_eq!(fs::read(dir.0.join("0")).unwrap(), b"saved");
        assert_no_save_temps(&dir.0);
    }

    #[test]
    fn saves_files_with_long_names() {
        let dir = TempDir::new();
        let path = dir.0.join(format!("{}.md", "長".repeat(80)));
        fs::write(&path, "original").unwrap();
        write(&path, "saved", None, false, None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"saved");
        assert_no_save_temps(&dir.0);
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_overwrite_when_folder_is_read_only() {
        let dir = TempDir::new();
        let sub = dir.0.join("locked");
        fs::create_dir(&sub).unwrap();
        let path = sub.join("note.md");
        fs::write(&path, "original").unwrap();
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o555)).unwrap();
        let result = write(&path, "saved", None, false, None);
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o755)).unwrap();
        result.unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"saved");
        assert_no_save_temps(&sub);
    }

    #[cfg(unix)]
    #[test]
    fn saves_through_existing_hard_links() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        let link = dir.0.join("hard-link.md");
        fs::write(&path, "original").unwrap();
        fs::hard_link(&path, &link).unwrap();
        let expected = read(&path, false).unwrap().disk_stamp;

        write(&path, "saved", None, false, Some(expected)).unwrap();

        assert_eq!(fs::read(&link).unwrap(), b"saved");
        assert_no_save_temps(&dir.0);
    }

    #[test]
    fn identifies_save_temporary_names() {
        assert!(is_save_temp(OsStr::new(".note.md.mdock-tmp-123a")));
        assert!(!is_save_temp(OsStr::new("note.md.mdock-tmp-123a")));
        assert!(!is_save_temp(OsStr::new(".note.md.tmp-123a")));
        assert!(!is_save_temp(OsStr::new(".mdock-tmp")));
    }

    #[test]
    fn detects_japanese_encodings_and_round_trips() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        let text = "これは日本語の文章です。文字コードの自動判定を確認します。";
        for encoding in [SHIFT_JIS, EUC_JP, ISO_2022_JP] {
            let (bytes, _, errors) = encoding.encode(text);
            assert!(!errors);
            fs::write(&path, &bytes).unwrap();
            let info = read(&path, false).unwrap();
            assert_eq!(info.text, text);
            assert_eq!(info.encoding, encoding.name());
            assert!(!info.bom);
            write(&path, &info.text, Some(info.encoding), info.bom, None).unwrap();
            assert_eq!(&fs::read(&path).unwrap()[..], bytes.as_ref());
        }
    }

    #[test]
    fn preserves_bom_and_unicode_byte_order() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        for (encoding, bytes) in [
            ("UTF-8", &b"\xef\xbb\xbf\xe6\x97\xa5\xf0\x9f\x98\x80"[..]),
            ("UTF-16LE", &b"\xff\xfe\xe5\x65\x3d\xd8\x00\xde"[..]),
            ("UTF-16BE", &b"\xfe\xff\x65\xe5\xd8\x3d\xde\x00"[..]),
        ] {
            fs::write(&path, bytes).unwrap();
            let info = read(&path, false).unwrap();
            assert_eq!(
                (info.text.as_str(), info.encoding, info.bom),
                ("日😀", encoding, true)
            );
            write(&path, &info.text, Some(info.encoding), info.bom, None).unwrap();
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn rejects_invalid_encoding_and_preserves_file_on_failed_save() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        let bytes = b"\xff\xfe\x00\xd8";
        fs::write(&path, bytes).unwrap();
        assert_eq!(read(&path, false).unwrap_err().code, "invalid_encoding");
        assert_eq!(
            write(&path, "😀", Some("Shift_JIS"), false, None)
                .unwrap_err()
                .code,
            "unrepresentable"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn marks_lossy_decoding_below_the_error_threshold() {
        let mut bytes = b"\xef\xbb\xbf".to_vec();
        bytes.extend([b'a'; 99]);
        bytes.push(0xff);
        let info = decode(&bytes).unwrap();
        assert!(info.lossy);
        assert!(info.text.ends_with('\u{fffd}'));
        assert!(!decode("本文中の\u{fffd}".as_bytes()).unwrap().lossy);
    }

    #[test]
    fn rejects_shift_jis_when_the_yen_sign_changes_on_round_trip() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        let original = b"original";
        fs::write(&path, original).unwrap();
        assert_eq!(
            write(&path, "100 ¥", Some("Shift_JIS"), false, None)
                .unwrap_err()
                .code,
            "unrepresentable"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn rejects_shift_jis_that_is_read_as_different_utf8_text() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        let original = b"original";
        fs::write(&path, original).unwrap();
        assert_eq!(
            write(&path, "ﾂｩ", Some("Shift_JIS"), false, None)
                .unwrap_err()
                .code,
            "unrepresentable"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn checks_both_disk_stamp_fields_before_writing() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        fs::write(&path, "original").unwrap();
        let stamp = read(&path, false).unwrap().disk_stamp;
        for expected in [
            DiskStamp {
                mtime: stamp.mtime - 1,
                ..stamp
            },
            DiskStamp {
                size: stamp.size + 1,
                ..stamp
            },
        ] {
            assert_eq!(
                write(&path, "edited", None, false, Some(expected))
                    .unwrap_err()
                    .code,
                "changed_on_disk"
            );
            assert_eq!(fs::read(&path).unwrap(), b"original");
        }
        let saved = write(&path, "edited", None, false, Some(stamp)).unwrap();
        assert_eq!(read(&path, false).unwrap().disk_stamp, saved);
        fs::remove_file(&path).unwrap();
        write(&path, "restored", None, false, Some(saved)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"restored");
    }

    #[test]
    fn large_files_require_force_and_have_a_hard_limit() {
        let dir = TempDir::new();
        let path = dir.0.join("large.md");
        let file = fs::File::create(&path).unwrap();
        file.set_len(READ_LIMIT).unwrap();
        assert_eq!(read(&path, false).unwrap().text.len() as u64, READ_LIMIT);
        file.set_len(READ_LIMIT + 1).unwrap();
        let error = read(&path, false).unwrap_err();
        assert_eq!(
            (error.code, error.size),
            ("large_file", Some(READ_LIMIT + 1))
        );
        assert_eq!(read(&path, true).unwrap().text.len() as u64, READ_LIMIT + 1);
        file.set_len(FORCE_LIMIT + 1).unwrap();
        for (force, code) in [(false, "large_file"), (true, "too_large")] {
            let error = read(&path, force).unwrap_err();
            assert_eq!((error.code, error.size), (code, Some(FORCE_LIMIT + 1)));
        }
    }

    #[test]
    fn distinguishes_missing_files_and_directories() {
        let dir = TempDir::new();
        assert_eq!(read(&dir.0, false).unwrap_err().code, "is_directory");
        assert_eq!(
            read(&dir.0.join("missing"), false).unwrap_err().code,
            "not_found"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifo_and_its_symlink() {
        let dir = TempDir::new();
        let fifo = dir.0.join("fifo");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let link = dir.0.join("link");
        std::os::unix::fs::symlink(&fifo, &link).unwrap();
        for path in [fifo, link] {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || tx.send(read(&path, false)));
            let error = rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code, "not_regular_file");
            assert!(error.message.contains("名前付きパイプ"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn distinguishes_permission_denied() {
        let dir = TempDir::new();
        let path = dir.0.join("private.md");
        fs::write(&path, "secret").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        // root ではファイルのモードで読み込みを拒否できない。
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(read(&path, false).unwrap_err().code, "permission_denied");
        }
    }
}
