import type { AppConfig } from "../lib/config";

interface Props {
  /** 当前配置。 */
  config: AppConfig;
  /** 任意配置项变动时回调（应用会实时应用并持久化到 localStorage）。 */
  onChange: (next: AppConfig) => void;
  /** 关闭面板。 */
  onClose: () => void;
}

/**
 * 功能面板（覆盖层）：集中放置与「挂件行为」相关的开关。
 * 样式复用覆盖层壳与设置面板的开关行，没有自己的样式表。
 */
export default function FeaturePanel({ config, onChange, onClose }: Props) {
  return (
    <div className="skin-overlay" onClick={onClose}>
      <div className="skin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="skin-head">
          <span>功能</span>
          <span className="skin-x" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="skin-body">
          <label
            className="set-switch-row"
            title="进入全屏应用（游戏）时自动开启穿透，退出全屏自动恢复"
          >
            <span className="set-label">全屏时自动穿透</span>
            <input
              type="checkbox"
              className="set-switch"
              checked={config.fullscreenPassthrough}
              onChange={(e) => onChange({ ...config, fullscreenPassthrough: e.target.checked })}
            />
          </label>
          <label
            className="set-switch-row"
            title="每个整点弹小窗显示时刻，并播放提示音；在挂件上右键选「试一下报时」可立刻看效果"
          >
            <span className="set-label">整点报时</span>
            <input
              type="checkbox"
              className="set-switch"
              checked={config.chime}
              onChange={(e) => onChange({ ...config, chime: e.target.checked })}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
