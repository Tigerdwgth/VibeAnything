// 粘贴图片 / 拖入文件的前端侧回归测试。
//
// jsdom 没有实现 DataTransfer / ClipboardEvent / DragEvent（探测确认：三者都是 undefined），
// 所以这里按规范补出最小的 DataTransfer 形状，再挂到**真实 Event** 上派发到**真实 DOM**。
// 被测的是我们自己的接线与提取逻辑，没有任何一处替身 —— File / FileReader / EventTarget
// 全是 jsdom 的真实实现（和 terminal-pointer.test.js 里 stub matchMedia 的性质一样：
// 补宿主环境的缺口，不替换被测对象）。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  filesFromDataTransfer, hasFiles, inferFileName, fileToBase64, quotePath,
  attachUploadHandlers,
} from '../src/terminal-upload.js';

/**
 * 按 DataTransfer 规范造一个够用的替身。
 *
 * **关键细节（2026-09-22 就是栽在这儿）**：真实浏览器里 `DataTransferItem.getAsFile()`
 * 每次调用都**现造一个新的 File 对象**；剪贴板截图不是磁盘上的文件，它的 `lastModified`
 * 取的是造对象那一刻的时间戳，所以两次调用拿到的值不一样。原来的替身两处返回**同一个
 * File 对象**，于是「按 name|size|lastModified 去重」在测试里永远成立、线上永远失效——
 * 粘一张图传两份。这里照真实行为每次现造，替身才有资格证明去重是对的。
 */
function makeDataTransfer(entries) {
  let clock = 1_700_000_000_000;
  const mint = (file) => {
    clock += 3;                       // 模拟「每次调用时间都不同」
    return new File([file], file.name, { type: file.type, lastModified: clock });
  };
  const items = entries.map((e) => (
    e.kind === 'file'
      ? {
        kind: 'file',
        type: e.file.type,
        getAsFile: () => mint(e.file),
        webkitGetAsEntry: () => (e.directory ? { isDirectory: true, isFile: false } : { isDirectory: false, isFile: true }),
      }
      : { kind: 'string', type: e.type || 'text/plain', getAsFile: () => null }
  ));
  // 浏览器里目录不出现在 .files 中，只在 items 里；照此还原。
  // .files 里的 File 同样是独立对象，和 getAsFile() 给的不是同一个。
  const files = entries
    .filter((e) => e.kind === 'file' && !e.directory && e.inFiles !== false)
    .map((e) => mint(e.file));
  return { items, files };
}

function pngFile(name = 'image.png') {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
}

/** 真实 Event + 规范外的 clipboardData/dataTransfer 属性（jsdom 不带这两个构造器）。 */
function dispatchWithData(el, type, dataKey, dt) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, dataKey, { value: dt, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

describe('filesFromDataTransfer', () => {
  test('从 items 里取出剪贴板图片', () => {
    const file = pngFile();
    const files = filesFromDataTransfer(makeDataTransfer([{ kind: 'file', file }]));
    expect(files).toHaveLength(1);
    // 不断言对象同一性：浏览器给的就不是同一个对象（getAsFile 每次现造），
    // 能用的判据是名字、类型、大小对得上。
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0].name).toBe(file.name);
    expect(files[0].type).toBe(file.type);
    expect(files[0].size).toBe(file.size);
  });

  test('同一个文件同时出现在 items 与 files 时只算一次', () => {
    // Chrome 粘贴截图时两处都有，不去重会把同一张图传两遍
    const file = pngFile();
    const dt = makeDataTransfer([{ kind: 'file', file }]);
    expect(dt.files).toHaveLength(1);          // 前提：替身确实两处都放了
    expect(filesFromDataTransfer(dt)).toHaveLength(1);
  });

  test('items 与 files 给的 File 对象不同（lastModified 都不一样）时仍然只算一次', () => {
    // 这正是线上「粘一张图传两份」的形态：两处的 File 除了内容一样，对象和时间戳都不同。
    // 去重键一旦把 lastModified 算进去，这里就会变成 2。
    const dt = makeDataTransfer([{ kind: 'file', file: pngFile() }]);
    const a = dt.items[0].getAsFile();
    const b = dt.files[0];
    expect(a).not.toBe(b);
    expect(a.lastModified).not.toBe(b.lastModified);
    expect(filesFromDataTransfer(dt)).toHaveLength(1);
  });

  test('Safari 粘贴截图：files 为空时退回 items，不能漏掉', () => {
    const dt = makeDataTransfer([{ kind: 'file', file: pngFile(), inFiles: false }]);
    expect(dt.files).toHaveLength(0);          // 前提：Safari 就是这样
    expect(filesFromDataTransfer(dt)).toHaveLength(1);
  });

  test('一次拖多个不同文件时一个都不能少', () => {
    const dt = makeDataTransfer([
      { kind: 'file', file: new File(['a'], 'a.png', { type: 'image/png' }) },
      { kind: 'file', file: new File(['bb'], 'b.png', { type: 'image/png' }) },
      { kind: 'file', file: new File(['ccc'], 'c.txt', { type: 'text/plain' }) },
    ]);
    expect(filesFromDataTransfer(dt).map(f => f.name)).toEqual(['a.png', 'b.png', 'c.txt']);
  });

  test('目录被挡掉', () => {
    // 拖文件夹进来时 File 的 size 为 0、读取必失败，不能让它进上传队列
    const dir = new File([], 'somedir', { type: '' });
    const files = filesFromDataTransfer(makeDataTransfer([{ kind: 'file', file: dir, directory: true }]));
    expect(files).toHaveLength(0);
  });

  test('纯文本剪贴板里没有文件', () => {
    const dt = makeDataTransfer([{ kind: 'string', type: 'text/plain' }]);
    expect(filesFromDataTransfer(dt)).toHaveLength(0);
    expect(hasFiles(dt)).toBe(false);
  });

  test('空 dataTransfer 不抛异常', () => {
    expect(filesFromDataTransfer(null)).toEqual([]);
    expect(filesFromDataTransfer({})).toEqual([]);
  });
});

