import NotionSettings from "./NotionSettings";

/**
 * Notion 同步面板（覆盖层）：独立入口，壳复用覆盖层样式，内容是 NotionSettings。
 */
export default function NotionPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="skin-overlay" onClick={onClose}>
      <div className="skin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="skin-head">
          <span>Notion 同步</span>
          <span className="skin-x" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="skin-body">
          <NotionSettings />
        </div>
      </div>
    </div>
  );
}
