//! 全屏检测与自动穿透。
//!
//! Windows 没有提供「进入/退出全屏」的事件通知，只能轮询。
//! 每 2 秒做一次三层判定（系统状态 → 几何覆盖 → 桌面排除），
//! 只在状态变化的瞬间切换穿透，全屏期间不做任何动作——
//! 用户可能主动解锁穿透在游戏里操作，不能被轮询强制覆盖回去。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::{set_passthrough, PassthroughState};

/// 轮询间隔：全屏切换对实时性要求不高，2 秒足够，开销可忽略。
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// 全屏检测与自动穿透的运行时状态。
pub struct FullscreenState {
    /// 功能开关（设置面板控制）。关闭时不检测、不动作。
    pub enabled: AtomicBool,
    /// 上一次轮询的全屏状态，用于只在「变化瞬间」动作。
    was_fullscreen: AtomicBool,
}

impl FullscreenState {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            was_fullscreen: AtomicBool::new(false),
        }
    }
}

/// 启动全屏检测轮询线程。
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        poll_once(&app);
        std::thread::sleep(POLL_INTERVAL);
    });
}

/// 单次轮询：判定全屏状态，仅在变化瞬间切换穿透。
fn poll_once(app: &AppHandle) {
    let state = app.state::<FullscreenState>();
    if !state.enabled.load(Ordering::SeqCst) {
        return;
    }

    let snap = snapshot();
    let was = state.was_fullscreen.load(Ordering::SeqCst);

    // 调试日志（当前停用）：需要核对全屏误报 / 漏报时取消下面的注释，
    // dev 构建每 2 秒输出一行前台应用信息（进程名、标题、命中层、窗口样式）。
    // #[cfg(debug_assertions)]
    // eprintln!(
    //     "[fullscreen] app={} | title={:?} | fullscreen={} (via={}, prev={}) | style={} | passthrough={}",
    //     snap.process_name,
    //     snap.window_title,
    //     snap.fullscreen,
    //     snap.via,
    //     was,
    //     snap.style_note,
    //     PassthroughState::read_current(app),
    // );

    // 边沿触发：只有全屏状态翻转的那一刻才动作，状态不变时完全不干预
    // ——用户在全屏里手动解锁、或在非全屏时手动开穿透，都不会被轮询覆盖。
    if snap.fullscreen == was {
        return;
    }

    if snap.fullscreen {
        // 进入全屏：穿透未开才开启（已开则不动，避免重复广播与音效）。
        if !PassthroughState::read_current(app) {
            // 先让前端收起面板：穿透生效后主窗口被禁用，面板上的关闭按钮点不到。
            let _ = app.emit("collapse-panel", ());
            if let Err(e) = set_passthrough(app, true) {
                eprintln!("[fullscreen] 自动开启穿透失败: {e}");
            }
        }
    } else if PassthroughState::read_current(app) {
        // 退出全屏：穿透开着才关闭。只在这一刻动作一次，之后用户手动开的
        // 非全屏穿透不会被反复关掉。
        if let Err(e) = set_passthrough(app, false) {
            eprintln!("[fullscreen] 自动关闭穿透失败: {e}");
        }
    }

    state.was_fullscreen.store(snap.fullscreen, Ordering::SeqCst);
    // 广播给前端，便于将来在界面上展示全屏状态。
    let _ = app.emit("fullscreen-changed", snap.fullscreen);
}

/// 单次轮询采集到的前台窗口信息。
/// 调试日志停用后这些字段暂无读取方，恢复日志（见 poll_once 内注释）即会用上。
#[allow(dead_code)]
struct Snapshot {
    process_name: String,
    window_title: String,
    fullscreen: bool,
    /// 命中的判定层："d3d"（系统级）、"geometry"（几何覆盖）或 "none"。
    via: &'static str,
    /// 窗口样式的摘要（调试用）：是否带标题栏、是否最大化。
    style_note: &'static str,
}

#[cfg(not(target_os = "windows"))]
fn snapshot() -> Snapshot {
    Snapshot {
        process_name: String::new(),
        window_title: String::new(),
        fullscreen: false,
        via: "none",
        style_note: "-",
    }
}

/// 三层判定：任一命中即视为全屏。
#[cfg(target_os = "windows")]
fn snapshot() -> Snapshot {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::{QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowLongPtrW, GetWindowTextW,
        GetWindowRect, GetWindowThreadProcessId, GWL_STYLE, WS_CAPTION, WS_MAXIMIZE,
    };

    unsafe {
        let hwnd = GetForegroundWindow();

        // ── 进程与窗口标题（调试日志用）──
        let mut pid = 0u32;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let mut tbuf = [0u16; 256];
        let tlen = GetWindowTextW(hwnd, &mut tbuf);
        let window_title = if tlen > 0 {
            String::from_utf16_lossy(&tbuf[..tlen as usize])
        } else {
            String::new()
        };

        let mut process_name = String::from("(unknown)");
        if pid != 0 {
            if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buf = [0u16; 512];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
                    .is_ok()
                {
                    let full = String::from_utf16_lossy(&buf[..len as usize]);
                    process_name = full.rsplit('\\').next().unwrap_or(&full).to_string();
                }
                let _ = windows::Win32::Foundation::CloseHandle(h);
            }
        }

        // ── 全屏判定：第 1 层，系统级（独占 D3D 全屏，典型游戏）──
        // 部分游戏会误报 QUNS_BUSY，所以不能只依赖这一层。
        let mut fullscreen = false;
        let mut via = "none";
        if let Ok(s) = SHQueryUserNotificationState() {
            if s == QUNS_RUNNING_D3D_FULL_SCREEN {
                fullscreen = true;
                via = "d3d";
            }
        }

        // ── 第 2 层：几何判定 + 无边框要求 ──
        // 仅「覆盖整个显示器」还不够：任务栏自动隐藏时，最大化窗口的矩形
        // 同样铺满整个显示器，会被误判成全屏。真正的全屏应用是无边框的
        // （WS_POPUP，无 WS_CAPTION），且不带 WS_MAXIMIZE——据此把最大化窗口排除掉。
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let has_caption = (style & (WS_CAPTION.0 as isize)) != 0;
        let maximized = (style & (WS_MAXIMIZE.0 as isize)) != 0;
        let style_note = match (has_caption, maximized) {
            (true, true) => "caption+maximized",
            (true, false) => "caption",
            (false, true) => "borderless+maximized",
            (false, false) => "borderless",
        };

        if !fullscreen
            && !hwnd.is_invalid()
            && hwnd != GetShellWindow()
            && hwnd != GetDesktopWindow()
            && !has_caption
            && !maximized
        {
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if GetMonitorInfoW(monitor, &mut info).as_bool() {
                    if rect.left <= info.rcMonitor.left
                        && rect.top <= info.rcMonitor.top
                        && rect.right >= info.rcMonitor.right
                        && rect.bottom >= info.rcMonitor.bottom
                    {
                        fullscreen = true;
                        via = "geometry";
                    }
                }
            }
        }

        Snapshot {
            process_name,
            window_title,
            fullscreen,
            via,
            style_note,
        }
    }
}
