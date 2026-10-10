//! Handing files that arrive from *outside* the app to the frontend.
//!
//! Three routes bring a document in without the user picking it in a dialog: a
//! Finder double-click (macOS delivers `RunEvent::Opened` with `file://` URLs),
//! a path given on the command line, and a second launch forwarded by the
//! single-instance plugin. All three funnel into [`deliver`].
//!
//! Delivery is deliberately two-sided, because a cold launch races the frontend:
//!
//! * [`deliver`] **queues** the paths and **also** emits [`OPEN_FILES_EVENT`].
//! * The frontend drains the queue with the `take_pending_open_files` command
//!   once it is listening, then keeps handling the event for the warm case.
//!
//! An earlier version only emitted the event after a fixed delay, which lost the
//! document whenever the webview was slower than the timer — the app came up on
//! an empty document. A queue cannot be missed: whatever the timing, the paths
//! are still there when the frontend asks.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Emitted with `{ paths: string[] }` whenever files should be opened.
pub const OPEN_FILES_EVENT: &str = "moda://open-files";

/// The event payload.
#[derive(Debug, Clone, Serialize)]
pub struct OpenFilesPayload {
    /// Absolute paths of the documents to open, in the order they arrived.
    pub paths: Vec<String>,
}

/// Paths that arrived before the frontend asked for them.
///
/// `Default` so Tauri can build it as managed state without a constructor.
#[derive(Default)]
pub struct PendingOpenFiles(pub Mutex<Vec<String>>);

/// Turn `file://` URLs into absolute paths, dropping anything else.
///
/// `RunEvent::Opened` is used for more than documents — a dropped folder or an
/// unrecognized scheme can arrive the same way — so non-file URLs are filtered
/// rather than guessed at.
pub fn paths_from_urls(urls: &[url::Url]) -> Vec<String> {
    urls.iter()
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.display().to_string())
        .collect()
}

/// Extensions that name a document rather than a program.
const DOCUMENT_EXTENSIONS: [&str; 6] = ["md", "markdown", "mdown", "mkd", "mdx", "txt"];

/// Whether an argument names a document the app should open.
///
/// The argument list also carries the executable path itself and whatever flags
/// the launcher added, so "is this an existing file" is not enough — argv[0] is
/// an existing file, and treating it as a document would make the app try to
/// open its own binary. The extension is what separates the two: a document is
/// a real file whose extension the app knows.
fn looks_like_document(argument: &str) -> bool {
    if argument.starts_with('-') {
        return false;
    }
    let path = std::path::Path::new(argument);
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    DOCUMENT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()) && path.is_file()
}

/// Keep only the arguments that name an openable document.
pub fn paths_from_args(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|argument| looks_like_document(argument))
        .cloned()
        .collect()
}

/// Queue these documents and tell the frontend about them.
///
/// Both halves are needed: the emit serves an already-running window, and the
/// queue covers a launch where the frontend is not listening yet.
pub fn deliver(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    if let Some(pending) = app.try_state::<PendingOpenFiles>() {
        match pending.0.lock() {
            Ok(mut queue) => queue.extend(paths.iter().cloned()),
            Err(poisoned) => poisoned.into_inner().extend(paths.iter().cloned()),
        }
    }

    if let Err(error) = app.emit(OPEN_FILES_EVENT, OpenFilesPayload { paths }) {
        // Only happens when there is no window to receive it; the queue still
        // holds the paths, so the document is not lost.
        eprintln!("could not emit {OPEN_FILES_EVENT}: {error}");
    }
}

/// Hand over everything queued so far, clearing the queue.
///
/// The frontend calls this once it is listening, which makes a cold launch
/// deterministic instead of timing-dependent.
#[tauri::command]
pub fn take_pending_open_files(state: tauri::State<'_, PendingOpenFiles>) -> Vec<String> {
    match state.0.lock() {
        Ok(mut queue) => std::mem::take(&mut *queue),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Scratch;

    #[test]
    fn converts_file_urls_to_paths() {
        let urls = vec![
            url::Url::parse("file:///Users/someone/notes/a.md").expect("parse"),
            url::Url::parse("file:///Users/someone/notes/b.md").expect("parse"),
        ];
        assert_eq!(
            paths_from_urls(&urls),
            vec!["/Users/someone/notes/a.md", "/Users/someone/notes/b.md"]
        );
    }

    #[test]
    fn ignores_non_file_urls() {
        let urls = vec![
            url::Url::parse("https://example.com/a.md").expect("parse"),
            url::Url::parse("moda://open?path=/tmp/x.md").expect("parse"),
        ];
        assert!(paths_from_urls(&urls).is_empty());
    }

    #[test]
    fn percent_encoded_paths_are_decoded() {
        let urls = vec![url::Url::parse("file:///Users/someone/My%20Notes/a.md").expect("parse")];
        assert_eq!(paths_from_urls(&urls), vec!["/Users/someone/My Notes/a.md"]);
    }

    #[test]
    fn keeps_only_documents_from_arguments() {
        let scratch = Scratch::new("args");
        let document = scratch.write("note.md", "x");
        let other = scratch.write("data.json", "{}");
        let binary = scratch.write("moda", "#!/bin/sh\n");

        let args = vec![
            binary.display().to_string(),
            "--flag".to_string(),
            scratch.root().display().to_string(),
            other.display().to_string(),
            document.display().to_string(),
        ];

        // A bare executable with no extension, a flag, a directory, and a
        // non-document file are all rejected; only the markdown document stays.
        assert_eq!(paths_from_args(&args), vec![document.display().to_string()]);
    }

    #[test]
    fn an_installed_executable_is_not_treated_as_a_document() {
        // Regression: the app's own binary is an existing file at argv[0], and an
        // earlier filter keyed on "exists on disk" tried to open it.
        let args = vec!["/Applications/Moda.app/Contents/MacOS/moda".to_string()];
        assert!(paths_from_args(&args).is_empty());
    }

    #[test]
    fn queued_paths_are_handed_over_once() {
        let state = PendingOpenFiles::default();
        *state.0.lock().expect("lock") = vec!["/tmp/a.md".to_string()];

        let first = take_from(&state);
        let second = take_from(&state);

        assert_eq!(first, vec!["/tmp/a.md"]);
        // Draining twice must not hand the same document over again, or the app
        // would reopen it on every start.
        assert!(second.is_empty());
    }

    /// The body of the command, without needing a Tauri `State` to build.
    fn take_from(state: &PendingOpenFiles) -> Vec<String> {
        match state.0.lock() {
            Ok(mut queue) => std::mem::take(&mut *queue),
            Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
        }
    }
}
