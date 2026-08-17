import { useState } from "react";

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
  addTitle = "新增",
  defaultTitle = "未命名",
}: Props) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");

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

  return (
    <div className="tab-bar">
      {items.map((item) => (
        <div
          key={item.id}
          className={`tab ${item.id === activeId ? "active" : ""}`}
          onClick={() => onSwitch(item.id)}
          onDoubleClick={() => beginRename(item)}
          title="单击切换，双击重命名"
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
      <button className="tab-add" onClick={onAdd} title={addTitle}>
        +
      </button>
    </div>
  );
}
