mod db;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOP, SWP_FRAMECHANGED,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TRANSPARENT,
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
                    // 解锁锁的 hover 检测同样跑在 Rust 的轮询里：
                    // 穿透时主窗口被 EnableWindow(FALSE) 禁用，其 webview 内的
                    // JS 不保证继续推进，因此不能依赖前端来判断鼠标是否靠近。
                    update_lock_hover(&app, x, y);
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

/// 读取窗口在屏幕上的矩形（物理像素）。GetCursorPos 同为物理像素，两者可直接比较。
#[cfg(target_os = "windows")]
fn window_rect(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    let mut r = RECT::default();
    unsafe {
        if windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut r).is_ok() {
            Some((r.left, r.top, r.right, r.bottom))
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn window_rect(_hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
    None
}

fn point_in_rect(x: i32, y: i32, r: (i32, i32, i32, i32)) -> bool {
    x >= r.0 && x <= r.2 && y >= r.1 && y <= r.3
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

// ---- 穿透解锁锁窗口 ----
// 主窗口穿透时对 OS 整体穿透，内部任何 DOM 都收不到鼠标事件，
// 因此「点击解锁」必须由一个自身不穿透的独立小窗口承载。

/// 锁窗口边长（逻辑像素），与前端 CSS 的 .lock-btn 尺寸一致。
const LOCK_SIZE: f64 = 40.0;
/// 锁与挂件的间距（物理像素）。
const LOCK_GAP_PX: i32 = 6;

/// 解锁锁的运行时状态：显示中标记、离开热区的时刻、自动收起延时。
pub struct LockState {
    visible: bool,
    /// 鼠标离开热区的时刻；在热区内为 None。
    left_at: Option<Instant>,
    /// 鼠标离开多久后收起（毫秒），与前端的 autoCloseDelay 保持同步。
    hide_delay_ms: u64,
}

impl LockState {
    pub fn new() -> Self {
        Self {
            visible: false,
            left_at: None,
            hide_delay_ms: 600,
        }
    }
}

/// 同步锁的自动收起延时（前端「自动收起延时」改动时调用）。
#[tauri::command]
fn set_lock_hide_delay(app: AppHandle, delay_ms: u64) {
    if let Ok(mut s) = app.state::<Mutex<LockState>>().inner().lock() {
        s.hide_delay_ms = delay_ms;
    }
}

/// 取主窗口的屏幕矩形（物理像素）。
fn main_window_rect(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    let win = app.get_webview_window("main")?;
    let hwnd = main_hwnd(&win).ok()?;
    window_rect(hwnd)
}

/// 按挂件位置算出锁窗口的矩形与左上角（物理像素）：
/// 挂件贴左边缘时锁在其右侧，否则在其左侧，垂直居中。
fn lock_rect_for(widget: (i32, i32, i32, i32)) -> ((i32, i32, i32, i32), (i32, i32)) {
    let (left, top, right, bottom) = widget;
    let h = bottom - top;
    let size = LOCK_SIZE.round() as i32;
    // 挂件贴紧屏幕左边缘（left 接近 0）即视为靠左停靠。
    let x = if left <= 2 {
        right + LOCK_GAP_PX
    } else {
        left - LOCK_GAP_PX - size
    };
    let y = top + (h - size) / 2;
    ((x, y, x + size, y + size), (x, y))
}

/// 穿透态下的锁 hover 检测：完全在 Rust 完成，不依赖前端事件。
fn update_lock_hover(app: &AppHandle, x: i32, y: i32) {
    // 仅穿透态启用。
    if !PassthroughState::read_current(app) {
        return;
    }
    let Some(widget) = main_window_rect(app) else {
        return;
    };
    let (lock_rect, (lock_x, lock_y)) = lock_rect_for(widget);
    let inside = point_in_rect(x, y, widget) || point_in_rect(x, y, lock_rect);

    let Ok(mut s) = app.state::<Mutex<LockState>>().inner().lock() else {
        return;
    };
    if inside {
        s.left_at = None;
        if !s.visible {
            s.visible = true;
            drop(s); // 释放锁后再操作窗口，避免窗口回调重入时死锁。
            if let Err(e) = show_lock_at(app, lock_x, lock_y) {
                eprintln!("[lock] 显示失败: {e}");
            }
        }
    } else if s.visible {
        match s.left_at {
            None => s.left_at = Some(Instant::now()),
            Some(t) => {
                if t.elapsed() >= Duration::from_millis(s.hide_delay_ms) {
                    s.visible = false;
                    s.left_at = None;
                    drop(s);
                    if let Err(e) = hide_lock_now(app) {
                        eprintln!("[lock] 隐藏失败: {e}");
                    }
                }
            }
        }
    }
}

/// 显示锁窗口（内部实现，供状态机与命令共用）。
fn show_lock_at(app: &AppHandle, x: i32, y: i32) -> Result<(), String> {
    let lock = ensure_lock_window(app)?;
    lock.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| format!("定位锁窗口失败: {e}"))?;
    lock.show().map_err(|e| format!("显示锁窗口失败: {e}"))?;
    Ok(())
}

/// 隐藏锁窗口（内部实现，窗口未创建时静默跳过）。
fn hide_lock_now(app: &AppHandle) -> Result<(), String> {
    if let Some(lock) = app.get_webview_window("widget-lock") {
        lock.hide().map_err(|e| format!("隐藏锁窗口失败: {e}"))?;
    }
    Ok(())
}

/// 创建（或复用）锁窗口。常驻隐藏，显示时由 Rust 定位后 show。
fn ensure_lock_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window("widget-lock") {
        return Ok(existing);
    }
    let lock = WebviewWindowBuilder::new(
        app,
        "widget-lock",
        WebviewUrl::App("index.html".into()),
    )
    .title("浮笺 · 解锁穿透")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .always_on_top(true)
    .inner_size(LOCK_SIZE, LOCK_SIZE)
    .build()
    .map_err(|e| format!("创建锁窗口失败: {e}"))?;
    // 点击不激活（焦点不离开当前应用）+ 不出现在 Alt-Tab 列表。
    if let Ok(hwnd) = main_hwnd(&lock) {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let bits = (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW).0 as isize;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | bits);
            let _ = SetWindowPos(
                hwnd,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    }
    Ok(lock)
}

/// 在指定物理坐标显示锁窗口（供状态机内部调用，也保留为命令便于排查）。
#[tauri::command]
fn show_lock_window(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    show_lock_at(&app, x, y)
}

/// 隐藏锁窗口（窗口未创建时静默跳过）。
#[tauri::command]
fn hide_lock_window(app: AppHandle) -> Result<(), String> {
    hide_lock_now(&app)
}

/// 退出前留给前端把防抖编辑落库的时间（毫秒）。
/// 文本与待办的编辑是防抖写入，直接退出会丢掉最后一次输入；这里先广播 `before-quit`
/// 让前端立即 flush，再用固定延时兜底退出——穿透态下主窗口被 `EnableWindow(FALSE)`
/// 禁用、其 webview 内的 JS 不保证推进，因此不能依赖前端的响应来决定是否退出。
const QUIT_FLUSH_MS: u64 = 250;

/// 退出应用。托盘菜单与挂件右键菜单必须共用这一入口——若前端自行 close()
/// 主窗口，既与托盘的退出行为不一致，又依赖前端权限，容易出现「右键退出无效」。
fn do_quit_app(app: &AppHandle) {
    let _ = app.emit("before-quit", ());
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(QUIT_FLUSH_MS));
        app.exit(0);
    });
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    do_quit_app(&app);
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
///
/// 注意：目标窗口一律按 label "main" 取，绝不用命令注入的调用方窗口——
/// 注入的 WebviewWindow 是「发起 invoke 的窗口」，穿透解锁锁若在锁窗口里调用，
/// 样式会打在锁自己身上，主窗口的穿透位永远不被清除（表现为解锁后仍点击穿透）。
fn do_toggle_passthrough(
    app: &AppHandle,
    tray_item: &Option<CheckMenuItem<tauri::Wry>>,
) -> Result<(), String> {
    // 取主窗口 HWND；窗口未就绪或取句柄失败时只翻转状态，不操作样式。
    let main_window = app.get_webview_window("main");
    let hwnd = match &main_window {
        Some(w) => match main_hwnd(w) {
            Ok(h) => Some(h),
            Err(e) => {
                eprintln!("[passthrough] 取 HWND 失败，仅切换状态: {e}");
                None
            }
        },
        None => None,
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
    // 关闭穿透时锁必然要收起，由 Rust 统一兜底，不依赖前端热区状态。
    if !new_on {
        let _ = hide_lock_now(app);
        if let Ok(mut s) = app.state::<Mutex<LockState>>().inner().lock() {
            s.visible = false;
            s.left_at = None;
        }
    }
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
    tray_ref: State<'_, TrayPassthroughRef>,
) -> Result<(), String> {
    // 穿透状态与样式切换完全在 Rust 完成；托盘勾选项由托管引用同步。
    // 不接收调用方窗口：目标恒为 main，见 do_toggle_passthrough 的说明。
    let item = tray_ref.inner().0.lock().ok().and_then(|g| g.clone());
    do_toggle_passthrough(&app, &item)
}

/// 把托盘穿透菜单项的引用托管起来，供切换命令同步勾选。
pub struct TrayPassthroughRef(pub Mutex<Option<CheckMenuItem<tauri::Wry>>>);

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(MouseWatcher::new());
            // 穿透状态服务：穿透模式的唯一真相源，由 Rust 维护并执行 Win32 样式切换。
            app.manage(Mutex::new(PassthroughState::new()));
            // 解锁锁的运行时状态（hover 检测与自动收起延时）。
            app.manage(Mutex::new(LockState::new()));
            // 托盘穿透菜单项引用，供切换命令同步勾选显示。
            app.manage(TrayPassthroughRef(Mutex::new(None)));
            // Create the schema up front; fail loudly if storage is unavailable.
            db::init_db(app);

            // 预创建锁窗口（隐藏常驻），首次 hover 出现时无需等待 webview 加载。
            if let Err(e) = ensure_lock_window(app.handle()) {
                eprintln!("[lock] 预创建锁窗口失败: {e}");
            }

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
                        // 直接执行切换（穿透逻辑在 Rust，托盘、挂件右键、解锁锁统一走此入口）。
                        let item = app
                            .state::<TrayPassthroughRef>()
                            .inner()
                            .0
                            .lock()
                            .ok()
                            .and_then(|g| g.clone());
                        if let Err(e) = do_toggle_passthrough(app, &item) {
                            eprintln!("[passthrough] 切换失败: {e}");
                        }
                    }
                    "quit" => {
                        do_quit_app(app);
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
            toggle_passthrough,
            show_lock_window,
            hide_lock_window,
            set_lock_hide_delay,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
