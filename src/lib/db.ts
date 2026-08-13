import { invoke } from "@tauri-apps/api/core";
import type { Note, Todo } from "../types";

/** Shape as it comes from the Rust backend (todos is a JSON string). */
interface RawNote {
  id: number;
  content: string;
  todos: string;
  created_at: number;
  updated_at: number;
}

/** Parse the raw backend note into the frontend model (todos JSON -> array). */
function parseNote(raw: RawNote): Note {
  let todos: Todo[] = [];
  try {
    const parsed = JSON.parse(raw.todos);
    if (Array.isArray(parsed)) todos = parsed;
  } catch {
    todos = [];
  }
  return { ...raw, todos };
}

/** Client-side gateway to the Rust note repository (SQLite). */
export class NoteRepository {
  /** Load the single saved note document, or null if none exists yet. */
  async load(): Promise<Note | null> {
    const raw = await invoke<RawNote | null>("load_note");
    return raw ? parseNote(raw) : null;
  }

  /** Insert or update the note document. Serializes todos to JSON for the backend. */
  save(note: Note): Promise<Note> {
    const raw: RawNote = { ...note, todos: JSON.stringify(note.todos) };
    return invoke<Note>("save_note", { note: raw });
  }
}
