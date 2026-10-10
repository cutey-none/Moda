//! Reading a folder's markdown tree for the sidebar.
//!
//! The whole tree is read in one call rather than lazily per folder expand. A
//! workspace of documents is small enough for that to be the simpler contract,
//! and it means expanding a node in the sidebar is instant with no IPC round
//! trip. Two guards keep "the user picked the wrong folder" from turning into a
//! hung app: a recursion depth limit, and a cap on the total number of entries
//! read.
//!
//! Errors are structured the same way as in [`crate::file_ops`], so the frontend
//! has one error shape to handle.

use std::fs;
use std::path::{Path, PathBuf};
use serde::Serialize;

use crate::file_ops::FileError;

/// Extensions treated as openable documents. Lower-case, without the dot.
const MARKDOWN_EXTENSIONS: [&str; 6] = ["md", "markdown", "mdown", "mkd", "mdx", "txt"];

/// How deep the tree walk goes. Deep enough for any real notes folder, shallow
/// enough that a symlink cycle or an accidental `/` cannot run away.
const MAX_DEPTH: usize = 12;

/// The most entries read across the whole walk. Beyond this the walk stops and
/// reports truncation rather than continuing.
const MAX_ENTRIES: usize = 5000;

/// Names never shown: version control and dependency directories are noise in a
/// writing workspace, and node_modules alone can dwarf the actual documents.
const IGNORED_DIRECTORIES: [&str; 5] = [".git", "node_modules", ".svn", ".hg", "target"];

/// One file or directory in the tree.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    /// Display name (the final path component).
    pub name: String,
    /// Absolute path.
    pub path: String,
    /// Whether this is a directory.
    pub is_directory: bool,
    /// Whether the app can open this as a document.
    pub is_markdown: bool,
    /// Size in bytes. Directories report 0.
    pub size: u64,
    /// Modification time in milliseconds since the epoch, or 0.
    pub modified_ms: u64,
    /// Children, in display order. Empty for files.
    pub children: Vec<TreeEntry>,
}

/// A folder's tree, plus what the walk had to leave out.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryTree {
    /// Absolute path of the folder that was read.
    pub path: String,
    /// Display name of that folder.
    pub name: String,
    /// Top-level entries, directories first and each group name-sorted.
    pub entries: Vec<TreeEntry>,
    /// Whether the entry cap was reached, so the UI can say so.
    pub truncated: bool,
}

/// Whether a path looks like a document the app can open.
fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .is_some_and(|extension| MARKDOWN_EXTENSIONS.contains(&extension.as_str()))
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

/// Sort entries the way a file browser reads: directories first, then files,
/// each group case-insensitively by name.
fn sort_entries(entries: &mut [TreeEntry]) {
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
}

/// Read one directory's entries without recursing.
fn read_children(directory: &Path, budget: &mut usize) -> Result<Vec<TreeEntry>, FileError> {
    let reader = fs::read_dir(directory).map_err(|error| FileError::io(directory, error))?;
    let mut entries = Vec::new();

    for item in reader {
        let Ok(item) = item else { continue };
        if *budget == 0 {
            break;
        }
        let path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();

        // Hidden entries stay hidden; that is what the leading dot means.
        if name.starts_with('.') {
            continue;
        }

        // `metadata` follows symlinks, so a link to a readable file reports that
        // file; a broken link fails and is skipped rather than shown as an error.
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let is_directory = metadata.is_dir();
        if is_directory && IGNORED_DIRECTORIES.contains(&name.as_str()) {
            continue;
        }

        *budget -= 1;
        entries.push(TreeEntry {
            path: path.display().to_string(),
            is_markdown: !is_directory && is_markdown_path(&path),
            is_directory,
            size: if is_directory { 0 } else { metadata.len() },
            modified_ms: modified_ms(&metadata),
            children: Vec::new(),
            name,
        });
    }

    Ok(entries)
}

/// Walk a directory tree, filling in children depth-first.
fn walk(directory: &Path, depth: usize, budget: &mut usize) -> Result<Vec<TreeEntry>, FileError> {
    let mut entries = read_children(directory, budget)?;

    if depth < MAX_DEPTH {
        for entry in &mut entries {
            if !entry.is_directory || *budget == 0 {
                continue;
            }
            // A directory that cannot be read (permissions) is shown as an empty
            // folder rather than failing the whole walk.
            entry.children =
                walk(&PathBuf::from(&entry.path), depth + 1, budget).unwrap_or_default();
        }
    }

    sort_entries(&mut entries);
    Ok(entries)
}

