import { useRef, useState } from "react";

/** 一个可被 TabBar 渲染的条目（仅含 UI 所需的最小字段，业务数据由调用方持有）。 */
export interface TabBarItem {
  id: number;
  title: string;
}

interface Props {
  items: TabBarItem[];
  activeId: number;
  /** 单击切换 */
  onSwitch: (id: number) => void;
  /** 新增条目（新增后由调用方决定激活哪个） */
  onAdd: () => void;
  /** 重命名提交（title 已 trim，调用方负责兜底默认名） */
  onRename: (id: number, title: string) => void;
  /** 删除条目 */
  onDelete: (id: number) => void;
  /** 拖拽重排：把 fromId 移动到 toId 之前（toId 为 null 表示放到末尾）。 */
  onReorder?: (fromId: number, toId: number | null) => void;
  /** 新增按钮的提示文案 */
  addTitle?: string;
  /** 重命名输入框失焦/回车时若为空使用的默认名（仅用于 UI 兜底展示） */
  defaultTitle?: string;
}

/**
 * 通用标签/分类栏：单击切换、双击重命名、右侧 + 新增、悬停出现删除按钮。
 * 组件与业务解耦——它只接收纯 id/title 列表与回调，不感知数据来自速记还是待办、
 * 也不感知底层如何持久化（调用方各自维护独立的 state 与存储）。
 */
export function TabBar({
  items,
  activeId,
  onSwitch,
  onAdd,
  onRename,
  onDelete,
  onReorder,
  addTitle = "新增",
  defaultTitle = "未命名",
}: Props) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  // 指针拖拽态：dragId 为正在拖动的条目；overId 为当前悬停的条目（用于插入提示）；
  // startX/startY 记录按下位置，moved 标记是否超过阈值（区分单击与拖拽）。
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const dragStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const overIdRef = useRef<number | null>(null);
  const movedRef = useRef(false);

  const DRAG_THRESHOLD = 5;

  const beginRename = (item: TabBarItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
  };

  const commitRename = () => {
    if (editingId !== null) {
      onRename(editingId, editTitle.trim() || defaultTitle);
    }
    setEditingId(null);
  };

  /** 结束拖拽：若发生移动且悬停目标有效，则提交重排。
   *  from/target 均从 ref 读取，避免快速拖动时 state 尚未刷新的时序问题。 */
  const finishDrag = () => {
    const moved = movedRef.current;
    const from = dragStart.current?.id ?? null;
    const target = overIdRef.current;
    setDragId(null);
    setOverId(null);
    dragStart.current = null;
    overIdRef.current = null;
    movedRef.current = false;
    if (from === null || !moved) return;
    // target 为 null 表示“放到末尾”，是合法语义，不应跳过；
    // 仅当目标就是自身（无意义重排）或缺少回调时跳过。
    if (target === from || !onReorder) return;
    onReorder(from, target);
  };

  /** 在 tab-bar 容器内，根据指针 X 找到插入目标 tab 的 id。
   *  返回某 tab 的 id 表示“插到该 tab 之前”；返回 null 表示“放到末尾”。
   *  规则：落在某 tab 左半 → 插到它前面；落在某 tab 右半 → 插到它后面
   *  （即返回下一个 tab 的 id，若已是最后一个则返回 null 放到末尾）。 */
  const findOverId = (clientX: number, container: HTMLElement): number | null => {
    const els = Array.from(
      container.querySelectorAll<HTMLElement>(".tab"),
    ).filter((el) => el.dataset.id);
    const ids = els.map((el) => Number(el.dataset.id));
    for (let i = 0; i < els.length; i++) {
      const rect = els[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return ids[i]; // 落在该 tab 左半 → 插到它前面
      }
      if (clientX <= rect.right) {
        // 落在该 tab 右半 → 插到它后面（下一个 tab 之前，或末尾）
        return i + 1 < ids.length ? ids[i + 1] : null;
      }
    }
    return null; // 越过所有 tab → 放到末尾
  };

  return (
    <div
      className="tab-bar"
      onPointerMove={(e) => {
        if (!dragStart.current) return;
        const dx = Math.abs(e.clientX - dragStart.current.x);
        const dy = Math.abs(e.clientY - dragStart.current.y);
        if (!movedRef.current && dx + dy > DRAG_THRESHOLD) {
          movedRef.current = true;
          setDragId(dragStart.current.id);
        }
        if (movedRef.current) {
          const target = findOverId(e.clientX, e.currentTarget);
          overIdRef.current = target;
          setOverId(target);
        }
      }}
      onPointerUp={() => {
        if (dragStart.current) finishDrag();
      }}
      onPointerLeave={() => {
        if (dragStart.current) finishDrag();
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-id={item.id}
          className={`tab ${item.id === activeId ? "active" : ""} ${
            dragId === item.id ? "dragging" : ""
          } ${overId === item.id && dragId !== null && dragId !== item.id ? "drag-over" : ""}`}
          onClick={() => onSwitch(item.id)}
          onDoubleClick={() => beginRename(item)}
          title="拖动可调整顺序，单击切换，双击重命名"
          onPointerDown={(e) => {
            if (editingId !== item.id) {
              dragStart.current = { id: item.id, x: e.clientX, y: e.clientY };
              movedRef.current = false;
            }
          }}
        >
          {editingId === item.id ? (
            <input
              className="tab-rename"
              autoFocus
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="tab-title">{item.title}</span>
              <span
                className="tab-del"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(item.id);
                }}
              >
                ×
              </span>
            </>
          )}
        </div>
      ))}
      <button
        className={`tab-add ${overId === null && dragId !== null ? "drag-over-end" : ""}`}
        onClick={onAdd}
        title={addTitle}
      >
        +
      </button>
    </div>
  );
}
