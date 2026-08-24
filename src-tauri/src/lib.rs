mod db;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager, State, WebviewWindow};

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOP, SWP_FRAMECHANGED,
    SWP_NOMOVE, SWP_NOSIZE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
};

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
/// dev：resource_dir() 指向 target/debug，实时皮肤源码在 项目根/public/skin。
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

/// 取主窗口的 Win32 HWND。
fn main_hwnd(window: &WebviewWindow) -> Result<HWND, String> {
    let handle = window
        .window_handle()
        .map_err(|e| format!("无法获取窗口句柄: {e}"))?;
    match handle.as_raw() {
        RawWindowHandle::Win32(w) => Ok(HWND(w.hwnd.get() as *mut std::ffi::c_void)),
        _ => Err("当前平台不支持穿透（仅 Windows）".into()),
    }
}

/// 直接操作窗口扩展样式实现「完全穿透」：
/// - WS_EX_TRANSPARENT：点击命中测试穿透到下方窗口（挂件后方的内容可交互）。
/// - WS_EX_NOACTIVATE：点击不激活本窗口，焦点不会切到应用。
/// - WS_EX_LAYERED：分层窗口，使 WS_EX_TRANSPARENT 的命中穿透稳定生效。
/// 切换后通过 SetWindowPos(SWP_FRAMECHANGED) 强制系统重算样式，立即应用/移除穿透位。
fn apply_transparent(hwnd: HWND, transparent: bool) -> Result<(), String> {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let bits = (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_LAYERED).0 as isize;
        let new_ex = if transparent {
            ex | bits
        } else {
            ex & !bits
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);
        // 强制窗口重绘样式，让系统立即应用/移除穿透位。
        SetWindowPos(
            hwnd,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
        )
        .map_err(|e| format!("SetWindowPos 失败: {e}"))?;
    }
    Ok(())
}

/// 禁用/恢复窗口输入：禁用时窗口连同其 webview 子窗口不接收任何鼠标/键盘，
/// 也不成为激活窗口，点击直接落到 z-order 下方——窗口只保留视觉效果。
unsafe fn set_input_enabled(hwnd: HWND, enabled: bool) {
    let _ = EnableWindow(hwnd, enabled);
}

/// 穿透状态：作为托管状态在命令间共享，是穿透模式的唯一真相源。
/// 托盘菜单与挂件右键菜单都经由同一个切换入口。
pub struct PassthroughState {
    on: AtomicBool,
}

impl PassthroughState {
    pub fn new() -> Self {
        Self {
            on: AtomicBool::new(false),
        }
    }
}

/// 切换穿透模式：更新状态 -> 执行 Win32 样式切换 -> 广播新状态给前端同步显示
/// -> 同步系统托盘勾选。托盘菜单与挂件右键菜单统一走这里。
fn do_toggle_passthrough(
    app: &AppHandle,
    window: &WebviewWindow,
    tray_item: &Option<CheckMenuItem<tauri::Wry>>,
) -> Result<(), String> {
    // 取主窗口 HWND；拿不到（如窗口未就绪）则只翻转状态，不操作样式。
    let hwnd = match main_hwnd(window) {
        Ok(h) => Some(h),
        Err(e) => {
            eprintln!("[passthrough] 取 HWND 失败，仅切换状态: {e}");
            None
        }
    };
    let new_on = match &hwnd {
        Some(h) => {
            let next = !PassthroughState::read_current(app);
            apply_transparent(*h, next)?;
            // 穿透时窗口连同 webview 子窗口不接收点击、也不抢焦点。
            unsafe { set_input_enabled(*h, !next) };
            next
        }
        None => !PassthroughState::read_current(app),
    };
    PassthroughState::write_current(app, new_on);
    // 广播给前端用于同步显示（FloatingWidget 的 passthrough 标记、proximity 早退等）。
    let _ = app.emit("passthrough-state", new_on);
    // 同步系统托盘勾选。
    if let Some(item) = tray_item {
        let _ = item.set_checked(new_on);
    }
    Ok(())
}

