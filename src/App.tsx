import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Menu, MenuItem, CheckMenuItem } from "@tauri-apps/api/menu";
import { WindowController, type Edge } from "./lib/window";
import { NoteWindow } from "./lib/noteWindow";
import { loadState, saveTabs, setActiveTab, loadCategories, saveCategories, setActiveCategory } from "./lib/db";
import { ProximitySensor } from "./lib/proximity";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type AppConfig } from "./lib/config";
import {
  loadSkins,
  resolveSkin,
  loadSkinName,
  saveSkinName,
  defaultSkin,
  type Skin,
} from "./lib/skins";
import { useEntityList, type EntityListApi } from "./lib/useEntityList";
import type { Category, Tab, Todo } from "./types";
import FloatingWidget from "./components/FloatingWidget";
import NotePanel from "./components/NotePanel";
import SkinPanel from "./components/SkinPanel";
import SettingsPanel from "./components/SettingsPanel";
import ConfirmDialog from "./components/ConfirmDialog";
import "./App.css";

/** 窗口的三种显示模式。 */
type Mode = "hidden" | "revealed" | "expanded";

/** 收起动画时长（毫秒），动画结束后才真正卸载/隐藏。 */
const CLOSE_ANIM = 220;
/** 文本/任务改动后多久落库一次（防抖，毫秒）。 */
const SAVE_DEBOUNCE = 400;



/** 把「自动收起延时」同步给 Rust：穿透解锁锁的自动隐藏用同一节奏。 */
function syncLockDelay(delayMs: number): void {
  invoke("set_lock_hide_delay", { delayMs }).catch((e) =>
    console.error("[lock] 同步收起延时失败:", e),
  );
}

/** 新建一个空白标签页。 */
function newTab(seq: number): Tab {
  return { id: Date.now() + seq, title: `浮笺 ${seq}`, note: "" };
}

/** 新建一个空白待办分类。 */
function newCategory(seq: number): Category {
  return { id: Date.now() + seq, title: `分类 ${seq}`, todos: [] };
}

/** 待办排序：已完成的永远沉底；未完成的按优先级降序（高在前）。 */
function sortTodos(list: Todo[]): Todo[] {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return b.priority - a.priority;
  });
}

