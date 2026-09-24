import { useCallback, useEffect, useRef, useState } from "react";
import { isEnabled, enable, disable } from "@tauri-apps/plugin-autostart";
import { sounds } from "../lib/sounds";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type AppConfig } from "../lib/config";
import { applyConfigToRust } from "../lib/configSync";
import type { NoteWindow } from "../lib/noteWindow";

/**
 * 用户配置的唯一归属：读取、持久化、下发到面板控制器与 Rust。
 * 对外只暴露「配置值 + 改配置入口」，调用方不感知 localStorage / Rust 同步的细节。
 */
export function useAppConfig(noteWin: NoteWindow) {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  // 开机自启的真相在操作系统，这里只做镜像显示。
  const [autostartOn, setAutostartOn] = useState<boolean>(false);
  // 最新配置引用：供只读最新值、不依赖 config 的路径（如切换固定/静音）使用。
  const configRef = useRef<AppConfig>(config);
  configRef.current = config;

  const applyConfigToCtl = useCallback(
    (cfg: AppConfig) => {
      noteWin.applyConfig(cfg);
    },
    [noteWin],
  );

  const onConfigChange = useCallback(
    (next: AppConfig) => {
      setConfig(next);
      applyConfigToCtl(next);
      saveConfig(next);
      applyConfigToRust(next);
      sounds.setMuted(next.muted);
    },
    [applyConfigToCtl],
  );

  /** 切换面板固定（读最新值，避免闭包读到旧 config）。 */
  const onTogglePin = useCallback(
    () => onConfigChange({ ...configRef.current, pinned: !configRef.current.pinned }),
    [onConfigChange],
  );

  /** 切换静音（同上）。 */
  const onToggleMute = useCallback(
    () => onConfigChange({ ...configRef.current, muted: !configRef.current.muted }),
    [onConfigChange],
  );

  /** 切换开机自启：真相在 OS，前端只镜像显示并写入系统启动项。 */
  const onAutostartChange = useCallback((on: boolean) => {
    setAutostartOn(on);
    (on ? enable() : disable()).catch((e) => console.error("[autostart] 设置失败:", e));
  }, []);

  // 启动：加载配置 → 刷新状态 → 下发控制器与 Rust → 读自启状态 → 播启动音。
  useEffect(() => {
    const cfg = loadConfig();
    setConfig(cfg);
    isEnabled()
      .then(setAutostartOn)
      .catch((e) => console.error("[autostart] 读取失败:", e));
    applyConfigToCtl(cfg);
    applyConfigToRust(cfg);
    // 静音要在播放启动音之前就位，否则静音也会被响到。
    sounds.setMuted(cfg.muted);
    sounds.play("notification");
  }, [applyConfigToCtl]);

  return {
    config,
    configRef,
    onConfigChange,
    autostartOn,
    onAutostartChange,
    onTogglePin,
    onToggleMute,
  };
}
