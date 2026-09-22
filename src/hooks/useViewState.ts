import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Menu, MenuItem, CheckMenuItem } from "@tauri-apps/api/menu";
import { logEvent } from "../lib/log";
import type { Edge, WindowController } from "../lib/window";
import { readMonitorScreen } from "../lib/screen";
import type { NoteWindow } from "../lib/noteWindow";
import { ProximitySensor } from "../lib/proximity";
import { sounds } from "../lib/sounds";
import type { AppConfig } from "../lib/config";
import type { WidgetBox } from "./useWidgetBox";

/** 窗口的三种显示模式。 */
export type Mode = "hidden" | "revealed" | "expanded";

/** 收起动画时长（毫秒），动画结束后才真正卸载/隐藏。 */
const CLOSE_ANIM = 220;
/** 收起后的冷却时长（毫秒），期间禁止 proximity 重新弹出。 */
const SUPPRESS_MS = 500;
/** 鼠标离开挂件时压入的短冷却（毫秒），抑制迟到的挂件采样反复 reveal。 */
const LEAVE_SUPPRESS_MS = 200;

/** 形态的可读名（只给留痕用）。 */
function viewName(m: Mode, hidden: boolean): string {
  return hidden ? "整窗隐藏" : m === "expanded" ? "面板" : m === "revealed" ? "挂件展开" : "挂件待命";
}

interface Options {
  windowCtl: WindowController;
  noteWin: NoteWindow;
  /** 最新配置引用（proximity 读 panelMargin / pinned / autoCloseDelay）。 */
  configRef: { current: AppConfig };
  /** 挂件容器尺寸（窗口宽高与悬停判定同源）。 */
  widgetBox: WidgetBox;
  /** 退出前把防抖中的编辑立即落库（before-quit 事件）。 */
  scheduleSave: (immediate?: boolean) => void;
}

/**
 * 视图 / 窗口生命周期控制器 —— 应用里「窗口显示成什么样」的唯一归属：
 *
 * - 形态状态机（hidden / revealed / expanded）与不变量，统一由 applyView 强制；
 * - 窗口动作串行器：异步 IPC 只执行最新目标，避免形态错配；
 * - 覆盖层面板（皮肤/设置/统计/功能/日程）开合；
 * - 全局鼠标 proximity 采样、系统托盘事件、穿透广播、屏幕与尺寸下发。
 */
