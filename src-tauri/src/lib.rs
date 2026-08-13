mod db;

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde::Serialize;
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
fn load_note(repo: State<db::NoteRepository>) -> Result<Option<db::Note>, String> {
    repo.load().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_note(repo: State<db::NoteRepository>, note: db::Note) -> Result<db::Note, String> {
    repo.save(note).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(db::NoteRepository::new(app.handle().clone()));
            app.manage(MouseWatcher::new());
            // Create the schema up front; fail loudly if storage is unavailable.
            app.state::<db::NoteRepository>()
                .init()
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_mouse_watch,
            load_note,
            save_note,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
