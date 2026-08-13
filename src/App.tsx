import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WindowController, type Edge } from "./lib/window";
import { NoteRepository } from "./lib/db";
import { ProximitySensor } from "./lib/proximity";
import type { Note } from "./types";
import FloatingBall from "./components/FloatingBall";
import NotePanel from "./components/NotePanel";
import "./App.css";

/** 窗口的三种显示模式。 */
type Mode = "hidden" | "revealed" | "expanded";

/** 鼠标离开 UI 范围多久后自动收起（毫秒）。 */
const HIDE_DELAY = 600;
/** 收起动画时长（毫秒），动画结束后才真正卸载/隐藏。 */
const CLOSE_ANIM = 220;

export default function App() {
  // ---- 视图状态 ----
  const [mode, setMode] = useState<Mode>("hidden"); // 当前模式：隐藏 / 展示 / 展开面板
  const [closing, setClosing] = useState(false); // 是否正在播放收起动画
  const [edge, setEdge] = useState<Edge>("right"); // 悬浮球当前贴附的边
  const [dragging, setDragging] = useState(false); // 悬浮球是否正在被拖动
  const [notes, setNotes] = useState<Note[]>([]); // 所有笔记列表
  const [active, setActive] = useState<Note | null>(null); // 当前正在编辑的笔记

  // ---- 跨渲染周期保存的可变引用 ----
  const modeRef = useRef<Mode>("hidden"); // 让 proximity 回调能读到最新 mode
  const hideTimer = useRef<number | null>(null); // 自动收起的计时器
  const closeTimer = useRef<number | null>(null); // 收起动画的计时器
  const draggingRef = useRef(false); // 与 dragging 同步，供 proximity 读取

  modeRef.current = mode;

  // WindowController 与 NoteRepository 都是“只创建一次”的控制器实例。
  const windowCtlRef = useRef<WindowController | null>(null);
  if (!windowCtlRef.current) windowCtlRef.current = new WindowController();
  const windowCtl = windowCtlRef.current;

  const notesRepoRef = useRef<NoteRepository | null>(null);
  if (!notesRepoRef.current) notesRepoRef.current = new NoteRepository();
  const notesRepo = notesRepoRef.current;

  // ---- 定时器管理 ----
  const clearTimers = () => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  /** 真正执行“收起”：回到隐藏态并贴边停靠。 */
  const doClose = useCallback(() => {
    setMode("hidden");
    setClosing(false);
    setActive(null);
    windowCtl.dockHidden();
  }, [windowCtl]);

  /** 开始收起动画（自动隐藏和关闭按钮共用）。 */
  const beginClose = useCallback(() => {
    clearTimers();
    if (modeRef.current === "hidden") return;
    setClosing(true);
    closeTimer.current = window.setTimeout(doClose, CLOSE_ANIM);
  }, [doClose]);

  // 注册“拖动结束”回调：球被 OS 拖动松手后，WindowController 会贴边并回调这里。
  useEffect(() => {
    windowCtl.onDragEnd((finalEdge) => {
      setEdge(finalEdge);
      draggingRef.current = false;
      setDragging(false);
      // 拖完恢复展示态（若正在展开面板则保持不变）。
      setMode((m) => (m === "expanded" ? m : "revealed"));
    });
  }, [windowCtl]);

  // 初始化：贴边隐藏、启动全局鼠标监听、加载笔记。
  useEffect(() => {
    windowCtl.dockHidden();
    invoke("start_mouse_watch").catch((e) => {
      console.error("[start_mouse_watch] 调用失败:", e);
    });
    notesRepo.loadAll().then(setNotes).catch(() => {});

    // 判断某个屏幕坐标是否落在当前模式的 UI 范围内。
    const inside = (x: number, y: number): boolean => {
      const b = windowCtl.boundsForMode(modeRef.current);
      return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    };

    const sensor = new ProximitySensor();
    sensor
      .start((x, y) => {
        // 拖动时绝不抢窗口，避免与 OS 拖动互相打架。
        if (draggingRef.current) return;
        const isInside = inside(x, y);
        if (modeRef.current === "hidden") {
          if (isInside) {
            setMode("revealed");
            windowCtl.showBall();
          }
        } else {
          if (isInside) {
            clearTimers();
            setClosing(false);
          } else if (!hideTimer.current && !closeTimer.current) {
            hideTimer.current = window.setTimeout(beginClose, HIDE_DELAY);
          }
        }
      })
      .catch((e) => console.error("[sensor.start] 失败:", e));

    return () => {
      sensor.stop();
      clearTimers();
    };
  }, [windowCtl, notesRepo, beginClose]);

  /** 打开笔记面板。 */
  const openPanel = useCallback(() => {
    clearTimers();
    setClosing(false);
    setMode("expanded");
    windowCtl.expandPanel();
    const now = Date.now();
    setActive({ id: 0, title: "", content: "", created_at: now, updated_at: now });
  }, [windowCtl]);

  /** 悬浮球通知 App：拖动状态切换（开始 / 结束）。 */
  const onDraggingChange = useCallback((next: boolean) => {
    draggingRef.current = next;
    setDragging(next);
  }, []);

  // ---- 笔记存取 ----
  const onSave = useCallback(
    async (note: Note) => {
      const saved = await notesRepo.save(note);
      setNotes((prev) => {
        const idx = prev.findIndex((n) => n.id === saved.id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = saved;
          return copy;
        }
        return [saved, ...prev];
      });
      setActive(saved);
    },
    [notesRepo],
  );

  const onDelete = useCallback(
    async (id: number) => {
      await notesRepo.delete(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
      beginClose();
    },
    [notesRepo, beginClose],
  );

  return (
    <div className="app">
      {mode === "expanded" ? (
        <NotePanel
          note={active}
          notes={notes}
          onSave={onSave}
          onDelete={onDelete}
          onClose={beginClose}
          onSelect={(n) => setActive(n)}
          closing={closing}
          edge={edge}
        />
      ) : (
        <FloatingBall
          revealed={mode === "revealed" || dragging}
          dragging={dragging}
          edge={edge}
          windowCtl={windowCtl}
          onOpen={openPanel}
          onDraggingChange={onDraggingChange}
        />
      )}
    </div>
  );
}
