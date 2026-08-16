use std::sync::{Mutex, OnceLock};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tab {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub todos: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistState {
    pub tabs: Vec<Tab>,
    pub active_tab_id: i64,
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
            todos TEXT NOT NULL DEFAULT '[]',
            position INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .expect("create tabs table failed");

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
            let (content, todos): (String, String) = conn
                .query_row(
                    "SELECT note, todos FROM notes WHERE id = 1",
                    [],
                    |r| Ok((r.get(0).unwrap_or_default(), r.get(1).unwrap_or_default())),
                )
                .unwrap_or(("".to_string(), "[]".to_string()));
            conn.execute(
                "INSERT INTO tabs (title, content, todos, position) VALUES ('速记', ?1, ?2, 0)",
                rusqlite::params![content, todos],
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

    // 存入全局单例；若之前已初始化则忽略（理论不会）。
    let _ = DB.set(Mutex::new(conn));
}

pub fn load_state() -> PersistState {
    let conn = db().lock().unwrap();

    let tabs = conn
        .prepare("SELECT id, title, content, todos, position FROM tabs ORDER BY position ASC")
        .unwrap()
        .query_map([], |row| {
            Ok(Tab {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                todos: row.get(3)?,
                position: row.get(4)?,
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
    pub todos: String,
}

pub fn save_tabs(tabs: Vec<TabInput>) {
    // 保护：禁止用空列表清空整个标签页库（避免启动竞态或误覆盖）。
    if tabs.is_empty() {
        return;
    }
    let conn = db().lock().unwrap();
    conn.execute("DELETE FROM tabs", []).ok();

    for (pos, t) in tabs.iter().enumerate() {
        conn.execute(
            "INSERT INTO tabs (id, title, content, todos, position) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, todos=excluded.todos, position=excluded.position",
            rusqlite::params![t.id, t.title, t.content, t.todos, pos as i64],
        )
        .expect("save tab failed");
    }
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