describe('inferFileName', () => {
  test('截图的通用名换成带时间戳的名字，扩展名跟内容类型走', () => {
    const name = inferFileName(pngFile('image.png'), new Date(2026, 8, 17, 3, 4, 5));
    expect(name).toBe('pasted-20260917-030405.png');
  });

  test('用户自己的文件名原样保留', () => {
    expect(inferFileName(pngFile('架构图.png'))).toBe('架构图.png');
  });
});

describe('quotePath', () => {
  test('普通路径不加引号', () => {
    expect(quotePath('/Users/gsj/.vibeanything/uploads/2026-09-17/030405-a.png'))
      .toBe('/Users/gsj/.vibeanything/uploads/2026-09-17/030405-a.png');
  });

  test('含空格的路径加引号（不加的话 claude 只会看到前半截）', () => {
    expect(quotePath('/tmp/my shot.png')).toBe("'/tmp/my shot.png'");
  });

  test('含单引号的路径按 POSIX 规则转义', () => {
    expect(quotePath("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
  });
});

describe('fileToBase64', () => {
  test('真实 FileReader 往返，二进制不失真', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    const file = new File([bytes], 'a.bin', { type: 'application/octet-stream' });
    const b64 = await fileToBase64(file);
    expect(b64).toBe(btoa(String.fromCharCode(...bytes)));
  });
});

describe('attachUploadHandlers', () => {
  let container; let xtermSink; let handle; let received; let dragStates;

  beforeEach(() => {
    container = document.createElement('div');
    // 模拟 xterm 的 helper textarea：它自己在 target 阶段监听 paste。
    // 我们的 capture 监听挂在容器上，必须只在「有文件」时才拦住它。
    xtermSink = document.createElement('textarea');
    container.appendChild(xtermSink);
    document.body.appendChild(container);
    received = [];
    dragStates = [];
    handle = attachUploadHandlers(container, {
      onFiles: (files) => received.push(files),
      onDragState: (active) => dragStates.push(active),
    });
  });

  afterEach(() => {
    handle.dispose();
    container.remove();
  });

  test('粘贴图片：接管、阻止默认、不让 xterm 再粘一遍', () => {
    let xtermGotIt = false;
    xtermSink.addEventListener('paste', () => { xtermGotIt = true; });

    const ev = dispatchWithData(xtermSink, 'paste', 'clipboardData',
      makeDataTransfer([{ kind: 'file', file: pngFile() }]));

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(xtermGotIt).toBe(false);
  });

  test('粘贴纯文本：原样放行给 xterm 的原生粘贴', () => {
    let xtermGotIt = false;
    xtermSink.addEventListener('paste', () => { xtermGotIt = true; });

    const ev = dispatchWithData(xtermSink, 'paste', 'clipboardData',
      makeDataTransfer([{ kind: 'string', type: 'text/plain' }]));

    expect(received).toHaveLength(0);
    expect(ev.defaultPrevented).toBe(false);
    expect(xtermGotIt).toBe(true);
  });

  test('拖入文件：drop 交给上传，并阻止浏览器打开这个文件', () => {
    const ev = dispatchWithData(container, 'drop', 'dataTransfer',
      makeDataTransfer([{ kind: 'file', file: pngFile('shot.png') }]));

    expect(received).toHaveLength(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  test('dragover 必须 preventDefault，否则 drop 根本不会触发', () => {
    const ev = dispatchWithData(container, 'dragover', 'dataTransfer', makeDataTransfer([]));
    expect(ev.defaultPrevented).toBe(true);
  });

  test('拖拽悬停态：进出子元素不闪，离开才熄灭', () => {
    const dt = makeDataTransfer([{ kind: 'file', file: pngFile() }]);
    dispatchWithData(container, 'dragenter', 'dataTransfer', dt);   // 进容器
    dispatchWithData(xtermSink, 'dragenter', 'dataTransfer', dt);   // 进子元素（冒泡）
    dispatchWithData(xtermSink, 'dragleave', 'dataTransfer', dt);   // 出子元素
    expect(dragStates).toEqual([true]);                             // 还在容器里，不该熄
    dispatchWithData(container, 'dragleave', 'dataTransfer', dt);   // 真离开
    expect(dragStates).toEqual([true, false]);
  });

  test('drop 之后悬停态复位', () => {
    const dt = makeDataTransfer([{ kind: 'file', file: pngFile() }]);
    dispatchWithData(container, 'dragenter', 'dataTransfer', dt);
    dispatchWithData(container, 'drop', 'dataTransfer', dt);
    expect(dragStates).toEqual([true, false]);
  });

  test('dispose 后不再接管粘贴', () => {
    handle.dispose();
    const ev = dispatchWithData(xtermSink, 'paste', 'clipboardData',
      makeDataTransfer([{ kind: 'file', file: pngFile() }]));
    expect(received).toHaveLength(0);
    expect(ev.defaultPrevented).toBe(false);
  });
});
