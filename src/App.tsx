import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isEnabled, enable, disable } from "@tauri-apps/plugin-autostart";
import { logEvent } from "./lib/log";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Menu, MenuItem, CheckMenuItem } from "@tauri-apps/api/menu";
import { WindowController, widgetBoxFor, type Edge } from "./lib/window";
import { readMonitorScreen } from "./lib/screen";
import { NoteWindow } from "./lib/noteWindow";
import { loadState, saveTabs, setActiveTab, loadCategories, saveCategories, setActiveCategory } from "./lib/db";
import { ProximitySensor } from "./lib/proximity";
import { sounds } from "./lib/sounds";
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
import { loadPlans, nearestInfo, nextRefreshAt, pendingCount, setPlanNotify, type Plan } from "./lib/plans";
import type { Category, Tab, Todo } from "./types";
import FloatingWidget from "./components/FloatingWidget";
import NotePanel from "./components/NotePanel";
import SkinPanel from "./components/SkinPanel";
import SettingsPanel from "./components/SettingsPanel";
import UsagePanel from "./components/UsagePanel";
import FeaturePanel from "./components/FeaturePanel";
import PlansPanel from "./components/PlansPanel";
import ConfirmDialog from "./components/ConfirmDialog";
import PopupToast from "./components/PopupToast";
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

/** 把「全屏自动穿透」开关同步给 Rust。 */
function syncFullscreenPassthrough(enabled: boolean): void {
  invoke("set_fullscreen_passthrough", { enabled }).catch((e) =>
    console.error("[fullscreen] 同步开关失败:", e),
  );
}

/** 把「记录应用使用时间」开关同步给 Rust 采样器。 */
function syncUsageTracking(enabled: boolean): void {
  invoke("set_usage_tracking", { enabled }).catch((e) =>
    console.error("[usage] 同步开关失败:", e),
  );
}

/** 把「整点报时」开关与闲置透明度同步给 Rust（小窗按此透明度显示）。 */
function syncChime(enabled: boolean, opacity: number): void {
  invoke("set_chime", { enabled, opacity }).catch((e) =>
    console.error("[chime] 同步失败:", e),
  );
}

