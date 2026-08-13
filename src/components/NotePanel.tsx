import { useEffect, useRef, useState } from "react";
import type { Note } from "../types";
import type { Edge } from "../lib/window";

interface Props {
  note: Note | null;
  notes: Note[];
  onSave: (note: Note) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
  onSelect: (note: Note) => void;
  closing: boolean;
  edge: Edge; // 当前贴附的边，决定面板动画从哪侧飘出
}

export default function NotePanel({
  note,
  notes,
  onSave,
  onDelete,
  onClose,
  onSelect,
  closing,
  edge,
}: Props) {
  const [title, setTitle] = useState(note?.title ?? "");
  const [content, setContent] = useState(note?.content ?? "");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTitle(note?.title ?? "");
    setContent(note?.content ?? "");
    taRef.current?.focus();
  }, [note?.id]);

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`panel dock-${edge} ${closing ? "closing" : ""}`}>
      <div className="panel-head">
        <span>速记</span>
        <button className="x" onClick={onClose} title="收起 (Esc)">
          ×
        </button>
      </div>
      <input
        className="title"
        value={title}
        placeholder="标题"
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        ref={taRef}
        className="content"
        value={content}
        placeholder="写点什么…"
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="panel-foot">
        <button className="del" onClick={() => note && onDelete(note.id)}>
          删除
        </button>
        <button className="save" onClick={() => note && onSave({ ...note, title, content })}>
          保存
        </button>
      </div>
      {notes.length > 0 && (
        <div className="list">
          {notes.map((n) => (
            <div
              key={n.id}
              className={`item ${n.id === note?.id ? "active" : ""}`}
              onClick={() => onSelect(n)}
            >
              <div className="item-title">{n.title || "无标题"}</div>
              <div className="item-sub">{n.content.slice(0, 24) || "—"}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