export default function App() {
  // ---- 视图状态 ----
  const [mode, setMode] = useState<Mode>("hidden"); // 当前模式：隐藏 / 展示 / 展开面板
  const [closing, setClosing] = useState(false); // 是否正在播放收起动画
  const [edge, setEdge] = useState<Edge>("right"); // 悬浮挂件当前贴附的边
  const [dragging, setDragging] = useState(false); // 悬浮挂件是否正在被拖动
  // 待办展示顺序（节流排序后的结果，避免连点优先级时列表跳动）。
  const [displayTodos, setDisplayTodos] = useState<Todo[]>([]);
  const displayTodosRef = useRef<Todo[]>([]); // 最新展示顺序（供 effect 读取，避免依赖循环）
  const sortTimerRef = useRef<number | null>(null); // 800ms 重排定时器
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG); // 用户配置（挂件大小/窗口/自动关闭）
  const [passthrough, setPassthroughState] = useState<boolean>(false); // 穿透模式
  const passthroughRef = useRef(false); // 最新穿透态，供 proximity / 点击早退读取
  const [skins, setSkins] = useState<Skin[]>([]); // 可用皮肤清单（运行时从 skin 目录自动读取）
  // 当前选用皮肤名（永久保存）。
  // 用户上次选择的皮肤（localStorage 永久保存，跨会话保留）。
  const [skinName, setSkinName] = useState<string>(loadSkinName);
  const [skin, setSkin] = useState<Skin | null>(null); // 当前选用皮肤对象（解析 skinName 后得到）
  const [skinOpen, setSkinOpen] = useState(false); // 皮肤面板是否打开
  const [settingsOpen, setSettingsOpen] = useState(false); // 设置面板是否打开
  // 删除确认弹窗：pendingDelete 非空时弹出，用户确认才真正删除（避免误删不可恢复）。
  const [pendingDelete, setPendingDelete] = useState<{
    kind: "tab" | "category";
    id: number;
  } | null>(null);

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
  // 标签页/分类的状态管理收敛到 useEntityList；此处的 ref 供 scheduleSave 在不产生
  // 循环依赖的前提下读取最新列表（hook 的 listRef/loadedRef 均为稳定引用）。
  const tabsApiRef = useRef<EntityListApi<Tab> | null>(null);
  const catsApiRef = useRef<EntityListApi<Category> | null>(null);

  modeRef.current = mode;
  modalOpenRef.current = skinOpen || settingsOpen;

  // WindowController 等控制器都是“只创建一次”的实例。
  const windowCtlRef = useRef<WindowController | null>(null);
  if (!windowCtlRef.current) windowCtlRef.current = new WindowController(config.widgetSize);
  const windowCtl = windowCtlRef.current;

  const noteWinRef = useRef<NoteWindow | null>(null);
  if (!noteWinRef.current) noteWinRef.current = new NoteWindow(windowCtl, config);
  const noteWin = noteWinRef.current;

  // ---- 防抖落库：任何文本/任务改动都会触发，SAVE_DEBOUNCE 内只存一次。tabs 与分类分别守卫。
  // @param immediate 传 true 时立即落库（用于删除等结构性变更，避免 HMR/防抖竞态导致复原）。
  const scheduleSave = useCallback((immediate = false) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const flush = () => {
      const t = tabsApiRef.current;
      const c = catsApiRef.current;
      if (t?.loadedRef.current) {
        saveTabs(t.listRef.current).catch((e) => console.error("[save] 失败:", e));
      }
      if (c?.loadedRef.current) {
        saveCategories(c.listRef.current).catch((e) => console.error("[saveCat] 失败:", e));
      }
    };
    if (immediate) flush();
    else saveTimer.current = window.setTimeout(flush, SAVE_DEBOUNCE);
  }, []);

  // ---- 标签页 / 待办分类：同一套状态管理，差异只在于数据形状与持久化目标 ----
  const tabsApi = useEntityList<Tab>({
    create: newTab,
    hasContent: (t) => t.note.trim().length > 0,
    persist: (list) => saveTabs(list).catch((e) => console.error("[save] 失败:", e)),
    schedulePersist: () => scheduleSave(),
    persistActive: (id) => setActiveTab(id).catch((e) => console.error("[setActiveTab] 失败:", e)),
    onConfirmDelete: (id) => setPendingDelete({ kind: "tab", id }),
  });
  tabsApiRef.current = tabsApi;

  const catsApi = useEntityList<Category>({
    create: newCategory,
    hasContent: (c) => c.todos.length > 0,
    persist: (list) => saveCategories(list).catch((e) => console.error("[saveCat] 失败:", e)),
    schedulePersist: () => scheduleSave(),
    persistActive: (id) =>
      setActiveCategory(id).catch((e) => console.error("[setActiveCategory] 失败:", e)),
    onConfirmDelete: (id) => setPendingDelete({ kind: "category", id }),
  });
  catsApiRef.current = catsApi;

  // ---- 当前激活的标签页（派生）----
  const activeTab: Tab | undefined =
    tabsApi.list.find((t) => t.id === tabsApi.activeId) ?? tabsApi.list[0];

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
      // 鼠标穿透（WS_EX_TRANSPARENT）由 Rust 的 toggle_passthrough 单独控制，
      // 这里只负责尺寸重排，不在 resize 时切换交互性。
      windowCtl.setWidgetSize(cfg.widgetSize).catch((e) => console.error("[setWidgetSize] 失败:", e));
    },
    [noteWin, windowCtl],
  );

  /** 设置面板改动：更新状态、应用到控制器并持久化到 localStorage。 */
  const onConfigChange = useCallback(
    (next: AppConfig) => {
      setConfig(next);
      applyConfigToCtl(next);
      saveConfig(next);
      syncLockDelay(next.autoCloseDelay);
    },
    [applyConfigToCtl],
  );

  /** 请求切换穿透模式：Rust 是状态的唯一真相源。这里只发出切换意图
   * （invoke toggle_passthrough），实际状态由 Rust 广播的 passthrough-state 事件
   * 驱动前端显示，托盘与右键菜单保持一致。 */
  const setPassthrough = useCallback(
    (on: boolean) => {
      if (on === passthroughRef.current) return;
      // 进入穿透态时先只显示挂件（无内容面板、不检测鼠标）；其余交给 Rust 处理 WS_EX_TRANSPARENT。
      if (on) {
        setMode("hidden");
        appHiddenRef.current = false;
        windowCtl.showOnly().catch((e) => console.error("[showOnly] 失败:", e));
      }
      invoke("toggle_passthrough").catch((e) => console.error("[passthrough] invoke 失败:", e));
    },
    [windowCtl],
  );

  /** 在挂件上右键：弹出原生菜单（隐藏 / 开关穿透）。 */
  const openContextMenu = useCallback(async () => {
    const hideItem = await MenuItem.new({
      text: "隐藏挂件",
      action: () => {
        appHiddenRef.current = true;
        setMode("hidden");
        windowCtl.hideApp().catch((e) => console.error("[hideApp] 失败:", e));
      },
    });
    const passItem = await CheckMenuItem.new({
      text: "穿透模式",
      checked: passthroughRef.current,
      action: () => {
        // 请求 Rust 切换；状态由 passthrough-state 广播同步（挂件在穿透态无法接收右键，属正常）。
        setPassthrough(!passthroughRef.current);
      },
    });
    const quitItem = await MenuItem.new({
      text: "退出",
      action: () => {
        // 与系统托盘「退出」共用 Rust 的 quit_app，避免两端各写一套导致行为不一致。
        invoke("quit_app").catch((e) => console.error("[退出] 失败:", e));
      },
    });
    const menu = await Menu.new({ items: [hideItem, passItem, quitItem] });
    await menu.popup();
  }, [windowCtl, setPassthrough]);

  /** 鼠标离开挂件即收起（穿透态/拖拽中除外）。
   *  竞态说明：鼠标快速掠过挂件时，mouseleave 可能先于 cursor-move 的
   *  reveal 生效（modeRef 仍是 hidden），按当前 mode 判断会漏收、之后卡在 hover。
   *  因此这里同时做两件事：
   *  1) 压一个短冷却（200ms），抑制迟到的“挂件内采样”把挂件重新 reveal；
   *  2) 延迟一帧复核 mode，若 reveal 已生效则立即收起。 */
  const onWidgetLeave = useCallback(() => {
    if (passthroughRef.current || draggingRef.current) return;
    suppressUntil.current = Math.max(suppressUntil.current, Date.now() + 200);
    if (modeRef.current === "revealed") {
      beginClose();
      return;
    }
    window.setTimeout(() => {
      if (passthroughRef.current || draggingRef.current) return;
      if (modeRef.current === "revealed") beginClose();
    }, 0);
  }, [beginClose]);

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
        // 启动即非穿透，穿透只作为用户主动开启的临时态。
        const safe = { ...cfg, passthrough: false };
        setConfig(safe);
        setPassthroughState(false);
        passthroughRef.current = false;
        applyConfigToCtl(safe);
        syncLockDelay(safe.autoCloseDelay);
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
    let unlistenTogglePt: UnlistenFn | null = null;
    listen("show-widget", () => {
      // 显示挂件后回到 idle 待命态（半掩、不 hover），由 proximity 检测鼠标靠近才 reveal。
      appHiddenRef.current = false;
      setMode("hidden");
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
    // 穿透状态由 Rust 统一维护并广播；前端只同步显示，不自己计算真相。
    // 但穿透切换会冻结/恢复鼠标采样与 DOM 事件（穿透期间 proximity 暂停、mouseleave
    // 被拦截），因此进入/退出时必须顺带把挂件形态归位到明确的待命态：
    // 否则 mode 会停留在穿透前的旧值（如 revealed），退出后鼠标已不在挂件上、
    // 又没有新的离开事件去收起它，就会永久卡在 hover。
    listen<boolean>("passthrough-state", (ev) => {
      const on = ev.payload;
      passthroughRef.current = on;
      setPassthroughState(on);
      appHiddenRef.current = false;
      clearTimers();
      setClosing(false);
      if (on) {
        // 进入穿透：与挂件右键菜单路径一致 —— 只保留挂件展示态，mode 归位 hidden。
        // 面板（expanded）打开时保持原样，不打断用户正在编辑的内容。
        if (modeRef.current !== "expanded") setMode("hidden");
        windowCtl.showOnly().catch((e) => console.error("[passthrough] showOnly 失败:", e));
      } else if (modeRef.current !== "expanded") {
        // 退出穿透：回到 idle 半掩待命态，由 proximity 重新采样鼠标位置决定是否 reveal。
        // 若鼠标此刻真的在挂件上，下一次 cursor-move（≤100ms）会立即把它再次 reveal。
        setMode("hidden");
        windowCtl.showApp().catch((e) => console.error("[passthrough] showApp 失败:", e));
      }
    }).then((fn) => {
      unlistenTogglePt = fn;
    });

    loadState()
      .then((state) => {
        tabsApiRef.current?.load(state.tabs, state.activeTabId);
        // 有数据才主动存回一次，确保数据库中的 position / active_tab_id 与前端一致。
        if (state.tabs.length > 0) scheduleSave();
      })
      .catch((e) => {
        tabsApiRef.current?.markLoaded();
        console.error("[load] 失败:", e);
      });

    loadCategories()
      .then((state) => {
        catsApiRef.current?.load(state.categories, state.activeCategoryId);
      })
      .catch((e) => {
        catsApiRef.current?.markLoaded();
        console.error("[loadCategories] 失败:", e);
      });

    // 判断某个屏幕坐标是否落在当前模式的 UI 范围内。
    // expanded（面板）读 NoteWindow 真实矩形；hidden/revealed（挂件）读 WindowController。
    const inside = async (x: number, y: number): Promise<boolean> => {
      const b =
        modeRef.current === "expanded"
          ? await noteWin.bounds()
          : await windowCtl.boundsForMode(modeRef.current);
      // 碰撞箱外扩：仅面板需要（鼠标在面板边缘外仍视为“在内”，避免误关闭）。
      // 挂件不能外扩——否则会在挂件周围形成“幽灵区”：鼠标离开挂件后停在那圈里
      // 仍判定为内部（且 mouseleave 不触发），导致 hover 卡住收不回去。
      const m = modeRef.current === "expanded" ? configRef.current.panelMargin : 0;
      return x >= b.left - m && x <= b.right + m && y >= b.top - m && y <= b.bottom + m;
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
        // 穿透模式：不检测鼠标位置，不自动收起也不弹出。
        // 解锁锁的 hover 检测由 Rust 在光标轮询中完成——穿透时主窗口被禁用，
        // 前端事件不保证继续推进。
        if (passthroughRef.current) return;
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
      unlistenTogglePt?.();
    };
  }, [windowCtl, beginClose, noteWin]);

  /** 打开笔记面板。 */
  const openPanel = useCallback(() => {
    // 穿透模式：点击不打开面板。
    if (passthroughRef.current) return;
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

  /** 确认弹窗“确定”：执行真正删除并关闭弹窗。 */
  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    const api = pendingDelete.kind === "tab" ? tabsApiRef.current : catsApiRef.current;
    api?.commitDelete(pendingDelete.id);
    setPendingDelete(null);
  }, [pendingDelete]);

  // ---- 当前标签页的编辑（自动保存）----
  const onContentChange = useCallback((content: string) => {
    tabsApiRef.current?.updateActive({ note: content });
  }, []);

  // ---- 当前分类的待办编辑（自动保存）----
  /** 基于当前激活分类更新 todos：读取最新列表引用，避免 state 异步导致读到旧数据。 */
  const mutateTodos = useCallback((mutate: (todos: Todo[]) => Todo[]) => {
    const ctl = catsApiRef.current;
    if (!ctl) return;
    const cur = ctl.listRef.current.find((c) => c.id === ctl.activeIdRef.current);
    ctl.updateActive({ todos: mutate(cur?.todos ?? []) });
  }, []);

  const onAddTodo = useCallback(
    (text: string) => {
      const todo: Todo = { id: crypto.randomUUID(), text, done: false, priority: 5, note: "" };
      mutateTodos((ts) => [...ts, todo]);
    },
    [mutateTodos],
  );

  const onToggleTodo = useCallback(
    (id: string) => {
      mutateTodos((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
    },
    [mutateTodos],
  );

  const onEditTodo = useCallback(
    (id: string, text: string) => {
      mutateTodos((ts) => ts.map((t) => (t.id === id ? { ...t, text } : t)));
    },
    [mutateTodos],
  );

  const onPriorityTodo = useCallback(
    (id: string, priority: number) => {
      mutateTodos((ts) => ts.map((t) => (t.id === id ? { ...t, priority } : t)));
    },
    [mutateTodos],
  );

  const onEditTodoNote = useCallback(
    (id: string, note: string) => {
      mutateTodos((ts) => ts.map((t) => (t.id === id ? { ...t, note } : t)));
    },
    [mutateTodos],
  );

  const onDeleteTodo = useCallback(
    (id: string) => {
      mutateTodos((ts) => ts.filter((t) => t.id !== id));
    },
    [mutateTodos],
  );

  /** 切换面板固定状态并持久化。 */
  const onTogglePin = useCallback(() => {
    onConfigChange({ ...configRef.current, pinned: !configRef.current.pinned });
  }, [onConfigChange]);

  // 渲染时按优先级降序排列（高优先级在前），不修改底层存储顺序。
  const activeCategory: Category | undefined =
    catsApi.list.find((c) => c.id === catsApi.activeId) ?? catsApi.list[0];
  const liveTodos = activeCategory?.todos ?? [];

  // 节流排序：底层 todos 变化（优先级/完成态/增删）时，先保持当前显示顺序（不打乱），
  // 800ms 内若没有新的改动才按 sortTodos 重新排序，避免连点 ± 时列表跳动。
  useEffect(() => {
    const prev = displayTodosRef.current;
    const prevIds = new Set(prev.map((t) => t.id));
    const curIds = new Set(liveTodos.map((t) => t.id));
    const overlap = prev.length > 0 && [...prevIds].some((id) => curIds.has(id));
    if (!overlap) {
      // 切换分类（或首次）：立即排序，不节流。
      if (sortTimerRef.current !== null) clearTimeout(sortTimerRef.current);
      const sorted = sortTodos(liveTodos);
      displayTodosRef.current = sorted;
      setDisplayTodos(sorted);
      return;
    }
    // 同分类内改动：先同步内容且保持当前顺序（新增追加、删除移除、文本更新均不打乱）。
    const byId = new Map(liveTodos.map((t) => [t.id, t]));
    const merged: Todo[] = [];
    const seen = new Set<string>();
    for (const t of prev) {
      if (byId.has(t.id)) {
        merged.push(byId.get(t.id)!);
        seen.add(t.id);
      }
    }
    for (const t of liveTodos) {
      if (!seen.has(t.id)) merged.push(t);
    }
    displayTodosRef.current = merged;
    setDisplayTodos(merged);
    if (sortTimerRef.current !== null) clearTimeout(sortTimerRef.current);
    sortTimerRef.current = window.setTimeout(() => {
      const sorted = sortTodos(liveTodos);
      displayTodosRef.current = sorted;
      setDisplayTodos(sorted);
    }, 800);
  }, [liveTodos]);

  // 卸载时清除未触发的重排定时器。
  useEffect(() => {
    return () => {
      if (sortTimerRef.current !== null) clearTimeout(sortTimerRef.current);
    };
  }, []);

  return (
    <div className="app">
      {mode === "expanded" ? (
        <NotePanel
          note={activeTab?.note ?? ""}
          todos={displayTodos}
          tabs={tabsApi.list}
          activeTabId={tabsApi.activeId}
          onContentChange={onContentChange}
          onAddTodo={onAddTodo}
          onToggleTodo={onToggleTodo}
          onEditTodo={onEditTodo}
          onPriorityTodo={onPriorityTodo}
          onEditTodoNote={onEditTodoNote}
          onDeleteTodo={onDeleteTodo}
          categories={catsApi.list}
          activeCategoryId={catsApi.activeId}
          onSwitchCategory={catsApi.switchTo}
          onAddCategory={catsApi.add}
          onRenameCategory={catsApi.rename}
          onDeleteCategory={catsApi.requestDelete}
          onReorderCategory={catsApi.reorder}
          pinned={config.pinned}
          onTogglePin={onTogglePin}
          onSwitchTab={tabsApi.switchTo}
          onAddTab={tabsApi.add}
          onRenameTab={tabsApi.rename}
          onDeleteTab={tabsApi.requestDelete}
          onReorderTab={tabsApi.reorder}
          onClose={() => beginClose(true)}
          closing={closing}
          edge={edge}
          idleOpacity={config.idleOpacity}
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
          skin={skin ?? defaultSkin()}
          passthrough={passthrough}
          onContextMenu={openContextMenu}
          onLeave={onWidgetLeave}
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

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === "category" ? "删除待办分类" : "删除浮笺"}
        message={
          pendingDelete?.kind === "category"
            ? "该分类下有待办内容，删除后不可恢复，确定删除吗？"
            : "该“浮笺”有内容，删除后不可恢复，确定删除吗？"
        }
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
