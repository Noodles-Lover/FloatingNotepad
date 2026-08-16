export interface Todo {
  id: string;
  text: string;
  done: boolean;
  priority: number; // 0=低 1=中 2=高（兼容旧数据）
  note: string; // 备注
}

/** 一个速记标签页：独立标题、文本与待办，永久存储。 */
export interface Tab {
  id: number;
  title: string;
  note: string;
  todos: Todo[];
}

/** 应用启动时从后端读取的整体状态。 */
export interface PersistState {
  tabs: Tab[];
  activeTabId: number;
}
