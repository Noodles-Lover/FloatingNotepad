//! 前台窗口信息（进程名 / 标题 / 类名 / 样式 / 是否铺满显示器）与系统空闲时长。
//!
//! 全屏检测（tracker.rs）与应用使用统计（usage.rs）都要读前台窗口，
//! 这里提供同一份实现，避免两套 Win32 调用各自漂移。

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

/// 前台窗口的句柄（原始值）；取不到时为 0。
#[cfg(target_os = "windows")]
pub fn foreground_hwnd() -> isize {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow().0 as isize }
}

#[cfg(not(target_os = "windows"))]
pub fn foreground_hwnd() -> isize {
    0
}

/// 是否是本应用的穿透解锁锁窗口（label "widget-lock"）。
///
/// 它是穿透态下由本应用弹出的 UI：既不能被全屏检测当成「用户离开了全屏应用」，
/// 也不该中断正在进行的会话——游戏还在跑，用户只是把鼠标移到了挂件上。
pub fn is_lock_window(app: &tauri::AppHandle, hwnd: isize) -> bool {
    use tauri::Manager;
    app.get_webview_window("widget-lock")
        .and_then(|w| crate::main_hwnd(&w).ok())
        .is_some_and(|h| h.0 as isize == hwnd)
}

/// 取窗口标题；无标题或读取失败时返回空串。
#[cfg(target_os = "windows")]
pub fn window_title(hwnd: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;

    unsafe {
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        }
    }
}

/// 取窗口所属进程的可执行文件名（如 `Code.exe`）；取不到时为 `(unknown)`。
#[cfg(target_os = "windows")]
pub fn process_name(hwnd: HWND) -> String {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    const UNKNOWN: &str = "(unknown)";

    unsafe {
        let mut pid = 0u32;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return UNKNOWN.to_string();
        }
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return UNKNOWN.to_string();
        };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let name = if QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok()
        {
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            full.rsplit('\\').next().unwrap_or(&full).to_string()
        } else {
            UNKNOWN.to_string()
        };
        let _ = CloseHandle(handle);
        name
    }
}

/// 取窗口类名（如 `CabinetWClass`）。类名由程序自己注册，**不随系统显示语言变化**，
/// 因此比窗口标题更适合做稳定识别。
#[cfg(target_os = "windows")]
pub fn class_name(hwnd: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

    unsafe {
        let mut buf = [0u16; 256];
        let len = GetClassNameW(hwnd, &mut buf);
        if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        }
    }
}

/// 窗口样式摘要：是否带标题栏、是否最大化。
#[cfg(target_os = "windows")]
pub fn window_style(hwnd: HWND) -> (bool, bool) {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_STYLE, WS_CAPTION, WS_MAXIMIZE};

    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        (
            (style & (WS_CAPTION.0 as isize)) != 0,
            (style & (WS_MAXIMIZE.0 as isize)) != 0,
        )
    }
}

/// 窗口矩形是否覆盖整个所在显示器（「铺满」是全屏的必要条件，但远不充分）。
#[cfg(target_os = "windows")]
pub fn covers_monitor(hwnd: HWND) -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            rect.left <= info.rcMonitor.left
                && rect.top <= info.rcMonitor.top
                && rect.right >= info.rcMonitor.right
                && rect.bottom >= info.rcMonitor.bottom
        } else {
            false
        }
    }
}

/// 系统覆盖层的类名：Alt+Tab 切换器、任务视图、开始菜单、锁屏等。
/// 这些窗口由系统提供，类名不随语言变化；`Shell_` 前缀的窗口一律视为外壳 UI。
const SHELL_OVERLAY_CLASSES: &[&str] = &[
    "XamlExplorerHostIslandWindow", // Win11 的 Alt+Tab / 任务视图（XAML island）
    "MultitaskingViewFrame",        // Win10 / Win11 的任务视图（Win+Tab）
    "TaskSwitcherWnd",              // Win10 的 Alt+Tab 切换器
    "Shell_InputSwitchTopLevelWindow", // 输入法 / 键盘布局切换（Alt+Shift）
    "ApplicationManager_ImmersiveShellWindow", // 沉浸式外壳（开始菜单、操作中心）
    "Windows.UI.Core.CoreWindow",   // UWP 覆盖层（开始菜单、搜索、通知中心）
    "ForegroundStaging",            // 锁屏 / 登录界面
    "Progman",                      // 桌面
];

/// 前台窗口是否是系统覆盖层（Alt+Tab 切换器、任务视图这类系统 UI）。
///
/// 它们**无边框且铺满显示器**，几何判定会把它们当全屏应用——表现为一按 Alt+Tab
/// 就自动穿透。它们同时也不是「在用某个应用」，不该计入使用时间。
///
/// 两级判定：先按类名（稳定、跨语言），再按「explorer 出的无边框铺满窗口」兜底
/// ——不同 Windows 版本的切换器类名会变，但都归 explorer，而资源管理器窗口
/// 一定带标题栏，所以无边框铺满的 explorer 窗口只能是系统 UI。
#[cfg(target_os = "windows")]
pub fn is_shell_overlay(hwnd: HWND) -> bool {
    let class = class_name(hwnd);
    if class.starts_with("Shell_")
        || SHELL_OVERLAY_CLASSES
            .iter()
            .any(|c| class.eq_ignore_ascii_case(c))
    {
        return true;
    }
    if process_name(hwnd).eq_ignore_ascii_case("explorer.exe") {
        let (has_caption, _) = window_style(hwnd);
        if !has_caption && covers_monitor(hwnd) {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
pub fn is_shell_overlay(_hwnd: ()) -> bool {
    false
}

/// 屏保是否正在运行——屏保一起，人肯定不在电脑前。
/// 这是「明确离开」的三个信号之一（另两个是锁屏与系统睡眠）。
#[cfg(target_os = "windows")]
pub fn screensaver_running() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETSCREENSAVERRUNNING, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    unsafe {
        let mut running = windows::Win32::Foundation::BOOL(0);
        let queried = SystemParametersInfoW(
            SPI_GETSCREENSAVERRUNNING,
            0,
            Some(&mut running as *mut _ as *mut std::ffi::c_void),
            // 只是查询，不写入用户配置，因此不传 SPIF_UPDATEINIFILE。
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        queried.is_ok() && running.as_bool()
    }
}

#[cfg(not(target_os = "windows"))]
pub fn screensaver_running() -> bool {
    false
}

/// 距最后一次键鼠输入的时长（毫秒）：用来判断「人是否还在电脑前」——
/// 人走开时前台应用不会变，只看前台窗口会把离席时间也算成使用时间。
#[cfg(target_os = "windows")]
pub fn idle_ms() -> u32 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info).as_bool() {
            // 两者都是「系统启动至今的毫秒数」，会在 49.7 天处回绕，
            // 用 wrapping_sub 保证回绕点附近也算出正确的间隔。
            GetTickCount().wrapping_sub(info.dwTime)
        } else {
            // 取不到就当作一直在用：宁可多记，也不要整段漏记。
            0
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn idle_ms() -> u32 {
    0
}
