//! 整点报时：每个整点弹出一个小窗显示当前时刻，并播放提示音。
//!
//! 小窗是独立窗口（label `chime`），与主窗口分离——主窗口可能被穿透或隐藏，
//! 报时不能依赖它。显示走 `SW_SHOWNA`，不抢焦点。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOP,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNA, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

use crate::db;

/// 小窗停留时长：到点报时与「试一下报时」一致，都是弹 5 秒后自己收起。
const VISIBLE: Duration = Duration::from_secs(5);
/// 小窗尺寸（逻辑像素）：只放得下「13:00」这么大。
const WIN_W: f64 = 104.0;
const WIN_H: f64 = 52.0;
/// 与挂件的间距（物理像素）。
const GAP_PX: i32 = 6;
/// 一天的毫秒数与一小时的毫秒数。
const HOUR_MS: i64 = 3_600_000;
/// 一分钟的毫秒数。
const MIN_MS: i64 = 60_000;

/// 小窗要显示的内容：时刻 + 不透明度。
///
/// 时刻由 Rust 格式化，前后端不各写一套；不透明度交给 CSS 而不是窗口分层样式
/// ——给 WebView2 的宿主窗口加 `WS_EX_LAYERED`（配合 SetLayeredWindowAttributes）
/// 会让窗口内容整个不显示，透明无边框的窗口看起来就是「什么都没弹出来」。
#[derive(Clone, Serialize)]
pub struct Payload {
    pub time: String,
    pub opacity: f64,
}

/// 当前应显示的内容。小窗常驻隐藏，事件可能因为 webview 重建等原因错过，
/// 所以挂载时主动取一次，保证窗口永远有内容（且是当时的时刻，不是启动时刻）。
pub fn current(app: &AppHandle) -> Payload {
    let permille = app
        .state::<ChimeState>()
        .opacity_permille
        .load(Ordering::SeqCst);
    Payload {
        time: now_hhmm(),
        opacity: permille as f64 / 1000.0,
    }
}

/// 本地时刻的「HH:MM」。
fn now_hhmm() -> String {
    let total = 4 * HOUR_MS + db::local_clock().1; // 见 ms_until_next_hour 的说明
    format!(
        "{:02}:{:02}",
        (total / HOUR_MS) % 24,
        (total / MIN_MS) % 60
    )
}

/// 报时的运行时状态。
pub struct ChimeState {
    /// 功能开关（功能面板控制）。关闭时到点不弹窗。
    pub enabled: AtomicBool,
    /// 小窗不透明度（千分之一，0~1000），跟随挂件的闲置透明度。
    opacity_permille: AtomicU32,
    /// 每次显示递增的序号：只有序号没变的收起定时器才算数。
    /// 手动「试一下报时」可能落在上一次停留期内，旧定时器不能把新弹的窗提前收走。
    show_seq: AtomicU64,
}

impl ChimeState {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            opacity_permille: AtomicU32::new(600),
            show_seq: AtomicU64::new(0),
        }
    }
}

/// 启动报时线程：睡到下一个整点，弹窗后再睡到下一个整点。
pub fn start(app: AppHandle) {
    thread::spawn(move || loop {
        // 睡到整点：即使功能关闭也要走时钟，否则重新开启后要等很久才第一次响。
        thread::sleep(Duration::from_millis(ms_until_next_hour()));
        if !app.state::<ChimeState>().enabled.load(Ordering::SeqCst) {
            continue;
        }
        // 收起由 show 自己排定：整点报时与手动「试一下报时」走同一条路径。
        if let Err(e) = show(&app) {
            eprintln!("[chime] 显示失败: {e}");
        }
    });
}

/// 距下一个整点还有多少毫秒。
///
/// `db::local_clock()` 返回「自当日起点（凌晨 4 点）已过的毫秒数」，
/// 加上 4 小时即为本地时刻；对一小时取余即得当前小时内已过的时间。
/// 末尾多等 250ms，避免因为本地时钟只精确到秒而在整点前就弹窗。
fn ms_until_next_hour() -> u64 {
    let passed = db::local_clock().1;
    let into_hour = (4 * HOUR_MS + passed) % HOUR_MS;
    (HOUR_MS - into_hour + 250).max(250) as u64
}

