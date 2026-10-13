// Mebular 桌面 App · 托盘状态点（16×16 纯色 PNG，内联；无外联、无遥测）
// 绿=健康 / 黄=启动中 / 红=异常。

const PNG = {
  green: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mPQO1NIEmIY1TCqYfhqAAC4lWsQZ+JqLgAAAABJRU5ErkJggg==',
  yellow: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4eISfJMQwqmFUw/DVAAAtq8QQs3hcsgAAAABJRU5ErkJggg==',
  red: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mN47mNDEmIY1TCqYfhqAADG/m8QxE7EoQAAAABJRU5ErkJggg==',
};

export function iconDataUrl(state) {
  const key = state === 'green' || state === 'yellow' || state === 'red' ? state : 'red';
  return `data:image/png;base64,${PNG[key]}`;
}

export const TRAY_STATES = Object.freeze(['green', 'yellow', 'red']);
