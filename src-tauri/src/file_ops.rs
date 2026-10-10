//! Reading and writing markdown documents on behalf of the frontend.
//!
//! Kept deliberately small: the frontend owns document state, this module owns
//! the filesystem. Errors are returned as structured values rather than strings
//! so the UI can distinguish "the user cannot read this file" from "this is not
//! a markdown document" without parsing prose.

use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

/// A document read from disk, together with the path it came from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    /// Absolute path of the file.
    pub path: String,
    /// File name without any directory component, for display in the title bar.
    pub name: String,
    /// Full text contents.
    pub contents: String,
    /// Modification time in milliseconds since the Unix epoch, or 0 when the
    /// platform does not report one.
    pub modified_ms: u64,
}

/// Why a file operation failed. Serialized as a tagged enum so the frontend can
/// branch on the kind rather than matching message text.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FileError {
    /// The path does not exist.
    NotFound { path: String },
    /// The path exists but could not be read or written (permissions, I/O).
    Io { path: String, message: String },
    /// The file is not valid UTF-8. Markdown is a text format; a binary or
    /// mis-encoded file is refused rather than silently mangled.
    NotUtf8 { path: String },
    /// The path exists but is not a directory, where a directory was required.
    NotADirectory { path: String },
}

impl FileError {
    /// Classify an I/O failure. Shared with the other filesystem modules so the
    /// frontend only ever has one error shape to handle.
    pub(crate) fn io(path: &Path, error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            FileError::NotFound {
                path: path.display().to_string(),
            }
        } else {
            FileError::Io {
                path: path.display().to_string(),
                message: error.to_string(),
            }
        }
    }
}

/// Where a save should go.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    /// Destination path. Always absolute, always chosen by the user or carried
    /// over from the file that was opened.
    pub path: String,
    /// Full replacement text for the file.
    pub contents: String,
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// Modification time in milliseconds, or 0 when unavailable.
fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0)
}

/// Read a markdown file from disk.
#[tauri::command]
pub fn read_document(path: String) -> Result<Document, FileError> {
    let requested = PathBuf::from(&path);
    let metadata = fs::metadata(&requested).map_err(|error| FileError::io(&requested, error))?;
    let bytes = fs::read(&requested).map_err(|error| FileError::io(&requested, error))?;
    let contents = String::from_utf8(bytes).map_err(|_| FileError::NotUtf8 { path: path.clone() })?;

    // Report the canonical path so a document opened through a symlink is
    // remembered by its real location, and saving it later writes where the
    // user expects.
    let resolved = fs::canonicalize(&requested).unwrap_or(requested);
    Ok(Document {
        name: file_name_of(&resolved),
        path: resolved.display().to_string(),
        contents,
        modified_ms: modified_ms(&metadata),
    })
}

/// Write a markdown file to disk, creating any missing parent directories.
#[tauri::command]
pub fn save_document(request: SaveRequest) -> Result<Document, FileError> {
    let target = PathBuf::from(&request.path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| FileError::io(parent, error))?;
        }
    }
    fs::write(&target, request.contents.as_bytes())
        .map_err(|error| FileError::io(&target, error))?;

    // Canonicalise for the same reason `read_document` does: on macOS `/var` is
    // a symlink to `/private/var`, so the path the caller wrote and the path a
    // later read reports would otherwise differ. The document would then be
    // tracked under two different names.
    let resolved = fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
    let metadata = fs::metadata(&resolved).map_err(|error| FileError::io(&resolved, error))?;
    Ok(Document {
        name: file_name_of(&resolved),
        path: resolved.display().to_string(),
        contents: request.contents,
        modified_ms: modified_ms(&metadata),
    })
}

/// Check whether a path exists and is a regular file.
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    fs::metadata(&path).map(|meta| meta.is_file()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Scratch;

    #[test]
    fn saves_then_reads_back_the_same_text() {
        let scratch = Scratch::new("file");
        let target = scratch.path("note.md");
        let text = "# 标题\n\n正文，带 emoji 🎉 与 `code`。\n";

        let saved = save_document(SaveRequest {
            path: target.display().to_string(),
            contents: text.to_string(),
        })
        .expect("save should succeed");
        assert_eq!(saved.name, "note.md");
        assert_eq!(saved.contents, text);

        let read = read_document(target.display().to_string()).expect("read should succeed");
        assert_eq!(read.contents, text);
        assert_eq!(read.name, "note.md");

        // Save and read must agree on the path, or the window would track one
        // document under two different names. The expected value is
        // canonicalised here rather than hardcoded, because on macOS the temp
        // directory is reached through the `/var` -> `/private/var` symlink.
        let canonical = fs::canonicalize(&target).expect("canonicalize");
        assert_eq!(saved.path, canonical.display().to_string());
        assert_eq!(read.path, saved.path);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let scratch = Scratch::new("file");
        let nested = scratch.path("a/b/c/deep.md");

        save_document(SaveRequest {
            path: nested.display().to_string(),
            contents: "deep".to_string(),
        })
        .expect("save should create the parent path");

        assert!(nested.is_file());
    }

    #[test]
    fn reading_a_missing_file_reports_not_found() {
        let scratch = Scratch::new("file");
        let missing = scratch.path("nope.md");

        match read_document(missing.display().to_string()) {
            Err(FileError::NotFound { path }) => assert_eq!(path, missing.display().to_string()),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn reading_a_binary_file_reports_not_utf8() {
        let scratch = Scratch::new("file");
        let binary = scratch.path("binary.md");
        // An invalid UTF-8 byte sequence, as a stray encoding would produce.
        fs::write(&binary, [0xff, 0xfe, 0x00, 0x41]).expect("write binary");

        match read_document(binary.display().to_string()) {
            Err(FileError::NotUtf8 { .. }) => {}
            other => panic!("expected NotUtf8, got {other:?}"),
        }
    }

    #[test]
    fn empty_document_round_trips() {
        let scratch = Scratch::new("file");
        let target = scratch.path("empty.md");

        save_document(SaveRequest {
            path: target.display().to_string(),
            contents: String::new(),
        })
        .expect("save empty");

        let read = read_document(target.display().to_string()).expect("read empty");
        assert_eq!(read.contents, "");
    }

    #[test]
    fn file_exists_distinguishes_files_from_absent_paths() {
        let scratch = Scratch::new("file");
        let file = scratch.path("real.md");
        fs::write(&file, "x").expect("write file");

        assert!(file_exists(file.display().to_string()));
        assert!(!file_exists(scratch.path("absent.md").display().to_string()));
        // A directory is not a file.
        assert!(!file_exists(scratch.root().display().to_string()));
    }
}

