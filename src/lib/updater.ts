import { getVersion } from "@tauri-apps/api/app";
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
  // 任何结果都带上当前版本号，方便判断“装的是哪个版本 / 该不该有新版本”。
  const current = await getVersion().catch(() => null);
  const cur = current ? `v${current}` : "版本号未知";
  try {
    onProgress(`当前 ${cur}，正在检查更新…`);
    const update = await check();
    if (!update) {
      onProgress(`已是最新版本（${cur}）`);
      return { kind: "up-to-date" };
    }
    onProgress(`发现新版本 v${update.version}（当前 ${cur}），正在下载安装…`);
    await update.downloadAndInstall();
    onProgress(`已安装 v${update.version}（原 ${cur}），重启后生效`);
    return { kind: "updated", version: update.version };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    onProgress(`更新失败（当前 ${cur}）：${message}`);
    return { kind: "failed", message };
  }
}

/** 重启应用，用于让刚安装的更新生效。 */
export async function restartApp(): Promise<void> {
  await relaunch();
}
