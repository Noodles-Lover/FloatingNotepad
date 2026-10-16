/**
 * 音效播放：全部声音的唯一出口。
 * 预载、静音、以及「替播不了声音的窗口代播」都收在这里，调用点只说「播什么」。
 *
 * 音源：安装目录的 audio/ 文件夹（用户可自行替换，重启生效），
 * 加载失败回落到打包内置的同名文件。dev 下 Vite 直接伺服 public/audio，不走磁盘。
 */

import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logEvent } from "./log";

export type SoundName = "lock" | "unlock" | "paperOpen" | "paperClose" | "notification" | "bell";

/** 内置音源的相对路径（dev 与兜底共用）。 */
const FILES: Record<SoundName, string> = {
  lock: "/audio/lock.mp3",
  unlock: "/audio/unlock.mp3",
  paperOpen: "/audio/paper-open.mp3",
  paperClose: "/audio/paper-close.mp3",
  notification: "/audio/new-notification.mp3",
  // 报时专用：整点报时与「试一下报时」用它，其它提示音不受影响。
  bell: "/audio/bell.mp3",
};

const NAMES = Object.keys(FILES) as SoundName[];

/** 音效播放器：持有音频池与静音状态，全应用共用一个实例。 */
export class SoundPlayer {
  private readonly pool: Map<SoundName, HTMLAudioElement>;
  private muted = false;

  constructor(files: Record<SoundName, string>) {
    this.pool = new Map(
      (Object.keys(files) as SoundName[]).map((name) => [name, createAudio([files[name]])]),
    );
  }

  /** 设置静音状态（功能面板控制）。 */
  setMuted(value: boolean): void {
    this.muted = value;
  }

  /**
   * 把音源切到磁盘目录：每个音效依次尝试磁盘上的 mp3 / ogg / wav，
   * 全部缺失才回落到打包内置的版本——所以换回默认直接删外置文件即可。
   */
  useDiskBase(dir: string): void {
    for (const name of NAMES) {
      // FILES 里存的是内置 URL（/audio/xxx.mp3），磁盘侧只要文件名主干。
      const stem = (FILES[name].split("/").pop() as string).replace(/\.mp3$/, "");
      const srcs = ["mp3", "ogg", "wav"].map((ext) =>
        convertFileSrc(`${dir}/${stem}.${ext}`),
      );
      srcs.push(FILES[name]);
      this.pool.set(name, createAudio(srcs));
    }
  }

  /**
   * 播放音效；同一种正在播时从头重放（快速切换表现为最新一次）。
   * 静音判断集中在这里，各调用点无需各自判断。
   */
  play(name: SoundName): void {
    if (this.muted) return;
    const audio = this.pool.get(name);
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => {
      /* 未交互时浏览器可能阻止播放，忽略 */
    });
  }

  /**
   * 订阅事件并在**本窗口**播放，返回解绑函数。
   *
   * 报时小窗这类从未被用户点过的窗口，Chromium 会拦掉它的自动播放，
   * 只能由已经交互过的窗口（主窗口）代为发声——这个判断属于音效自己，
   * 不该散落在各个调用点。
   */
  playOnEvent(event: string, name: SoundName): () => void {
    let cancelled = false;
    const unlisten: Promise<UnlistenFn> = listen(event, () => {
      if (!cancelled) this.play(name);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }
}

/** 音源候选链：依次尝试，全部失败才停（链尾是内置音源，保证总能响）。
    中途候选缺失是常态（数据目录本来就常为空），只记整链失败。 */
function createAudio(srcs: string[]): HTMLAudioElement {
  const audio = new Audio(srcs[0]);
  audio.preload = "auto";
  if (srcs.length > 1) {
    let index = 0;
    audio.addEventListener("error", () => {
      index += 1;
      if (index < srcs.length) {
        audio.src = srcs[index];
        audio.load();
      } else {
        logEvent("audio", `音源全部失败: ${srcs[0]}`);
      }
    });
  }
  return audio;
}

/** 全应用共用的播放器实例。 */
export const sounds = new SoundPlayer(FILES);

/**
 * 切到磁盘音源（prod only）：问 Rust 拿安装目录的 audio/ 路径。
 * dev 下 Vite 直接伺服 public/audio，保持内置路径即可。
 * 各步骤留痕到诊断日志，替换不生效时照日志定位（目录、回落原因）。
 */
export function initAudio(): void {
  if (import.meta.env.DEV) {
    logEvent("audio", "dev 构建：使用 Vite 伺服的内置音源，不走磁盘");
    return;
  }
  invoke<string>("audio_dir")
    .then((dir) => {
      logEvent("audio", `音源切到磁盘: ${dir}`);
      sounds.useDiskBase(dir);
    })
    .catch((e) => logEvent("audio", `获取音效目录失败，维持内置音源: ${e}`));
}

/** Rust 下发的音效名是否认识（`PopupPayload.sound` 是字符串，跨语言边界要收窄）。 */
export function isSoundName(value: string): value is SoundName {
  return (NAMES as string[]).includes(value);
}
