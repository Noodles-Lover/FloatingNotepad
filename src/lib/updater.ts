import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** 一次更新检查的最终结果。 */
export type UpdateOutcome =
  | { kind: "up-to-date" }
  | { kind: "updated"; version: string }
  | { kind: "failed"; message: string };

/**
 * 检查并安装更新，进度通过 onProgress 实时回传给调用方显示。
 *
 * 设置面板与将来的托盘菜单应共用这一个入口——更新流程只有一份实现，
 * 避免「托盘能更新、面板报错」这类静默失效。
 * 未配置更新源或处于 dev 构建时 check() 会抛错，这里统一降级为 failed，
 * 由调用方决定如何提示。
 */
export async function checkAndInstallUpdate(
  onProgress: (message: string) => void,
): Promise<UpdateOutcome> {
  try {
    onProgress("正在检查更新…");
    const update = await check();
    if (!update) {
      onProgress("已是最新版本");
      return { kind: "up-to-date" };
    }
    onProgress(`发现新版本 ${update.version}，正在下载安装…`);
    await update.downloadAndInstall();
    onProgress(`已安装 ${update.version}，重启后生效`);
    return { kind: "updated", version: update.version };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    onProgress(`更新失败：${message}`);
    return { kind: "failed", message };
  }
}

/** 重启应用，用于让刚安装的更新生效。 */
export async function restartApp(): Promise<void> {
  await relaunch();
}
