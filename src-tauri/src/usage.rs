//! 应用使用时间统计。
//!
//! 每 10 秒看一眼前台窗口，把「连续使用某个应用」记成一条会话（起止时间）写进本地 SQLite。
//! 只有前台切换、跨天、明确离开（锁屏 / 屏保 / 系统睡眠，外加长时间无输入兜底）
//! 或关闭功能时才会结束会话，其余时候只做一次 UPDATE 续期，
//! 因此进程被强杀也只丢一个轮询间隔。
//!
//! 数据全部留在本机 notes.db，面板只展示当天（凌晨 4 点为界）。

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::db;

/// 轮询间隔：时长最终以分钟呈现，10 秒的粒度足够，开销可忽略。
/// 注意：这也是会话的最小可分辨时长，合并阈值必须大于它，否则「夹在中间」的
/// 会话永远达不到判定长度（见 MERGE_GAP_MS）。
const POLL_INTERVAL: Duration = Duration::from_secs(10);
/// 连续无键鼠输入达到这个时长，才**兜底**判定人已离开。
///
/// 不能按几十秒就停表：看视频、看文档、开会投屏时全程没有输入，但人一直在看。
/// 真正的「明确离开」由锁屏（系统覆盖层）、屏保、系统睡眠三个信号判定，
/// 这条只用来兜住「离开了但既没锁屏也没屏保」的情况。
const IDLE_CUTOFF_MS: u32 = 45 * 60_000;
/// 「A → 别的 app → A」中间那段的合并上限：不超过这个时长的中间记录会被丢掉，
/// 前后两段接成一个区间（误触 / 焦点被短暂抢走不该在时间线上留下痕迹）。
const MERGE_GAP_MS: i64 = 20_000;
/// 锁屏 / 登录界面的宿主进程：前台是它们时人显然已离开。
/// 与 `is_shell_overlay` 的类名判定互补——不同 Windows 版本锁屏时返回的窗口并不一样，
/// 类名漏掉的这里兜住，避免把「锁屏」记成一条 LockApp 的使用记录。
const AWAY_PROCESSES: &[&str] = &["LockApp.exe", "LogonUI.exe"];
/// 两次轮询之间的墙上时钟跳变超过这个值，即认为系统睡过一觉（合盖 / 休眠）。
/// 远大于轮询间隔，正常调度抖动不会误判。
const SLEEP_GAP_MS: i64 = 60_000;

/// 使用统计的运行时状态。
pub struct UsageState {
    /// 功能开关（使用面板控制）。关闭时停止采样并结束进行中的会话。
    pub enabled: AtomicBool,
    /// 进行中的会话。只留 rowid 与归属，时长由数据库按 end-start 算。
    session: Mutex<Option<Session>>,
    /// 上一次轮询的墙上时刻（Unix 毫秒）；与本次的差值用于识别系统睡眠。
    last_poll_ms: AtomicI64,
}

struct Session {
    id: i64,
    app: String,
    day: String,
}

impl UsageState {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            session: Mutex::new(None),
            last_poll_ms: AtomicI64::new(0),
        }
    }
}

/// 启动使用统计轮询线程（内部按开关决定是否采样）。
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        poll_once(&app);
        std::thread::sleep(POLL_INTERVAL);
    });
}

/// 当前本地日期（"YYYY-MM-DD"），供统计命令按天查询。
pub fn today() -> String {
    db::local_clock().0
}

