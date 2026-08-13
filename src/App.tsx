import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WindowController, type Edge } from "./lib/window";
import { NoteWindow } from "./lib/noteWindow";
import { NoteRepository } from "./lib/db";
import { ProximitySensor } from "./lib/proximity";
import type { Note, Todo } from "./types";
import FloatingBall from "./components/FloatingBall";
import NotePanel from "./components/NotePanel";
import "./App.css";

/** 窗口的三种显示模式。 */
type Mode = "hidden" | "revealed" | "expanded";

/** 鼠标离开 UI 范围多久后自动收起（毫秒）。 */
const HIDE_DELAY = 600;
/** 收起动画时长（毫秒），动画结束后才真正卸载/隐藏。 */
const CLOSE_ANIM = 220;
/** 文本/任务改动后多久落库一次（防抖，毫秒）。 */
const SAVE_DEBOUNCE = 400;

/** 新建一份空白笔记文档（固定 id = 1，单文档模型）。 */
function emptyNote(): Note {
  const now = Date.now();
  return { id: 1, content: "", todos: [], created_at: now, updated_at: now };
}

export default function App() {
  // ---- 视图状态 ----
  const [mode, setMode] = useState<Mode>("hidden"); // 当前模式：隐藏 / 展示 / 展开面板
  const [closing, setClosing] = useState(false); // 是否正在播放收起动画
  const [edge, setEdge] = useState<Edge>("right"); // 悬浮球当前贴附的边
  const [dragging, setDragging] = useState(false); // 悬浮球是否正在被拖动
  const [note, setNote] = useState<Note>(emptyNote()); // 唯一一份笔记文档

  // ---- 跨渲染周期保存的可变引用 ----
  const modeRef = useRef<Mode>("hidden"); // 让 proximity 回调能读到最新 mode
  const hideTimer = useRef<number | null>(null); // 自动收起的计时器
  const closeTimer = useRef<number | null>(null); // 收起动画的计时器
  const draggingRef = useRef(false); // 与 dragging 同步，供 proximity 读取
  const suppressUntil = useRef(0); // 收起后的冷却时间，期间禁止 proximity 重新弹出
  const saveTimer = useRef<number | null>(null); // 自动保存的防抖计时器
  const noteRef = useRef<Note>(note); // 最新文档，供防抖保存读取
  noteRef.current = note;

  modeRef.current = mode;

  // WindowController 与 NoteRepository 都是“只创建一次”的控制器实例。
  const windowCtlRef = useRef<WindowController | null>(null);
  if (!windowCtlRef.current) windowCtlRef.current = new WindowController();
  const windowCtl = windowCtlRef.current;

  const notesRepoRef = useRef<NoteRepository | null>(null);
  if (!notesRepoRef.current) notesRepoRef.current = new NoteRepository();
  const notesRepo = notesRepoRef.current;

  const noteWinRef = useRef<NoteWindow | null>(null);
  if (!noteWinRef.current) noteWinRef.current = new NoteWindow(windowCtl);
  const noteWin = noteWinRef.current;

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

  /** 防抖落库：任何文本/任务改动都会触发，SAVE_DEBOUNCE 内只存一次。 */
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      notesRepo.save(noteRef.current).catch((e) => console.error("[save] 失败:", e));
    }, SAVE_DEBOUNCE);
  }, [notesRepo]);

  /** 真正执行“收起”：切回隐藏态并让窗口回到球隐藏态。窗口动作统一交给 NoteWindow。 */
  const doClose = useCallback(() => {
    setMode("hidden");
    setClosing(false);
    noteWin.collapse();
  }, [noteWin]);

  /** 开始收起动画——自动隐藏（鼠标离开）和手动关闭（点叉）共用的唯一入口。 */
  const beginClose = useCallback(() => {
    clearTimers();
    if (modeRef.current === "hidden") return;
    // 关闭后进入短暂冷却，避免鼠标恰在隐藏缝里导致刚关又立刻弹出。
    suppressUntil.current = Date.now() + 500;
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

  // 初始化：贴边隐藏、启动全局鼠标监听、恢复上次笔记。
  useEffect(() => {
    windowCtl.dockHidden();
    invoke("start_mouse_watch").catch((e) => {
      console.error("[start_mouse_watch] 调用失败:", e);
    });
    notesRepo
      .load()
      .then((n) => {
        if (n) setNote(n);
      })
      .catch((e) => console.error("[load] 失败:", e));

    // 判断某个屏幕坐标是否落在当前模式的 UI 范围内。
    // expanded（面板）读 NoteWindow 真实矩形；hidden/revealed（球）读 WindowController。
    const inside = async (x: number, y: number): Promise<boolean> => {
      const b =
        modeRef.current === "expanded"
          ? await noteWin.bounds()
          : await windowCtl.boundsForMode(modeRef.current);
      return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    };

    const sensor = new ProximitySensor();
    sensor
      .start(async (x, y) => {
        // 拖动时绝不抢窗口，避免与 OS 拖动互相打架。
        if (draggingRef.current) return;
        // 刚收起后的冷却期内，禁止 proximity 把球重新弹出。
        if (Date.now() < suppressUntil.current) return;
        const isInside = await inside(x, y);
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
  }, [windowCtl, notesRepo, beginClose, noteWin]);

  /** 打开笔记面板。 */
  const openPanel = useCallback(() => {
    clearTimers();
    setClosing(false);
    setMode("expanded");
    // 面板由 NoteWindow 负责窗口形态；球当前的 dockEdge/dockY 决定对齐与弹出方向。
    noteWin.expand(windowCtl.currentEdge(), windowCtl.getDockY());
  }, [noteWin, windowCtl]);

  /** 悬浮球通知 App：拖动状态切换（开始 / 结束）。 */
  const onDraggingChange = useCallback((next: boolean) => {
    draggingRef.current = next;
    setDragging(next);
  }, []);

  // ---- 笔记文档编辑（自动保存）----
  const onContentChange = useCallback(
    (content: string) => {
      setNote((prev) => ({ ...prev, content }));
      scheduleSave();
    },
    [scheduleSave],
  );

  const onAddTodo = useCallback(
    (text: string) => {
      const todo: Todo = { id: crypto.randomUUID(), text, done: false };
      setNote((prev) => ({ ...prev, todos: [...prev.todos, todo] }));
      scheduleSave();
    },
    [scheduleSave],
  );

  const onToggleTodo = useCallback(
    (id: string) => {
      setNote((prev) => ({
        ...prev,
        todos: prev.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
      }));
      scheduleSave();
    },
    [scheduleSave],
  );

  const onEditTodo = useCallback(
    (id: string, text: string) => {
      setNote((prev) => ({
        ...prev,
        todos: prev.todos.map((t) => (t.id === id ? { ...t, text } : t)),
      }));
      scheduleSave();
    },
    [scheduleSave],
  );

  const onDeleteTodo = useCallback(
    (id: string) => {
      setNote((prev) => ({ ...prev, todos: prev.todos.filter((t) => t.id !== id) }));
      scheduleSave();
    },
    [scheduleSave],
  );

  return (
    <div className="app">
      {mode === "expanded" ? (
        <NotePanel
          note={note}
          onContentChange={onContentChange}
          onAddTodo={onAddTodo}
          onToggleTodo={onToggleTodo}
          onEditTodo={onEditTodo}
          onDeleteTodo={onDeleteTodo}
          onClose={beginClose}
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
