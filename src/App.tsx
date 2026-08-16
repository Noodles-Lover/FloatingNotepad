import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WindowController, type Edge } from "./lib/window";
import { NoteWindow } from "./lib/noteWindow";
import { loadState, saveTabs, setActiveTab } from "./lib/db";
import { ProximitySensor } from "./lib/proximity";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type AppConfig } from "./lib/config";
import { loadSkins, resolveSkin, loadSkinName, saveSkinName, type Skin } from "./lib/skins";
import type { Tab, Todo } from "./types";
import FloatingWidget from "./components/FloatingWidget";
import NotePanel from "./components/NotePanel";
import SkinPanel from "./components/SkinPanel";
import SettingsPanel from "./components/SettingsPanel";
import "./App.css";

/** 窗口的三种显示模式。 */
type Mode = "hidden" | "revealed" | "expanded";

/** 收起动画时长（毫秒），动画结束后才真正卸载/隐藏。 */
const CLOSE_ANIM = 220;
/** 文本/任务改动后多久落库一次（防抖，毫秒）。 */
const SAVE_DEBOUNCE = 400;

/** 新建一个空白标签页。 */
function newTab(seq: number): Tab {
  return { id: Date.now() + seq, title: `速记 ${seq}`, note: "", todos: [] };
}

export default function App() {
  // ---- 视图状态 ----
  const [mode, setMode] = useState<Mode>("hidden"); // 当前模式：隐藏 / 展示 / 展开面板
  const [closing, setClosing] = useState(false); // 是否正在播放收起动画
  const [edge, setEdge] = useState<Edge>("right"); // 悬浮挂件当前贴附的边
  const [dragging, setDragging] = useState(false); // 悬浮挂件是否正在被拖动
  const [tabs, setTabs] = useState<Tab[]>([]); // 全部速记标签页
  const [activeTabId, setActiveTabId] = useState<number>(0); // 当前激活的标签页 id
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG); // 用户配置（挂件大小/窗口/自动关闭）
  const [skins, setSkins] = useState<Skin[]>([]); // 可用皮肤清单（运行时从 skin 目录自动读取）
  const [skinName, setSkinName] = useState<string>(() => loadSkinName()); // 当前选用皮肤名（永久保存）
  const [skin, setSkin] = useState<Skin | null>(null); // 当前选用皮肤对象（解析 skinName 后得到）
  const [skinOpen, setSkinOpen] = useState(false); // 皮肤面板是否打开
  const [settingsOpen, setSettingsOpen] = useState(false); // 设置面板是否打开

  // ---- 跨渲染周期保存的可变引用 ----
  const modeRef = useRef<Mode>("hidden"); // 让 proximity 回调能读到最新 mode
  const hideTimer = useRef<number | null>(null); // 自动收起的计时器
  const closeTimer = useRef<number | null>(null); // 收起动画的计时器
  const draggingRef = useRef(false); // 与 dragging 同步，供 proximity 读取
  const suppressUntil = useRef(0); // 收起后的冷却时间，期间禁止 proximity 重新弹出
  const userMustLeaveRef = useRef(false); // 手动关闭（点叉）后，需鼠标先离开挂件范围才允许再次弹出
  const saveTimer = useRef<number | null>(null); // 自动保存的防抖计时器
  const configRef = useRef<AppConfig>(config); // 最新配置，供 proximity 读取 autoCloseDelay
  configRef.current = config;
  const appHiddenRef = useRef(false); // 托盘“隐藏挂件”后整窗隐藏，期间 proximity 不响应
  const modalOpenRef = useRef(false); // 皮肤/设置面板打开时，暂停 proximity 的收起与弹出
  const tabsRef = useRef<Tab[]>(tabs); // 最新标签页，供防抖保存读取
  tabsRef.current = tabs;
  const activeRef = useRef<number>(activeTabId); // 最新激活 id，供防抖保存读取
  activeRef.current = activeTabId;
  const loadedRef = useRef(false); // 标签页是否已从后端加载完成（防止启动期空数据覆盖）

  modeRef.current = mode;
  modalOpenRef.current = skinOpen || settingsOpen;

  // WindowController 等控制器都是“只创建一次”的实例。
  const windowCtlRef = useRef<WindowController | null>(null);
  if (!windowCtlRef.current) windowCtlRef.current = new WindowController(config.widgetSize);
  const windowCtl = windowCtlRef.current;

  const noteWinRef = useRef<NoteWindow | null>(null);
  if (!noteWinRef.current) noteWinRef.current = new NoteWindow(windowCtl, config);
  const noteWin = noteWinRef.current;

  // ---- 当前激活的标签页（派生）----
  const activeTab: Tab | undefined = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

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
    // 未加载完成前绝不落库，否则会用初始的空 tabs 覆盖掉刚迁移/恢复的数据。
    if (!loadedRef.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTabs(tabsRef.current).catch((e) => console.error("[save] 失败:", e));
    }, SAVE_DEBOUNCE);
  }, []);

  /** 真正执行“收起”：切回隐藏态并让窗口回到球隐藏态。窗口动作统一交给 NoteWindow。 */
  const doClose = useCallback(() => {
    setMode("hidden");
    setClosing(false);
    noteWin.collapse();
  }, [noteWin]);

  /** 开始收起动画——自动隐藏（鼠标离开）和手动关闭（点叉）共用的入口。
   * @param fromUser 是否由用户点叉触发；手动关闭时鼠标仍在窗口内，需等其离开后才允许再弹出。 */
  const beginClose = useCallback(
    (fromUser = false) => {
      clearTimers();
      if (modeRef.current === "hidden") return;
      // 关闭后进入短暂冷却，避免鼠标恰在隐藏缝里导致刚关又立刻弹出。
      suppressUntil.current = Date.now() + 500;
      if (fromUser) userMustLeaveRef.current = true;
      setClosing(true);
      closeTimer.current = window.setTimeout(doClose, CLOSE_ANIM);
    },
    [doClose],
  );

  /** 把配置应用到控制器：挂件尺寸实时重排、面板尺寸下次展开生效、自动关闭时间即时生效。 */
  const applyConfigToCtl = useCallback(
    (cfg: AppConfig) => {
      noteWin.applyConfig(cfg);
      // 始终同步挂件尺寸到控制器内部状态，避免设置期间跳过导致窗口与 DOM 尺寸脱节（截断/空隙）。
      windowCtl.syncWidgetSize(cfg.widgetSize);
      // 面板已展开（或设置面板打开）时，禁止把整窗 resize 成挂件尺寸，否则面板会瞬间缩小/被卸载；
      // 挂件尺寸留到收起后由 showWidget/dockHidden 自然应用。
      const panelActive = modeRef.current === "expanded" || modalOpenRef.current;
      if (panelActive) return;
      // 用当前交互态重排挂件尺寸（展开时保持可交互，否则隐藏态穿透）。
      const interactive = modeRef.current !== "hidden" || draggingRef.current;
      windowCtl.setWidgetSize(cfg.widgetSize, interactive).catch((e) => console.error("[setWidgetSize] 失败:", e));
    },
    [noteWin, windowCtl],
  );

  /** 设置面板改动：更新状态、应用到控制器并持久化到 localStorage。 */
  const onConfigChange = useCallback(
    (next: AppConfig) => {
      setConfig(next);
      applyConfigToCtl(next);
      saveConfig(next);
    },
    [applyConfigToCtl],
  );

  // 皮肤/设置面板打开时：清掉正在进行的收起计时，避免面板刚打开就被自动收起。
  useEffect(() => {
    if (skinOpen || settingsOpen) clearTimers();
  }, [skinOpen, settingsOpen]);

  // 加载用户配置（出厂默认 <- public/config.ini <- localStorage 覆盖），
  // 拿到后既要刷新 React 状态，也要立刻应用到窗口控制器（否则挂件大小/窗口尺寸不生效）。
  useEffect(() => {
    let alive = true;
    loadConfig()
      .then((cfg) => {
        if (!alive) return;
        setConfig(cfg);
        applyConfigToCtl(cfg);
      })
      .catch((e) => console.error("[loadConfig] 失败:", e));
    return () => {
      alive = false;
    };
  }, [applyConfigToCtl]);

  // 加载皮肤清单并解析当前选用皮肤；变化模式对应 solidMode=true（整颗停靠、不滑出），
  // 滑动模式/无皮肤对应 solidMode=false（CSS 滑出半掩）。提升到 App 级避免重挂载闪现。
  useEffect(() => {
    let alive = true;
    loadSkins()
      .then((list) => {
        if (!alive) return;
        setSkins(list);
        const cur = resolveSkin(list, skinName);
        setSkin(cur);
        windowCtl.setSolidMode(cur.mode === "transform");
      })
      .catch((e) => console.error("[loadSkins] 失败:", e));
    return () => {
      alive = false;
    };
  }, [windowCtl, skinName]);

  // 注册“拖动结束”回调：挂件被 OS 拖动松手后，WindowController 会贴边并回调这里。
  useEffect(() => {
    windowCtl.onDragEnd((finalEdge) => {
      setEdge(finalEdge);
      draggingRef.current = false;
      setDragging(false);
      // 拖完恢复展示态（若正在展开面板则保持不变）。
      setMode((m) => (m === "expanded" ? m : "revealed"));
    });
  }, [windowCtl]);

  // 初始化：默认展示挂件、启动全局鼠标监听、恢复上次标签页。
  useEffect(() => {
    // 先用真实显示器尺寸刷新屏幕，否则 window.screen 在 Tauri 下不可靠，
    // 会把挂件/面板定位到屏幕外（表现为“点一下挂件就消失、窗口看不见”）。
    windowCtl.refreshScreen().catch((e) => console.error("[refreshScreen] 失败:", e));
    noteWin.refreshScreen().catch((e) => console.error("[refreshScreen] 失败:", e));
    windowCtl.showWidget();
    invoke("start_mouse_watch").catch((e) => {
      console.error("[start_mouse_watch] 调用失败:", e);
    });

    // 系统托盘菜单（显示/隐藏挂件）通过事件驱动，这里监听并切换窗口形态。
    let unlistenShow: UnlistenFn | null = null;
    let unlistenHide: UnlistenFn | null = null;
    listen("show-widget", () => {
      appHiddenRef.current = false;
      setMode("revealed");
      windowCtl.showApp();
    }).then((fn) => {
      unlistenShow = fn;
    });
    listen("hide-widget", () => {
      appHiddenRef.current = true;
      setMode("hidden");
      windowCtl.hideApp();
    }).then((fn) => {
      unlistenHide = fn;
    });
    loadState()
      .then((state) => {
        loadedRef.current = true;
        if (state.tabs.length === 0) return;
        setTabs(state.tabs);
        setActiveTabId(state.activeTabId);
        // 主动存回一次，确保数据库中的 position / active_tab_id 与前端一致（含已迁移的待办）。
        scheduleSave();
      })
      .catch((e) => {
        loadedRef.current = true;
        console.error("[load] 失败:", e);
      });

    // 判断某个屏幕坐标是否落在当前模式的 UI 范围内。
    // expanded（面板）读 NoteWindow 真实矩形；hidden/revealed（挂件）读 WindowController。
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
        // 托盘已整窗隐藏时，忽略全局鼠标，避免又把窗口弹出。
        if (appHiddenRef.current) return;
        // 皮肤/设置面板打开时，不自动收起也不自动弹出，保证面板稳定可操作。
        if (modalOpenRef.current) return;
        // 刚收起后的冷却期内，禁止 proximity 把球重新弹出。
        if (Date.now() < suppressUntil.current) return;
        const isInside = await inside(x, y);
        if (modeRef.current === "hidden") {
          if (isInside) {
            // 手动关闭（点叉）后鼠标仍停在挂件上：必须等其先离开，才允许再次弹出，
            // 否则刚收起又会立刻弹回（自动关闭时鼠标已离开，不会触发此处）。
            if (!userMustLeaveRef.current) {
              setMode("revealed");
              windowCtl.showWidget();
            }
          } else {
            // 鼠标已离开一次，解除“必须离开”约束，后续可正常弹出。
            userMustLeaveRef.current = false;
          }
        } else {
          if (isInside) {
            clearTimers();
            setClosing(false);
          } else if (!configRef.current.pinned && !hideTimer.current && !closeTimer.current) {
            // 面板未固定时才随鼠标离开自动收起；固定后只有手动点叉能关闭。
            hideTimer.current = window.setTimeout(beginClose, configRef.current.autoCloseDelay);
          }
        }
      })
      .catch((e) => console.error("[sensor.start] 失败:", e));

    return () => {
      sensor.stop();
      clearTimers();
      unlistenShow?.();
      unlistenHide?.();
    };
  }, [windowCtl, beginClose, noteWin]);

  /** 打开笔记面板。 */
  const openPanel = useCallback(() => {
    clearTimers();
    setClosing(false);
    setMode("expanded");
    // 面板由 NoteWindow 负责窗口形态；挂件当前的 dockEdge/dockY 决定对齐与弹出方向。
    noteWin.expand(windowCtl.currentEdge(), windowCtl.getDockY());
  }, [noteWin, windowCtl]);

  /** 悬浮挂件通知 App：拖动状态切换（开始 / 结束）。 */
  const onDraggingChange = useCallback((next: boolean) => {
    draggingRef.current = next;
    setDragging(next);
  }, []);

  /** 切换皮肤：更新状态、下发 solidMode、永久保存到 localStorage（独立 key）。 */
  const onSelectSkin = useCallback(
    (name: string) => {
      const cur = resolveSkin(skins, name);
      setSkinName(name);
      setSkin(cur);
      windowCtl.setSolidMode(cur.mode === "transform");
      saveSkinName(name);
      setSkinOpen(false);
    },
    [skins, windowCtl],
  );

  // ---- 标签页操作 ----
  const switchTab = useCallback((id: number) => {
    setActiveTabId(id);
    setActiveTab(id).catch((e) => console.error("[setActiveTab] 失败:", e));
  }, []);

  const addTab = useCallback(() => {
    setTabs((prev) => {
      const tab = newTab(prev.length + 1);
      setActiveTabId(tab.id);
      setActiveTab(tab.id).catch(() => {});
      return [...prev, tab];
    });
    scheduleSave();
  }, [scheduleSave]);

  const renameTab = useCallback(
    (id: number, title: string) => {
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
      scheduleSave();
    },
    [scheduleSave],
  );

  // ---- 当前标签页的编辑（自动保存）----
  const updateActive = useCallback(
    (patch: Partial<Tab>) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === activeRef.current ? { ...t, ...patch } : t)),
      );
      scheduleSave();
    },
    [scheduleSave],
  );

  const onContentChange = useCallback(
    (content: string) => {
      updateActive({ note: content });
    },
    [updateActive],
  );

  const onAddTodo = useCallback(
    (text: string) => {
      const todo: Todo = { id: crypto.randomUUID(), text, done: false, priority: 5, note: "" };
      const cur = tabsRef.current.find((t) => t.id === activeRef.current);
      const todos = [...(cur?.todos ?? []), todo];
      updateActive({ todos });
    },
    [updateActive],
  );

  const onToggleTodo = useCallback(
    (id: string) => {
      const cur = tabsRef.current.find((t) => t.id === activeRef.current);
      const todos = (cur?.todos ?? []).map((t) =>
        t.id === id ? { ...t, done: !t.done } : t,
      );
      updateActive({ todos });
    },
    [updateActive],
  );

  const onEditTodo = useCallback(
    (id: string, text: string) => {
      const cur = tabsRef.current.find((t) => t.id === activeRef.current);
      const todos = (cur?.todos ?? []).map((t) => (t.id === id ? { ...t, text } : t));
      updateActive({ todos });
    },
    [updateActive],
  );

  const onPriorityTodo = useCallback(
    (id: string, priority: number) => {
      const cur = tabsRef.current.find((t) => t.id === activeRef.current);
      const todos = (cur?.todos ?? []).map((t) =>
        t.id === id ? { ...t, priority } : t,
      );
      updateActive({ todos });
    },
    [updateActive],
  );

  const onEditTodoNote = useCallback(
    (id: string, note: string) => {
      const cur = tabsRef.current.find((t) => t.id === activeRef.current);
      const todos = (cur?.todos ?? []).map((t) => (t.id === id ? { ...t, note } : t));
      updateActive({ todos });
    },
    [updateActive],
  );

  const onDeleteTodo = useCallback(
    (id: string) => {
      const cur = tabsRef.current.find((t) => t.id === activeRef.current);
      const todos = (cur?.todos ?? []).filter((t) => t.id !== id);
      updateActive({ todos });
    },
    [updateActive],
  );

  /** 切换面板固定状态并持久化。 */
  const onTogglePin = useCallback(() => {
    onConfigChange({ ...configRef.current, pinned: !configRef.current.pinned });
  }, [onConfigChange]);

  // 渲染时按优先级降序排列（高优先级在前），不修改底层存储顺序。
  const sortedTodos = [...(activeTab?.todos ?? [])].sort(
    (a, b) => b.priority - a.priority,
  );

  return (
    <div className="app">
      {mode === "expanded" ? (
        <NotePanel
          note={activeTab?.note ?? ""}
          todos={sortedTodos}
          tabs={tabs}
          activeTabId={activeTabId}
          onContentChange={onContentChange}
          onAddTodo={onAddTodo}
          onToggleTodo={onToggleTodo}
          onEditTodo={onEditTodo}
          onPriorityTodo={onPriorityTodo}
          onEditTodoNote={onEditTodoNote}
          onDeleteTodo={onDeleteTodo}
          pinned={config.pinned}
          onTogglePin={onTogglePin}
          onSwitchTab={switchTab}
          onAddTab={addTab}
          onRenameTab={renameTab}
          onClose={() => beginClose(true)}
          closing={closing}
          edge={edge}
          onOpenSkin={() => setSkinOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <FloatingWidget
          revealed={mode === "revealed" || dragging}
          dragging={dragging}
          edge={edge}
          windowCtl={windowCtl}
          onOpen={openPanel}
          onDraggingChange={onDraggingChange}
          widgetSize={config.widgetSize}
          idleOpacity={config.idleOpacity}
          skin={skin ?? { name: "default", mode: "slide", widget: "/skin/default/widget.png" }}
        />
      )}

      {skinOpen && (
        <SkinPanel
          skins={skins}
          current={skin?.name ?? ""}
          onSelect={onSelectSkin}
          onClose={() => setSkinOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          config={config}
          onChange={onConfigChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
