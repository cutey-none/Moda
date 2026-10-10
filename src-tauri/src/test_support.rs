//! Shared helpers for tests that need a real directory on disk.
//!
//! Exists because three modules had grown their own near-identical copy of this,
//! and all three named the directory from a timestamp alone. Rust runs tests in
//! parallel, so two tests starting in the same nanosecond shared a directory and
//! saw each other's files — which showed up as a genuine failure in the
//! directory walker, not as flakiness that could be shrugged off. Uniqueness here
//! is what keeps the filesystem tests independent.
//!
//! Compiled only for tests, so it costs the shipped binary nothing.

#![cfg(test)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Distinguishes scratch directories created in the same nanosecond.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A temporary directory that removes itself when dropped.
///
/// The guard is the point: a panicking test still cleans up, so a failing run
/// does not leave fixtures behind in the system temp directory.
pub struct Scratch {
    root: PathBuf,
}

impl Scratch {
    /// Create an empty scratch directory.
    pub fn new(label: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        let thread = std::thread::current().id();
        let root = std::env::temp_dir().join(format!("moda-{label}-{stamp}-{counter}-{thread:?}"));
        std::fs::create_dir_all(&root).expect("create scratch dir");
        Scratch { root }
    }

    /// The scratch directory itself.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// An absolute path inside the scratch directory, without creating it.
    pub fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    /// Write a file, creating any missing parent directories.
    pub fn write(&self, relative: &str, contents: &str) -> PathBuf {
        let target = self.path(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&target, contents).expect("write file");
        target
    }

    /// Create a directory inside the scratch directory.
    pub fn mkdir(&self, relative: &str) -> PathBuf {
        let target = self.path(relative);
        std::fs::create_dir_all(&target).expect("create dir");
        target
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
