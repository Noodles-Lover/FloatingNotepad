import type { Skin } from "../lib/skins";

/** 皮肤卡片的专属样式：只有这个面板用，跟在组件里。 */
const cardStyles = `
.skin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 10px;
}

.skin-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  background: rgba(255, 253, 245, 0.8);
  border: 2px solid rgba(232, 217, 168, 0.7);
  border-radius: 10px;
  cursor: pointer;
  transition:
    border-color 160ms ease,
    transform 160ms ease,
    box-shadow 160ms ease;
}

.skin-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(80, 60, 20, 0.14);
}

.skin-card.active {
  border-color: var(--cinnabar);
  box-shadow: 0 0 0 2px rgba(196, 92, 72, 0.28);
}

.skin-thumb {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
  background: var(--paper-3);
}

.skin-thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.skin-name {
  font-size: 12px;
  color: var(--ink);
  text-align: center;
  line-height: 1.2;
}
`;

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
      <div className="modal-group-title">{title}</div>
      {list.length === 0 ? (
        <div className="modal-empty">（暂无）</div>
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
    <div className="modal-overlay" onClick={onClose}>
      <style>{cardStyles}</style>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>选择皮肤</span>
          <span className="modal-close" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="modal-body">
          {renderGroup("滑动模式（单张 widget）", slideSkins)}
          {renderGroup("变化模式（idle + hover 两张）", transformSkins)}
        </div>
      </div>
    </div>
  );
}
