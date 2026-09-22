import { memo, useEffect, useRef, useState } from "react";
import type { Category, Tab, Todo } from "../types";
import type { Edge } from "../lib/window";
import { PLANS_TAB_ID, type NearestInfo, type Plan } from "../lib/plans";
import { TabBar } from "./TabBar";
import PlansView from "./PlansView";

interface Props {
  note: string;
  todos: Todo[];
  tabs: Tab[];
  activeTabId: number;
  onContentChange: (content: string) => void;
  onAddTodo: (text: string) => void;
  onToggleTodo: (id: string) => void;
  onEditTodo: (id: string, text: string) => void;
  onEditTodoNote: (id: string, note: string) => void;
  onPriorityTodo: (id: string, priority: number) => void;
  onDeleteTodo: (id: string) => void;
  categories: Category[];
  activeCategoryId: number;
  onSwitchCategory: (id: number) => void;
  onAddCategory: () => void;
  onRenameCategory: (id: number, title: string) => void;
  onDeleteCategory: (id: number) => void;
  pinned: boolean;
  onTogglePin: () => void;
  muted: boolean; // 是否静音（头栏按钮切换）
  onToggleMute: () => void;
  onSwitchTab: (id: number) => void;
  onAddTab: () => void;
  onRenameTab: (id: number, title: string) => void;
  onDeleteTab: (id: number) => void;
  onReorderTab: (fromId: number, toId: number | null) => void;
  onReorderCategory: (fromId: number, toId: number | null) => void;
  onClose: () => void;
  closing: boolean;
  edge: Edge; // 当前贴附的边，决定面板动画从哪侧飘出
  idleOpacity: number; // 挂件闲置不透明度：面板开合动画的起始/结束不透明度
  onOpenSkin: () => void; // 打开皮肤选择面板
  onOpenFeatures: () => void; // 打开功能面板
  onOpenSettings: () => void; // 打开设置面板
  onOpenUsage: () => void; // 打开使用统计面板
  onOpenPlans: () => void; // 打开新增日程面板
  plans: Plan[]; // 全部日程（待办栏「日程」标签页的内容）
  onPlansChange: (plans: Plan[]) => void; // 日程增删改后同步给 App
  /** 最近一项日程（主页面日期行左侧显示）；无近期日程时为 null，整段隐藏。 */
  nearest: NearestInfo | null;
}

/** 回形针图标（品牌装饰）。 */
function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

/** 图钉图标（lucide 风格的内联 SVG，避免引入额外依赖）。 */
function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

/** 设置（齿轮）图标。 */
function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** 皮肤（调色板）图标。 */
function PaletteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r="1" />
      <circle cx="17.5" cy="10.5" r="1" />
      <circle cx="8.5" cy="7.5" r="1" />
      <circle cx="6.5" cy="12.5" r="1" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z" />
    </svg>
  );
}

/** 统计（柱状图）图标。 */
function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 16v-4" />
      <path d="M12 16V8" />
      <path d="M17 16v-8" />
    </svg>
  );
}

/** 功能（星芒）图标。 */
function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8L18 16z" />
    </svg>
  );
}

/** 音量图标：静音时在喇叭右侧画一个叉，开启时画声波。 */
function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      {muted ? (
        <>
          <path d="M22 9l-6 6" />
          <path d="M16 9l6 6" />
        </>
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}

/** 日历图标（新增日程入口）。 */
function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M8 2v4M16 2v4M3 10h18" />
    </svg>
  );
}

/** 根据优先级返回进度条颜色（1-5 绿、6-7 黄、8 橙、9-10 红）。 */
function priorityColor(p: number): string {
  if (p >= 9) return "#e2483d";
  if (p === 8) return "#f0883e";
  if (p >= 6) return "#e8c33a";
  return "#4caf6d";
}

