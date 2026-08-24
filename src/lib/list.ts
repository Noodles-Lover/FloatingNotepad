/** 通用列表工具：与 React 无关的纯函数，供 App 状态管理复用。 */

/**
 * 把 fromId 条目移动到 toId 之前；toId 为 null 表示放到末尾。
 * 若 fromId 不存在返回 null（调用方应跳过保存）。
 */
export function reorderById<T extends { id: number }>(
  list: T[],
  fromId: number,
  toId: number | null,
): T[] | null {
  const fromIdx = list.findIndex((i) => i.id === fromId);
  if (fromIdx === -1) return null;
  const moved = list[fromIdx];
  const rest = list.filter((i) => i.id !== fromId);
  const targetIdx = toId === null ? -1 : rest.findIndex((i) => i.id === toId);
  const at = targetIdx === -1 ? rest.length : targetIdx;
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}
