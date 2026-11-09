import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DOCK_ICON_MAX, DOCK_ICON_MIN, type AppConfig } from "../lib/config";
import { checkAndInstallUpdate, restartApp } from "../lib/updater";

interface Props {
  /** 当前配置。 */
  config: AppConfig;
  /** 任意配置项变动时回调（应用会实时应用并持久化到 localStorage）。 */
  onChange: (next: AppConfig) => void;
  /** 关闭面板。 */
  onClose: () => void;
}

/** 一个带数值显示的滑块行。 */
function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span>{label}</span>
        <span className="set-val">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/**
 * 高度分配条：一条被分成两段的纸，拖动中间的分隔把手改变两段的宽度。
 * 原生 range 透明铺在上层，只借它的整十吸附与键盘操作；两段宽度和把手位置
 * 都由同一个 --split 决定，看到的就是「把面板高度分给速记和待办」而不是一个数值。
 */
function SplitSlider({
  noteRatio,
  onChange,
}: {
  noteRatio: number;
  onChange: (ratio: number) => void;
}) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span>速记 / 待办 高度比</span>
      </div>
      <div className="split-track" style={{ ["--split" as string]: `${noteRatio}%` }}>
        <div className="split-segment">速记 {noteRatio}%</div>
        <div className="split-segment">待办 {100 - noteRatio}%</div>
        <input
          className="split-range"
          type="range"
          min={0}
          max={100}
          step={10}
          value={noteRatio}
          aria-label="速记与待办高度比例"
          onChange={(e) => onChange(Math.min(70, Math.max(30, Number(e.target.value))))}
        />
      </div>
    </div>
  );
}

/**
 * 设置面板（覆盖层）：调整挂件尺寸、面板大小、自动收起延时、闲置不透明度。
 * 改动即时生效并写入 localStorage。
 * 覆盖在应用最上层，点击空白处或右上角叉号关闭。
 */
export default function SettingsPanel({ config, onChange, onClose }: Props) {
  const set = (patch: Partial<AppConfig>) => onChange({ ...config, ...patch });
  /** 更新流程的进度文案；空串表示未开始。 */
  const [updateMsg, setUpdateMsg] = useState("");
  /** 更新已安装，需要重启才生效。 */
  const [needRestart, setNeedRestart] = useState(false);

  const openDataDir = () => {
    invoke("open_data_dir").catch((e) =>
      setUpdateMsg(`打开数据文件夹失败：${e}`),
    );
  };

  const runUpdate = async () => {
    setNeedRestart(false);
    const outcome = await checkAndInstallUpdate(setUpdateMsg);
    if (outcome.kind === "updated") setNeedRestart(true);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>设置</span>
          <span className="modal-close" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="modal-body">
          <label className="set-switch-row" title="关闭全部音效（面板开合、报时、提醒）">
            <span className="set-label">静音</span>
            <input
              type="checkbox"
              className="set-switch"
              checked={config.muted}
              onChange={(e) => set({ muted: e.target.checked })}
            />
          </label>
          <Slider
            label="挂件尺寸"
            value={config.widgetSize}
            min={30}
            max={300}
            step={1}
            unit="px"
            onChange={(v) => set({ widgetSize: v })}
          />
          <Slider
            label="面板宽度"
            value={config.windowWidth}
            min={240}
            max={900}
            step={10}
            unit="px"
            onChange={(v) => set({ windowWidth: v })}
          />
          <Slider
            label="面板高度"
            value={config.windowHeight}
            min={200}
            max={900}
            step={10}
            unit="px"
            onChange={(v) => set({ windowHeight: v })}
          />
          <Slider
            label="快捷栏图标"
            value={config.dockIconSize}
            min={DOCK_ICON_MIN}
            max={DOCK_ICON_MAX}
            step={2}
            unit="px"
            onChange={(v) => set({ dockIconSize: v })}
          />
          <SplitSlider noteRatio={config.noteRatio} onChange={(v) => set({ noteRatio: v })} />
          <Slider
            label="自动收起延时"
            value={config.autoCloseDelay}
            min={0}
            max={5000}
            step={100}
            unit="ms"
            onChange={(v) => set({ autoCloseDelay: v })}
          />
          <Slider
            label="闲置不透明度"
            value={Math.round(config.idleOpacity * 100)}
            min={10}
            max={100}
            step={5}
            unit="%"
            onChange={(v) => set({ idleOpacity: v / 100 })}
          />
          <Slider
            label="碰撞箱外扩"
            value={config.panelMargin}
            min={0}
            max={100}
            step={1}
            unit="px"
            onChange={(v) => set({ panelMargin: v })}
          />
        </div>
        <div className="set-actions">
          <button className="set-btn" onClick={openDataDir} title="在数据文件夹中可备份 notes.db">
            打开数据文件夹
          </button>
          <button className="set-btn" onClick={runUpdate}>
            检查更新
          </button>
          {needRestart && (
            <button
              className="set-btn set-btn-primary"
              onClick={() => restartApp().catch(() => undefined)}
            >
              重启应用
            </button>
          )}
        </div>
        {updateMsg && <div className="set-hint">{updateMsg}</div>}
      </div>
    </div>
  );
}
