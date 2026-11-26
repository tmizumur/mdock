use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, ISO_2022_JP, UTF_8, UTF_16BE, UTF_16LE};
use serde::Serialize;
use std::fs::{self, Metadata, OpenOptions};
use std::io::{self, Read};
use std::path::Path;

const READ_LIMIT: u64 = 5 * 1024 * 1024;
const FORCE_LIMIT: u64 = 100 * 1024 * 1024;

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

#[derive(Debug, Serialize)]
pub(crate) struct TextInfo {
    text: String,
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
    let mut bytes = Vec::new();
    let mut reader = file.take(limit + 1);
    reader.read_to_end(&mut bytes)?;
    let size = bytes.len() as u64;
    if size > limit {
        check_size(size.max(reader.get_ref().metadata()?.len()), limit)?;
    }
    decode(bytes)
}

fn detect(bytes: &[u8]) -> &'static Encoding {
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    detector.guess(None, Utf8Detection::Deny)
}

fn decode(mut bytes: Vec<u8>) -> Result<TextInfo, FileError> {
    let (encoding, skip) = if let Some(bom) = Encoding::for_bom(&bytes) {
        bom
    } else {
        match String::from_utf8(bytes) {
            // ISO-2022-JP のエスケープ列も UTF-8 として有効。
            Ok(text)
                if !text.as_bytes().contains(&0x1b) || detect(text.as_bytes()) != ISO_2022_JP =>
            {
                return Ok(TextInfo {
                    text,
                    encoding: UTF_8.name(),
                    bom: false,
                    lossy: false,
                });
            }
            Ok(text) => {
                bytes = text.into_bytes();
                (ISO_2022_JP, 0)
            }
            Err(error) => {
                bytes = error.into_bytes();
                (detect(&bytes), 0)
            }
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
    Ok(TextInfo {
        text: text.into_owned(),
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
) -> Result<(), FileError> {
    let encoding = match encoding {
        Some(name) => Encoding::for_label_no_replacement(name.as_bytes()).ok_or_else(|| {
            FileError::new("other", format!("未対応の文字コードです（{name}）。"))
        })?,
        None => UTF_8,
    };
    let mut bytes = Vec::new();
    if encoding == UTF_16LE || encoding == UTF_16BE {
        let little_endian = encoding == UTF_16LE;
        if bom {
            bytes.extend(if little_endian {
                [0xff, 0xfe]
            } else {
                [0xfe, 0xff]
            });
        }
        // encoding_rs の encode は UTF-16 を指定すると UTF-8 を返す。
        for unit in text.encode_utf16() {
            bytes.extend(if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
    } else {
        let (encoded, _, had_errors) = encoding.encode(text);
        if had_errors
            || (encoding != UTF_8 && encoding.decode_without_bom_handling(&encoded).0 != text)
        {
            return Err(FileError::new(
                "unrepresentable",
                format!("この文字は {} で保存できません。", encoding.name()),
            ));
        }
        if encoding == UTF_8 && bom {
            bytes.extend([0xef, 0xbb, 0xbf]);
        } else {
            return fs::write(path, encoded).map_err(FileError::from);
        }
        bytes.extend_from_slice(&encoded);
    }
    fs::write(path, bytes).map_err(FileError::from)
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
            write(&path, &info.text, Some(info.encoding), info.bom).unwrap();
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
            write(&path, &info.text, Some(info.encoding), info.bom).unwrap();
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
            write(&path, "😀", Some("Shift_JIS"), false)
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
        let info = decode(bytes).unwrap();
        assert!(info.lossy);
        assert!(info.text.ends_with('\u{fffd}'));
        assert!(
            !decode("本文中の\u{fffd}".as_bytes().to_vec())
                .unwrap()
                .lossy
        );
    }

    #[test]
    fn rejects_shift_jis_when_the_yen_sign_changes_on_round_trip() {
        let dir = TempDir::new();
        let path = dir.0.join("note.md");
        let original = b"original";
        fs::write(&path, original).unwrap();
        assert_eq!(
            write(&path, "100 ¥", Some("Shift_JIS"), false)
                .unwrap_err()
                .code,
            "unrepresentable"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
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