/// Read a folder's tree for the sidebar.
#[tauri::command]
pub fn read_directory_tree(path: String) -> Result<DirectoryTree, FileError> {
    let requested = PathBuf::from(&path);
    let metadata = fs::metadata(&requested).map_err(|error| FileError::io(&requested, error))?;
    if !metadata.is_dir() {
        return Err(FileError::NotADirectory { path });
    }

    let resolved = fs::canonicalize(&requested).unwrap_or(requested);
    let mut budget = MAX_ENTRIES;
    let entries = walk(&resolved, 0, &mut budget)?;

    Ok(DirectoryTree {
        name: resolved
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| resolved.display().to_string()),
        path: resolved.display().to_string(),
        entries,
        truncated: budget == 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Scratch;

    /// Find a top-level entry by name.
    fn entry<'a>(tree: &'a DirectoryTree, name: &str) -> &'a TreeEntry {
        tree.entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap_or_else(|| panic!("no entry named {name}"))
    }

    #[test]
    fn lists_files_and_directories_with_markdown_flagged() {
        let scratch = Scratch::new("tree");
        scratch.write("note.md", "# hi");
        scratch.write("data.json", "{}");
        scratch.mkdir("sub");

        let tree = read_directory_tree(scratch.root().display().to_string()).expect("read tree");

        assert_eq!(entry(&tree, "note.md").is_markdown, true);
        assert_eq!(entry(&tree, "note.md").is_directory, false);
        assert_eq!(entry(&tree, "data.json").is_markdown, false);
        assert_eq!(entry(&tree, "sub").is_directory, true);
    }

    #[test]
    fn nests_children_and_sorts_directories_first() {
        let scratch = Scratch::new("tree");
        scratch.write("zebra.md", "z");
        scratch.write("apple.md", "a");
        scratch.write("folder/inner.md", "i");

        let tree = read_directory_tree(scratch.root().display().to_string()).expect("read tree");

        // Directory first, then files alphabetically (case-insensitive).
        let names: Vec<&str> = tree.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["folder", "apple.md", "zebra.md"]);

        let nested = entry(&tree, "folder");
        assert_eq!(nested.children.len(), 1);
        assert_eq!(nested.children[0].name, "inner.md");
        assert!(nested.children[0].path.ends_with("folder/inner.md"));
    }

    #[test]
    fn hides_dotfiles_and_ignored_directories() {
        let scratch = Scratch::new("tree");
        scratch.write("visible.md", "v");
        scratch.write(".hidden.md", "h");
        scratch.mkdir(".git");
        scratch.mkdir("node_modules");
        scratch.write("node_modules/dep.md", "d");

        let tree = read_directory_tree(scratch.root().display().to_string()).expect("read tree");

        let names: Vec<&str> = tree.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["visible.md"]);
    }

    #[test]
    fn reports_a_file_as_not_a_directory() {
        let scratch = Scratch::new("tree");
        let file = scratch.write("note.md", "x");

        match read_directory_tree(file.display().to_string()) {
            Err(FileError::NotADirectory { .. }) => {}
            other => panic!("expected NotADirectory, got {other:?}"),
        }
    }

    #[test]
    fn reports_a_missing_directory_as_not_found() {
        let scratch = Scratch::new("tree");
        let missing = scratch.root().join("absent");

        match read_directory_tree(missing.display().to_string()) {
            Err(FileError::NotFound { .. }) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn empty_directory_yields_no_entries_and_is_not_truncated() {
        let scratch = Scratch::new("tree");
        scratch.mkdir("empty");

        let tree = read_directory_tree(scratch.root().join("empty").display().to_string())
            .expect("read tree");

        assert!(tree.entries.is_empty());
        assert!(!tree.truncated);
    }

    #[test]
    fn recognizes_every_markdown_extension_case_insensitively() {
        for name in ["a.md", "b.MD", "c.markdown", "d.mkd", "e.mdx", "f.txt"] {
            assert!(is_markdown_path(Path::new(name)), "{name} should be markdown");
        }
        for name in ["a.png", "b.pdf", "c", "d.docx"] {
            assert!(!is_markdown_path(Path::new(name)), "{name} should not be markdown");
        }
    }
}