function NotePanel({
  note,
  todos,
  tabs,
  activeTabId,
  onContentChange,
  onAddTodo,
  onToggleTodo,
  onEditTodo,
  onEditTodoNote,
  onPriorityTodo,
  onDeleteTodo,
  categories,
  activeCategoryId,
  onSwitchCategory,
  onAddCategory,
  onRenameCategory,
  onDeleteCategory,
  pinned,
  onTogglePin,
  onSwitchTab,
  onAddTab,
  onRenameTab,
  onDeleteTab,
  onReorderTab,
  onReorderCategory,
  onClose,
  closing,
  edge,
  idleOpacity,
  muted,
  onToggleMute,
  onOpenSkin,
  onOpenFeatures,
  onOpenSettings,
  onOpenUsage,
  onOpenPlans,
  plans,
  onPlansChange,
  nearest,
}: Props) {
  // 「日程」是待办栏里的系统标签页：选中时待办清单换成日程清单，速记区不动。
  const plansActive = activeCategoryId === PLANS_TAB_ID;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const todoInputRef = useRef<HTMLInputElement>(null);
  // 打开面板时取一次当前时间（日期印章 + 时钟），后台驻留期间不刷新。
  const [sealTime] = useState(() => new Date());
  // 当前正在编辑备注的任务 id 集合（点击任务行切换展开备注输入框）。
  const [editingNotes, setEditingNotes] = useState<Set<string>>(new Set());
  // 备注气泡：脱离 todo-list 的 overflow 裁切，用 fixed 定位在任务行上方。
  const [hoverNote, setHoverNote] = useState<{ text: string; rect: DOMRect } | null>(null);

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

  const commitTodo = (el: HTMLInputElement) => {
    // 直接读输入框 DOM 值：中文输入法组合结束后 DOM 才是完整中文，state 可能滞后。
    const text = el.value.trim();
    if (!text) return;
    onAddTodo(text);
    el.value = "";
  };

  const toggleNote = (id: string) => {
    setEditingNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      className={`panel-box dock-${edge} ${closing ? "closing" : ""}`}
      style={{ ["--idle-opacity" as string]: `${idleOpacity}` }}
    >
      {/* 撕纸边缘：比面板纸大一圈的深色底，沿手撕轮廓露出一圈厚度边 */}
      <div className="panel-edge" aria-hidden="true" />
      <div className="panel">
      <div className="panel-head">
        <span className="brand">
          <PaperclipIcon />
          <span>浮笺</span>
        </span>
        <div className="head-actions">
          <button
            className={`icon-btn pin-btn ${pinned ? "active" : ""}`}
            onClick={onTogglePin}
            title={pinned ? "已固定（点此取消固定）" : "固定面板（固定后不自动收起）"}
          >
            <PinIcon />
          </button>
          <button className="icon-btn" onClick={onOpenSkin} title="皮肤">
            <PaletteIcon />
          </button>
          <button className="icon-btn" onClick={onOpenFeatures} title="功能">
            <SparkleIcon />
          </button>
          <button className="icon-btn" onClick={onOpenUsage} title="使用统计">
            <ChartIcon />
          </button>
          <button className="icon-btn" onClick={onOpenPlans} title="日程">
            <CalendarIcon />
          </button>
          <button
            className={`icon-btn mute-btn ${muted ? "active" : ""}`}
            onClick={onToggleMute}
            title={muted ? "已静音（点此恢复音效）" : "静音（关闭音效）"}
          >
            <VolumeIcon muted={muted} />
          </button>
          <button className="icon-btn" onClick={onOpenSettings} title="设置">
            <SettingsIcon />
          </button>
          <button className="x" onClick={onClose} title="收起 (Esc)">
            ×
          </button>
        </div>

        {/* 日期印章：作为头栏的换行行（占满整行）紧贴按钮那排下方。
            若单独占一个面板 flex 项，面板的 8px gap 会在它上下各加一条，
            和速记区就会隔得很开。 */}
        <div className="note-seal-row">
          {/* 最近一项日程：借日期行左侧的空白显示，零额外高度；
              没有近期日程时整段不渲染，把这一行还给日期。 */}
          {nearest && (
            <span
              className="seal-plan"
              title={`${nearest.when}${nearest.time ? ` ${nearest.time}` : ""} ${nearest.text}（点击查看日程）`}
              onClick={() => onSwitchCategory(PLANS_TAB_ID)}
            >
              <span className="seal-plan-dot" aria-hidden />
              <span className="seal-plan-when">{nearest.when}</span>
              {nearest.time && <span className="seal-plan-time">{nearest.time}</span>}
              <span className="seal-plan-text">{nearest.text}</span>
            </span>
          )}
          <span className="date-seal">
            {sealTime.getFullYear()}.
            {String(sealTime.getMonth() + 1).padStart(2, "0")}.
            {String(sealTime.getDate()).padStart(2, "0")}
          </span>
          <span className="week-seal">
            周{["日", "一", "二", "三", "四", "五", "六"][sealTime.getDay()]}
          </span>
          <span className="time-seal">
            {String(sealTime.getHours()).padStart(2, "0")}:
            {String(sealTime.getMinutes()).padStart(2, "0")}
          </span>
        </div>
      </div>

      {/* 速记标签页：复用通用 TabBar（双击重命名、单击切换、+ 新增、悬停删除） */}
      <TabBar
        items={tabs}
        activeId={activeTabId}
        onSwitch={onSwitchTab}
        onAdd={onAddTab}
        onRename={onRenameTab}
        onDelete={onDeleteTab}
        onReorder={onReorderTab}
        addTitle="新增标签页"
        defaultTitle="浮笺"
        title="速记"
      />

      <textarea
        key={activeTabId}
        ref={taRef}
        className="content"
        defaultValue={note}
        placeholder="写点什么…"
        onChange={(e) => onContentChange(e.target.value)}
      />

      {/* 待办分类：同样复用通用 TabBar，数据与速记完全独立存储。
          其中「日程」是系统标签页，与分类并列但不可改名/删除。 */}
      <TabBar
        items={categories.map((c) => ({ ...c, system: c.id === PLANS_TAB_ID }))}
        activeId={activeCategoryId}
        onSwitch={onSwitchCategory}
        onAdd={onAddCategory}
        onRename={onRenameCategory}
        onDelete={onDeleteCategory}
        onReorder={onReorderCategory}
        addTitle="新增分类"
        defaultTitle="分类"
        title="待办"
      />

      {/* 选中「日程」系统标签页时，这块区域换成日程清单（只看与删）；
          速记区照常在上面，切标签不会像换页一样把整块内容换掉。 */}
      {plansActive ? (
        <PlansView plans={plans} onChange={onPlansChange} />
      ) : (
        <>
          <div className="todo-list">
        {todos.map((t) => {
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
                  defaultValue={t.text}
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
                  defaultValue={t.note}
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
          ref={todoInputRef}
          className="todo-input"
          defaultValue=""
          placeholder="添加任务…"
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTodo(e.currentTarget);
          }}
        />
        <button
          className="todo-add-btn"
          onClick={() => {
            if (todoInputRef.current) commitTodo(todoInputRef.current);
          }}
        >
          添加
        </button>
          </div>
        </>
      )}

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
    </div>
  );
}

export default memo(NotePanel);
