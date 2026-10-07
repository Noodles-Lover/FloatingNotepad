//! 指定应用的使用计时：后台按前台窗口累计该应用的被使用时长。
//!
//! 累计放在 Rust 线程里（500ms 一跳），前端只负责显示——面板收起时挂件不渲染，
//! 显示会停，但计时不会停。
//!
//! 匹配按**进程名**而不是窗口句柄：同一应用的新窗口、对话框、设置页都算这个应用，
//! 只认句柄会在用户开第二个窗口时静默停表。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, GWL_EXSTYLE,
    WS_EX_TOOLWINDOW,
};

use crate::foreground;
use crate::log;

/// 采样间隔：500ms 足以跟上「切走就停」，也不至于太频繁。
const TICK: Duration = Duration::from_millis(500);
/// 空闲超过这个时长就不再累计：人不在电脑前不算在用这个应用。
const IDLE_LIMIT_MS: u32 = 60_000;

/// 候选窗口（选择面板的列表项）。
#[derive(Serialize, Clone)]
pub struct WindowInfo {
    /// 窗口句柄的原始值（选中后回传）。
    pub hwnd: isize,
    pub title: String,
    /// 所属进程名（如 `Code.exe`），同一进程可能有多个窗口。
    pub process: String,
}

/// 计时状态（前端显示用）。
#[derive(Serialize, Clone, Default)]
pub struct TimerState {
    pub running: bool,
    pub title: String,
    pub process: String,
    pub elapsed_ms: u64,
    /// 挂件停靠在哪一侧（`left` / `right`）：计时窗口贴在另一侧，文字据此靠边对齐。
    pub edge: String,
}

/// 计时窗口与挂件之间的间隙（物理像素）。
const GAP: i32 = 4;

/// 计时窗口尺寸：只有一行字那么高——取挂件高度的一半，但**封顶 40px**，
/// 这样挂件调大时文字不会跟着夸张（字号是窗口高度的 40%，恒定在 16px 内）。
/// 宽度按字高估一段：窗口是穿透的，多留的透明区域不挡点击。
fn size_for(widget_height: i32) -> (i32, i32) {
    let h = ((widget_height as f32 * 0.5) as i32).clamp(24, 40);
    let w = (h as f32 * 2.0) as i32 + 44;
    (w, h)
}

struct Target {
    hwnd: isize,
    title: String,
    process: String,
}

/// 运行时态：目标窗口与累计时长。
#[derive(Default)]
pub struct WindowTimer {
    target: Mutex<Option<Target>>,
    running: AtomicBool,
    elapsed_ms: AtomicU64,
    /// 挂件停靠侧；由定位时按主窗口所在屏幕的左右半区推断。
    edge: Mutex<String>,
    /// 计时窗口是否已显示（隐藏时不必每跳都去置样式）。
    shown: AtomicBool,
    /// 计时窗口尺寸：开始计时时按挂件当前尺寸定一次，之后不再跟变化。
    size: Mutex<(i32, i32)>,
    /// 上次定位的窗口坐标，变了才动窗口。
    last_pos: Mutex<Option<(i32, i32)>>,
}

impl WindowTimer {
    fn read(&self) -> TimerState {
        let target = self.target.lock().unwrap();
        TimerState {
            running: self.running.load(Ordering::Relaxed),
            title: target.as_ref().map(|t| t.title.clone()).unwrap_or_default(),
            process: target.as_ref().map(|t| t.process.clone()).unwrap_or_default(),
            elapsed_ms: self.elapsed_ms.load(Ordering::Relaxed),
            edge: self.edge.lock().unwrap().clone(),
        }
    }
}

/// EnumWindows 的回调：必须是 `extern "system" fn`（闭包没有 C ABI），
/// 收集容器按 Win32 惯例经 lparam 传入。
unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if ex_style & (WS_EX_TOOLWINDOW.0 as u32) != 0 {
        return true.into();
    }
    let mut pid = 0u32;
    let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    if pid == 0 || pid == std::process::id() {
        return true.into();
    }
    let title = foreground::window_title(hwnd);
    if title.trim().is_empty() || foreground::is_shell_overlay(hwnd) {
        return true.into();
    }
    out.push(WindowInfo {
        hwnd: hwnd.0 as isize,
        process: foreground::process_name(hwnd),
        title,
    });
    true.into()
}

/// 可供选择的窗口：可见、有标题，且不是工具窗口、本应用或系统覆盖层。
pub fn list_windows() -> Vec<WindowInfo> {
    let mut out: Vec<WindowInfo> = Vec::new();
    let ctx = LPARAM(&mut out as *mut Vec<WindowInfo> as isize);
    unsafe {
        let _ = EnumWindows(Some(collect_window), ctx);
    }
    out.sort_by(|a, b| a.process.cmp(&b.process).then(a.title.cmp(&b.title)));
    out
}

/// 开始计时：记住目标窗口并清零。
pub fn start(app: &AppHandle, hwnd: isize) -> Result<TimerState, String> {
    let h = HWND(hwnd as *mut _);
    let title = foreground::window_title(h);
    if title.trim().is_empty() {
        return Err("该窗口已不存在".to_string());
    }
    let state = app.state::<WindowTimer>();
    *state.target.lock().unwrap() = Some(Target {
        hwnd,
        title: title.clone(),
        process: foreground::process_name(h),
    });
    state.elapsed_ms.store(0, Ordering::Relaxed);
    state.running.store(true, Ordering::Relaxed);
    // 尺寸在开始时按挂件当前设置定一次，之后不跟变化。
    *state.size.lock().unwrap() = (0, 0);
    log::write(app, "timer", &format!("开始计时: {title}"));
    Ok(state.read())
}

