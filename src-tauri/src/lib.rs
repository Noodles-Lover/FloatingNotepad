mod db;

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

/// Event payload broadcast on every cursor poll.
#[derive(Clone, Serialize)]
pub struct CursorMove {
    pub x: i32,
    pub y: i32,
}

/// Background service that polls the OS cursor and broadcasts its position.
/// Encapsulated as a managed state so commands share a single instance.
pub struct MouseWatcher {
    running: AtomicBool,
}

impl MouseWatcher {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
        }
    }

    /// Spawn the polling loop. Idempotent — a second call is a no-op.
    pub fn start(&self, app: AppHandle) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        thread::spawn(move || {
            loop {
                if let Some((x, y)) = current_cursor() {
                    let _ = app.emit("cursor-move", CursorMove { x, y });
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
    }
}

#[cfg(target_os = "windows")]
fn current_cursor() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut pt).is_ok() {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn current_cursor() -> Option<(i32, i32)> {
    None
}

// ---- Commands: thin adapters over the services above ----
// NOTE: Tauri v2 registers the command under the Rust function name
// (snake_case) by default. The frontend `invoke` and the `commands.allow`
// entries in permissions/*.toml must use the same snake_case name.

#[tauri::command]
fn start_mouse_watch(app: AppHandle, watcher: State<MouseWatcher>) {
    watcher.start(app);
}

#[tauri::command]
fn load_tabs() -> Result<db::PersistState, String> {
    Ok(db::load_state())
}

#[tauri::command]
fn save_tabs(tabs: Vec<db::TabInput>) -> Result<(), String> {
    db::save_tabs(tabs);
    Ok(())
}

#[tauri::command]
fn set_active_tab(tab_id: i64) -> Result<(), String> {
    db::set_active_tab(tab_id);
    Ok(())
}

#[tauri::command]
fn load_categories() -> Result<db::CategoryState, String> {
    Ok(db::load_categories())
}

#[tauri::command]
fn save_categories(categories: Vec<db::CategoryInput>) -> Result<(), String> {
    db::save_categories(categories);
    Ok(())
}

#[tauri::command]
fn set_active_category(category_id: i64) -> Result<(), String> {
    db::set_active_category(category_id);
    Ok(())
}

/// 列出 skin/ 下的所有材质包（文件夹名即材质名）。
/// dev：resource_dir() 指向 target/debug，实时皮肤源码在 项目根/public/skin；
///   target/debug/skin 是旧构建残留的过时拷贝，故不再优先用。
/// prod：resource_dir() 指向打包的 resources，皮肤在 resources/skin。
/// 由于 dev 下 resource_dir 的具体层级随版本变化，这里枚举多个候选路径，
/// 取第一个真实存在的目录，避免拼错路径导致读不到任何皮肤。
#[tauri::command]
fn list_skins(app: AppHandle) -> Result<Vec<String>, String> {
    let base = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    let candidates = [
        base.join("../public/skin"),   // resource_dir = src-tauri
        base.join("../../public/skin"), // resource_dir = target/debug
        base.join("skin"),             // prod 打包目录
    ];
    let dir = candidates
        .into_iter()
        .find(|p| p.is_dir())
        .unwrap_or_else(|| base.join("skin"));

    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    if let Some(name) = entry.file_name().to_str() {
                        // 跳过以 '.' 开头的隐藏目录（如 .git）。
                        if !name.starts_with('.') {
                            names.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(MouseWatcher::new());
            // Create the schema up front; fail loudly if storage is unavailable.
            db::init_db(app);

            // 系统托盘：右键菜单显示 / 隐藏挂件。
            let show_item = MenuItem::with_id(app, "show", "显示挂件", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "隐藏挂件", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("浮窗便签")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        let _ = app.emit("show-widget", ());
                    }
                    "hide" => {
                        let _ = app.emit("hide-widget", ());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_mouse_watch,
            load_tabs,
            save_tabs,
            set_active_tab,
            load_categories,
            save_categories,
            set_active_category,
            list_skins,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
