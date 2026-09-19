//! 通用弹出小窗：在挂件旁显示一小段内容（大字 + 可选小字），停留后自动收起。
//!
//! 与主窗口分离的独立窗口（label `popup`）——主窗口可能被穿透或隐藏，弹出不能依赖它。
//! 谁需要弹一下（目前的唯一调用者是整点报时）就调 [`show`]，内容与关闭方式都写在
//! [`Payload`] 里，不感知业务。显示走 `SW_SHOWNA`，不抢焦点。
//!
//! 不透明度交给 CSS（`style={{ opacity }}`）而不是窗口分层样式：给 WebView2 的宿主
//! 窗口加 `WS_EX_LAYERED` 配合 `SetLayeredWindowAttributes` 会让内容整个不显示。

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNA, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

/// 停留时长：一眼的事，弹够 `VISIBLE` 就自己收起。
const VISIBLE: Duration = Duration::from_secs(5);
/// 紧凑尺寸（逻辑像素）：刚好放得下「13:00」。
const WIN_W: f64 = 104.0;
const WIN_H: f64 = 52.0;
/// 长内容尺寸：宽一些，高度按字数估。
const WIDE_W: f64 = 220.0;
const WIDE_LINE_H: f64 = 22.0;
const WIDE_BASE_H: f64 = 34.0;
/// 每行能放下的宽度单位（中日韩字符算 2 个单位）。
const UNITS_PER_LINE: usize = 26;
/// 最多估 5 行：再长由前端截断，避免窗口被撑得过高。
const MAX_LINES: usize = 5;
/// 与主窗口的间距（物理像素）。
const GAP_PX: i32 = 6;
/// 日志上限：超过就重头写，避免长期运行越写越大。
const LOG_MAX_BYTES: u64 = 64 * 1024;

/// 要显示的内容。
#[derive(Clone, Serialize)]
pub struct Payload {
    /// 主文本（多行用 \n 分隔）。
    pub text: String,
    /// 副文本（小字，可选）。
    pub sub: Option<String>,
    pub opacity: f64,
}

/// 弹窗的运行时状态。
pub struct PopupState {
    /// 不透明度（千分之一，0~1000），跟随挂件的闲置透明度。
    opacity_permille: AtomicU32,
    /// 每次显示递增的序号：只有序号没变的收起定时器才算数。
    /// 连续弹两次时，旧定时器不能把新弹的窗提前收走。
    show_seq: AtomicU64,
    /// 最近一次显示的内容：小窗挂载时会主动取一次（webview 重建后仍是同一内容）。
    last: Mutex<Option<Payload>>,
}

impl PopupState {
    pub fn new() -> Self {
        Self {
            opacity_permille: AtomicU32::new(600),
            show_seq: AtomicU64::new(0),
            last: Mutex::new(None),
        }
    }
}

/// 设置不透明度（千分之一），由调用方按自己的配置同步。
pub fn set_opacity(app: &AppHandle, opacity: f64) {
    let permille = (opacity.clamp(0.0, 1.0) * 1000.0).round() as u32;
    app.state::<PopupState>()
        .opacity_permille
        .store(permille.min(1000), Ordering::SeqCst);
}

/// 当前应显示的内容。小窗挂载时主动取一次，避免错过事件后一片空白。
pub fn current(app: &AppHandle) -> Payload {
    let state = app.state::<PopupState>();
    if let Ok(guard) = state.last.lock() {
        if let Some(p) = guard.clone() {
            return p;
        }
    }
    let permille = state.opacity_permille.load(Ordering::SeqCst);
    Payload {
        text: String::new(),
        sub: None,
        opacity: permille as f64 / 1000.0,
    }
}

