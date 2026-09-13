use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tab {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: i64,
    pub title: String,
    pub todos: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistState {
    pub tabs: Vec<Tab>,
    pub active_tab_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryState {
    pub categories: Vec<Category>,
    pub active_category_id: i64,
}

/// 全局 SQLite 连接（应用生命周期内单例）。
static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

fn db() -> &'static Mutex<Connection> {
    DB.get().expect("database not initialized")
}

pub fn init_db(app: &tauri::App) {
    let db_path = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("notes.db");
    let conn = Connection::open(db_path).expect("open sqlite failed");

    // WAL：默认的回滚日志模式每次写入都要「建 journal → 两次 fsync → 删 journal」，
    // 慢盘或被安全软件扫到时，一次 fsync 偶发能卡到秒级——而数据库命令跑在主线程
    // （见 lib.rs 的约束注释），直接表现为界面掉帧。WAL 把写入变成追加日志，
    // 读不阻塞写、写不阻塞读，fsync 次数也大幅下降。
    // synchronous=NORMAL：WAL 下应用崩溃不会损坏数据库，只有整机掉电才有丢数据的可能。
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("enable wal failed");
    conn.pragma_update(None, "synchronous", "NORMAL")
        .expect("set synchronous failed");
    // 采样线程与命令可能同时写库：取不到锁时排队等 5 秒，不要立刻报错。
    conn.busy_timeout(Duration::from_millis(5000))
        .expect("set busy_timeout failed");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            note TEXT NOT NULL,
            todos TEXT NOT NULL DEFAULT '[]'
        )",
        [],
    )
    .expect("create notes table failed");

    // ensure the single note row exists
    let cnt: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes WHERE id = 1", [], |r| r.get(0))
        .unwrap_or(0);
    if cnt == 0 {
        conn.execute(
            "INSERT INTO notes (id, note, todos) VALUES (1, '', '[]')",
            [],
        )
        .expect("insert default note failed");
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS tabs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT '速记',
            content TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .expect("create tabs table failed");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT '主要',
            todos TEXT NOT NULL DEFAULT '[]',
            position INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .expect("create categories table failed");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )
    .expect("create meta table failed");

    // migrate legacy single note into the first tab (only once)
    let migrated: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM meta WHERE key = 'migrated_notes'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if migrated == 0 {
        let existing_tabs: i64 = conn
            .query_row("SELECT COUNT(*) FROM tabs", [], |r| r.get(0))
            .unwrap_or(0);
        if existing_tabs == 0 {
            let content: String = conn
                .query_row(
                    "SELECT note FROM notes WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            conn.execute(
                "INSERT INTO tabs (title, content, position) VALUES ('速记', ?1, 0)",
                rusqlite::params![content],
            )
            .expect("migrate legacy note failed");
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('active_tab_id', '1')",
                [],
            )
            .expect("set default active tab failed");
        }
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('migrated_notes', '1')",
            [],
        )
        .expect("mark migrated failed");
    }

    // 初始化待办分类：默认“主要”分类；若第一个标签页里还残留旧待办，将其迁到“主要”分类。
    let migrated_cat: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM meta WHERE key = 'migrated_categories'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if migrated_cat == 0 {
        let existing_cat: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))
            .unwrap_or(0);
        if existing_cat == 0 {
            // 取出旧单文档版本里残留的待办，迁移到“主要”分类（待办已解耦到分类）。
            let legacy_todos: String = conn
                .query_row(
                    "SELECT todos FROM notes WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or("[]".to_string());
            conn.execute(
                "INSERT INTO categories (title, todos, position) VALUES ('主要', ?1, 0)",
                rusqlite::params![legacy_todos],
            )
            .expect("insert default category failed");
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('active_category_id', '1')",
                [],
            )
            .expect("set default active category failed");
        }
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('migrated_categories', '1')",
            [],
        )
        .expect("mark migrated categories failed");
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS usage_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day TEXT NOT NULL,
            app TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL
        )",
        [],
    )
    .expect("create usage_sessions table failed");

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_sessions_day ON usage_sessions(day)",
        [],
    )
    .expect("create usage_sessions index failed");

    // 使用统计只展示当天，历史留 30 天足够；再老的清掉，避免 notes.db 无谓变大。
    conn.execute(
        "DELETE FROM usage_sessions WHERE day < date('now', 'localtime', '-30 days')",
        [],
    )
    .ok();

    // 存入全局单例；若之前已初始化则忽略（理论不会）。
    let _ = DB.set(Mutex::new(conn));
}

