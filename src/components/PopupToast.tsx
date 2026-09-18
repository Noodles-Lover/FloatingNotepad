interface Props {
  /** 弹出内容（主文本 + 可选小字）。 */
  text: string;
  sub: string | null;
  /** 正在播放消失动画（由调用方控制，动画结束后再卸载）。 */
  leaving: boolean;
}

/**
 * 面板内的弹出提示（主窗口渲染）。
 *
 * 面板展开时独立小窗会被面板挡住，Rust 那边就不弹窗、只广播内容，
 * 改由这里在面板顶部显示——内容与停留时长都和独立小窗一致。
 */
export default function PopupToast({ text, sub, leaving }: Props) {
  return (
    <div className={`popup-toast ${leaving ? "leaving" : ""}`}>
      <div className="popup-toast-body">
        {text.split("\n").map((line, i) => (
          <span className="popup-toast-line" key={i}>
            {line}
          </span>
        ))}
        {sub && <span className="popup-toast-sub">{sub}</span>}
      </div>
    </div>
  );
}
