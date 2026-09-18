mod chime;
mod log;
mod notify;
mod popup;
mod shortcut;
mod plans;
mod db;
mod foreground;
mod tracker;
mod usage;

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
use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, IsWindowVisible, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWL_EXSTYLE, HWND_TOP, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, SW_HIDE,
    SW_SHOWNA, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
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

/// 光标广播的关注范围：离挂件/面板所在窗口这么近的移动才值得唤醒前端。
/// 前端自己会按精确碰撞箱判定，这里只是别把屏幕另一头的移动也发过去。
const CURSOR_MARGIN_PX: i32 = 48;

/// 光标广播的门槛。
///
/// 前端只用这个坐标判断「鼠标是否靠近挂件/面板」，所以只有几件事值得跨进程发一次：
/// 状态刚变成需要关心（穿透关闭、窗口重新显示）、刚进入关注范围、范围内坐标变了；
/// 离开范围时补发一次，前端才知道该开始收起计时。
struct CursorEmit {
    /// 上一次广播的坐标（物理像素）。坐标没变就没有新信息。
    last: Mutex<Option<(i32, i32)>>,
    /// 上一拍是否在关注范围内（用于补发「离开」）。
    near: AtomicBool,
    /// 上一拍是否处于需要前端关心的状态：窗口可见且未穿透。
    interested: AtomicBool,
}

impl CursorEmit {
    fn new() -> Self {
        Self {
            last: Mutex::new(None),
            near: AtomicBool::new(false),
            interested: AtomicBool::new(false),
        }
    }

