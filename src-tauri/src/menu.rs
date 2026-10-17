//! The native macOS menu bar.
//!
//! Replaces Tauri's default menu with the standard macOS set — App, File, Edit,
//! View, Window — so the app's commands are discoverable without reading the
//! README. This is the platform's idiom: a Mac user looks in the menu bar for
//! what an app can do, and a shortcut that is not listed there may as well not
//! exist.
//!
//! Items that act on the document do not do the work here. They carry an id,
//! [`handle_event`] maps that id to a [`MenuCommand`], and the frontend runs the
//! same code path its toolbar buttons and key bindings use. One implementation of
//! "save" cannot drift from another that way.
//!
//! Cut/copy/paste, undo/redo and the window controls are Tauri's predefined
//! items, so they use the platform's own implementations and behave exactly as
//! they do in any other Mac app.

use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Emitted when a menu item the frontend owns is chosen.
pub const MENU_EVENT: &str = "moda://menu";

/// The command a menu item asks for.
///
/// A closed set rather than a free string: a typo becomes a compile error on
/// this side instead of a silently dead menu item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MenuCommand {
    NewDocument,
    OpenDocument,
    OpenFolder,
    SaveDocument,
    SaveAs,
    RefreshTree,
    ToggleSource,
    ToggleSidebar,
    ShowOutline,
    InsertLink,
    Find,
    FindNext,
    FindPrevious,
    About,
    CheckForUpdates,
}

/// The payload of [`MENU_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct MenuPayload {
    pub command: MenuCommand,
}

/// Every document command, with the menu id it is reached by and the accelerator
/// it advertises.
///
/// One table drives both the menu construction and the id-to-command lookup, so
/// the two cannot disagree. `None` for the accelerator means the item has none —
/// a menu entry is still useful as a reminder that the feature exists.
const COMMANDS: [(&str, &str, Option<&str>, MenuCommand); 13] = [
    ("new-document", "新建", Some("CmdOrCtrl+N"), MenuCommand::NewDocument),
    ("open-document", "打开…", Some("CmdOrCtrl+O"), MenuCommand::OpenDocument),
    (
        "open-folder",
        "打开文件夹…",
        Some("CmdOrCtrl+Shift+O"),
        MenuCommand::OpenFolder,
    ),
    ("save-document", "保存", Some("CmdOrCtrl+S"), MenuCommand::SaveDocument),
    ("save-as", "另存为…", Some("CmdOrCtrl+Shift+S"), MenuCommand::SaveAs),
    ("refresh-tree", "刷新文件树", Some("CmdOrCtrl+R"), MenuCommand::RefreshTree),
    (
        "insert-link",
        "插入链接…",
        Some("CmdOrCtrl+K"),
        MenuCommand::InsertLink,
    ),
    ("find", "查找…", Some("CmdOrCtrl+F"), MenuCommand::Find),
    ("find-next", "查找下一个", Some("CmdOrCtrl+G"), MenuCommand::FindNext),
    (
        "find-previous",
        "查找上一个",
        Some("CmdOrCtrl+Shift+G"),
        MenuCommand::FindPrevious,
    ),
    (
        "toggle-source",
        "源码 / 所见即所得",
        Some("CmdOrCtrl+/"),
        MenuCommand::ToggleSource,
    ),
    (
        "toggle-sidebar",
        "显示侧边栏",
        Some("CmdOrCtrl+Shift+E"),
        MenuCommand::ToggleSidebar,
    ),
    (
        "show-outline",
        "显示大纲",
        Some("CmdOrCtrl+Shift+U"),
        MenuCommand::ShowOutline,
    ),
];

/// The command a menu id stands for.
///
/// Returns `None` for the ids Tauri owns (the predefined items handle their own
/// behaviour), which is why an unrecognized id is not an error.
pub fn command_for_id(id: &str) -> Option<MenuCommand> {
    if id == "about-moda" {
        return Some(MenuCommand::About);
    }
    if id == "check-for-updates" {
        return Some(MenuCommand::CheckForUpdates);
    }
    COMMANDS
        .iter()
        .find(|(menu_id, ..)| *menu_id == id)
        .map(|(_, _, _, command)| *command)
}

/// Report a chosen menu item to the frontend.
///
/// Wire this to `App::on_menu_event`. Ids Tauri owns are ignored.
pub fn handle_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(command) = command_for_id(id) else {
        return;
    };
    // A failed emit means there is no window left to receive it; the user will
    // see that without a log line.
    let _ = app.emit(MENU_EVENT, MenuPayload { command });
}

