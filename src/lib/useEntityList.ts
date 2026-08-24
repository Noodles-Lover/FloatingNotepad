import { useCallback, useRef, useState } from "react";
import { reorderById } from "./list";

/**
 * 实体列表状态管理 hook：为「带激活项的持久化列表」提供统一的状态与 CRUD。
 *
 * 速记标签页与待办分类共享同一套管理模式（列表 + 激活项 + 防抖保存 + 重排 + 删除确认），
 * 差异仅在于：数据形状、默认名、删除确认条件、以及持久化目标。调用方把这些差异作为
 * options 注入，hook 内部不再感知业务细节。
 */

export interface EntityListOptions<T> {
  /** 新建实体；seq 从 1 递增，调用方用它生成默认名/唯一 id。 */
  create: (seq: number) => T;
  /** 判定实体「有内容」（决定删除时是否需要用户确认）。 */
  hasContent: (item: T) => boolean;
  /** 立即持久化整个列表（新增/重排/删除时调用）。 */
  persist: (list: T[]) => void;
  /** 防抖持久化（重命名/编辑时调用）。 */
  schedulePersist: () => void;
  /** 持久化激活项 id。 */
  persistActive: (id: number) => void;
  /** 需要确认删除时回调（由调用方弹确认框）。 */
  onConfirmDelete: (id: number) => void;
}

export interface EntityListApi<T> {
  list: T[];
  activeId: number;
  /** 已从后端加载完成的标记（防止加载完成前误保存）。 */
  loadedRef: { current: boolean };
  /** 列表最新值的引用（立即持久化路径依赖它，避免 state 异步导致的竞态）。 */
  listRef: { current: T[] };
  /** 激活项 id 的最新引用（供读取当前项，如 todo 编辑）。 */
  activeIdRef: { current: number };
  /** 加载后端数据：非空时覆盖列表与激活项；空列表视为「还没有数据」，仅标记已加载。 */
  load: (items: T[], activeId: number) => void;
  /** 加载失败时仅标记「已加载」，让后续保存照常进行。 */
  markLoaded: () => void;
  /** 切换激活项并持久化。 */
  switchTo: (id: number) => void;
  /** 新增一项并激活、立即持久化。 */
  add: () => void;
  /** 重命名指定项（防抖持久化）。 */
  rename: (id: number, title: string) => void;
  /** 重排顺序：把 fromId 移动到 toId 之前（toId 为 null 放到末尾）。立即持久化。 */
  reorder: (fromId: number, toId: number | null) => void;
  /** 删除（带确认）：有内容弹确认框，无内容直接删。 */
  requestDelete: (id: number) => void;
  /** 真正执行删除：保底至少保留 1 个；删的是激活项时切到相邻项。立即持久化。 */
  commitDelete: (id: number) => void;
  /** 更新当前激活项的字段（防抖持久化）。 */
  updateActive: (patch: Partial<T>) => void;
}

export function useEntityList<T extends { id: number }>(
  opts: EntityListOptions<T>,
): EntityListApi<T> {
  const [list, setList] = useState<T[]>([]);
  const [activeId, setActiveId] = useState<number>(0);
  const listRef = useRef<T[]>([]);
  listRef.current = list;
  const activeIdRef = useRef<number>(0);
  activeIdRef.current = activeId;
  const loadedRef = useRef(false);

  const load = useCallback((items: T[], active: number) => {
    loadedRef.current = true;
    if (items.length === 0) return;
    listRef.current = items;
    activeIdRef.current = active;
    setList(items);
    setActiveId(active);
  }, []);

  const markLoaded = useCallback(() => {
    loadedRef.current = true;
  }, []);

  const switchTo = useCallback((id: number) => {
    setActiveId(id);
    activeIdRef.current = id;
    opts.persistActive(id);
  }, [opts]);

  const add = useCallback(() => {
    const item = opts.create(listRef.current.length + 1);
    const next = [...listRef.current, item];
    listRef.current = next;
    setList(next);
    setActiveId(item.id);
    activeIdRef.current = item.id;
    opts.persistActive(item.id);
    opts.persist(next);
  }, [opts]);

  const rename = useCallback((id: number, title: string) => {
    const next = listRef.current.map((i) => (i.id === id ? { ...i, title } : i));
    listRef.current = next;
    setList(next);
    opts.schedulePersist();
  }, [opts]);

  const reorder = useCallback((fromId: number, toId: number | null) => {
    const next = reorderById(listRef.current, fromId, toId);
    if (!next) return;
    listRef.current = next;
    setList(next);
    opts.persist(next);
  }, [opts]);

  const commitDelete = useCallback((id: number) => {
    const prev = listRef.current;
    if (prev.length <= 1) return; // 至少保留一个
    const idx = prev.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const next = prev.filter((i) => i.id !== id);
    if (activeIdRef.current === id) {
      const fallback = next[Math.max(0, idx - 1)];
      setActiveId(fallback.id);
      activeIdRef.current = fallback.id;
      opts.persistActive(fallback.id);
    }
    listRef.current = next;
    setList(next);
    // 结构性变更：直接用最新列表落库，确保删除立即持久化。
    opts.persist(next);
  }, [opts]);

  const requestDelete = useCallback(
    (id: number) => {
      const item = listRef.current.find((i) => i.id === id);
      if (item && opts.hasContent(item)) opts.onConfirmDelete(id);
      else commitDelete(id);
    },
    [opts, commitDelete],
  );

  const updateActive = useCallback((patch: Partial<T>) => {
    const next = listRef.current.map((i) =>
      i.id === activeIdRef.current ? { ...i, ...patch } : i,
    );
    listRef.current = next;
    setList(next);
    opts.schedulePersist();
  }, [opts]);

  return {
    list,
    activeId,
    loadedRef,
    listRef,
    activeIdRef,
    load,
    markLoaded,
    switchTo,
    add,
    rename,
    reorder,
    requestDelete,
    commitDelete,
    updateActive,
  };
}
