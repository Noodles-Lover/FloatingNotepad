use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// Domain entity: a single note row persisted in SQLite.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub content: String,
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

    /// Create the notes table if it does not exist yet. Called once at startup.
    pub fn init(&self) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "create table if not exists notes (
                id integer primary key autoincrement,
                title text not null default '',
                content text not null default '',
                created_at integer not null,
                updated_at integer not null
            )",
            [],
        )?;
        Ok(())
    }

    pub fn load_all(&self) -> Result<Vec<Note>, rusqlite::Error> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "select id, title, content, created_at, updated_at \
             from notes order by updated_at desc",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Note {
                id: r.get(0)?,
                title: r.get(1)?,
                content: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Insert when id <= 0, otherwise update. Returns the persisted row
    /// (with a freshly assigned id on insert).
    pub fn save(&self, mut note: Note) -> Result<Note, rusqlite::Error> {
        let conn = self.connect()?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        if note.id <= 0 {
            conn.execute(
                "insert into notes (title, content, created_at, updated_at) values (?, ?, ?, ?)",
                params![note.title, note.content, now, now],
            )?;
            note.id = conn.last_insert_rowid();
            note.created_at = now;
            note.updated_at = now;
        } else {
            conn.execute(
                "update notes set title = ?, content = ?, updated_at = ? where id = ?",
                params![note.title, note.content, now, note.id],
            )?;
            note.updated_at = now;
        }
        Ok(note)
    }

    pub fn delete(&self, id: i64) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute("delete from notes where id = ?", params![id])?;
        Ok(())
    }
}