export function useViewState({ windowCtl, noteWin, configRef, widgetBox, scheduleSave }: Options) {
  // ---- 形态状态 ----
  const [mode, setMode] = useState<Mode>("hidden");
  const [closing, setClosing] = useState(false); // 是否正在播放收起动画
  const [edge, setEdge] = useState<Edge>("right"); // 挂件当前贴附的边
  const [dragging, setDragging] = useState(false); // 挂件是否正在被拖动
  const [passthrough, setPassthroughState] = useState(false); // 穿透模式（真相在 Rust）

  // ---- 覆盖层面板 ----
  const [skinOpen, setSkinOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);

  // ---- 跨渲染周期可变引用 ----
  const modeRef = useRef<Mode>("hidden");
  const hideTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const suppressUntil = useRef(0);
  const userMustLeaveRef = useRef(false);
  const appHiddenRef = useRef(false);
  const passthroughRef = useRef(false);
  const widgetPlacedRef = useRef(false);
  const modalOpenRef = useRef(false);
  const screenRef = useRef<{ w: number; h: number } | null>(null);
  const winOpRef = useRef<(() => Promise<void>) | null>(null);
  const winOpBusyRef = useRef(false);

  modeRef.current = mode;
  modalOpenRef.current = skinOpen || settingsOpen || usageOpen || featuresOpen || plansOpen;

  const clearTimers = useCallback(() => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  // ---- 窗口动作串行器 ----
  // 窗口操作是异步的（show / setSize / setPosition 各一次 IPC）。多次形态切换接连发生时，
  // 先发起的调用可能后完成，把窗口留在旧形态（例如窗口停在挂件尺寸、界面却已是面板）。
  // 这里把动作排成一条队列、且只执行最新目标：无论请求怎么交错，窗口最终一定等于最后一次请求。
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

  const closeOverlays = useCallback(() => {
    setSkinOpen(false);
    setSettingsOpen(false);
    setUsageOpen(false);
    setFeaturesOpen(false);
    setPlansOpen(false);
  }, []);

  /**
   * 视图状态迁移的唯一入口。所有「窗口形态」变化都必须调用它，不变量在此统一强制：
   * - I1 覆盖层只在面板里存在：目标不是 expanded 时无条件关闭全部覆盖层；
   * - I2 整窗隐藏 ⟹ 挂件形态；
   * - I3 穿透中 ⟹ 挂件形态（穿透时点击穿透，面板无意义也点不到）。
   *
   * @param animate 是否播「面板收起」动画。只有鼠标离开 / 点叉这类需要视觉过度的场景传 true。
   * @param fromUser 用户主动关闭（点叉）——决定「需先离开热区才允许再弹出」。
   */
  const applyView = useCallback(
    (
      target: { mode: Mode; appHidden?: boolean },
      opts: { animate?: boolean; fromUser?: boolean } = {},
    ) => {
      const prevAppHidden = appHiddenRef.current;
      const appHidden = target.appHidden ?? prevAppHidden;
      // I2 / I3：整窗隐藏或穿透中，一律回到挂件隐藏态。
      const nextMode: Mode = appHidden || passthroughRef.current ? "hidden" : target.mode;

      clearTimers();
      setClosing(false);
      // appHidden 立即生效：proximity 依据它早退，不能等 commit——动画与异步窗口动作期间有空窗。
      appHiddenRef.current = appHidden;
      if (nextMode === "hidden") suppressUntil.current = Date.now() + SUPPRESS_MS;
      if (opts.fromUser) userMustLeaveRef.current = true;

      const prev = modeRef.current;
      const leavingExpanded = prev === "expanded" && nextMode !== "expanded";
      const enteringExpanded = prev !== "expanded" && nextMode === "expanded";

      // I1：先关覆盖层再动窗口——覆盖层渲染在 App 级，晚关就会被压进挂件窗口。
      if (nextMode !== "expanded") closeOverlays();

      // 只记「面板开合 / 整窗显隐」这类低频关键变化；挂件的 hover 进出太频繁，不记。
      if (leavingExpanded || enteringExpanded || appHidden !== prevAppHidden) {
        logEvent("view", `${viewName(prev, prevAppHidden)} → ${viewName(nextMode, appHidden)}`);
      }
      if (leavingExpanded && !appHidden) sounds.play("paperClose");
      if (enteringExpanded) sounds.play("paperOpen");

      /** 落到目标形态：ref 先更新（同步可见），窗口动作交给串行器（最终收敛到最新目标）。 */
      const commit = () => {
        modeRef.current = nextMode;
        setMode(nextMode);
        runWindowOp(async () => {
          if (appHidden) {
            await windowCtl.hideApp();
          } else if (nextMode === "expanded") {
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
    [clearTimers, closeOverlays, runWindowOp, windowCtl, noteWin],
  );

  // ---- 面板开合 ----
  /** 打开笔记面板（穿透 / 整窗隐藏下窗口不可交互，防御性早退）。 */
  const openPanel = useCallback(() => {
    if (passthroughRef.current || appHiddenRef.current) return;
    applyView({ mode: "expanded" });
  }, [applyView]);

  /** 关闭笔记面板（带收起动画，来自用户点叉）。 */
  const closePanel = useCallback(
    () => applyView({ mode: "hidden" }, { animate: true, fromUser: true }),
    [applyView],
  );

  const openSkin = useCallback(() => setSkinOpen(true), []);
  const openFeatures = useCallback(() => setFeaturesOpen(true), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const openUsage = useCallback(() => setUsageOpen(true), []);
  const openPlans = useCallback(() => setPlansOpen(true), []);
  const closeSkin = useCallback(() => setSkinOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeUsage = useCallback(() => setUsageOpen(false), []);
  const closeFeatures = useCallback(() => setFeaturesOpen(false), []);
  const closePlans = useCallback(() => setPlansOpen(false), []);

  /**
   * 请求切换穿透模式：Rust 是状态的唯一真相源。这里只发出切换意图，
   * 视图变化由 Rust 广播的 passthrough-state 事件经 applyView 统一驱动——不在此处提前改形态。
   */
  const setPassthrough = useCallback((on: boolean) => {
    if (on === passthroughRef.current) return;
    invoke("toggle_passthrough").catch((e) => console.error("[passthrough] invoke 失败:", e));
  }, []);

  /**
   * 鼠标离开挂件即收起（穿透态 / 拖拽中除外）。
   * 竞态：快速掠过时 mouseleave 可能先于 reveal 生效（modeRef 仍是 hidden），按当前 mode 判断会漏收。
   * 因此同时：1) 压一个短冷却抑制迟到的挂件采样；2) 延迟一帧复核 mode，若 reveal 已生效则立即收起。
   */
  const onWidgetLeave = useCallback(() => {
    if (passthroughRef.current || draggingRef.current) return;
    suppressUntil.current = Math.max(suppressUntil.current, Date.now() + LEAVE_SUPPRESS_MS);
    if (modeRef.current === "revealed") {
      applyView({ mode: "hidden" });
      return;
    }
    window.setTimeout(() => {
      if (passthroughRef.current || draggingRef.current) return;
      if (modeRef.current === "revealed") applyView({ mode: "hidden" });
    }, 0);
  }, [applyView]);

  /** 挂件通知 App：拖动状态切换（开始 / 结束）。 */
  const onDraggingChange = useCallback((next: boolean) => {
    draggingRef.current = next;
    setDragging(next);
  }, []);

  /** 在挂件上右键：弹出原生菜单（隐藏 / 穿透 / 试一下报时 / 试一下提醒 / 退出）。 */
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
      action: () => setPassthrough(!passthroughRef.current),
    });
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
    const menu = await Menu.new({ items: [hideItem, passItem, chimeItem, notifyItem, quitItem] });
    await menu.popup();
    // 菜单期间指针被菜单接管，挂件收不到 mouseleave，会一直卡在展开态。
    // 菜单关闭等同于鼠标离开：走同一条收起路径。
    onWidgetLeave();
  }, [applyView, setPassthrough, onWidgetLeave]);

  // 打开覆盖层面板时重置收起倒计时：让每次打开都能用满一个完整延时周期。
  useEffect(() => {
    if (skinOpen || settingsOpen || usageOpen || featuresOpen || plansOpen) clearTimers();
  }, [skinOpen, settingsOpen, usageOpen, featuresOpen, plansOpen, clearTimers]);

  /**
   * 尺寸一变就下发：窗口宽高只能由 JS 给，且它是悬停判定依据，必须与容器同尺寸。
   * 两种情况只记录、不动窗口：启动首次定位前（屏幕尺寸还没拿到）、面板打开时（resize 会把面板挤小）。
   */
  useEffect(() => {
    if (!widgetPlacedRef.current || modeRef.current === "expanded" || modalOpenRef.current) {
      windowCtl.syncWidgetBox(widgetBox);
      return;
    }
    windowCtl.setWidgetBox(widgetBox).catch((e) => console.error("[setWidgetBox] 失败:", e));
  }, [widgetBox.width, widgetBox.height, widgetBox.peek, windowCtl, widgetBox]);

  /**
   * 屏幕逻辑尺寸的唯一读入口：读一次喂给两个控制器。尺寸没变就直接返回——
   * 换显示器 / 改缩放的回调可能频繁触发，但不常有真实变化。
   */
  const syncScreen = useCallback(async () => {
    const size = await readMonitorScreen();
    if (!size) return;
    const prev = screenRef.current;
    if (prev && prev.w === size.w && prev.h === size.h) return;
    screenRef.current = size;
    windowCtl.applyScreen(size);
    noteWin.applyScreen(size);
    // 尺寸真的变了：停靠 X 与 dockY 都要按新屏幕重算（首次定位前 / 面板打开时不重排）。
    if (!widgetPlacedRef.current || modeRef.current === "expanded" || modalOpenRef.current) return;
    windowCtl.placeWidget(windowCtl.currentEdge()).catch((e) => console.error("[placeWidget] 失败:", e));
  }, [noteWin, windowCtl]);

  // 注册「拖动结束」回调：挂件被 OS 拖动松手后，WindowController 会贴边并回调这里。
  useEffect(() => {
    windowCtl.onDragEnd((finalEdge) => {
      setEdge(finalEdge);
      draggingRef.current = false;
      setDragging(false);
      // 拖完恢复展示态（面板打开时不动，避免把面板拽回挂件）。
      if (modeRef.current !== "expanded") applyView({ mode: "revealed" });
    });
  }, [windowCtl, applyView]);

  // 初始化：窗口定位、全局鼠标监听、系统托盘 / 穿透 / 退出 / 收起 事件。
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
    // 换显示器 / 改缩放（DPI）后重读屏幕尺寸。
    const unwatchScreen = windowCtl.watchScreenChange(() => {
      void syncScreen();
    });
    invoke("start_mouse_watch").catch((e) => {
      console.error("[start_mouse_watch] 调用失败:", e);
    });

    // listen 返回 Promise：cleanup 同步执行时它可能尚未 resolve。用 cancelled 标记兜底——
    // 延迟 resolve 的 unlisten 发现 effect 已销毁时立即自行解绑（否则 StrictMode 会泄漏 listener）。
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
        // 显示挂件后回到 idle 待命态，由 proximity 检测鼠标靠近才 reveal。
        applyView({ mode: "hidden", appHidden: false });
      }),
    );
    bind(
      listen("hide-widget", () => {
        applyView({ mode: "hidden", appHidden: true });
      }),
    );
    // 穿透状态由 Rust 统一维护并广播；前端只同步显示。穿透切换会冻结/恢复鼠标采样与 DOM 事件，
    // 因此进入/退出时顺带把挂件形态归位到待命态，否则会停在穿透前的旧值、永久卡在 hover。
    bind(
      listen<boolean>("passthrough-state", (ev) => {
        const on = ev.payload;
        // 穿透音效挂在这里：Rust 的 set_passthrough 无论被谁调用都广播本事件，音效自动覆盖全部路径。
        sounds.play(on ? "lock" : "unlock");
        passthroughRef.current = on;
        setPassthroughState(on);
        // appHidden 不显式传：穿透变化不该把托盘隐藏的窗口重新弹出来。
        applyView({ mode: "hidden" });
      }),
    );
    // 退出前 Rust 会广播 before-quit：把防抖中的编辑立即落库，避免丢掉最后一次输入。
    bind(listen("before-quit", () => scheduleSave(true)));
    // 全屏自动穿透前 Rust 会广播 collapse-panel：抢在穿透生效前收起面板（关动画）。
    bind(
      listen("collapse-panel", () => {
        applyView({ mode: "hidden" }, { animate: false });
      }),
    );

    // 判断某个屏幕坐标是否落在当前模式的 UI 范围内。
    // expanded 读 NoteWindow 真实矩形，hidden/revealed 读 WindowController。
    const inside = async (x: number, y: number): Promise<boolean> => {
      const b =
        modeRef.current === "expanded"
          ? await noteWin.bounds()
          : await windowCtl.boundsForMode(modeRef.current);
      // 碰撞箱外扩：仅面板需要；挂件不能外扩，否则会在周围形成「幽灵区」导致 hover 卡住。
      const m = modeRef.current === "expanded" ? configRef.current.panelMargin : 0;
      return x >= b.left - m && x <= b.right + m && y >= b.top - m && y <= b.bottom + m;
    };

    const sensor = new ProximitySensor();
    sensor
      .start(async (x, y) => {
        // 拖动时绝不抢窗口；托盘整窗隐藏时忽略全局鼠标；冷却期内禁止重新弹出；穿透时不检测。
        if (draggingRef.current) return;
        if (appHiddenRef.current) return;
        if (Date.now() < suppressUntil.current) return;
        if (passthroughRef.current) return;
        const isInside = await inside(x, y);
        // await 期间状态可能已变，判定一律以最新形态为准。
        const cur = modeRef.current;
        if (cur === "hidden") {
          if (isInside) {
            // 手动关闭（点叉）后鼠标仍停在挂件上：必须等其先离开才允许再次弹出。
            if (!userMustLeaveRef.current) applyView({ mode: "revealed" });
          } else {
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
  }, [windowCtl, applyView, noteWin, scheduleSave, syncScreen, clearTimers, configRef]);

  return {
    mode,
    closing,
    edge,
    dragging,
    passthrough,
    modeRef,
    applyView,
    openPanel,
    closePanel,
    onWidgetLeave,
    onDraggingChange,
    openContextMenu,
    overlays: { skinOpen, settingsOpen, usageOpen, featuresOpen, plansOpen },
    openSkin,
    closeSkin,
    openSettings,
    closeSettings,
    openUsage,
    closeUsage,
    openFeatures,
    closeFeatures,
    openPlans,
    closePlans,
  };
}
