// 统一复制入口。桌面版与手机版共用。
//
// Dashboard 走 HTTP（非 secure context）时浏览器**根本不暴露** `navigator.clipboard`
// —— 它是 undefined，`navigator.clipboard.writeText(...)` 是同步 TypeError，
// promise 链上的 .catch() 接不住，于是所有复制入口静默失效（2026-07-13 的事故）。
// 所以这里必须先可选链探测，不可用时回退临时 textarea + document.execCommand('copy')。
// execCommand 只在**用户手势的调用栈内**有效（click / mouseup / touchend 都满足），
// 别把它挪进 setTimeout。
//
// iOS 上的坑（2026-09-22）：`textarea.select()` 对 **readonly** 的元素不起作用，
// 光靠 select() + setSelectionRange() 造不出 execCommand('copy') 能用的文档选区，
// 于是 execCommand 返回 false ——「点了复制什么也没发生」。iOS 要的是
// contentEditable + Range 那套（clipboard.js 这类库用的也是它）：临时解开 readonly、
// 用 Range 选中节点内容、再 setSelectionRange，最后把属性还原。

/** iPadOS 13+ 的 UA 伪装成 Mac，靠触摸点数量补判。 */
function isIOS() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** 把 textarea 的内容选中。返回是否真的选出了东西。 */
function selectAll(ta, length) {
  if (isIOS()) {
    // 顺序有讲究：先解开 readonly 才能设选区，设完再还原，免得键盘被唤起
    const prevEditable = ta.contentEditable;
    const prevReadOnly = ta.readOnly;
    ta.contentEditable = 'true';
    ta.readOnly = false;

    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, length);

    ta.contentEditable = prevEditable;
    ta.readOnly = prevReadOnly;
  } else {
    ta.select();
    ta.setSelectionRange(0, length);
  }
  return ta.selectionEnd > ta.selectionStart;
}

/**
 * @param {string} text 要复制的内容，空串直接跳过
 * @param {object}   [handlers]
 * @param {() => void} [handlers.onSuccess]      复制成功（两条路径都会回调），用来弹「已复制」
 * @param {(text: string) => void} [handlers.onFailure]
 *        浏览器拒绝了复制。**必须处理**：不给出口的话用户看到的就是「点了没反应」，
 *        无从判断是没选中、还是被浏览器挡了。手机版用它弹出可手动长按拷贝的面板。
 * @param {() => void} [handlers.onRestoreFocus] 回退路径里选中会抢走焦点，
 *                                               桌面端用它把焦点还给终端；手机端**不要**传
 *                                               （focus 终端会弹出输入法）。
 */
export function copyTextToClipboard(text, { onSuccess, onFailure, onRestoreFocus } = {}) {
  if (!text) return;

  const fallbackCopy = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = 'none';
    ta.style.opacity = '0';
    // 16px 以下 iOS 聚焦时会整页放大；这里虽然看不见，仍按规矩写死
    ta.style.fontSize = '16px';
    document.body.appendChild(ta);

    let ok = false;
    try {
      if (selectAll(ta, text.length)) ok = document.execCommand('copy');
    } catch { ok = false; }

    document.body.removeChild(ta);
    onRestoreFocus?.();
    if (ok) onSuccess?.();
    else onFailure?.(text);
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => onSuccess?.()).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}