impl PassthroughState {
    fn read_current(app: &AppHandle) -> bool {
        app.state::<Mutex<PassthroughState>>()
            .inner()
            .lock()
            .map(|s| s.on.load(Ordering::SeqCst))
            .unwrap_or(false)
    }
    fn write_current(app: &AppHandle, on: bool) {
        if let Ok(s) = app.state::<Mutex<PassthroughState>>().inner().lock() {
            s.on.store(on, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
fn toggle_passthrough(
    app: AppHandle,
    window: WebviewWindow,
    tray_ref: State<'_, TrayPassthroughRef>,
) -> Result<(), String> {
    // 穿透状态与样式切换完全在 Rust 完成；托盘勾选项由托管引用同步。
    let item = tray_ref.inner().0.lock().ok().and_then(|g| g.clone());
    do_toggle_passthrough(&app, &window, &item)
}

/// 把托盘穿透菜单项的引用托管起来，供切换命令同步勾选。
pub struct TrayPassthroughRef(pub Mutex<Option<CheckMenuItem<tauri::Wry>>>);

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(MouseWatcher::new());
            // 穿透状态服务：穿透模式的唯一真相源，由 Rust 维护并执行 Win32 样式切换。
            app.manage(Mutex::new(PassthroughState::new()));
            // 托盘穿透菜单项引用，供切换命令同步勾选显示。
            app.manage(TrayPassthroughRef(Mutex::new(None)));
            // Create the schema up front; fail loudly if storage is unavailable.
            db::init_db(app);

            // 系统托盘：右键菜单显示 / 隐藏挂件 / 切换穿透模式（带勾选）/ 退出。
            let show_item = MenuItem::with_id(app, "show", "显示挂件", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "隐藏挂件", true, None::<&str>)?;
            let toggle_pt_item =
                CheckMenuItem::with_id(app, "toggle_passthrough", "切换穿透模式", true, false, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            // 启动即非穿透，确保窗口正常可交互。
            let _ = toggle_pt_item.set_checked(false);
            // 把托盘穿透项引用托管，供 toggle_passthrough command 同步勾选。
            if let Ok(mut r) = app.state::<TrayPassthroughRef>().inner().0.lock() {
                *r = Some(toggle_pt_item.clone());
            }
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &toggle_pt_item, &quit_item])?;
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("浮窗便签")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        let _ = app.emit("show-widget", ());
                    }
                    "hide" => {
                        let _ = app.emit("hide-widget", ());
                    }
                    "toggle_passthrough" => {
                        // 直接执行切换（穿透逻辑在 Rust，托盘与右键统一走此入口）。
                        // 取主窗口用于 Win32 样式操作；缺省穿透项由托管引用提供。
                        let win = app.get_webview_window("main");
                        let item = app
                            .state::<TrayPassthroughRef>()
                            .inner()
                            .0
                            .lock()
                            .ok()
                            .and_then(|g| g.clone());
                        if let Some(w) = win {
                            if let Err(e) = do_toggle_passthrough(app, &w, &item) {
                                eprintln!("[passthrough] 切换失败: {e}");
                            }
                        } else {
                            // 窗口未就绪：仅翻转状态并广播，待窗口就绪后样式由后续切换补全。
                            let next = !PassthroughState::read_current(app);
                            PassthroughState::write_current(app, next);
                            let _ = app.emit("passthrough-state", next);
                            if let Some(i) = item {
                                let _ = i.set_checked(next);
                            }
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // 挂件右键菜单的穿透切换：前端 emit 此事件，由 Rust 统一执行切换。
            let app_handle = app.handle().clone();
            app.listen("request-toggle-passthrough", move |_| {
                let app = app_handle.clone();
                let win = app.get_webview_window("main");
                let item = app
                    .state::<TrayPassthroughRef>()
                    .inner()
                    .0
                    .lock()
                    .ok()
                    .and_then(|g| g.clone());
                if let Some(w) = win {
                    if let Err(e) = do_toggle_passthrough(&app, &w, &item) {
                        eprintln!("[passthrough] 切换失败: {e}");
                    }
                } else {
                    let next = !PassthroughState::read_current(&app);
                    PassthroughState::write_current(&app, next);
                    let _ = app.emit("passthrough-state", next);
                    if let Some(i) = item {
                        let _ = i.set_checked(next);
                    }
                }
            });

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
            toggle_passthrough,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
