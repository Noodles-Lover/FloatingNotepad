import { useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import { notionActions, notionUi, useNotionSync } from "../hooks/useNotionSync";

/**
 * Notion 同步设置的视图层：状态与动作都住在模块级单例（useNotionSync）里，
 * 面板收起再打开，执行中提示、结果消息、输入内容都还在。
 */
export default function NotionSettings() {
  const ui = useNotionSync();
  const executing = ui.busy !== "";
  /** 重置前的确认弹窗（用应用自带的 ConfirmDialog，原生 confirm 在 Tauri 下很丑）。 */
  const [confirmReset, setConfirmReset] = useState(false);

  const reset = () => setConfirmReset(true);

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
          {ui.busy === "reset" ? ui.busyLabel : "重置数据库"}
        </button>
      </div>
      <div className="set-switch-row" title="按固定间隔自动跑一轮双向同步">
        <span className="set-label">自动同步</span>
        <input
          type="checkbox"
          className="set-switch"
          checked={ui.autoSync}
          onChange={(e) => notionUi.setAutoSync(e.target.checked)}
        />
      </div>
      {ui.autoSync && (
        <div className="set-switch-row" title="自动同步的轮询间隔（10–3600 秒）">
          <span className="set-label">同步间隔</span>
          <span className="auto-interval">
            <input
              className="set-input"
              type="number"
              min={10}
              max={3600}
              value={ui.intervalSecs}
              onChange={(e) => notionUi.setIntervalSecs(Number(e.target.value))}
              disabled={executing}
            />
            秒
          </span>
        </div>
      )}
      {ui.conflicts.length > 0 && (
        <div className="conflict-list">
          <div className="conflict-title">
            以下 {ui.conflicts.length} 条两边都有改动，请选择保留哪边：
          </div>
          {ui.conflicts.map((c) => {
            const key = `${c.collection}:${c.local_id}`;
            return (
              <div key={key} className="conflict-item">
                <div className="conflict-label">
                  [{c.collection_label}] {c.label}
                </div>
                <div className="conflict-desc">应用：{c.local_desc}</div>
                <div className="conflict-desc">Notion：{c.remote_desc}</div>
                <div className="set-actions">
                  <button
                    className="set-btn"
                    onClick={() => notionActions.resolveLocal(c)}
                    disabled={executing}
                  >
                    用应用
                  </button>
                  <button
                    className="set-btn"
                    onClick={() => notionActions.resolveRemote(c)}
                    disabled={executing}
                  >
                    用 Notion
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {ui.msg && <div className="set-hint">{ui.msg}</div>}
      <ConfirmDialog
        open={confirmReset}
        title="重置 Notion 同步"
        message="将归档 Notion 三个库里的全部页面并清空映射表，本地数据不动。之后点「立即同步」即可按本地现状重建。"
        confirmText="重置"
        onConfirm={() => {
          setConfirmReset(false);
          notionActions.reset();
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
