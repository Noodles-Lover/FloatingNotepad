use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// Domain entity: a single note row persisted in SQLite.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Note {
    pub id: i64,
    pub content: String,
    /// To-do list, serialized as a JSON array (SQLite has no array type).
    pub todos: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Repository encapsulating every SQLite access for notes.
/// Holds the app handle so callers never deal with connection paths.
pub struct NoteRepository {
    app: tauri::AppHandle,
}

impl NoteRepository {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    fn db_path(&self) -> PathBuf {
        let dir = self
            .app
            .path()
            .app_data_dir()
            .expect("could not resolve app data dir");
        std::fs::create_dir_all(&dir).ok();
        dir.join("notes.db")
    }

    fn connect(&self) -> Result<Connection, rusqlite::Error> {
        Connection::open(self.db_path())
    }

    /// Create the notes table if it does not exist yet, and migrate legacy
    /// schemas (pre-todos) by adding the missing `todos` column. Called once
    /// at startup.
    pub fn init(&self) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "create table if not exists notes (
                id integer primary key,
                content text not null default '',
                todos text not null default '[]',
                created_at integer not null,
                updated_at integer not null
            )",
            [],
        )?;
        // 兼容旧版本：若表是早期带 title 列的 schema，补上 todos 列。
        let has_todos: bool = conn.query_row(
            "select count(*) from pragma_table_info('notes') where name = 'todos'",
            [],
            |r| r.get(0),
        )?;
        if !has_todos {
            conn.execute("alter table notes add column todos text not null default '[]'", [])?;
        }
        Ok(())
    }

    /// Load the single note document (id = 1). Returns None if never saved.
    pub fn load(&self) -> Result<Option<Note>, rusqlite::Error> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "select id, content, todos, created_at, updated_at \
             from notes where id = 1",
        )?;
        let mut rows = stmt.query_map([], |r| {
            Ok(Note {
                id: r.get(0)?,
                content: r.get(1)?,
                todos: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Insert or update the single note document. The frontend always passes
    /// id = 1, so this is an upsert on the primary key.
    pub fn save(&self, mut note: Note) -> Result<Note, rusqlite::Error> {
        let conn = self.connect()?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        conn.execute(
            "insert into notes (id, content, todos, created_at, updated_at) \
             values (?, ?, ?, ?, ?) \
             on conflict(id) do update set \
               content = excluded.content, \
               todos = excluded.todos, \
               updated_at = excluded.updated_at",
            params![note.id, note.content, note.todos, now, now],
        )?;
        note.updated_at = now;
        if note.id <= 0 {
            note.id = 1;
        }
        Ok(note)
    }
}