pub fn load_state() -> PersistState {
    let conn = db().lock().unwrap();

    let tabs = conn
        .prepare("SELECT id, title, content, position FROM tabs ORDER BY position ASC")
        .unwrap()
        .query_map([], |row| {
            Ok(Tab {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                position: row.get(3)?,
            })
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect::<Vec<_>>();

    let active_tab_id: i64 = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'active_tab_id'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(1);

    let active_tab_id = if tabs.iter().any(|t| t.id == active_tab_id) {
        active_tab_id
    } else {
        tabs.first().map(|t| t.id).unwrap_or(1)
    };

    PersistState {
        tabs,
        active_tab_id,
    }
}

#[derive(Debug, Deserialize)]
pub struct TabInput {
    pub id: i64,
    pub title: String,
    pub content: String,
}

/// 全量替换表中的实体：先 DELETE 再按 position 重新 INSERT（同一事务内完成）。
/// 空列表直接跳过（保护：禁止清空整个表，避免启动竞态或误覆盖）。
fn replace_all<T>(
    conn: &mut Connection,
    table: &str,
    rows: &[T],
    insert: impl Fn(&mut Transaction<'_>, usize, &T) -> rusqlite::Result<()>,
) {
    if rows.is_empty() {
        return;
    }
    let mut tx = conn.transaction().expect("begin tx failed");
    tx.execute(&format!("DELETE FROM {table}"), []).ok();
    for (pos, row) in rows.iter().enumerate() {
        insert(&mut tx, pos, row).expect("insert failed");
    }
    tx.commit().expect("commit tx failed");
}

pub fn save_tabs(tabs: Vec<TabInput>) {
    replace_all(&mut db().lock().unwrap(), "tabs", &tabs, |tx, pos, t| {
        tx.execute(
            "INSERT INTO tabs (id, title, content, position) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, position=excluded.position",
            rusqlite::params![t.id, t.title, t.content, pos as i64],
        )
        .map(|_| ())
    });
}

pub fn set_active_tab(tab_id: i64) {
    let conn = db().lock().unwrap();
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('active_tab_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![tab_id.to_string()],
    )
    .expect("set active tab failed");
}

// ---- 待办分类（与速记标签页平行的独立持久化模型）----

#[derive(Debug, Deserialize)]
pub struct CategoryInput {
    pub id: i64,
    pub title: String,
    pub todos: String,
}

pub fn load_categories() -> CategoryState {
    let conn = db().lock().unwrap();

    let categories = conn
        .prepare("SELECT id, title, todos, position FROM categories ORDER BY position ASC")
        .unwrap()
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                title: row.get(1)?,
                todos: row.get(2)?,
                position: row.get(3)?,
            })
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect::<Vec<_>>();

    let active_category_id: i64 = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'active_category_id'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(1);

    let active_category_id = if categories.iter().any(|c| c.id == active_category_id) {
        active_category_id
    } else {
        categories.first().map(|c| c.id).unwrap_or(1)
    };

    CategoryState {
        categories,
        active_category_id,
    }
}

pub fn save_categories(categories: Vec<CategoryInput>) {
    replace_all(&mut db().lock().unwrap(), "categories", &categories, |tx, pos, c| {
        tx.execute(
            "INSERT INTO categories (id, title, todos, position) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, todos=excluded.todos, position=excluded.position",
            rusqlite::params![c.id, c.title, c.todos, pos as i64],
        )
        .map(|_| ())
    });
}

pub fn set_active_category(category_id: i64) {
    let conn = db().lock().unwrap();
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('active_category_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![category_id.to_string()],
    )
    .expect("set active category failed");
}

// ---- 应用使用统计（usage.rs 采样写入，面板只读当天）----

/// 一段连续使用：起止均为 Unix 毫秒，对应时间线上的一个区间。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSession {
    pub app: String,
    pub start: i64,
    pub end: i64,
}

/// 某个应用当天的累计使用时长。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageTotal {
    pub app: String,
    pub ms: i64,
}

/// 一天的使用数据：时间线用 sessions，饼图用 totals。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageDay {
    pub day: String,
    pub sessions: Vec<UsageSession>,
    pub totals: Vec<UsageTotal>,
}

/// 开一条新会话：起止都先记为 start，之后由 touch_session 续期。
pub fn open_session(day: &str, app: &str, start_ms: i64) -> i64 {
    let conn = db().lock().unwrap();
    conn.execute(
        "INSERT INTO usage_sessions (day, app, start_ms, end_ms) VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![day, app, start_ms],
    )
    .expect("insert usage session failed");
    conn.last_insert_rowid()
}

/// 把会话的结束时间推到 end_ms：采样续期与收尾共用一个入口。
pub fn touch_session(id: i64, end_ms: i64) {
    let conn = db().lock().unwrap();
    conn.execute(
        "UPDATE usage_sessions SET end_ms = ?1 WHERE id = ?2",
        rusqlite::params![end_ms, id],
    )
    .expect("update usage session failed");
}

/// 全部历史范围内的各应用总时长（面板可切到「全部」查看，与时间线的当天口径不同）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageTotals {
    pub totals: Vec<UsageTotal>,
    /// 有记录的首 / 末日期（"YYYY-MM-DD"）；没有任何记录时为空串。
    pub from_day: String,
    pub to_day: String,
}

