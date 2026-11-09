import { useCallback, useEffect, useRef, useState } from "react";
import {
  addLauncher,
  launchPath,
  listLaunchers,
  pickLauncherFile,
  removeLauncher,
  renameLauncher,
  reorderLaunchers,
  type LauncherItem,
} from "../lib/launchers";
import "./LauncherDock.css";

interface Props {
  edge: "left" | "right";
  /** 打开系统文件对话框期间挂起自动收起。 */
  holdAutoClose: (hold: boolean) => void;
  /** 与纸皮面板一起播放收起动画。 */
  closing: boolean;
}

/** 纸皮面板外侧的快捷栏：图标竖排可滚动，接续列表末尾的 + 添加，悬停出圆形删除叉。 */
export default function LauncherDock({ edge, holdAutoClose, closing }: Props) {
  const [items, setItems] = useState<LauncherItem[]>([]);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // 拖拽排序：与 TabBar 同一套 pointer events 契约，toPath 为 null 表示放到末尾。
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [overPath, setOverPath] = useState<string | null>(null);
  const dragStart = useRef<{ path: string; x: number; y: number } | null>(null);
  const overPathRef = useRef<string | null>(null);
  const movedRef = useRef(false);
  // 松手后浏览器还会派发一次 click，不抑制就会把"拖完"误当成"启动应用"。
  const suppressClickRef = useRef(false);

  const DRAG_THRESHOLD = 5;

  useEffect(() => {
    const refresh = () => {
      listLaunchers()
        .then(setItems)
        .catch((e) => console.error("[launchers] 加载失败:", e));
    };
    refresh();
    window.addEventListener("launcher-refresh", refresh);
    return () => window.removeEventListener("launcher-refresh", refresh);
  }, []);

  const add = useCallback(async () => {
    holdAutoClose(true);
    try {
      const path = await pickLauncherFile();
      if (!path) return;
      setItems(await addLauncher(path));
    } catch (e) {
      console.error("[launchers] 添加失败:", e);
    } finally {
      holdAutoClose(false);
    }
  }, [holdAutoClose]);

  const remove = useCallback(async (path: string) => {
    try {
      setItems(await removeLauncher(path));
    } catch (e) {
      console.error("[launchers] 删除失败:", e);
    }
  }, []);

  const launch = useCallback(async (path: string) => {
    try {
      await launchPath(path);
    } catch (e) {
      console.error("[launchers] 启动失败:", e);
    }
  }, []);

  const commitRename = useCallback(
    async (el: HTMLInputElement) => {
      if (editingPath === null) return;
      const path = editingPath;
      setEditingPath(null);
      try {
        setItems(await renameLauncher(path, el.value));
      } catch (e) {
        console.error("[launchers] 重命名失败:", e);
      }
    },
    [editingPath],
  );

  /** 竖排命中判定：落在某项上半 → 插到它前面；下半 → 插到它后面（越过最后一项为 null）。 */
  const findOverPath = (clientY: number, container: HTMLElement): string | null => {
    const els = Array.from(
      container.querySelectorAll<HTMLElement>(".launcher-item"),
    ).filter((el) => el.dataset.path);
    const paths = els.map((el) => el.dataset.path!);
    for (let i = 0; i < els.length; i++) {
      const rect = els[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return paths[i];
      if (clientY <= rect.bottom) {
        return i + 1 < paths.length ? paths[i + 1] : null;
      }
    }
    return null;
  };

  /** 收尾：from/target 都从 ref 读，避免快速拖动时 state 尚未刷新。 */
  const finishDrag = useCallback(() => {
    const moved = movedRef.current;
    const from = dragStart.current?.path ?? null;
    const target = overPathRef.current;
    setDragPath(null);
    setOverPath(null);
    dragStart.current = null;
    overPathRef.current = null;
    movedRef.current = false;
    if (from === null) return;
    if (moved) suppressClickRef.current = true;
    if (!moved || target === from) return;
    reorderLaunchers(from, target)
      .then(setItems)
      .catch((e) => console.error("[launchers] 排序保存失败:", e));
  }, []);

  return (
    <div className={`launcher-dock dock-${edge} ${closing ? "closing" : ""}`}>
      <div
        className="launcher-list"
        onPointerMove={(e) => {
          if (!dragStart.current) return;
          const dx = Math.abs(e.clientX - dragStart.current.x);
          const dy = Math.abs(e.clientY - dragStart.current.y);
          if (!movedRef.current && dx + dy > DRAG_THRESHOLD) {
            movedRef.current = true;
            setDragPath(dragStart.current.path);
          }
          if (movedRef.current) {
            const target = findOverPath(e.clientY, e.currentTarget);
            overPathRef.current = target;
            setOverPath(target);
          }
        }}
        onPointerUp={() => {
          if (dragStart.current) finishDrag();
        }}
        onPointerLeave={() => {
          if (dragStart.current) finishDrag();
        }}
      >
        {items.map((it) => (
          <div
            key={it.path}
            data-path={it.path}
            className={`launcher-item ${dragPath === it.path ? "dragging" : ""} ${
              overPath === it.path && dragPath !== null && dragPath !== it.path
                ? "drag-over"
                : ""
            }`}
          >
            <button
              className="launcher-icon"
              title={`${it.path}（拖动可排序）`}
              aria-label={`打开 ${it.name}`}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                void launch(it.path);
              }}
              onPointerDown={(e) => {
                // 只在图标上起拖：删除叉、文件名双击重命名都不参与拖拽。
                if (editingPath !== it.path) {
                  dragStart.current = { path: it.path, x: e.clientX, y: e.clientY };
                  movedRef.current = false;
                  suppressClickRef.current = false;
                }
              }}
            >
              {it.icon ? (
                <img src={it.icon} alt="" draggable={false} />
              ) : (
                <span className="launcher-fallback">{it.name.slice(0, 1)}</span>
              )}
            </button>
            <button
              className="launcher-remove"
              title="移除"
              aria-label={`移除 ${it.name}`}
              onClick={() => remove(it.path)}
            >
              ×
            </button>
            {editingPath === it.path ? (
              <input
                className="launcher-rename"
                autoFocus
                defaultValue={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={(e) => void commitRename(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename(e.currentTarget);
                  if (e.key === "Escape") {
                    e.stopPropagation(); // 别冒泡到 NotePanel 的 window 级 Escape 监听
                    setEditingPath(null);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="launcher-name"
                title={`${it.name}（双击重命名）`}
                onDoubleClick={() => {
                  setEditingPath(it.path);
                  setEditName(it.name);
                }}
              >
                {it.name}
              </span>
            )}
          </div>
        ))}
        <button
          className={`launcher-add ${
            overPath === null && dragPath !== null ? "drag-over-end" : ""
          }`}
          title="添加应用或文件"
          aria-label="添加应用或文件"
          onClick={add}
        >
          +
        </button>
      </div>
    </div>
  );
}