/// 显示报时小窗：定位到挂件旁、按闲置透明度设不透明度，然后不激活地显示。
fn show(app: &AppHandle) -> Result<(), String> {
    let Some(widget) = crate::main_window_rect(app) else {
        return Err("取主窗口矩形失败".to_string());
    };
    let window = ensure_chime_window(app)?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = (WIN_W * scale).round() as i32;
    let h = (WIN_H * scale).round() as i32;
    let (x, y) = chime_pos(widget, w, h);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| format!("定位报时窗口失败: {e}"))?;

    let hwnd = crate::main_hwnd(&window)?;
    unsafe {
        // 与解锁锁同理：只显示不激活，别把焦点从用户当前窗口抢走。
        let _ = ShowWindow(hwnd, SW_SHOWNA);
        // show 之后补一次置顶：窗口是常驻的，期间可能有别的窗口盖到它上面。
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
    // 广播给所有窗口：音效由主窗口播放——报时小窗从没被点过，
    // Chromium 的自动播放策略会拦掉它没有用户交互的 audio。
    // 必须在显示之后发，前端拿到时刻的同时窗口已经可见。
    let _ = app.emit("chime-show", current(app));

    // 停留 VISIBLE 后自动收起：定时器只在序号没变时生效，
    // 期间若又弹了一次（手动试报时落在上一次停留期内），旧定时器自动作废。
    let seq = app
        .state::<ChimeState>()
        .show_seq
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app2 = app.clone();
    thread::spawn(move || {
        thread::sleep(VISIBLE);
        if app2.state::<ChimeState>().show_seq.load(Ordering::SeqCst) == seq {
            if let Err(e) = hide(&app2) {
                eprintln!("[chime] 隐藏失败: {e}");
            }
        }
    });
    Ok(())
}

/// 立刻弹一次报时小窗（挂件右键菜单「试一下报时」调用）。
/// 与到点报时完全同一条路径：同样停留 `VISIBLE` 后自己收起。
pub fn ring(app: &AppHandle) -> Result<(), String> {
    show(app)
}

/// 隐藏报时小窗。
fn hide(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("chime") {
        let hwnd = crate::main_hwnd(&window)?;
        let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
    }
    Ok(())
}

/// 小窗左上角（物理像素）：贴在挂件内侧，垂直居中。
fn chime_pos(widget: (i32, i32, i32, i32), w: i32, h: i32) -> (i32, i32) {
    let (left, top, right, bottom) = widget;
    let x = if left <= 2 { right + GAP_PX } else { left - GAP_PX - w };
    (x, top + (bottom - top - h) / 2)
}

/// 预创建报时窗口（setup 阶段调用）：常驻隐藏，到点由 Rust 定位后显示。
pub fn ensure(app: &AppHandle) -> Result<WebviewWindow, String> {
    ensure_chime_window(app)
}

fn ensure_chime_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window("chime") {
        return Ok(existing);
    }
    let window = WebviewWindowBuilder::new(app, "chime", WebviewUrl::App("index.html".into()))
        .title("浮笺 · 报时")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .always_on_top(true)
        .inner_size(WIN_W, WIN_H)
        .build()
        .map_err(|e| format!("创建报时窗口失败: {e}"))?;
    // 点击不激活 + 不出现在 Alt-Tab；报时只是看一眼，不该打断用户手上的事。
    if let Ok(hwnd) = crate::main_hwnd(&window) {
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
    Ok(window)
}

/// 写入开关与不透明度（功能面板在加载配置与改动时调用）。
pub fn apply(app: &AppHandle, enabled: bool, opacity: f64) {
    let state = app.state::<ChimeState>();
    state.enabled.store(enabled, Ordering::SeqCst);
    let permille = (opacity.clamp(0.0, 1.0) * 1000.0).round() as u32;
    state
        .opacity_permille
        .store(permille.min(1000), Ordering::SeqCst);
}
