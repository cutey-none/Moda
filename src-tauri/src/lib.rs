//! Moda — a WYSIWYG markdown editor.
//!
//! The Rust side stays thin on purpose: it owns the filesystem, the native
//! dialogs, and the files that arrive from outside the app, while the editor and
//! all document state live in the webview.

mod directory;
mod file_ops;
mod menu;
mod open_files;

#[cfg(test)]
mod test_support;

use open_files::PendingOpenFiles;
use tauri::Manager;

/// Gives the window its macOS backing material, so the chrome has something to
/// be translucent *over*.
///
/// The frontend paints nothing behind the title bar, sidebar and status bar, and
/// `tauri.conf.json` marks the window transparent, so the desktop is visible
/// through the webview in exactly those places. This puts the system material in
/// that gap. `NSGlassEffectView` is the genuine macOS 26 liquid glass; it reports
/// `UnsupportedPlatformVersion` on anything older, where the sidebar vibrancy
/// material is the closest equivalent. Neither failure is worth aborting over —
/// the CSS glass still reads as translucency without a native layer behind it.
#[cfg(target_os = "macos")]
fn apply_window_material(window: &tauri::WebviewWindow) {
    use window_vibrancy::{LiquidGlassOptions, NSGlassEffectViewStyle, NSVisualEffectMaterial};

    let glass = window_vibrancy::apply_liquid_glass(
        window.clone(),
        LiquidGlassOptions::new(NSGlassEffectViewStyle::Regular),
    );

    if glass.is_err() {
        // Below macOS 26 there is no glass view to install, and the sidebar
        // material is the nearest thing the older API offers.
        let _ = window_vibrancy::apply_vibrancy(
            window.clone(),
            NSVisualEffectMaterial::Sidebar,
            None,
            None,
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance is registered first: on macOS a Finder double-click while
    // Moda is already running would otherwise start a second process, and the
    // document would open in that one instead of the window the user is looking
    // at. The plugin hands the second launch's arguments to this callback, which
    // forwards them to the existing window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            open_files::deliver(app, open_files::paths_from_args(&argv));
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Paths that arrive before the frontend is listening wait here.
        .manage(PendingOpenFiles::default())
        .invoke_handler(tauri::generate_handler![
            file_ops::read_document,
            file_ops::save_document,
            file_ops::file_exists,
            directory::read_directory_tree,
            open_files::take_pending_open_files,
        ])
        .setup(|app| {
            // The native menu bar. Installed before anything else so the app has
            // its commands listed from the first moment the window appears.
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;

            // The glass sits behind the webview, so it has to be in place before
            // the window is ever painted, or the first frame flashes desktop.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                apply_window_material(&window);
            }

            // A document named on the command line — a cold launch from Finder,
            // or `moda note.md` — is queued and announced. The frontend drains
            // the queue on start-up, so no timing assumption is needed.
            let paths = open_files::paths_from_args(&std::env::args().collect::<Vec<_>>());
            open_files::deliver(app.handle(), paths);
            Ok(())
        })
        // Menu clicks are reported to the frontend, which runs the same code the
        // toolbar and the keyboard shortcuts use.
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .build(tauri::generate_context!())
        .expect("error while building moda")
        .run(|app, event| {
            // macOS delivers Finder double-clicks here, as `file://` URLs.
            if let tauri::RunEvent::Opened { urls } = event {
                open_files::deliver(app, open_files::paths_from_urls(&urls));
            }
        });
}
