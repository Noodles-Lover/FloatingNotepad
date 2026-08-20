import type { AppConfig } from "../lib/config";

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
 * 设置面板（覆盖层）：调整挂件尺寸、面板大小、自动收起延时、闲置不透明度。
 * 改动即时生效并写入 localStorage。
 * 覆盖在应用最上层，点击空白处或右上角叉号关闭。
 */
export default function SettingsPanel({ config, onChange, onClose }: Props) {
  const set = (patch: Partial<AppConfig>) => onChange({ ...config, ...patch });

  return (
    <div className="skin-overlay" onClick={onClose}>
      <div className="skin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="skin-head">
          <span>设置</span>
          <span className="skin-x" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="skin-body">
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
      </div>
    </div>
  );
}
