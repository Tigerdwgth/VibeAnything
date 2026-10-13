import { useState } from 'react';
import { DEFAULT_AVATAR, avatarSrcOf, displayNameOf } from './profile';

/**
 * 头像。没设过就是站点默认图。
 *
 * 自定义头像加载不出来时（data 坏了、或是老浏览器不认那个格式）退回默认图：
 * 头像位上挂一个裂图图标，比显示默认兔子难看得多，而且会让人以为是账号出了问题。
 *
 * 记的是「哪一张失败了」而不是一个 failed 布尔 —— 换新头像时不必再拿 effect 把
 * 布尔重置回去（那正是 React 19 会拦下的写法），新 src 与记下的那张不同，自然重试。
 */
export default function Avatar({ profile, size = 26, radius = '6px', style, ...rest }) {
  const src = avatarSrcOf(profile);
  const [failedSrc, setFailedSrc] = useState(null);
  const shown = failedSrc === src ? DEFAULT_AVATAR : src;

  return (
    <img
      src={shown}
      alt={displayNameOf(profile)}
      draggable={false}
      onError={() => setFailedSrc(src)}
      style={{
        width: `${size}px`, height: `${size}px`,
        borderRadius: radius, objectFit: 'cover',
        flexShrink: 0, userSelect: 'none',
        ...style,
      }}
      {...rest}
    />
  );
}