/// 计时窗口跟随挂件：贴在挂件的另一侧（内侧），高度与挂件一致。
///
/// 停靠侧按主窗口落在所在屏幕的哪半区推断——多显示器下也成立，
/// 前端因此不用再上报停靠边。
fn follow_widget(app: &AppHandle) {
    use tauri::Manager;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SetWindowPos, ShowWindow, HWND_TOP, SWP_NOACTIVATE, SWP_NOSIZE, SW_HIDE,
        SW_SHOWNA,
    };

    let state = app.state::<WindowTimer>();
    if !state.running.load(Ordering::Relaxed) {
        if state.shown.swap(false, Ordering::Relaxed) {
            if let Some(win) = app.get_webview_window("widget-timer") {
                if let Ok(h) = crate::main_hwnd(&win) {
                    unsafe {
                        let _ = ShowWindow(h, SW_HIDE);
                    }
                }
            }
        }
        return;
    }

    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let Ok(main_h) = crate::main_hwnd(&main) else {
        return;
    };
    let mut rect = RECT::default();
    unsafe {
        if GetWindowRect(main_h, &mut rect).is_err() {
            return;
        }
        let monitor = MonitorFromWindow(main_h, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return;
        }
        let work = info.rcWork;
        let docked_left =
            (rect.left + rect.right) / 2 < (work.left + work.right) / 2;
        *state.edge.lock().unwrap() =
            if docked_left { "left" } else { "right" }.to_string();

        let widget_height = rect.bottom - rect.top;
        let Some(timer_win) = app.get_webview_window("widget-timer") else {
            return;
        };
        // 尺寸只在本轮计时开始时定一次：用户中途改挂件大小，计时窗口也不跟着变。
        let (w, h) = {
            let mut size = state.size.lock().unwrap();
            if size.0 <= 0 {
                *size = size_for(widget_height);
                let _ = timer_win.set_size(tauri::PhysicalSize::new(size.0 as u32, size.1 as u32));
            }
            *size
        };
        let x0 = if docked_left {
            rect.right + GAP
        } else {
            rect.left - GAP - w
        };
        // 夹在工作区内：主窗口贴边时，多显示器与任务栏都可能让外面那侧越界。
        let x = x0.clamp(work.left, (work.right - w).max(work.left));
        let y = (rect.top + (widget_height - h) / 2).clamp(work.top, work.bottom);

        if *state.last_pos.lock().unwrap() != Some((x, y)) {
            let _ = SetWindowPos(
                crate::main_hwnd(&timer_win).unwrap_or(HWND_TOP),
                HWND_TOP,
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE,
            );
            *state.last_pos.lock().unwrap() = Some((x, y));
        }
        if !state.shown.swap(true, Ordering::Relaxed) {
            if let Ok(th) = crate::main_hwnd(&timer_win) {
                // 重新接管命中测试：webview 初始化可能把窗口过程换回 wry 的，
                // 只在建窗时设一次不够。
                crate::clickthrough::enable(th);
                // SW_SHOWNA 只显示不激活：不能把焦点从当前应用抢走。
                let _ = ShowWindow(th, SW_SHOWNA);
            }
        }
    }
}
pub fn stop(app: &AppHandle) -> TimerState {
    let state = app.state::<WindowTimer>();
    state.running.store(false, Ordering::Relaxed);
    *state.target.lock().unwrap() = None;
    state.elapsed_ms.store(0, Ordering::Relaxed);
    log::write(app, "timer", "停止计时");
    state.read()
}

/// 当前计时状态（前端每秒取一次）。
pub fn snapshot(app: &AppHandle) -> TimerState {
    app.state::<WindowTimer>().read()
}

/// 采样线程：累计时长，并把计时窗口贴到挂件的另一侧。
///
/// 两件事放同一个循环：定位需要读主窗口矩形，与累计共用一次节拍就够了。
pub fn start_thread(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("window-timer".into())
        .spawn(move || {
            let mut last = Instant::now();
            loop {
                std::thread::sleep(TICK);
                let now = Instant::now();
                let delta_ms = now.duration_since(last).as_millis() as u64;
                last = now;

                let state = app.state::<WindowTimer>();
                if state.running.load(Ordering::Relaxed) {
                    let target = state.target.lock().unwrap();
                    if let Some(t) = target.as_ref() {
                        let gone = !unsafe { IsWindow(HWND(t.hwnd as *mut _)) }.as_bool();
                        if gone {
                            drop(target);
                            state.running.store(false, Ordering::Relaxed);
                            log::write(&app, "timer", "目标窗口已关闭，计时停止");
                        } else {
                            let fg = foreground::foreground_hwnd();
                            let on_target = fg == t.hwnd
                                || foreground::process_name(HWND(fg as *mut _)) == t.process;
                            if on_target && foreground::idle_ms() < IDLE_LIMIT_MS {
                                state.elapsed_ms.fetch_add(delta_ms, Ordering::Relaxed);
                            }
                        }
                    }
                }
                follow_widget(&app);
            }
        });
}
