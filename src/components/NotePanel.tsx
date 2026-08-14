import { useEffect, useRef, useState } from "react";
import type { Note } from "../types";
import type { Edge } from "../lib/window";

interface Props {
  note: Note;
  onContentChange: (content: string) => void;
  onAddTodo: (text: string) => void;
  onToggleTodo: (id: string) => void;
  onEditTodo: (id: string, text: string) => void;
  onEditTodoNote: (id: string, note: string) => void;
  onPriorityTodo: (id: string, priority: number) => void;
  onDeleteTodo: (id: string) => void;
  onClose: () => void;
  closing: boolean;
  edge: Edge; // 当前贴附的边，决定面板动画从哪侧飘出
  onOpenSkin: () => void; // 打开皮肤选择面板
  onOpenSettings: () => void; // 打开设置面板
}

/** 根据优先级返回进度条颜色（1-5 绿、6-7 黄、8 橙、9-10 红）。 */
function priorityColor(p: number): string {
  if (p >= 9) return "#e2483d";
  if (p === 8) return "#f0883e";
  if (p >= 6) return "#e8c33a";
  return "#4caf6d";
}

export default function NotePanel({
  note,
  onContentChange,
  onAddTodo,
  onToggleTodo,
  onEditTodo,
  onEditTodoNote,
  onPriorityTodo,
  onDeleteTodo,
  onClose,
  closing,
  edge,
  onOpenSkin,
  onOpenSettings,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 新增任务的输入框（本地态，回车或点“添加”后清空并上抛）。
  const [newText, setNewText] = useState("");
  // 当前正在编辑备注的任务 id 集合（点击任务行切换展开备注输入框）。
  const [editingNotes, setEditingNotes] = useState<Set<string>>(new Set());

  const toggleNote = (id: string) => {
    setEditingNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  // 备注气泡：脱离 todo-list 的 overflow 裁切，用 fixed 定位在任务行上方。
  const [hoverNote, setHoverNote] = useState<{ text: string; rect: DOMRect } | null>(null);

  return (
    <div className={`panel dock-${edge} ${closing ? "closing" : ""}`}>
      <div className="panel-head">
        <span>速记</span>
        <div className="head-actions">
          <button className="skin-btn" onClick={onOpenSkin} title="皮肤">
            皮肤
          </button>
          <button className="skin-btn" onClick={onOpenSettings} title="设置">
            设置
          </button>
          <button className="x" onClick={onClose} title="收起 (Esc)">
            ×
          </button>
        </div>
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
        {note.todos.map((t) => {
          const color = priorityColor(t.priority);
          const editing = editingNotes.has(t.id);
          return (
            <div className={`todo ${t.done ? "done" : ""}`} key={t.id}>
              <div
                className="todo-main"
                onMouseEnter={(e) =>
                  t.note && !editing && setHoverNote({ text: t.note, rect: e.currentTarget.getBoundingClientRect() })
                }
                onMouseLeave={() => setHoverNote(null)}
              >
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
                  className={`todo-note-btn ${t.note ? "has" : ""}`}
                  onClick={() => toggleNote(t.id)}
                  title="备注"
                >
                  ✎
                </button>
                <div className="prio">
                  <button
                    className="prio-step"
                    onClick={() => onPriorityTodo(t.id, t.priority - 1)}
                    title="降低优先级"
                    disabled={t.priority <= 1}
                  >
                    −
                  </button>
                  <span className="prio-num" style={{ color }}>
                    {t.priority}
                  </span>
                  <button
                    className="prio-step"
                    onClick={() => onPriorityTodo(t.id, t.priority + 1)}
                    title="提高优先级"
                    disabled={t.priority >= 10}
                  >
                    +
                  </button>
                  <span className="prio-bar" aria-hidden>
                    <span
                      className="prio-fill"
                      style={{ width: `${(t.priority / 10) * 100}%`, background: color }}
                    />
                  </span>
                </div>
                <button
                  className="todo-del"
                  onClick={() => onDeleteTodo(t.id)}
                  title="删除"
                >
                  ×
                </button>
              </div>
              {editing && (
                <textarea
                  className="todo-note-input"
                  value={t.note}
                  placeholder="备注…"
                  autoFocus
                  onChange={(e) => onEditTodoNote(t.id, e.target.value)}
                />
              )}
            </div>
          );
        })}
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

      {/* 备注气泡：fixed 定位，脱离列表裁切，显示在任务行上方 */}
      {hoverNote && (
        <div
          className="todo-note-pop"
          style={{
            left: hoverNote.rect.left + hoverNote.rect.width / 2,
            top: hoverNote.rect.top - 8,
          }}
        >
          {hoverNote.text}
        </div>
      )}
    </div>
  );
}
