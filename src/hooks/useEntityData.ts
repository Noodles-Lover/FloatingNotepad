import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadState,
  saveTabs,
  setActiveTab,
  loadCategories,
  saveCategories,
  setActiveCategory,
} from "../lib/db";
import { useEntityList, type EntityListApi } from "../lib/useEntityList";
import type { Category, Tab, Todo } from "../types";

/** 文本/任务改动后多久落库一次（防抖，毫秒）。 */
const SAVE_DEBOUNCE = 400;
/** 优先级重排的节流时长（毫秒）。 */
const SORT_THROTTLE = 800;

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

export interface PendingDelete {
  kind: "tab" | "category";
  id: number;
}

/**
 * 速记标签页与待办分类的数据层：加载、防抖落库、CRUD、删除确认，
 * 以及待办的节流排序展示顺序。
 *
 * UI 只从这里取数据与回调，不感知 localStorage / 数据结构 / 排序策略。
 */
export function useEntityData() {
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const saveTimer = useRef<number | null>(null);
  const tabsApiRef = useRef<EntityListApi<Tab> | null>(null);
  const catsApiRef = useRef<EntityListApi<Category> | null>(null);

  // 防抖落库：任何文本/任务改动都会触发，SAVE_DEBOUNCE 内只存一次；tabs 与分类分别守卫。
  // @param immediate 传 true 时立即落库（删除等结构性变更，避免 HMR/防抖竞态导致复原）。
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

  // 标签页 / 待办分类：同一套状态管理，差异只在数据形状与持久化目标。
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

  // 启动加载：有数据才主动存回一次，确保库里的 position / active_id 与前端一致。
  useEffect(() => {
    loadState()
      .then((state) => {
        tabsApiRef.current?.load(state.tabs, state.activeTabId);
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
  }, [scheduleSave]);

  // 当前激活项（派生）。memo 化：无激活项时 `?? list[0]` 不会每帧造新引用。
  const activeTab = useMemo(
    () => tabsApi.list.find((t) => t.id === tabsApi.activeId) ?? tabsApi.list[0],
    [tabsApi],
  );
  const activeCategory = useMemo(
    () => catsApi.list.find((c) => c.id === catsApi.activeId) ?? catsApi.list[0],
    [catsApi],
  );
  const liveTodos = useMemo(() => activeCategory?.todos ?? [], [activeCategory]);

  // 待办展示顺序：节流排序，避免连点优先级时列表跳动。
  const [displayTodos, setDisplayTodos] = useState<Todo[]>([]);
  const displayTodosRef = useRef<Todo[]>([]);
  const sortTimerRef = useRef<number | null>(null);

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
    }, SORT_THROTTLE);
  }, [liveTodos]);

  // 卸载时清除未触发的重排定时器。
  useEffect(() => {
    return () => {
      if (sortTimerRef.current !== null) clearTimeout(sortTimerRef.current);
    };
  }, []);

  // ---- 当前标签页的编辑（自动保存）----
  const onContentChange = useCallback((content: string) => {
    tabsApiRef.current?.updateActive({ note: content });
  }, []);

  // ---- 当前分类的待办编辑 ----
  /** 基于当前激活分类更新 todos：读取最新列表引用，避免 state 异步读到旧数据。 */
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

  /** 确认弹窗「确定」：执行真正删除并关闭弹窗。 */
  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    const api = pendingDelete.kind === "tab" ? tabsApiRef.current : catsApiRef.current;
    api?.commitDelete(pendingDelete.id);
    setPendingDelete(null);
  }, [pendingDelete]);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  return {
    tabsApi,
    catsApi,
    activeTab,
    displayTodos,
    pendingDelete,
    confirmDelete,
    cancelDelete,
    scheduleSave,
    onContentChange,
    onAddTodo,
    onToggleTodo,
    onEditTodo,
    onPriorityTodo,
    onEditTodoNote,
    onDeleteTodo,
  };
}