/// About shows the version from `tauri.conf.json` — the one releases bump and
/// the updater compares against — not `Cargo.toml`'s, which nothing checks.
fn about_metadata(version: &str) -> AboutMetadata {
    AboutMetadata {
        name: Some("Moda".to_string()),
        version: Some(version.to_string()),
        comments: Some("所见即所得的 Markdown 编辑器".to_string()),
        ..Default::default()
    }
}

/// Build the application menu.
///
/// `SubmenuBuilder` is used for each menu rather than `MenuBuilder`, because a
/// submenu is what a menu bar is made of — `MenuBuilder::build` returns a
/// `Menu<R>`, which cannot be inserted into another menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // "检查更新…" sits under About, where a Mac user looks for it. It is the only
    // way Moda ever contacts the update server: there is no check on launch.
    let check_for_updates =
        MenuItemBuilder::with_id("check-for-updates", "检查更新…").build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Moda")
        .about(Some(about_metadata(&app.package_info().version.to_string())))
        .item(&check_for_updates)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(&item(app, "new-document")?)
        .item(&item(app, "open-document")?)
        .item(&item(app, "open-folder")?)
        .separator()
        .item(&item(app, "save-document")?)
        .item(&item(app, "save-as")?)
        .separator()
        .item(&item(app, "refresh-tree")?)
        .separator()
        .close_window()
        .build()?;

    // Undo/cut/copy/paste are predefined, so they use the platform's own
    // implementations rather than a reimplementation that would differ subtly.
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item(app, "insert-link")?)
        .separator()
        .item(&item(app, "find")?)
        .item(&item(app, "find-next")?)
        .item(&item(app, "find-previous")?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "视图")
        .item(&item(app, "toggle-source")?)
        .item(&item(app, "toggle-sidebar")?)
        .item(&item(app, "show-outline")?)
        .separator()
        .fullscreen()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "窗口")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}

/// Build one document menu item from the [`COMMANDS`] table.
fn item<R: Runtime>(
    app: &AppHandle<R>,
    menu_id: &str,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let (_, text, accelerator, _) = COMMANDS
        .iter()
        .find(|(id, ..)| *id == menu_id)
        .expect("every menu item id is in COMMANDS");

    let mut builder = MenuItemBuilder::with_id(menu_id, *text);
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(*accelerator);
    }
    builder.build(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_shows_the_version_it_is_given() {
        let about = about_metadata("9.8.7");
        assert_eq!(about.version.as_deref(), Some("9.8.7"));
        assert_eq!(about.name.as_deref(), Some("Moda"));
    }

    #[test]
    fn every_command_id_maps_back_to_its_command() {
        for (menu_id, _, _, command) in COMMANDS {
            assert_eq!(
                command_for_id(menu_id),
                Some(command),
                "{menu_id} did not map back to its command"
            );
        }
    }

    #[test]
    fn unknown_and_predefined_ids_are_ignored() {
        // Tauri's own items carry ids too; they must not be mistaken for ours.
        for id in ["quit", "copy", "paste", "minimize", "not-a-real-item"] {
            assert_eq!(command_for_id(id), None, "{id} should not be handled");
        }
    }

    #[test]
    fn menu_ids_are_unique() {
        // Two items sharing an id would make one of them unhandleable.
        let mut ids: Vec<&str> = COMMANDS.iter().map(|(id, ..)| *id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "duplicate menu id in COMMANDS");
    }

    #[test]
    fn check_for_updates_has_its_own_id() {
        // It lives in the app menu rather than in COMMANDS' document menus, so
        // it is mapped separately — and must still be found.
        assert_eq!(
            command_for_id("check-for-updates"),
            Some(MenuCommand::CheckForUpdates)
        );
    }

    #[test]
    fn commands_serialize_to_the_names_the_frontend_switches_on() {
        let cases = [
            (MenuCommand::NewDocument, "new-document"),
            (MenuCommand::OpenDocument, "open-document"),
            (MenuCommand::OpenFolder, "open-folder"),
            (MenuCommand::SaveDocument, "save-document"),
            (MenuCommand::SaveAs, "save-as"),
            (MenuCommand::RefreshTree, "refresh-tree"),
            (MenuCommand::ToggleSource, "toggle-source"),
            (MenuCommand::ToggleSidebar, "toggle-sidebar"),
            (MenuCommand::ShowOutline, "show-outline"),
            (MenuCommand::InsertLink, "insert-link"),
            (MenuCommand::Find, "find"),
            (MenuCommand::FindNext, "find-next"),
            (MenuCommand::FindPrevious, "find-previous"),
            (MenuCommand::About, "about"),
            (MenuCommand::CheckForUpdates, "check-for-updates"),
        ];
        for (command, expected) in cases {
            let json = serde_json::to_value(MenuPayload { command }).expect("serialize");
            assert_eq!(json["command"], expected);
        }
    }
}
