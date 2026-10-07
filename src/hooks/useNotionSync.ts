import { useEffect, useSyncExternalStore } from "react";
import {
  getNotionConfig,
  getNotionConflicts,
  isReady,
  resetNotionSync,
  resolveNotionConflict,
  setNotionConfig,
  syncNotion,
  type NotionConflict,
  type SyncSummary,
} from "../lib/notion";

/** 当前正在执行的操作。 */
export type Busy = "" | "save" | "sync" | "resolve" | "reset";

const BUSY_LABEL = {
  save: "保存中…",
  sync: "同步中…",
  resolve: "处理中…",
  reset: "重置中…",
} as const;

function labelOf(kind: Busy): string {
  return kind === "save" ? "保存" : kind === "sync" ? "同步" : kind === "resolve" ? "冲突处理" : "重置";
}

export interface NotionSyncUi {
  busy: Busy;
  /** 执行中按钮文案（如「同步中…」）；空闲为空串。 */
  busyLabel: string;
  msg: string;
  token: string;
  page: string;
  ready: boolean;
  /** 自动同步开关与轮询间隔（秒）。 */
  autoSync: boolean;
  intervalSecs: number;
  /** 待用户选边的同步冲突。 */
  conflicts: NotionConflict[];
}

/**
 * Notion 面板的状态放在模块级单例：设置面板收起会卸载组件，
 * 但同步/建库是后台动作，执行中提示与结果必须活过一次「收起再打开」，
 * 输入框内容也一样。组件只是这个状态的视图。
 */
let state = {
  busy: "" as Busy,
  msg: "",
  token: "",
  page: "",
  ready: false,
  autoSync: false,
  intervalSecs: 60,
  conflicts: [] as NotionConflict[],
};
let snapshot: NotionSyncUi = view(state);

function view(s: typeof state): NotionSyncUi {
  return { ...s, busyLabel: s.busy ? BUSY_LABEL[s.busy] : "" };
}

const listeners = new Set<() => void>();

function update(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  snapshot = view(state);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 重取冲突列表（失败时保留现状）。 */
async function refreshLists() {
  const conflicts = await getNotionConflicts().catch(() => state.conflicts);
  update({ conflicts });
}

let loaded = false;
/** 首次用到时读一次已保存的配置与待处理冲突（幂等）；开着自动同步就顺带启动轮询。 */
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  getNotionConfig()
    .then((cfg) => {
      update({
        token: cfg.token,
        page: cfg.parent_page_id,
        ready: isReady(cfg),
        autoSync: cfg.auto_sync,
        intervalSecs: cfg.sync_interval_secs,
      });
      if (cfg.auto_sync) startPolling();
    })
    .catch((e) => update({ msg: `读取配置失败：${e}` }));
  refreshLists();
}

/** 订阅模块级状态；组件卸载不影响后台动作与状态本身。 */
export function useNotionSync(): NotionSyncUi {
  const ui = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(ensureLoaded, []);
  return ui;
}

/** 输入编辑：即时反映到状态，收起再打开不丢。 */
export const notionUi = {
  setToken: (token: string) => update({ token }),
  setPage: (page: string) => update({ page }),
  setAutoSync: (on: boolean) => {
    update({ autoSync: on, msg: "" });
    if (on) startPolling();
    else stopPolling();
    persistQuietly();
  },
  setIntervalSecs: (secs: number) => {
    const v = clampInterval(secs);
    update({ intervalSecs: v });
    if (state.autoSync) startPolling(); // 间隔变了，重排下一次轮询
    persistQuietly();
  },
};

/** 间隔下限 10 秒（一轮同步是好几个 HTTP 请求，再快没有意义），上限一小时。 */
function clampInterval(secs: number): number {
  if (!Number.isFinite(secs)) return 60;
  return Math.min(3600, Math.max(10, Math.round(secs)));
}

/** 静默持久化开关与间隔（含当前 token/page，与「立即同步」的自动落盘一致）。 */
function persistQuietly() {
  setNotionConfig(state.token, state.page, state.autoSync, state.intervalSecs).catch((e) =>
    update({ msg: `保存设置失败：${e}` }),
  );
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;

/** 启动自动同步轮询：setTimeout 链而非 setInterval，改间隔即时生效且不叠加。 */
function startPolling() {
  stopPolling();
  const tick = () => {
    pollTimer = setTimeout(tick, state.intervalSecs * 1000);
    // 未配置或上一轮还没跑完就跳过这一拍，等下一拍。
    if (!state.ready || state.busy) return;
    notionActions.sync();
  };
  pollTimer = setTimeout(tick, state.intervalSecs * 1000);
}

function stopPolling() {
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

/** 串行守卫：同一时刻只允许一个 Notion 动作（自动同步将来也走这里）。 */
async function run(kind: Exclude<Busy, "">, action: () => Promise<string>) {
  if (state.busy) return;
  update({ busy: kind, msg: "" });
  try {
    update({ busy: "", msg: await action() });
  } catch (e) {
    update({ busy: "", msg: `${labelOf(kind)}失败：${e}` });
  }
}

export const notionActions = {
  save: () =>
    run("save", async () => {
      await setNotionConfig(state.token, state.page, state.autoSync, state.intervalSecs);
      update({ ready: isReady(await getNotionConfig()) });
      return "配置已保存";
    }),
  sync: () =>
    run("sync", async () => {
      // 先落配置再同步：Rust 侧同步开头会确保三个库存在（缺哪个建哪个），
      // 所以不需要单独的「建数据库」按钮。
      await setNotionConfig(state.token, state.page, state.autoSync, state.intervalSecs);
      const s: SyncSummary = await syncNotion();
      // 新冲突与处理历史要立刻反映到面板。
      await refreshLists();
      const tail = state.conflicts.length > 0 ? `；${state.conflicts.length} 条冲突待选择` : "";
      return `同步完成：推 ${s.pushed} / 拉 ${s.pulled} / 删 ${s.deleted} / 冲突 ${s.conflicts}${tail}`;
    }),
  reset: () =>
    run("reset", async () => {
      const n = await resetNotionSync();
      update({ conflicts: [] });
      return `已重置：归档 ${n} 页。现在点「立即同步」重建`;
    }),
  resolveLocal: (c: NotionConflict) =>
    run("resolve", async () => {
      await resolveNotionConflict(c.collection, c.local_id, "local");
      await refreshLists();
      return `已保留应用版本：${c.label}`;
    }),
  resolveRemote: (c: NotionConflict) =>
    run("resolve", async () => {
      await resolveNotionConflict(c.collection, c.local_id, "remote");
      await refreshLists();
      return `已保留 Notion 版本：${c.label}`;
    }),
};
