import { notionActions, notionUi, useNotionSync } from "../hooks/useNotionSync";

/**
 * Notion 同步设置的视图层：状态与动作都住在模块级单例（useNotionSync）里，
 * 面板收起再打开，执行中提示、结果消息、输入内容都还在。
 */
export default function NotionSettings() {
  const ui = useNotionSync();
  const executing = ui.busy !== "";

  const reset = () => {
    const ok = window.confirm(
      "将归档 Notion 三个库里的全部页面并清空映射表，本地数据不动。\n之后点「立即同步」即可按本地现状重建。继续？",
    );
    if (ok) notionActions.reset();
  };

  return (
    <div className="set-row">
      <div className="set-label">
        <span>Notion 同步</span>
      </div>
      <input
        className="set-input"
        type="password"
        placeholder="Integration 密钥（secret_…）"
        value={ui.token}
        onChange={(e) => notionUi.setToken(e.target.value)}
        disabled={executing}
      />
      <input
        className="set-input"
        placeholder="容器页链接或页面 ID"
        value={ui.page}
        onChange={(e) => notionUi.setPage(e.target.value)}
        disabled={executing}
      />
      <div className="set-actions">
        <button className="set-btn" onClick={notionActions.save} disabled={executing}>
          {executing ? ui.busyLabel : "保存"}
        </button>
        <button
          className="set-btn set-btn-primary"
          onClick={notionActions.sync}
          disabled={executing || ui.token === "" || ui.page === ""}
        >
          {ui.busy === "sync" ? ui.busyLabel : "立即同步"}
        </button>
        <button
          className="set-btn"
          onClick={reset}
          disabled={executing || !ui.ready}
        >
          {ui.busy === "reset" ? ui.busyLabel : "重置同步"}
        </button>
      </div>
      {ui.msg && <div className="set-hint">{ui.msg}</div>}
    </div>
  );
}
