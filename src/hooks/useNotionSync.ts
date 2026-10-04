import { useEffect, useSyncExternalStore } from "react";
import {
  getNotionConfig,
  isReady,
  resetNotionSync,
  setNotionConfig,
  syncNotion,
  type SyncSummary,
} from "../lib/notion";

/** 当前正在执行的操作。 */
export type Busy = "" | "save" | "sync" | "reset";

const BUSY_LABEL = {
  save: "保存中…",
  sync: "同步中…",
  reset: "重置中…",
} as const;

function labelOf(kind: Busy): string {
  return kind === "save" ? "保存" : kind === "sync" ? "同步" : "重置";
}

export interface NotionSyncUi {
  busy: Busy;
  /** 执行中按钮文案（如「同步中…」）；空闲为空串。 */
  busyLabel: string;
  msg: string;
  token: string;
  page: string;
  ready: boolean;
}

/**
 * Notion 面板的状态放在模块级单例：设置面板收起会卸载组件，
 * 但同步/建库是后台动作，执行中提示与结果必须活过一次「收起再打开」，
 * 输入框内容也一样。组件只是这个状态的视图。
 */
let state = { busy: "" as Busy, msg: "", token: "", page: "", ready: false };
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

let loaded = false;
/** 首次用到时读一次已保存的配置（幂等）。 */
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  getNotionConfig()
    .then((cfg) => update({ token: cfg.token, page: cfg.parent_page_id, ready: isReady(cfg) }))
    .catch((e) => update({ msg: `读取配置失败：${e}` }));
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
};

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
      await setNotionConfig(state.token, state.page);
      update({ ready: isReady(await getNotionConfig()) });
      return "配置已保存";
    }),
  sync: () =>
    run("sync", async () => {
      // 先落配置再同步：Rust 侧同步开头会确保三个库存在（缺哪个建哪个），
      // 所以不需要单独的「建数据库」按钮。
      await setNotionConfig(state.token, state.page);
      const s: SyncSummary = await syncNotion();
      update({ ready: true });
      return `同步完成：推 ${s.pushed} / 拉 ${s.pulled} / 删 ${s.deleted} / 冲突 ${s.conflicts}`;
    }),
  reset: () =>
    run("reset", async () => {
      const n = await resetNotionSync();
      return `已重置：归档 ${n} 页。现在点「立即同步」重建`;
    }),
};
