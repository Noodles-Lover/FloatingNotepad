//! 日程 / 待办：一次性任务（某天）与周常任务（每周几），可按时刻提醒。
//!
//! 数据落在 `plans` 表（见 db.rs）；提醒线程每分钟比一次，命中的任务走**系统通知**
//! （音效仍由主窗口播放）——全屏/游戏时要不要打扰用户交给系统判断，比自己画弹窗可靠。
//! 没有「完成」概念：任务只是带日期时间列出来，不需要了就删掉。

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::{chime, db, log, notify};

/// 提醒通知的标题。
const NOTIFY_TITLE: &str = "浮笺 · 日程";

/// 一天的毫秒数与一分钟的毫秒数。
const MIN_MS: i64 = 60_000;

/// 日程的运行时状态。
pub struct PlanState {
    /// 提醒总开关（功能面板控制，作用于全部任务——不逐条设置）。
    pub notify: AtomicBool,
    /// 上一次提醒落在哪一分钟（Unix 分钟）。睡眠唤醒后可能同一分钟被唤醒多次，
    /// 用它保证一分钟最多弹一次。
    last_fire_min: AtomicI64,
}

impl PlanState {
    pub fn new() -> Self {
        Self {
            notify: AtomicBool::new(false),
            last_fire_min: AtomicI64::new(-1),
        }
    }
}

/// 启动提醒线程：睡到下一个整分，比一次到点的任务。
pub fn start(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(std::time::Duration::from_millis(ms_until_next_minute()));
        if !app.state::<PlanState>().notify.load(Ordering::SeqCst) {
            continue;
        }
        if let Err(e) = fire_due(&app) {
            log::write(&app, "plans", &format!("提醒失败: {e}"));
        }
    });
}

/// 距下一个整分还有多少毫秒（末尾多等 250ms，避免秒级误差导致提前触发）。
fn ms_until_next_minute() -> u64 {
    let (_, _, second) = db::local_time();
    (60 - second).max(0) as u64 * 1000 + 250
}

/// 弹出当前这一分钟到点的任务。时间为空的任务不提醒（用户没给时刻）。
fn fire_due(app: &AppHandle) -> Result<(), String> {
    // 同一分钟只弹一次：唤醒补跑、线程抖动都不该让小窗连弹两回。
    let minute = (now_millis() / MIN_MS) as i64;
    let state = app.state::<PlanState>();
    if state.last_fire_min.swap(minute, Ordering::SeqCst) == minute {
        return Ok(());
    }

    // 日程用的是真实日历日（00:00 换日），不是使用统计那套 4 点日界。
    let now = chime::now_hhmm();
    let day = db::local_day();
    let weekday = db::local_weekday();
    let due: Vec<String> = db::load_plans()
        .into_iter()
        .filter(|p| {
            if p.time.as_deref() != Some(now.as_str()) {
                return false;
            }
            match p.kind.as_str() {
                "once" => p.date.as_deref() == Some(day.as_str()),
                "weekly" => p.weekday == Some(weekday),
                _ => false,
            }
        })
        .map(|p| p.text)
        .collect();

    if due.is_empty() {
        return Ok(());
    }
    crate::log::write(app, "plans", &format!("到点命中 {} 条", due.len()));
    // 同一分钟多条：合并成一条通知，逐行显示，避免后一条把前一条顶掉。
    remind(app, &due.join("\n"), &now)
}

/// 立刻发一条测试提醒（挂件右键菜单）：不用等到点就能确认通知能不能弹出来。
pub fn test(app: &AppHandle) -> Result<(), String> {
    let (now, _, _) = db::local_time();
    remind(app, "（测试提醒）", &now)
}

/// 发一条任务提醒：系统通知负责画面，主窗口负责音效。
fn remind(app: &AppHandle, text: &str, time: &str) -> Result<(), String> {
    // 音效与报时同一套（主窗口代播）；系统通知自带的提示音是系统行为。
    let _ = app.emit("plan-due", ());
    notify::send(app, NOTIFY_TITLE, &format!("{time}  {text}"))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 写入提醒开关（日程面板在加载配置与改动时调用）。留痕：开关状态看不出来，
/// 而「没弹通知」最常见的原因就是它其实是关的。
pub fn apply(app: &AppHandle, enabled: bool) {
    // 只在真正变化时留痕：本函数在每次设置改动时都会被调用（前端全量同步配置），
    // 无条件写日志会被拖动滑块之类的高频改动刷屏。
    let prev = app
        .state::<PlanState>()
        .notify
        .swap(enabled, Ordering::SeqCst);
    if prev != enabled {
        log::write(
            app,
            "plans",
            &format!("任务提醒开关: {}", if enabled { "开" } else { "关" }),
        );
    }
}
