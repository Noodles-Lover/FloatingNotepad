/**
 * 音效播放：全部声音的唯一出口。
 * 预载、静音、以及「替播不了声音的窗口代播」都收在这里，调用点只说「播什么」。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SoundName = "lock" | "unlock" | "paperOpen" | "paperClose" | "notification" | "bell";

const FILES: Record<SoundName, string> = {
  lock: "/audio/lock.mp3",
  unlock: "/audio/unlock.mp3",
  paperOpen: "/audio/paper-open.mp3",
  paperClose: "/audio/paper-close.mp3",
  notification: "/audio/new-notification.mp3",
  // 报时专用：整点报时与「试一下报时」用它，其它提示音不受影响。
  bell: "/audio/bell.mp3",
};

/** 音效播放器：持有音频池与静音状态，全应用共用一个实例。 */
export class SoundPlayer {
  private readonly pool: Map<SoundName, HTMLAudioElement>;
  private muted = false;

  constructor(files: Record<SoundName, string>) {
    this.pool = new Map(
      (Object.keys(files) as SoundName[]).map((name) => [name, createAudio(files[name])]),
    );
  }

  /** 设置静音状态（功能面板控制）。 */
  setMuted(value: boolean): void {
    this.muted = value;
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

function createAudio(src: string): HTMLAudioElement {
  const audio = new Audio(src);
  audio.preload = "auto";
  return audio;
}

/** 全应用共用的播放器实例。 */
export const sounds = new SoundPlayer(FILES);
