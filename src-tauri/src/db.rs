use std::sync::{Mutex, OnceLock};
use rusqlite::Connection;
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

pub fn save_tabs(tabs: Vec<TabInput>) {
    // 保护：禁止用空列表清空整个标签页库（避免启动竞态或误覆盖）。
    if tabs.is_empty() {
        return;
    }
    let mut conn = db().lock().unwrap();
    let tx = conn.transaction().expect("begin tx failed");
    tx.execute("DELETE FROM tabs", []).ok();

    for (pos, t) in tabs.iter().enumerate() {
        tx.execute(
            "INSERT INTO tabs (id, title, content, position) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, position=excluded.position",
            rusqlite::params![t.id, t.title, t.content, pos as i64],
        )
        .expect("save tab failed");
    }
    tx.commit().expect("commit tx failed");
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
    // 保护：禁止用空列表清空整个分类库（避免启动竞态或误覆盖）。
    if categories.is_empty() {
        return;
    }
    let mut conn = db().lock().unwrap();
    let tx = conn.transaction().expect("begin tx failed");
    tx.execute("DELETE FROM categories", []).ok();

    for (pos, c) in categories.iter().enumerate() {
        tx.execute(
            "INSERT INTO categories (id, title, todos, position) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, todos=excluded.todos, position=excluded.position",
            rusqlite::params![c.id, c.title, c.todos, pos as i64],
        )
        .expect("save category failed");
    }
    tx.commit().expect("commit tx failed");
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
