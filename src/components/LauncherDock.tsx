import { useCallback, useEffect, useState } from "react";
import {
  addLauncher,
  launchPath,
  listLaunchers,
  pickLauncherFile,
  removeLauncher,
  renameLauncher,
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

  return (
    <div className={`launcher-dock dock-${edge} ${closing ? "closing" : ""}`}>
      <div className="launcher-list">
        {items.map((it) => (
          <div className="launcher-item" key={it.path}>
            <button
              className="launcher-icon"
              title={it.path}
              aria-label={`打开 ${it.name}`}
              onClick={() => launch(it.path)}
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
          className="launcher-add"
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