/** 同步「任务提醒」总开关给 Rust（到点由它弹小窗）。 */
function syncPlanNotify(enabled: boolean): void {
  setPlanNotify(enabled).catch((e) => console.error("[plans] 同步开关失败:", e));
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
  const [autostartOn, setAutostartOn] = useState<boolean>(false); // 开机自启（状态由 OS 维护）
  const passthroughRef = useRef(false); // 最新穿透态，供 proximity / 点击早退读取
  const [skins, setSkins] = useState<Skin[]>([]); // 可用皮肤清单（运行时从 skin 目录自动读取）
  // 当前选用皮肤名（永久保存）。
  // 用户上次选择的皮肤（localStorage 永久保存，跨会话保留）。
  const [skinName, setSkinName] = useState<string>(loadSkinName);
  const [skin, setSkin] = useState<Skin | null>(null); // 当前选用皮肤对象（解析 skinName 后得到）
  const [skinOpen, setSkinOpen] = useState(false); // 皮肤面板是否打开
  const [settingsOpen, setSettingsOpen] = useState(false); // 设置面板是否打开
  const [usageOpen, setUsageOpen] = useState(false); // 使用统计面板是否打开
  const [featuresOpen, setFeaturesOpen] = useState(false); // 功能面板是否打开
  const [plansOpen, setPlansOpen] = useState(false); // 新增日程面板是否打开
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
  /** 启动首次定位（拿到真实屏幕尺寸之后）是否已完成。未完成前只记录尺寸、不动窗口（见下方尺寸下发 effect）。 */
  const widgetPlacedRef = useRef(false);
  /** 覆盖层面板（皮肤/设置）是否打开。用于 resize 判断，见 applyConfigToCtl。 */
  const modalOpenRef = useRef(false);
  // 标签页/分类的状态管理收敛到 useEntityList；此处的 ref 供 scheduleSave 在不产生
  // 循环依赖的前提下读取最新列表（hook 的 listRef/loadedRef 均为稳定引用）。
  const tabsApiRef = useRef<EntityListApi<Tab> | null>(null);
  const catsApiRef = useRef<EntityListApi<Category> | null>(null);

  modeRef.current = mode;
  modalOpenRef.current = skinOpen || settingsOpen || usageOpen || featuresOpen || plansOpen;

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

  // ---- 日程：待办系统标签页的内容，主页面那一行与挂件角标都从它派生 ----
  const [plans, setPlans] = useState<Plan[]>([]);
  const nearest = useMemo(() => nearestInfo(plans), [plans]);
  const planCount = useMemo(() => pendingCount(plans), [plans]);

  const reloadPlans = useCallback(() => {
    loadPlans()
      .then(setPlans)
      .catch((e) => console.error("[plans] 加载失败:", e));
  }, []);

  // 启动取一次
  useEffect(() => {
    reloadPlans();
  }, [reloadPlans]);

  // 之后不做定时轮询：日程只由本应用改（增删改即时重算），真正需要重取的是
  // 「派生值随时刻过期」的边界——今天某条日程的时刻走完、以及跨过 00:00。
  useEffect(() => {
    const at = new Date();
    const delay = Math.max(1_000, nextRefreshAt(plans, at) - at.getTime());
    const timer = window.setTimeout(reloadPlans, delay);
    return () => window.clearTimeout(timer);
  }, [plans, reloadPlans]);

  // 日程到点后派生值随之变化（角标少一个、最近一项往后挪），不必等下一个边界。
  useEffect(() => {
    const pending: Promise<UnlistenFn> = listen("plan-due", reloadPlans);
    return () => {
      pending.then((fn) => fn()).catch(() => {});
    };
  }, [reloadPlans]);

  // 窗口被隐藏期间定时器会被 webview 节流，重新可见时补一次，别停在过期画面上。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reloadPlans();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reloadPlans]);

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

  // ---- 窗口动作串行器 ----
  // 窗口操作是异步的（show / setSize / setPosition 各一次 IPC）。多次形态切换接连发生时，
  // 先发起的调用可能后完成，把窗口留在旧形态（例如窗口停在挂件尺寸、界面却已是面板）。
  // 这里把窗口动作排成一条队列，并且只执行**最新目标**（中途过期的直接丢弃）：
  // 无论请求怎么交错，窗口最终一定等于最后一次请求的形态。
  const winOpRef = useRef<(() => Promise<void>) | null>(null);
  const winOpBusyRef = useRef(false);
  const runWindowOp = useCallback((op: () => Promise<void>) => {
    winOpRef.current = op;
    if (winOpBusyRef.current) return;
    winOpBusyRef.current = true;
    void (async () => {
      while (winOpRef.current) {
        const next = winOpRef.current;
        winOpRef.current = null;
        try {
          await next();
        } catch (e) {
          console.error("[view] 窗口动作失败:", e);
        }
      }
      winOpBusyRef.current = false;
    })();
  }, []);

  /** 形态的可读名（只给留痕用）。 */
  const viewName = (m: Mode, hidden: boolean): string =>
    hidden ? "整窗隐藏" : m === "expanded" ? "面板" : m === "revealed" ? "挂件展开" : "挂件待命";

  /**
   * 视图状态迁移的**唯一入口**。所有「窗口形态」变化都必须调用它。
   *
   * 不变量在这里统一强制，任何调用方都绕不过：
   * - I1 覆盖层只在面板里存在：目标不是 expanded 时无条件关闭全部覆盖层；
   * - I2 整窗隐藏 ⟹ 挂件形态；
   * - I3 穿透中 ⟹ 挂件形态（穿透时窗口点击穿透，面板既无意义也点不到）。
   *
   * @param animate 是否播「面板收起」动画。只有鼠标离开 / 点叉这类需要视觉过度的场景传 true；
   *   托盘显隐、穿透、全屏等一律默认立即落定——它们没有可视动画，延迟只会制造
   *   「界面已变、窗口没变」的空窗。
   * @param fromUser 用户主动关闭（点叉）——决定「需先离开热区才允许再弹出」。
   */
  const applyView = useCallback(
    (target: { mode: Mode; appHidden?: boolean }, opts: { animate?: boolean; fromUser?: boolean } = {}) => {
      const prevAppHidden = appHiddenRef.current;
      const appHidden = target.appHidden ?? prevAppHidden;
      // I2 / I3：整窗隐藏或穿透中，一律回到挂件隐藏态。
      const mode: Mode = appHidden || passthroughRef.current ? "hidden" : target.mode;

      clearTimers();
      setClosing(false);
      // appHidden 立即生效：proximity 依据它早退，不能等 commit——动画与异步窗口动作期间有空窗。
      appHiddenRef.current = appHidden;
      // 收起后进入短暂冷却，避免鼠标恰在隐藏缝里导致刚关又立刻弹出。
      if (mode === "hidden") suppressUntil.current = Date.now() + 500;
      if (opts.fromUser) userMustLeaveRef.current = true;

      const prev = modeRef.current;
      const leavingExpanded = prev === "expanded" && mode !== "expanded";
      const enteringExpanded = prev !== "expanded" && mode === "expanded";

      // I1：先关覆盖层再动窗口——覆盖层渲染在 App 级，晚关就会被压进挂件窗口。
      if (mode !== "expanded") {
        setSkinOpen(false);
        setSettingsOpen(false);
        setUsageOpen(false);
        setFeaturesOpen(false);
        setPlansOpen(false);
      }

      // 只记「面板开合 / 整窗显隐」这类低频关键变化；挂件的 hover 进出太频繁，不记。
      if (leavingExpanded || enteringExpanded || appHidden !== prevAppHidden) {
        logEvent("view", `${viewName(prev, prevAppHidden)} → ${viewName(mode, appHidden)}`);
      }
      if (leavingExpanded && !appHidden) sounds.play("paperClose");
      if (enteringExpanded) sounds.play("paperOpen");

      /** 落到目标形态：ref 先更新（同步可见），窗口动作交给串行器（最终收敛到最新目标）。 */
      const commit = () => {
        modeRef.current = mode;
        setMode(mode);
        runWindowOp(async () => {
          if (appHidden) {
            await windowCtl.hideApp();
          } else if (mode === "expanded") {
            await windowCtl.showOnly();
            await noteWin.expand(windowCtl.currentEdge(), windowCtl.getDockY());
          } else {
            // hidden 与 revealed 的窗口形态相同：显示并停靠回挂件尺寸。
            await windowCtl.showApp();
          }
        });
      };

      // 只有「面板收起」需要动画：延迟卸载才能播 CSS 滑出。
      if (leavingExpanded && opts.animate === true) {
        setClosing(true);
        closeTimer.current = window.setTimeout(() => {
          setClosing(false);
          commit();
        }, CLOSE_ANIM);
        return;
      }
      commit();
    },
    [runWindowOp, windowCtl, noteWin],
  );

  /** 把配置应用到控制器：面板尺寸下次展开生效（挂件尺寸由下面的尺寸下发 effect 统一处理）。 */
  const applyConfigToCtl = useCallback(
    (cfg: AppConfig) => {
      noteWin.applyConfig(cfg);
    },
    [noteWin],
  );

  /** 设置面板改动：更新状态、应用到控制器并持久化到 localStorage。 */
  const onConfigChange = useCallback(
    (next: AppConfig) => {
      setConfig(next);
      applyConfigToCtl(next);
      saveConfig(next);
      syncLockDelay(next.autoCloseDelay);
      syncFullscreenPassthrough(next.fullscreenPassthrough);
      syncUsageTracking(next.usageTracking);
      syncChime(next.chime, next.idleOpacity);
      syncPlanNotify(next.planNotify);
      sounds.setMuted(next.muted);
    },
    [applyConfigToCtl],
  );

  /** 请求切换穿透模式：Rust 是状态的唯一真相源。这里只发出切换意图
   * （invoke toggle_passthrough），视图变化由 Rust 广播的 passthrough-state 事件
   * 经 applyView 统一驱动——不在此处提前改形态，避免出现第二个真相源。 */
  const setPassthrough = useCallback(
    (on: boolean) => {
      if (on === passthroughRef.current) return;
      invoke("toggle_passthrough").catch((e) => console.error("[passthrough] invoke 失败:", e));
    },
    [],
  );



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
      applyView({ mode: "hidden" });
      return;
    }
    window.setTimeout(() => {
      if (passthroughRef.current || draggingRef.current) return;
      if (modeRef.current === "revealed") applyView({ mode: "hidden" });
    }, 0);
  }, [applyView]);

  /** 在挂件上右键：弹出原生菜单（隐藏 / 穿透 / 试一下报时 / 退出）。 */
  const openContextMenu = useCallback(async () => {
    const hideItem = await MenuItem.new({
      text: "隐藏挂件",
      action: () => {
        logEvent("widget", "隐藏挂件");
        applyView({ mode: "hidden", appHidden: true });
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
    // 临时调试项：等整点太慢，右键即可立刻弹一次报时小窗看效果。
    const chimeItem = await MenuItem.new({
      text: "试一下报时",
      action: () => {
        invoke("ring_chime").catch((e) => console.error("[chime] 触发失败:", e));
      },
    });
    const notifyItem = await MenuItem.new({
      text: "试一下提醒",
      action: () => {
        invoke("test_notify").catch((e) => console.error("[plans] 测试提醒失败:", e));
      },
    });
    const quitItem = await MenuItem.new({
      text: "退出",
      action: () => {
        // 与系统托盘「退出」共用 Rust 的 quit_app，避免两端各写一套导致行为不一致。
        invoke("quit_app").catch((e) => console.error("[退出] 失败:", e));
      },
    });
    const menu = await Menu.new({
      items: [hideItem, passItem, chimeItem, notifyItem, quitItem],
    });
    await menu.popup();
    // 菜单期间指针被菜单接管，挂件收不到 mouseleave，会一直卡在展开态。
    // 菜单关闭等同于鼠标离开：走同一条收起路径；若指针确实还停在挂件上，
    // 光标采样会在冷却结束后把它再展开回来。
    onWidgetLeave();
  }, [windowCtl, setPassthrough, onWidgetLeave]);

  // 打开覆盖层面板时重置收起倒计时：让每次打开都能用满一个完整延时周期，
  // 不会被上一次计时顺手收走。鼠标移开后仍会照常自动收起（收起时面板一并关闭）。
  useEffect(() => {
    if (skinOpen || settingsOpen || usageOpen || featuresOpen || plansOpen) clearTimers();
  }, [skinOpen, settingsOpen, usageOpen, featuresOpen, plansOpen]);

  // 加载用户配置（出厂默认 <- localStorage 覆盖），
  // 拿到后既要刷新 React 状态，也要立刻应用到窗口控制器（否则挂件大小/窗口尺寸不生效）。
  useEffect(() => {
    const cfg = loadConfig();
    setConfig(cfg);
    // 穿透是 Rust 维护的运行时态，启动恒为关（见 lib.rs 的 PassthroughState）。
    setPassthroughState(false);
    passthroughRef.current = false;
    // 开机自启状态由 OS 维护，启动即从系统读取真实值（不缓存进 localStorage）。
    isEnabled()
      .then(setAutostartOn)
      .catch((e) => console.error("[autostart] 读取失败:", e));
    applyConfigToCtl(cfg);
    syncLockDelay(cfg.autoCloseDelay);
    syncFullscreenPassthrough(cfg.fullscreenPassthrough);
    syncUsageTracking(cfg.usageTracking);
    syncChime(cfg.chime, cfg.idleOpacity);
    syncPlanNotify(cfg.planNotify);
    // 静音状态要在播放启动提示音之前就位，否则静音也会被响到。
    sounds.setMuted(cfg.muted);
    sounds.play("notification");
  }, [applyConfigToCtl]);

  // 弹窗与任务提醒的音效都由主窗口代播：那些窗口从没被用户点过，
  // Chromium 会拦掉无用户交互的自动播放——这个判断在 sounds.playOnEvent 里。
  // 弹出（目前是报时）用专门的钟声，任务提醒用通用提示音。
  useEffect(() => sounds.playOnEvent("popup-show", "bell"), []);
  useEffect(() => sounds.playOnEvent("plan-due", "notification"), []);

  // 面板展开时弹出改在面板内显示（由 Rust 按窗口几何判断后只广播内容），
  // 这里把内容画在面板顶部，停留时长与独立小窗一致。
  const [popupToast, setPopupToast] = useState<{
    text: string;
    sub: string | null;
    leaving: boolean;
  } | null>(null);

  /** 关掉面板内提示：先播消失动画，动画结束再卸载（直接卸载就看不到动画了）。 */
  const dismissToast = useCallback(() => {
    setPopupToast((prev) => (prev ? { ...prev, leaving: true } : null));
    window.setTimeout(() => setPopupToast(null), 180);
  }, []);

  useEffect(() => {
    const unlisten: Promise<UnlistenFn> = listen<{
      text: string;
      sub: string | null;
    }>("popup-show", (ev) => {
      if (modeRef.current !== "expanded") return; // 没开面板时看独立小窗
      setPopupToast({ text: ev.payload.text, sub: ev.payload.sub, leaving: false });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, []);

  // 停留时长与独立小窗一致（Rust 的 VISIBLE = 5 秒）。
  useEffect(() => {
    if (!popupToast || popupToast.leaving) return;
    const timer = window.setTimeout(dismissToast, 5000);
    return () => window.clearTimeout(timer);
  }, [popupToast, dismissToast]);



  /**
   * 挂件容器尺寸：长边 = 配置的挂件大小，短边按素材比例收缩，宽度再加固定留白。
   * 映射规则全在 widgetBoxFor 里；窗口与 CSS 容器都取这一个结果——不一致就会出现
   * “看着有但摸不到”（容器大于窗口）或“摸得到但看不见”（容器小于窗口）。
   */
  const widgetBox = widgetBoxFor(config.widgetSize, (skin ?? defaultSkin()).ratio);

  /**
   * 尺寸一变就下发：窗口的宽高只能由 JS 给，而它同时是悬停判定的依据，必须与容器同尺寸。
   * 两种情况只记录、不动窗口：
   * - 启动首次定位前：真实屏幕尺寸还没拿到，此刻 resize 会拿兜底屏幕尺寸把窗口放歪
   *   （见 LOGIC.md「停靠位置持久化」）；尺寸已记进控制器，随后的 showWidget 会带上它。
   * - 面板打开时：resize 会把面板挤成挂件大小。
   */
  useEffect(() => {
    if (!widgetPlacedRef.current || modeRef.current === "expanded" || modalOpenRef.current) {
      windowCtl.syncWidgetBox(widgetBox);
      return;
    }
    windowCtl.setWidgetBox(widgetBox).catch((e) => console.error("[setWidgetBox] 失败:", e));
  }, [widgetBox.width, widgetBox.height, widgetBox.peek, windowCtl]);

  /**
   * 屏幕逻辑尺寸的唯一读入口：读一次喂给两个控制器（一次读取，两处共用）。
   * 尺寸没变就直接返回——换显示器/改缩放的回调可能频繁触发，但不常有真实变化。
   */
  const screenRef = useRef<{ w: number; h: number } | null>(null);
  const syncScreen = useCallback(async () => {
    const size = await readMonitorScreen();
    if (!size) return;
    const prev = screenRef.current;
    if (prev && prev.w === size.w && prev.h === size.h) return;
    screenRef.current = size;
    windowCtl.applyScreen(size);
    noteWin.applyScreen(size);
    // 尺寸真的变了：停靠 X 与 dockY 都要按新屏幕重算。
    // 启动首次定位前 / 面板打开时都不重排（前者由随后的 showWidget 带上，后者收起时由 dockHidden 带上）。
    if (!widgetPlacedRef.current || modeRef.current === "expanded" || modalOpenRef.current) return;
    windowCtl
      .placeWidget(windowCtl.currentEdge())
      .catch((e) => console.error("[placeWidget] 失败:", e));
  }, [noteWin, windowCtl]);

  // 皮肤清单只跟皮肤目录有关，与“当前选了哪个”无关，因此只在启动加载一次
  // （依赖里带上当前皮肤名会让每次换皮肤都重跑一遍目录 IPC 与逐张图片加载）。
  useEffect(() => {
    let alive = true;
    loadSkins()
      .then((list) => {
        if (alive) setSkins(list);
      })
      .catch((e) => console.error("[loadSkins] 失败:", e));
    return () => {
      alive = false;
    };
  }, []);

  // 当前选用皮肤由「清单 + 选中的名字」推出；变化模式对应 solidMode=true（整颗停靠、不滑出），
  // 滑动模式对应 solidMode=false（CSS 滑出半掩）。提升到 App 级避免重挂载闪现。
  useEffect(() => {
    // 清单还没到：先不动（挂件此时按内置 default 渲染）。
    if (skins.length === 0) return;
    const cur = resolveSkin(skins, skinName);
    setSkin(cur);
    windowCtl.setSolidMode(cur.mode === "transform");
  }, [skins, skinName, windowCtl]);

  // 注册“拖动结束”回调：挂件被 OS 拖动松手后，WindowController 会贴边并回调这里。
  useEffect(() => {
    windowCtl.onDragEnd((finalEdge) => {
      setEdge(finalEdge);
      draggingRef.current = false;
      setDragging(false);
      // 拖完恢复展示态（面板打开时不动，避免把面板拽回挂件）。
      if (modeRef.current !== "expanded") applyView({ mode: "revealed" });
    });
  }, [windowCtl, applyView]);

  // 初始化：默认展示挂件、启动全局鼠标监听、恢复上次标签页。
  useEffect(() => {
    // 先拿到真实显示器尺寸再定位：applyScreen 会把上次记录的停靠 Y 夹回可见范围，
    // 之后同步 UI 的贴边方向（决定挂件翻转与面板展开侧），最后才显示窗口。
    syncScreen()
      .catch((e) => console.error("[screen] 读取失败:", e))
      .then(() => {
        setEdge(windowCtl.currentEdge());
        windowCtl.showWidget();
        // 首次定位完成：此后才允许尺寸变化重排窗口（尺寸已记在控制器里，showWidget 用它定位）。
        widgetPlacedRef.current = true;
      });
    // 换显示器 / 改缩放（DPI）后重读屏幕尺寸，否则停靠坐标会一直按旧屏幕算。
    const unwatchScreen = windowCtl.watchScreenChange(() => {
      void syncScreen();
    });
    invoke("start_mouse_watch").catch((e) => {
      console.error("[start_mouse_watch] 调用失败:", e);
    });

    // 系统托盘菜单（显示/隐藏挂件）通过事件驱动，这里监听并切换窗口形态。
    // listen 返回的是 Promise：cleanup 同步执行时它可能尚未 resolve，若只在 cleanup 里
    // 解绑「已保存的变量」，StrictMode 的 mount→unmount→mount 会让第一次注册的 listener
    // 永久泄漏（cleanup 时变量仍是 null）。故用 cancelled 标记——延迟 resolve 的 unlisten
    // 发现所属 effect 已销毁时立即自行解绑。
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const bind = (p: Promise<UnlistenFn>) => {
      p.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      }).catch((e) => console.error("[listen] 注册失败:", e));
    };

    bind(
      listen("show-widget", () => {
        // 显示挂件后回到 idle 待命态（半掩、不 hover），由 proximity 检测鼠标靠近才 reveal。
        applyView({ mode: "hidden", appHidden: false });
      }),
    );
    bind(
      listen("hide-widget", () => {
        applyView({ mode: "hidden", appHidden: true });
      }),
    );
    // 穿透状态由 Rust 统一维护并广播；前端只同步显示，不自己计算真相。
    // 但穿透切换会冻结/恢复鼠标采样与 DOM 事件（穿透期间 proximity 暂停、mouseleave
    // 被拦截），因此进入/退出时必须顺带把挂件形态归位到明确的待命态：
    // 否则 mode 会停留在穿透前的旧值（如 revealed），退出后鼠标已不在挂件上、
    // 又没有新的离开事件去收起它，就会永久卡在 hover。
    bind(
      listen<boolean>("passthrough-state", (ev) => {
        const on = ev.payload;
        // 穿透音效挂在这里而非各切换入口：Rust 的 set_passthrough 无论被谁调用
        // （用户切换 / 托盘 / 解锁按钮 / 全屏自动）都会广播本事件，音效自动覆盖全部路径。
        sounds.play(on ? "lock" : "unlock");
        // 先更新真相，再让 applyView 依不变量强制回到挂件形态（穿透时面板无意义且点不到）。
        // appHidden 不显式传：穿透变化不该把托盘隐藏的窗口重新弹出来。
        passthroughRef.current = on;
        setPassthroughState(on);
        applyView({ mode: "hidden" });
      }),
    );
    // 退出前 Rust 会广播 before-quit（见 src-tauri/LOGIC.md「退出」）：
    // 此时把防抖中的文本/待办编辑立即落库，避免丢掉最后一次输入。
    bind(listen("before-quit", () => scheduleSave(true)));
    // 全屏自动穿透前 Rust 会广播 collapse-panel：穿透生效后主窗口被
    // EnableWindow(FALSE) 禁用，面板上的关闭按钮就点不到了，所以先收起面板。
    bind(
      listen("collapse-panel", () => {
        // 全屏自动穿透前先收起面板（穿透生效后主窗口被禁用，关闭按钮点不到）。
        // 目标不含面板，applyView 会连覆盖层一起关掉——这正是之前漏掉、导致
        // 「二层面板被压缩进挂件尺寸窗口」的那一步。关动画：要抢在穿透生效前收完。
        applyView({ mode: "hidden" }, { animate: false });
      }),
    );

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
        // 刚收起后的冷却期内，禁止 proximity 把球重新弹出。
        if (Date.now() < suppressUntil.current) return;
        // 穿透模式：不检测鼠标位置，不自动收起也不弹出。
        // 解锁锁的 hover 检测由 Rust 在光标轮询中完成——穿透时主窗口被禁用，
        // 前端事件不保证继续推进。
        if (passthroughRef.current) return;
        const isInside = await inside(x, y);
        // await 期间状态可能已变，判定一律以最新形态为准。
        const cur = modeRef.current;
        if (cur === "hidden") {
          if (isInside) {
            // 手动关闭（点叉）后鼠标仍停在挂件上：必须等其先离开，才允许再次弹出，
            // 否则刚收起又会立刻弹回（自动关闭时鼠标已离开，不会触发此处）。
            if (!userMustLeaveRef.current) applyView({ mode: "revealed" });
          } else {
            // 鼠标已离开一次，解除“必须离开”约束，后续可正常弹出。
            userMustLeaveRef.current = false;
          }
        } else if (isInside) {
          clearTimers();
          setClosing(false);
        } else if (!configRef.current.pinned && !hideTimer.current && !closeTimer.current) {
          // 面板未固定时才随鼠标离开自动收起；固定后只有手动点叉能关闭。
          hideTimer.current = window.setTimeout(
            () => applyView({ mode: "hidden" }, { animate: true }),
            configRef.current.autoCloseDelay,
          );
        }
      })
      .catch((e) => console.error("[sensor.start] 失败:", e));

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
      unwatchScreen();
      sensor.stop();
      clearTimers();
    };
  }, [windowCtl, applyView, noteWin, scheduleSave, syncScreen]);

  /** 打开笔记面板。 */
  const openPanel = useCallback(() => {
    // 穿透 / 整窗隐藏下窗口不可交互，点不到；防御性早退。
    if (passthroughRef.current || appHiddenRef.current) return;
    applyView({ mode: "expanded" });
  }, [applyView]);

  /** 悬浮挂件通知 App：拖动状态切换（开始 / 结束）。 */
  const onDraggingChange = useCallback((next: boolean) => {
    draggingRef.current = next;
    setDragging(next);
  }, []);

  /** 切换皮肤：只改名字并持久化；皮肤对象、solidMode、尺寸都由名字驱动的 effect 跟上。 */
  const onSelectSkin = useCallback((name: string) => {
    setSkinName(name);
    saveSkinName(name);
    setSkinOpen(false);
  }, []);

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

  /** 切换静音并持久化（音效开关在面板头栏，与固定按钮同排）。 */
  const onToggleMute = useCallback(() => {
    onConfigChange({ ...configRef.current, muted: !configRef.current.muted });
  }, [onConfigChange]);

  /** 切换开机自启：真相在 OS，前端只同步显示并写入系统启动项。 */
  const onAutostartChange = useCallback((on: boolean) => {
    setAutostartOn(on);
    (on ? enable() : disable())
      .catch((e) => console.error("[autostart] 设置失败:", e));
  }, []);

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
          muted={config.muted}
          onToggleMute={onToggleMute}
          onSwitchTab={tabsApi.switchTo}
          onAddTab={tabsApi.add}
          onRenameTab={tabsApi.rename}
          onDeleteTab={tabsApi.requestDelete}
          onReorderTab={tabsApi.reorder}
          onClose={() => applyView({ mode: "hidden" }, { animate: true, fromUser: true })}
          closing={closing}
          edge={edge}
          idleOpacity={config.idleOpacity}
          onOpenSkin={() => setSkinOpen(true)}
          onOpenFeatures={() => setFeaturesOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenUsage={() => setUsageOpen(true)}
          onOpenPlans={() => setPlansOpen(true)}
          plans={plans}
          onPlansChange={setPlans}
          nearest={nearest}
        />
      ) : (
        <FloatingWidget
          revealed={mode === "revealed" || dragging}
          dragging={dragging}
          edge={edge}
          planCount={config.planBadge ? planCount : 0}
          windowCtl={windowCtl}
          onOpen={openPanel}
          onDraggingChange={onDraggingChange}
          widgetWidth={widgetBox.width}
          widgetHeight={widgetBox.height}
          widgetPeek={widgetBox.peek}
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

      {usageOpen && (
        <UsagePanel
          config={config}
          onChange={onConfigChange}
          onClose={() => setUsageOpen(false)}
        />
      )}

      {featuresOpen && (
        <FeaturePanel
          config={config}
          onChange={onConfigChange}
          autostart={autostartOn}
          onAutostartChange={onAutostartChange}
          onClose={() => setFeaturesOpen(false)}
        />
      )}

      {plansOpen && (
        <PlansPanel
          onChange={setPlans}
          notify={config.planNotify}
          onNotifyChange={(on) => onConfigChange({ ...config, planNotify: on })}
          badge={config.planBadge}
          onBadgeChange={(on) => onConfigChange({ ...config, planBadge: on })}
          onClose={() => setPlansOpen(false)}
        />
      )}

      {/* 只在面板展开时显示：收起面板后提示不该继续飘在挂件上方，
          但状态留着——下次打开面板若还没过停留时长，它还在。 */}
      {mode === "expanded" && popupToast && (
        <PopupToast
          text={popupToast.text}
          sub={popupToast.sub}
          leaving={popupToast.leaving}
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
