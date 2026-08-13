import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Forwards the global cursor position (from the Rust `cursor-move` event)
 * in logical pixels. The caller decides proximity based on the current UI
 * bounds, so the trigger range always matches what's actually on screen.
 */
export class ProximitySensor {
  private unlisten: Promise<UnlistenFn> | null = null;

  async start(onMove: (x: number, y: number) => void): Promise<void> {
    this.unlisten = listen<{ x: number; y: number }>("cursor-move", (event) => {
      const dpr = window.devicePixelRatio || 1;
      onMove(event.payload.x / dpr, event.payload.y / dpr);
    });
    await this.unlisten;
  }

  async stop(): Promise<void> {
    if (this.unlisten) {
      const unlistenFn = await this.unlisten;
      unlistenFn();
      this.unlisten = null;
    }
  }
}
