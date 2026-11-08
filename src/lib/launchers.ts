import { invoke } from "@tauri-apps/api/core";

/** 展开时纸皮面板外侧那一列快捷栏的宽度（逻辑像素）。 */
export const DOCK_WIDTH = 64;

export interface LauncherItem {
  path: string;
  name: string;
  /** PNG 的 data URL；提取失败时为空串，列表里显示文件名首字。 */
  icon: string;
}

export function listLaunchers(): Promise<LauncherItem[]> {
  return invoke<LauncherItem[]>("list_launchers");
}

export function addLauncher(path: string): Promise<LauncherItem[]> {
  return invoke<LauncherItem[]>("add_launcher", { path });
}

export function renameLauncher(path: string, name: string): Promise<LauncherItem[]> {
  return invoke<LauncherItem[]>("rename_launcher", { path, name });
}

export function removeLauncher(path: string): Promise<LauncherItem[]> {
  return invoke<LauncherItem[]>("remove_launcher", { path });
}

export function launchPath(path: string): Promise<void> {
  return invoke("launch_path", { path });
}

/** 打开系统文件选择框，返回绝对路径；取消返回 null。 */
export async function pickLauncherFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    title: "选择要加入的应用或文件",
  });
  return typeof picked === "string" ? picked : null;
}
