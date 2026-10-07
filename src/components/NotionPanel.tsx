import { useState } from "react";
import NotionSettings from "./NotionSettings";

/**
 * Notion 同步面板（覆盖层）：独立入口，壳复用覆盖层样式，内容是 NotionSettings。
 * 头栏「?」打开使用说明层（密钥获取、可调整项与不可动项）。
 */
export default function NotionPanel({ onClose }: { onClose: () => void }) {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Notion 同步</span>
          <span className="modal-head-btns">
            <span className="modal-close" onClick={() => setHelpOpen(true)} title="使用说明">
              ?
            </span>
            <span className="modal-close" onClick={onClose} title="关闭">
              ×
            </span>
          </span>
        </div>
        <div className="modal-body">
          <NotionSettings />
        </div>
      </div>

      {helpOpen && (
        <div className="modal-overlay" onClick={() => setHelpOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>使用说明</span>
              <span className="modal-close" onClick={() => setHelpOpen(false)} title="关闭">
                ×
              </span>
            </div>
            <div className="modal-body">
              <div>
                <div className="modal-group-title">首次使用</div>
                <div className="help-text">
                  1. 在 app.notion.com/developers/connections 新建连接，选择API令牌，复制密钥（ntn_…）。
                  <br />
                  2. 在 Notion 打开一个页面 → 右上角 ··· → 集成 → 添加连接 → 选择刚才的连接。
                  <br />
                  3. 面板里填密钥与页面链接 →
                  「立即同步」：三个库（速记/待办/日程）自动建在容器页下，并按推送数据上去。
                </div>
              </div>
              <div>
                <div className="modal-group-title">日常使用</div>
                <div className="help-text">
                  应用端改动后点「立即同步」会同步双方改动的数据；两边都改过同一条时，它出现在冲突列表里，选「用应用」或「用
                  Notion」即可。
                </div>
              </div>
              <div>
                <div className="modal-group-title">可以随意调整</div>
                <div className="help-text">
                  视图、筛选、排序、列宽、列顺序、颜色与图标；新增自己的属性或视图——同步只读写既定列。
                </div>
              </div>
              <div>
                <div className="modal-group-title">不要动</div>
                <div className="help-text">
                  各库的列名与列类型（速记：标题/内容/本地ID；待办：内容/完成/优先级/备注/分类/本地ID；日程：内容/日期/类型/星期/本地ID）——同步按列名读写，不要进行改动。
                </div>
              </div>
              <div>
                <div className="modal-group-title">兜底</div>
                <div className="help-text">
                  「重置同步」= 归档三个库的全部页面并清空映射，之后「立即同步」按本地现状重建；也可以直接删除数据库，点击同步会自动重建。
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
