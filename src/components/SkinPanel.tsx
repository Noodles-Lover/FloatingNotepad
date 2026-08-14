import type { Skin } from "../lib/skins";

interface Props {
  /** 所有可用皮肤（运行时从 skin 目录自动读取）。 */
  skins: Skin[];
  /** 当前选中皮肤的 name。 */
  current: string;
  /** 点击某个材质包时回调，参数为其 name。 */
  onSelect: (name: string) => void;
  /** 关闭面板。 */
  onClose: () => void;
}

/** 取某个皮肤用于预览/展示的代表图：滑动模式用 widget，变化模式用 idle。 */
function previewSrc(s: Skin): string {
  return s.mode === "slide" ? s.widget : s.idle;
}

/**
 * 皮肤选择面板（覆盖层）：按“滑动模式 / 变化模式”分组展示材质包（文件夹名即材质名），
 * 点击即可切换悬浮挂件外观。覆盖在应用最上层，点击空白处或右上角叉号关闭。
 */
export default function SkinPanel({ skins, current, onSelect, onClose }: Props) {
  const slideSkins = skins.filter((s) => s.mode === "slide");
  const transformSkins = skins.filter((s) => s.mode === "transform");

  const renderGroup = (title: string, list: Skin[]) => (
    <div className="skin-group">
      <div className="skin-group-title">{title}</div>
      {list.length === 0 ? (
        <div className="skin-empty">（暂无）</div>
      ) : (
        <div className="skin-grid">
          {list.map((s) => (
            <button
              key={s.name}
              type="button"
              className={`skin-card${s.name === current ? " active" : ""}`}
              onClick={() => onSelect(s.name)}
              title={s.name}
            >
              <span className="skin-thumb">
                <img src={previewSrc(s)} alt="" draggable={false} />
              </span>
              <span className="skin-name">{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="skin-overlay" onClick={onClose}>
      <div className="skin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="skin-head">
          <span>选择皮肤</span>
          <span className="skin-x" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="skin-body">
          {renderGroup("滑动模式（单张 widget）", slideSkins)}
          {renderGroup("变化模式（idle + hover 两张）", transformSkins)}
        </div>
      </div>
    </div>
  );
}