/// 单次轮询：把「此刻在用哪个应用」并入进行中的会话。
fn poll_once(app: &AppHandle) {
    let state = app.state::<UsageState>();
    // 当作「此刻」的唯一时间基准：整轮判定共用，避免中途跳秒造成区间错位。
    let now = Clock::now();
    let prev_poll = state.last_poll_ms.load(Ordering::SeqCst);
    state.last_poll_ms.store(now.ms, Ordering::SeqCst);

    if !state.enabled.load(Ordering::SeqCst) {
        // 关掉时把进行中的会话收尾，否则会留一条没有结束时间的记录。
        // 时间基准照常推进：重新开启时距上次采样已久，不应被判成睡了一觉。
        close_session(&state, now.ms);
        return;
    }

    // 系统睡眠（合盖 / 休眠）时本线程被挂起，GetTickCount 与「最后输入时间」
    // 一起冻结，空闲判定失效——醒来后会把整段睡眠算成使用时间。墙上时钟不受
    // 挂起影响，因此用它识别睡眠：跳变超过阈值就把会话停在上一次轮询，
    // 睡眠时长不计入任何应用。
    if prev_poll > 0 && now.ms - prev_poll > SLEEP_GAP_MS {
        close_session(&state, prev_poll);
        return;
    }

    // 只有「明确离开」才停表：锁屏（前台是系统覆盖层，foreground_app 会返回 None）、
    // 屏保运行、系统睡眠（上面已处理）。看视频这类零输入但人在看的情况必须继续累计，
    // 因此键鼠空闲只作兜底，且阈值放到 45 分钟。
    let away =
        crate::foreground::screensaver_running() || crate::foreground::idle_ms() >= IDLE_CUTOFF_MS;
    let current = if away { None } else { foreground_app() };

    let Ok(mut guard) = state.session.lock() else {
        return;
    };
    match (current, guard.as_ref()) {
        // 同一个应用、同一天：只续期，不开新会话。
        (Some(name), Some(s)) if s.app == name && s.day == now.day => {
            db::touch_session(s.id, now.ms);
        }
        // 应用切换或跨天：先收尾旧的，再开新的。
        (Some(name), _) => {
            let prev = guard.take();
            // 跨天时旧会话属于昨天，结束时间按昨天最后一毫秒算，
            // 不能写成「现在」——那会把今天开头的几分钟记到昨天头上。
            let end = match &prev {
                Some(old) if old.day != now.day => now.day_start_ms - 1,
                _ => now.ms,
            };
            if let Some(old) = &prev {
                db::touch_session(old.id, end);
                // 合并「A → 很短的别的 app → A」：命中时沿用前一段 A，不开新会话。
                // 跨天的旧会话不参与——它属于昨天，接不上今天的区间。
                if old.day == now.day {
                    if let Some(kept) =
                        db::merge_short_gap(&now.day, &name, now.ms, MERGE_GAP_MS, old.id)
                    {
                        *guard = Some(Session {
                            id: kept,
                            app: name,
                            day: now.day,
                        });
                        return;
                    }
                }
            }
            let id = db::open_session(&now.day, &name, now.ms);
            *guard = Some(Session {
                id,
                app: name,
                day: now.day,
            });
        }
        // 空闲或前台是浮笺自己：没有在用的应用，收尾即可。
        (None, Some(_)) => close_locked(&mut guard, now.ms),
        (None, None) => {}
    }
}

/// 结束进行中的会话（取锁版本，供开关关闭时调用）。
fn close_session(state: &UsageState, end_ms: i64) {
    if let Ok(mut guard) = state.session.lock() {
        close_locked(&mut guard, end_ms);
    }
}

/// 结束会话并落库。已持有锁时调用。
fn close_locked(guard: &mut Option<Session>, end_ms: i64) {
    if let Some(s) = guard.take() {
        db::touch_session(s.id, end_ms);
    }
}

/// 一次轮询的时间基准。
struct Clock {
    /// 本地日期。
    day: String,
    /// 当前时刻（Unix 毫秒）。
    ms: i64,
    /// 今日 00:00:00.000 的 Unix 毫秒。
    day_start_ms: i64,
}

impl Clock {
    fn now() -> Self {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let (day, passed) = db::local_clock();
        Self {
            day,
            ms,
            day_start_ms: ms - passed,
        }
    }
}

/// 本进程的可执行文件名：浮笺只是贴在别人上面的便签，不把自己算进使用时间。
fn own_process() -> &'static str {
    static OWN: OnceLock<String> = OnceLock::new();
    OWN.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default()
    })
}

/// 取当前前台应用的进程名；取不到、或前台就是浮笺自己时返回 None。
#[cfg(target_os = "windows")]
fn foreground_app() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    // 系统覆盖层（Alt+Tab 切换器、任务视图）不是「在用某个应用」：
    // 切换期间属于操作间隙，不该记到任何应用头上（会话就此暂停）。
    if crate::foreground::is_shell_overlay(hwnd) {
        return None;
    }
    let name = crate::foreground::process_name(hwnd);
    if name.is_empty() || name == "(unknown)" || name == own_process() {
        return None;
    }
    if AWAY_PROCESSES.iter().any(|p| name.eq_ignore_ascii_case(p)) {
        return None;
    }
    Some(name)
}

#[cfg(not(target_os = "windows"))]
fn foreground_app() -> Option<String> {
    None
}