    /// 这一拍的坐标要不要广播给前端。
    fn should_emit(&self, app: &AppHandle, x: i32, y: i32) -> bool {
        let interested = main_window_visible(app) && !PassthroughState::read_current(app);
        if self.interested.swap(interested, Ordering::SeqCst) != interested {
            // 状态翻转：坐标可能没动，但前端需要重新判一次——清掉记忆，强制发一次。
            if let Ok(mut last) = self.last.lock() {
                *last = None;
            }
        }
        if !interested {
            self.near.store(false, Ordering::SeqCst);
            return false;
        }

        let near = main_window_rect(app).is_some_and(|(left, top, right, bottom)| {
            point_in_rect(
                x,
                y,
                (
                    left - CURSOR_MARGIN_PX,
                    top - CURSOR_MARGIN_PX,
                    right + CURSOR_MARGIN_PX,
                    bottom + CURSOR_MARGIN_PX,
                ),
            )
        });
        let was_near = self.near.swap(near, Ordering::SeqCst);
        if !near {
            // 已经在外：只在刚离开的那一拍补一次（前端据此开始收起计时），之后不再打扰。
            return was_near;
        }
        if !was_near {
            return true; // 刚进入：立刻发一次
        }

        let Ok(mut last) = self.last.lock() else {
            return false;
        };
        let changed = *last != Some((x, y));
        *last = Some((x, y));
        changed
    }
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
            // 采样频率固定：锁窗口的 hover 判定依赖它，前端的弹出判定也靠这个时间分辨率。
            // 广播出去的次数则按需过滤，见 CursorEmit。
            let emit = CursorEmit::new();
            loop {
                if let Some((x, y)) = current_cursor() {
                    // 解锁锁的 hover 检测同样跑在 Rust 的轮询里：
                    // 穿透时主窗口被 EnableWindow(FALSE) 禁用，其 webview 内的
                    // JS 不保证继续推进，因此不能依赖前端来判断鼠标是否靠近。
                    update_lock_hover(&app, x, y);
                    if emit.should_emit(&app, x, y) {
                        let _ = app.emit("cursor-move", CursorMove { x, y });
                    }
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

// ---- 数据库命令的线程约束 ----
// 写入（save_* / set_active_*）保持同步：它们是「全量替换」语义，并发完成时
// 若顺序颠倒，后跑完的旧快照会把新内容盖掉——同步执行天然按到达顺序排队。
// 读取没有这个约束，改成 async 由 Tauri 放到线程池执行，避免慢查询卡住主线程。

#[tauri::command]
async fn load_tabs() -> Result<db::PersistState, String> {
    Ok(db::load_state())
}

#[tauri::command]
async fn load_categories() -> Result<db::CategoryState, String> {
    Ok(db::load_categories())
}

#[tauri::command]
async fn load_usage() -> Result<db::UsageDay, String> {
    Ok(db::load_usage(&usage::today()))
}

/// 取全部历史的应用总时长（面板的「全部」视图，时间线始终只看当天）。
#[tauri::command]
async fn load_usage_all() -> Result<db::UsageTotals, String> {
    Ok(db::load_usage_all())
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
fn save_categories(categories: Vec<db::CategoryInput>) -> Result<(), String> {
    db::save_categories(categories);
    Ok(())
}

#[tauri::command]
fn set_active_category(category_id: i64) -> Result<(), String> {
    db::set_active_category(category_id);
    Ok(())
}

/// 在文件管理器中打开数据目录，方便用户备份或迁移速记与待办。
/// 目录不存在时先创建——首次启动前点击也能打开到正确位置。
#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("无法打开文件管理器: {e}"))?;
    }
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

/// 锁窗口边长（逻辑像素）。比前端的 .lock-btn 略大一圈，
/// 给按钮的 hover 放大留出空间，免得放大时被窗口边界裁掉。
const LOCK_SIZE: f64 = 30.0;
/// 锁与挂件的间距（物理像素）。
const LOCK_GAP_PX: i32 = 4;

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

/// 主窗口当前是否可见（托盘「隐藏挂件」后为 false）。
fn main_window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| main_hwnd(&w).ok())
        .map(|h| unsafe { IsWindowVisible(h) }.as_bool())
        .unwrap_or(false)
}

/// 锁若处于显示中则收起，并清掉 hover 状态。
fn hide_lock_if_visible(app: &AppHandle) {
    let Ok(mut s) = app.state::<Mutex<LockState>>().inner().lock() else {
        return;
    };
    if !s.visible {
        return;
    }
    s.visible = false;
    s.left_at = None;
    drop(s); // 释放锁后再操作窗口，避免窗口回调重入时死锁。
    if let Err(e) = hide_lock_now(app) {
        eprintln!("[lock] 隐藏失败: {e}");
    }
}

/// 穿透态下的锁 hover 检测：完全在 Rust 完成，不依赖前端事件。
fn update_lock_hover(app: &AppHandle, x: i32, y: i32) {
    // 仅穿透态启用。非穿透态下若锁还挂着（例如穿透刚被关掉），顺手收起来，
    // 否则它会一直浮在屏幕上——这里以前是直接 return，锁就再也没有收起的机会。
    if !PassthroughState::read_current(app) {
        hide_lock_if_visible(app);
        return;
    }
    // 主窗口被托盘「隐藏挂件」时，矩形仍然算得出来，热区依旧成立，
    // 锁会孤零零地浮在屏幕上。主窗口不可见时一律收起。
    if !main_window_visible(app) {
        hide_lock_if_visible(app);
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
    // 不能用 WebviewWindow::show()：它走 SW_SHOW，会激活窗口、把焦点从全屏应用
    // 里抢走（游戏失焦，穿透也就名存实亡），同时还会让自己变成前台窗口。
    // SW_SHOWNA 只显示不激活，配合窗口上的 WS_EX_NOACTIVATE，
    // 前台仍是原来的应用——锁只负责可见与可点。
    let hwnd = main_hwnd(&lock)?;
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNA) };
    Ok(())
}

/// 隐藏锁窗口（内部实现，窗口未创建时静默跳过）。
///
/// 与显示一样直接发 Win32 消息：显示走的是 `SW_SHOWNA`（绕开 Tauri 的 show），
/// 这里对称地用 `SW_HIDE`，不依赖 Tauri 对窗口可见状态的记忆。
fn hide_lock_now(app: &AppHandle) -> Result<(), String> {
    if let Some(lock) = app.get_webview_window("widget-lock") {
        let hwnd = main_hwnd(&lock)?;
        let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
    }
    Ok(())
}

