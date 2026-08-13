import { invoke } from "@tauri-apps/api/core";
import type { Note } from "../types";

/** Client-side gateway to the Rust note repository (SQLite). */
export class NoteRepository {
  loadAll(): Promise<Note[]> {
    return invoke<Note[]>("load_notes");
  }

  save(note: Note): Promise<Note> {
    return invoke<Note>("save_note", { note });
  }

  delete(id: number): Promise<void> {
    return invoke("delete_note", { id });
  }
}
