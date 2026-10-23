import { useRef, useState } from 'react';
import { useTheme, makeInputBase } from './theme';
import Avatar from './Avatar';
import {
  NICKNAME_MAX_LENGTH, ACCEPTED_SOURCE_TYPES,
  checkNickname, fileToAvatarDataUrl, usesDefaultAvatar,
} from './profile';

/**
 * 个人信息弹窗：改自己的昵称和头像。
 *
 * 只提交**改动过**的字段 —— 服务端把「没传」和「传了 null」当两件事（前者不动、
 * 后者清空回落默认），只改昵称时不该把几十 KB 的头像原样再传一遍，更不该误清。
 *
 * fullscreen：手机版铺满整屏（弹窗在小屏上挤成一条）。桌面版是居中的卡片。
 */
export default function ProfileModal({ token, profile, onClose, onSaved, fullscreen = false }) {
  const T = useTheme();
  const inputBase = makeInputBase(T);
  const fileRef = useRef(null);

  const [nickname, setNickname] = useState(profile?.nickname || '');
  const [avatar, setAvatar] = useState(profile?.avatar || null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const draft = { username: profile?.username, nickname, avatar };
  const nicknameError = checkNickname(nickname);
  const nicknameLength = Array.from(nickname.trim()).length;
  const dirty = (nickname.trim() !== (profile?.nickname || '')) || (avatar !== (profile?.avatar || null));

  async function pickImage(file) {
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      setAvatar(await fileToAvatarDataUrl(file));
    } catch (e) {
      // 解码/压缩失败必须说出来：这一步没有任何视觉反馈，静默失败等于「点了没反应」
      setError(e.message || '这张图片处理失败');
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    pickImage(e.dataTransfer?.files?.[0]);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (nicknameError) { setError(nicknameError); return; }

    const patch = {};
    if (nickname.trim() !== (profile?.nickname || '')) patch.nickname = nickname.trim() || null;
    if (avatar !== (profile?.avatar || null)) patch.avatar = avatar;
    if (!Object.keys(patch).length) { onClose(); return; }

    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error || '保存失败'); return; }
      onSaved?.(data);
      onClose();
    } catch {
      setError('连接服务器失败');
    } finally {
      setBusy(false);
    }
  }

  const card = fullscreen
    ? { width: '100%', height: '100%', maxWidth: 'none', borderRadius: 0, overflowY: 'auto' }
    : { width: '100%', maxWidth: '380px', borderRadius: T.radiusLg, boxShadow: '0 24px 64px rgba(0,0,0,0.5)' };

  return (
    <div
      className="va-fade"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: T.fontSans,
      }}
    >
      <div
        className="va-pop"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.bgCard, border: `1px solid ${T.border}`,
          padding: '1.5rem', boxSizing: 'border-box', ...card,
        }}
      >
        <h3 style={{ margin: '0 0 1.25rem 0', color: T.textPrimary, fontSize: '1.1rem' }}>个人信息</h3>

        {error && (
          <div style={{
            background: T.dangerDim, border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: T.radiusSm, padding: '0.5rem 0.75rem',
            color: '#fca5a5', fontSize: '0.82rem', marginBottom: '1rem',
          }}>{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          {/* 头像：大图预览 + 点击/拖入换图 */}
          <div
            onClick={() => !busy && fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            title="点击选择图片，或把图片拖进来"
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem',
              padding: '1rem', marginBottom: '1.1rem',
              border: `1px dashed ${dragging ? T.accent : T.border}`,
              background: dragging ? T.accentDim : 'transparent',
              borderRadius: T.radiusMd, cursor: busy ? 'wait' : 'pointer',
              transition: 'background-color 0.15s, border-color 0.15s, color 0.15s, opacity 0.15s, box-shadow 0.15s',
            }}
          >
            <Avatar profile={draft} size={88} radius="50%" style={{ border: `1px solid ${T.border}` }} />
            <span style={{ fontSize: '0.75rem', color: T.textMuted }}>
              点击选择图片，或拖进来
            </span>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_SOURCE_TYPES.join(',')}
            onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ''; }}
            style={{ display: 'none' }}
          />

          <button
            type="button"
            onClick={() => setAvatar(null)}
            disabled={busy || usesDefaultAvatar(draft)}
            style={{
              width: '100%', padding: '0.4rem', marginBottom: '1.1rem',
              background: 'none', color: T.textSecondary,
              border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
              fontSize: '0.78rem', fontFamily: T.fontSans,
              cursor: usesDefaultAvatar(draft) ? 'not-allowed' : 'pointer',
              opacity: usesDefaultAvatar(draft) ? 0.5 : 1,
            }}
          >恢复默认头像</button>

          <div style={{ marginBottom: '1.25rem' }}>
            <label
              htmlFor="profile-nickname"
              style={{
                display: 'flex', justifyContent: 'space-between',
                color: T.textSecondary, fontSize: '0.8rem', marginBottom: '0.35rem',
              }}
            >
              <span>昵称</span>
              <span style={{ color: nicknameLength > NICKNAME_MAX_LENGTH ? T.danger : T.textMuted }}>
                {nicknameLength}/{NICKNAME_MAX_LENGTH}
              </span>
            </label>
            <input
              id="profile-nickname"
              name="nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={profile?.username || ''}
              autoComplete="nickname"
              style={inputBase}
            />
            <div style={{ marginTop: '0.35rem', fontSize: '0.72rem', color: T.textMuted }}>
              留空则显示用户名 {profile?.username}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              style={{
                flex: 1, padding: '0.5rem',
                background: T.bgHover, color: T.textPrimary,
                border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                cursor: busy ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem', fontFamily: T.fontSans,
              }}
            >取消</button>
            <button
              type="submit"
              disabled={busy || !!nicknameError || !dirty}
              style={{
                flex: 1, padding: '0.5rem',
                background: (busy || nicknameError || !dirty) ? T.bgHover : T.accent,
                color: '#fff', border: 'none', borderRadius: T.radiusSm,
                cursor: (busy || nicknameError || !dirty) ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem', fontWeight: 600, fontFamily: T.fontSans,
                opacity: busy ? 0.7 : 1,
              }}
            >{busy ? '处理中…' : '保存'}</button>
          </div>
        </form>

        {/* 昵称可以随便改，用户名不能 —— 登录时要填的是它，这里得留个地方看得到 */}
        <div style={{ marginTop: '1rem', fontSize: '0.72rem', color: T.textMuted, textAlign: 'center' }}>
          登录账号 {profile?.username}
        </div>
      </div>
    </div>
  );
}