/// 弹一次：按内容估尺寸 → 定位到挂件旁 → 不激活地显示 → 广播内容 → 到点自动收起。
///
/// 面板展开时不弹独立小窗（会被面板挡住，等于白弹），只广播内容，
/// 由主窗口在面板内显示——这就是前端 `PopupToast` 的用途。
pub fn show(app: &AppHandle, text: impl Into<String>, sub: Option<String>) -> Result<(), String> {
    let state = app.state::<PopupState>();
    let payload = Payload {
        text: text.into(),
        sub,
        opacity: state.opacity_permille.load(Ordering::SeqCst) as f64 / 1000.0,
    };
    let use_window = !panel_expanded(app);
    trace(
        app,
        &format!(
            "show 内容={:?} 弹独立小窗={use_window}",
            payload.text.lines().next().unwrap_or("")
        ),
    );

    if use_window {
        let Some(widget) = crate::main_window_rect(app) else {
            return Err("取主窗口矩形失败".to_string());
        };
        let window = ensure(app)?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let (lw, lh) = estimate_size(&payload);
        window
            .set_size(LogicalSize::new(lw, lh))
            .map_err(|e| format!("设置弹窗尺寸失败: {e}"))?;
        let (x, y) = popup_pos(
            widget,
            (lw * scale).round() as i32,
            (lh * scale).round() as i32,
        );
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| format!("定位弹窗失败: {e}"))?;

        let hwnd = crate::main_hwnd(&window)?;
        unsafe {
            // 与解锁锁同理：只显示不激活，别把焦点从用户当前窗口抢走。
            let _ = ShowWindow(hwnd, SW_SHOWNA);
            // HWND_TOPMOST 而不是 HWND_TOP：挂件本身是置顶窗口，
            // HWND_TOP 只把窗口排到「非置顶组」的第一位，与挂件重叠时会被压在下面。
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
        trace(app, &format!(" 位置=({x}, {y}) 尺寸={lw}x{lh}"));
    }

    if let Ok(mut guard) = app.state::<PopupState>().last.lock() {
        *guard = Some(payload.clone());
    }
    // 广播给所有窗口：音效由主窗口播放（本窗口从没被点过，Chromium 会拦掉无交互的 audio）；
    // 面板展开时主窗口还会据此在面板内显示一份。
    let _ = app.emit("popup-show", payload);
    if !use_window {
        return Ok(());
    }

    // 到点自动收起：定时器只在序号没变时生效，期间若又弹了一次，旧定时器自动作废。
    let seq = app
        .state::<PopupState>()
        .show_seq
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app2 = app.clone();
    thread::spawn(move || {
        thread::sleep(VISIBLE);
        if app2.state::<PopupState>().show_seq.load(Ordering::SeqCst) == seq {
            if let Err(e) = hide(&app2) {
                trace(&app2, &format!("隐藏失败: {e}"));
            }
        }
    });
    Ok(())
}

/// 隐藏弹窗。
pub fn hide(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("popup") {
        let hwnd = crate::main_hwnd(&window)?;
        let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
        trace(app, "隐藏");
    }
    Ok(())
}

/// 预创建弹窗（setup 阶段调用）：常驻隐藏，显示时由 Rust 定位后再显示。
pub fn ensure(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window("popup") {
        return Ok(existing);
    }
    let window = WebviewWindowBuilder::new(app, "popup", WebviewUrl::App("index.html".into()))
        .title("浮笺 · 提示")
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
        .map_err(|e| format!("创建弹窗失败: {e}"))?;
    // 点击不激活 + 不出现在 Alt-Tab；弹窗只是看一眼，不该打断用户手上的事。
    if let Ok(hwnd) = crate::main_hwnd(&window) {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let bits = (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW).0 as isize;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | bits);
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
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

/// 按内容估窗口尺寸（逻辑像素）：短内容用紧凑尺寸，长内容按字数估行数。
fn estimate_size(p: &Payload) -> (f64, f64) {
    let short = p.sub.is_none() && p.text.chars().count() <= 5;
    if short {
        return (WIN_W, WIN_H);
    }
    // 显式换行各自成行，长行再按宽度折行。
    let lines: usize = p
        .text
        .split('\n')
        .map(|seg| {
            let units: usize = seg.chars().map(|c| if is_wide(c) { 2 } else { 1 }).sum();
            ((units + UNITS_PER_LINE - 1) / UNITS_PER_LINE).max(1)
        })
        .sum();
    let lines = lines.max(1).min(MAX_LINES);
    (WIDE_W, WIDE_BASE_H + lines as f64 * WIDE_LINE_H)
}

/// 中日韩/全角字符按双倍宽度估算（粗估即可，多一行空余不影响观感）。
fn is_wide(c: char) -> bool {
    (c as u32) > 0x2e7f
}

/// 弹窗左上角（物理像素）：贴在主窗口内侧，垂直居中。
fn popup_pos(widget: (i32, i32, i32, i32), w: i32, h: i32) -> (i32, i32) {
    let (left, top, right, bottom) = widget;
    let x = if left <= 2 { right + GAP_PX } else { left - GAP_PX - w };
    (x, top + (bottom - top - h) / 2)
}

/// 主窗口（速记面板）是否展开。以**窗口几何**为答案，而不是听前端同步来的标志位：
/// 标志位一旦与服务端失联（invoke 被拒、事件丢失）就永远停在旧值，表现是
/// 「有内容但看不见」，而且极难查。几何是物理事实，不需要同步，也不会过时。
///
/// 面板是竖长的纸（宽度不小于 240、高大于宽），挂件是正方形（宽高都等于挂件尺寸）。
fn panel_expanded(app: &AppHandle) -> bool {
    match crate::main_window_rect(app) {
        Some((left, top, right, bottom)) => {
            let (w, h) = (right - left, bottom - top);
            w >= 240 && h > w
        }
        None => false,
    }
}

/// 留痕：弹窗的位置/可见性都是运行时事实，出问题时看日志比读代码快。
fn trace(app: &AppHandle, msg: &str) {
    crate::log::write(app, "popup", msg);
}