/// 读全部历史：各应用累计总时长（降序）与有记录的日期范围。
pub fn load_usage_all() -> UsageTotals {
    let conn = db().lock().unwrap();

    let totals = conn
        .prepare(
            "SELECT app, SUM(end_ms - start_ms) FROM usage_sessions
             GROUP BY app ORDER BY SUM(end_ms - start_ms) DESC",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |row| {
                Ok(UsageTotal {
                    app: row.get(0)?,
                    ms: row.get(1)?,
                })
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    let (from_day, to_day): (String, String) = conn
        .query_row(
            "SELECT COALESCE(MIN(day), ''), COALESCE(MAX(day), '') FROM usage_sessions",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or_default();

    UsageTotals {
        totals,
        from_day,
        to_day,
    }
}

/// 本地「逻辑日」（"YYYY-MM-DD"）与「自该日起点已过的毫秒数」（秒精度）。
///
/// 一天以**凌晨 4 点**为界：熬夜到凌晨 3 点仍算前一天，更符合实际作息。
/// 时区换算交给 SQLite 的 `localtime` 修饰符，不自己处理夏令时。
/// 起点 = 把当前时刻减 4 小时后取当日零点再加 4 小时——这样凌晨 0~4 点会
/// 自然落到前一天的 04:00，不需要额外的分支判断。
pub fn local_clock() -> (String, i64) {
    let conn = db().lock().unwrap();
    let (day, secs): (String, i64) = conn
        .query_row(
            "SELECT date('now', 'localtime', '-4 hours'),
                    strftime('%s', 'now', 'localtime')
                    - strftime('%s', datetime('now', 'localtime', '-4 hours', 'start of day', '+4 hours'))",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or_default();
    (day, secs * 1000)
}

/// 合并「夹在中间的一小段」：A → B（很短）→ A 视为一直在用 A。
///
/// 典型场景是误触、或系统把焦点短暂抢走（弹窗、UAC、输入法切换）——不合并的话
/// 时间线会被切成三段，看起来像认真切过去用了另一个应用。
/// 命中则删掉中间会话、把前一段的结束时间续到现在，返回续期后的会话 id。
///
/// @param current_id 刚结束的中间会话（B）；@param max_gap_ms 判定「一小段」的上限。
pub fn merge_short_gap(
    day: &str,
    app: &str,
    now_ms: i64,
    max_gap_ms: i64,
    current_id: i64,
) -> Option<i64> {
    let mut conn = db().lock().unwrap();

    // 中间那段的时长：从它开始到此刻。
    let (cur_app, cur_start): (String, i64) = conn
        .query_row(
            "SELECT app, start_ms FROM usage_sessions WHERE id = ?1",
            rusqlite::params![current_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    // 前后本就是同一个应用时不算「夹在中间」；超过上限说明是真的用了一会儿。
    if cur_app == app || now_ms - cur_start > max_gap_ms {
        return None;
    }

    // 前一段（A）：同一天里 id 更小的最近一条。
    let (prev_id, prev_app): (i64, String) = conn
        .query_row(
            "SELECT id, app FROM usage_sessions WHERE day = ?1 AND id < ?2
             ORDER BY id DESC LIMIT 1",
            rusqlite::params![day, current_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    if prev_app != app {
        return None;
    }

    // 删掉中间段 + 续期前一段：两步要么都成，要么都不做。
    let tx = conn.transaction().expect("begin tx failed");
    tx.execute(
        "DELETE FROM usage_sessions WHERE id = ?1",
        rusqlite::params![current_id],
    )
    .ok()?;
    tx.execute(
        "UPDATE usage_sessions SET end_ms = ?1 WHERE id = ?2",
        rusqlite::params![now_ms, prev_id],
    )
    .ok()?;
    tx.commit().ok()?;

    Some(prev_id)
}

/// 读某一天的使用数据：会话区间（时间线）与各应用总时长（饼图，按时长降序）。
pub fn load_usage(day: &str) -> UsageDay {
    let conn = db().lock().unwrap();

    let sessions = conn
        .prepare(
            "SELECT app, start_ms, end_ms FROM usage_sessions
             WHERE day = ?1 ORDER BY start_ms ASC",
        )
        .and_then(|mut stmt| {
            stmt.query_map([day], |row| {
                Ok(UsageSession {
                    app: row.get(0)?,
                    start: row.get(1)?,
                    end: row.get(2)?,
                })
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    let totals = conn
        .prepare(
            "SELECT app, SUM(end_ms - start_ms) FROM usage_sessions
             WHERE day = ?1 GROUP BY app ORDER BY SUM(end_ms - start_ms) DESC",
        )
        .and_then(|mut stmt| {
            stmt.query_map([day], |row| {
                Ok(UsageTotal {
                    app: row.get(0)?,
                    ms: row.get(1)?,
                })
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    UsageDay {
        day: day.to_string(),
        sessions,
        totals,
    }
}
