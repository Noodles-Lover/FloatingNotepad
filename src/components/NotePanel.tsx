import { useEffect, useRef, useState } from "react";
import type { Note } from "../types";
import type { Edge } from "../lib/window";

interface Props {
  note: Note;
  onContentChange: (content: string) => void;
  onAddTodo: (text: string) => void;
  onToggleTodo: (id: string) => void;
  onEditTodo: (id: string, text: string) => void;
  onDeleteTodo: (id: string) => void;
  onClose: () => void;
  closing: boolean;
  edge: Edge; // 当前贴附的边，决定面板动画从哪侧飘出
}

export default function NotePanel({
  note,
  onContentChange,
  onAddTodo,
  onToggleTodo,
  onEditTodo,
  onDeleteTodo,
  onClose,
  closing,
  edge,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 新增任务的输入框（本地态，回车或点“添加”后清空并上抛）。
  const [newText, setNewText] = useState("");

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commitTodo = () => {
    const text = newText.trim();
    if (!text) return;
    onAddTodo(text);
    setNewText("");
  };

  return (
    <div className={`panel dock-${edge} ${closing ? "closing" : ""}`}>
      <div className="panel-head">
        <span>速记</span>
        <button className="x" onClick={onClose} title="收起 (Esc)">
          ×
        </button>
      </div>

      <textarea
        ref={taRef}
        className="content"
        value={note.content}
        placeholder="写点什么…"
        onChange={(e) => onContentChange(e.target.value)}
      />

      <div className="todo-head">待办</div>
      <div className="todo-list">
        {note.todos.map((t) => (
          <div className={`todo ${t.done ? "done" : ""}`} key={t.id}>
            <input
              type="checkbox"
              checked={t.done}
              onChange={() => onToggleTodo(t.id)}
            />
            <input
              className="todo-text"
              value={t.text}
              onChange={(e) => onEditTodo(t.id, e.target.value)}
            />
            <button
              className="todo-del"
              onClick={() => onDeleteTodo(t.id)}
              title="删除"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="todo-add">
        <input
          className="todo-input"
          value={newText}
          placeholder="添加任务…"
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTodo();
          }}
        />
        <button className="todo-add-btn" onClick={commitTodo}>
          添加
        </button>
      </div>
    </div>
  );
}