/// 把锁窗口的绘制与命中测试都裁到按钮那一小块。
///
/// Windows 会把小窗口撑到系统最小尺寸（实测 30×30 被撑成 136×38），
/// 多出来的部分虽然透明，却**照常参与命中测试**——等于在挂件旁边糊了一块看不见的
/// 挡板，穿透点击全被它吃掉。窗口区域同时裁剪绘制与用户交互，正好解掉这个问题。
fn apply_lock_region(lock: &WebviewWindow) -> Result<(), String> {
    let hwnd = main_hwnd(lock)?;
    let scale = lock.scale_factor().unwrap_or(1.0);
    let size = (LOCK_SIZE * scale).round().max(1.0) as i32;
    unsafe {
        // 圆角半径取边长 → 得到一个圆形区域，与锁按钮的圆形外观一致。
        let region = CreateRoundRectRgn(0, 0, size, size, size, size);
        if region.is_invalid() {
            return Err("创建锁窗口区域失败".into());
        }
        SetWindowRgn(hwnd, region, true);
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
        apply_lock_region(&lock)?;
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
    // 使用统计的结束时间是攒在内存里的（见 usage.rs 的落库间隔），退出前补一次，
    // 否则最后一段时长会随进程一起消失。
    usage::flush(app);
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

/// 把穿透模式设置为指定状态（而不是切换）。
///
/// 这是穿透的**唯一实现**：更新状态 -> 执行 Win32 样式切换 -> 广播新状态给前端
/// -> 同步系统托盘勾选。`do_toggle_passthrough`（用户切换）与全屏自动逻辑
/// （`tracker.rs`）都经由它，不存在第二条旁路。
///
/// 注意：目标窗口一律按 label "main" 取，绝不用命令注入的调用方窗口——
/// 注入的 WebviewWindow 是「发起 invoke 的窗口」，穿透解锁锁若在锁窗口里调用，
/// 样式会打在锁自己身上，主窗口的穿透位永远不被清除（表现为解锁后仍点击穿透）。
pub fn set_passthrough(app: &AppHandle, on: bool) -> Result<(), String> {
    // 取主窗口 HWND；窗口未就绪或取句柄失败时只写状态，不操作样式。
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
    if let Some(h) = hwnd {
        apply_transparent(h, on)?;
        // 穿透时窗口连同 webview 子窗口不接收点击、也不抢焦点。
        unsafe { set_input_enabled(h, !on) };
    }
    PassthroughState::write_current(app, on);
    // 广播给前端用于同步显示（FloatingWidget 的 passthrough 标记、proximity 早退等）。
    let _ = app.emit("passthrough-state", on);
    // 关闭穿透时锁必然要收起，由 Rust 统一兜底，不依赖前端热区状态。
    if !on {
        let _ = hide_lock_now(app);
        if let Ok(mut s) = app.state::<Mutex<LockState>>().inner().lock() {
            s.visible = false;
            s.left_at = None;
        }
    }
    // 同步系统托盘勾选。
    if let Some(item) = tray_item_for_state(app) {
        let _ = item.set_checked(on);
    }
    Ok(())
}

/// 从托管引用取托盘穿透菜单项（命令与内部逻辑共用）。
fn tray_item_for_state(app: &AppHandle) -> Option<CheckMenuItem<tauri::Wry>> {
    app.state::<TrayPassthroughRef>()
        .inner()
        .0
        .lock()
        .ok()
        .and_then(|g| g.clone())
}

/// 切换穿透模式：翻转后交由 set_passthrough 统一执行。托盘菜单与挂件右键菜单统一走这里。
fn do_toggle_passthrough(app: &AppHandle) -> Result<(), String> {
    let next = !PassthroughState::read_current(app);
    set_passthrough(app, next)
}

impl PassthroughState {
    pub fn read_current(app: &AppHandle) -> bool {
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
fn toggle_passthrough(app: AppHandle) -> Result<(), String> {
    // 穿透状态与样式切换完全在 Rust 完成；托盘勾选项由托管引用同步。
    // 不接收调用方窗口：目标恒为 main，见 set_passthrough 的说明。
    do_toggle_passthrough(&app)
}

/// 同步「记录应用使用时间」开关（使用面板控制，前端在加载配置与改动时调用）。
#[tauri::command]
fn set_usage_tracking(app: AppHandle, enabled: bool) {
    app.state::<usage::UsageState>()
        .enabled
        .store(enabled, Ordering::SeqCst);
}

/// 同步「整点报时」开关与闲置透明度（功能面板控制）。
#[tauri::command]
fn set_chime(app: AppHandle, enabled: bool, opacity: f64) {
    chime::apply(&app, enabled, opacity);
}

/// 立刻弹一次报时小窗：等不到整点时用它验证外观与音效（挂件右键菜单调用）。
#[tauri::command]
fn ring_chime(app: AppHandle) -> Result<(), String> {
    chime::ring(&app)
}

/// 取弹窗当前应显示的内容（文本 + 副文本 + 不透明度）。
/// 小窗挂载时主动取一次，避免错过事件后空白或显示启动时刻。
#[tauri::command]
fn popup_state(app: AppHandle) -> popup::Payload {
    popup::current(&app)
}

/// 取全部日程（一次性与周常混在一起，排序交给前端——它要按日期/时刻展开周常）。
#[tauri::command]
fn load_plans() -> Vec<db::Plan> {
    db::load_plans()
}

/// 新增一条日程：`kind` 为 `once`（用 date）或 `weekly`（用 weekday）；time 可为空。
#[tauri::command]
fn add_plan(
    kind: String,
    date: Option<String>,
    weekday: Option<i64>,
    time: Option<String>,
    text: String,
) -> Result<db::Plan, String> {
    db::add_plan(&kind, date.as_deref(), weekday, time.as_deref(), &text)
}

#[tauri::command]
fn delete_plan(id: i64) -> Result<(), String> {
    db::delete_plan(id)
}

/// 同步「任务提醒」总开关（日程面板控制，作用于全部日程）。
#[tauri::command]
fn set_plan_notify(app: AppHandle, enabled: bool) {
    plans::apply(&app, enabled);
}

/// 立刻发一条测试提醒（挂件右键菜单）：不用等到点就能确认通知弹不弹得出来。
#[tauri::command]
fn test_notify(app: AppHandle) -> Result<(), String> {
    plans::test(&app)
}

/// 同步「全屏自动穿透」开关（设置面板控制，前端在加载配置与改动时调用）。
#[tauri::command]
fn set_fullscreen_passthrough(app: AppHandle, enabled: bool) {
    app.state::<tracker::FullscreenState>()
        .enabled
        .store(enabled, Ordering::SeqCst);
}

/// 把托盘穿透菜单项的引用托管起来，供切换命令同步勾选。
pub struct TrayPassthroughRef(pub Mutex<Option<CheckMenuItem<tauri::Wry>>>);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 任务提醒走系统通知：是否在全屏/游戏里打扰用户由系统决定。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(MouseWatcher::new());
            // 穿透状态服务：穿透模式的唯一真相源，由 Rust 维护并执行 Win32 样式切换。
            app.manage(Mutex::new(PassthroughState::new()));
            // 解锁锁的运行时状态（hover 检测与自动收起延时）。
            app.manage(Mutex::new(LockState::new()));
            // 托盘穿透菜单项引用，供切换命令同步勾选显示。
            app.manage(TrayPassthroughRef(Mutex::new(None)));
            // 全屏检测与自动穿透的运行时状态（开关默认关，由前端加载配置后同步）。
            app.manage(tracker::FullscreenState::new());
            // 应用使用统计的运行时状态（开关默认关，由前端加载配置后同步）。
            app.manage(usage::UsageState::new());
            // 整点报时的运行时状态（开关默认关，由前端加载配置后同步）。
            app.manage(chime::ChimeState::new());
            // 通用弹窗的运行时状态（不透明度 + 内容）。
            app.manage(popup::PopupState::new());
            // 日程提醒的运行时状态（开关默认关，由前端加载配置后同步）。
            app.manage(plans::PlanState::new());
            // Create the schema up front; fail loudly if storage is unavailable.
            db::init_db(app);

            // 启动全屏检测轮询（内部按开关决定是否动作）。
            tracker::start(app.handle().clone());

            // 启动应用使用统计轮询（内部按开关决定是否采样）。
            usage::start(app.handle().clone());

            // 启动整点报时（内部按开关决定是否弹窗）。
            chime::start(app.handle().clone());

            // 启动日程提醒（内部按开关决定是否弹窗）。
            plans::start(app.handle().clone());

            // 预创建锁窗口（隐藏常驻），首次 hover 出现时无需等待 webview 加载。
            if let Err(e) = ensure_lock_window(app.handle()) {
                eprintln!("[lock] 预创建锁窗口失败: {e}");
            }

            // 预创建弹窗（隐藏常驻）：它靠事件刷新内容，
            // 若等首次弹出时才创建，前端还没挂载，第一次事件就丢了。
            if let Err(e) = popup::ensure(app.handle()) {
                eprintln!("[popup] 预创建弹窗失败: {e}");
            }

            // 准备系统通知环境（补 AppUserModelID 快捷方式，见 notify.rs）。
            notify::prepare(app.handle());

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
                        if let Err(e) = do_toggle_passthrough(app) {
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
            open_data_dir,
            list_skins,
            toggle_passthrough,
            set_fullscreen_passthrough,
            set_usage_tracking,
            load_usage,
            load_usage_all,
            set_chime,
            ring_chime,
            popup_state,
            load_plans,
            add_plan,
            delete_plan,
            set_plan_notify,
            test_notify,
            show_lock_window,
            hide_lock_window,
            set_lock_hide_delay,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
