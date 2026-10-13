# Dashboard Enhancements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add machine/directory switching and password change functionality to Dashboard

**Architecture:**
- Frontend: Add machine selector dropdown and password change modal in React
- Backend: Add directory listing API and password update endpoint with validation
- Security: Verify old password before allowing change, validate directory access

**Tech Stack:** React, Express, SQLite (bcrypt), WebSocket (existing)

---

## Task 1: Backend - Add Directory Listing API

**Files:**
- Modify: `packages/server/index.js` (add new endpoint)
- Test: Manual test with curl

**Step 1: Add directory listing endpoint**

Add after the `/api/me` endpoint in `packages/server/index.js`:

```javascript
// 获取指定机器的目录列表
app.get('/api/machines/:machineId/directories', authMiddleware, (req, res) => {
  const { machineId } = req.params;
  const { path: dirPath } = req.query;

  // 通过 relay 向指定机器请求目录列表
  const { RelayServer } = require('./relay');
  const relay = global.relayServer;
  if (!relay) return res.status(503).json({ error: 'Relay not available' });

  const machine = relay.getMachine(machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });

  // 发送请求到机器
  machine.ws.send(JSON.stringify({
    type: 'list_dir',
    path: dirPath || require('os').homedir()
  }));

  // 等待响应（简化版，实际应该用 Promise）
  res.json({ message: 'Request sent, check WebSocket for response' });
});
```

**Step 2: Store relay server globally**

Modify `startServer` function in `packages/server/index.js`:

```javascript
function startServer(opts = {}) {
  // ... existing code ...
  const relay = new RelayServer();
  global.relayServer = relay;  // 添加这行
  // ... rest of code ...
}
```

**Step 3: Test the endpoint**

```bash
# Start server
cd /opt/ccfeishu
HOST=TAILSCALE_IP_REDACTED node packages/server/index.js

# In another terminal, test
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/machines/test-machine/directories?path=/home
```

Expected: `{"message": "Request sent, check WebSocket for response"}`

**Step 4: Commit**

```bash
git add packages/server/index.js
git commit -m "feat(api): add directory listing endpoint for machines"
```

---

## Task 2: Backend - Add Password Change API

**Files:**
- Modify: `packages/server/auth.js` (add updatePassword function)
- Modify: `packages/server/index.js` (add endpoint)
- Test: Manual test with curl

**Step 1: Add updatePassword function to auth.js**

Add to `packages/server/auth.js`:

```javascript
async function updatePassword(username, oldPassword, newPassword) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE username = ?', username);
  if (!user) throw new Error('User not found');

  // 验证旧密码
  const valid = await bcrypt.compare(oldPassword, user.password);
  if (!valid) throw new Error('Invalid old password');

  // 更新密码
  const hash = await bcrypt.hash(newPassword, 10);
  await db.run('UPDATE users SET password = ? WHERE username = ?', hash, username);
  return true;
}

module.exports = { createUser, verifyPassword, generateToken, authMiddleware, listUsers, updatePassword };
```

**Step 2: Add password change endpoint**

Add to `packages/server/index.js` after `/api/me`:

```javascript
// 修改密码
app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '旧密码和新密码不能为空' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少6个字符' });
  }

  try {
    const { updatePassword } = require('./auth');
    await updatePassword(req.user.username, oldPassword, newPassword);
    res.json({ success: true, message: '密码修改成功' });
  } catch (e) {
    if (e.message.includes('Invalid old password')) {
      return res.status(401).json({ error: '旧密码错误' });
    }
    res.status(500).json({ error: '修改失败' });
  }
});
```

**Step 3: Test the endpoint**

```bash
# Test with curl
curl -X POST http://localhost:3000/api/change-password \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"oldPassword":"admin123","newPassword":"newpass123"}'
```

Expected: `{"success":true,"message":"密码修改成功"}`

**Step 4: Verify password changed**

```bash
# Try login with new password
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"newpass123"}'
```

Expected: Returns token

**Step 5: Commit**

```bash
git add packages/server/auth.js packages/server/index.js
git commit -m "feat(api): add password change endpoint with validation"
```

---

## Task 3: Frontend - Add Machine Selector Component

**Files:**
- Create: `packages/server/frontend/src/MachineSelector.jsx`
- Modify: `packages/server/frontend/src/Dashboard.jsx`

**Step 1: Create MachineSelector component**

Create `packages/server/frontend/src/MachineSelector.jsx`:

```jsx
import { useTheme } from './theme';

export default function MachineSelector({ machines, currentMachine, onSelect }) {
  const T = useTheme();

  if (!machines || machines.length <= 1) return null;

  return (
    <div style={{ marginBottom: '1rem' }}>
      <label style={{
        display: 'block',
        color: T.textSecondary,
        fontSize: '0.8rem',
        marginBottom: '0.5rem'
      }}>
        选择开发机
      </label>
      <select
        value={currentMachine || ''}
        onChange={(e) => onSelect(e.target.value)}
        style={{
          width: '100%',
          padding: '0.5rem',
          background: T.bgBase,
          border: `1px solid ${T.border}`,
          borderRadius: T.radiusSm,
          color: T.textPrimary,
          fontSize: '0.875rem',
          cursor: 'pointer'
        }}
      >
        <option value="">所有开发机</option>
        {machines.map(m => (
          <option key={m.machineId} value={m.machineId}>
            {m.machineId} ({m.sessionCount} sessions)
          </option>
        ))}
      </select>
    </div>
  );
}
```

**Step 2: Integrate into Dashboard**

Modify `packages/server/frontend/src/Dashboard.jsx`:

Add import:
```javascript
import MachineSelector from './MachineSelector';
```

Add state:
```javascript
const [selectedMachine, setSelectedMachine] = useState('');
```

Add machine list computation:
```javascript
const machines = useMemo(() => {
  const map = new Map();
  sessions.forEach(s => {
    if (!map.has(s.machineId)) {
      map.set(s.machineId, { machineId: s.machineId, sessionCount: 0 });
    }
    map.get(s.machineId).sessionCount++;
  });
  return Array.from(map.values());
}, [sessions]);

const filteredSessions = useMemo(() => {
  if (!selectedMachine) return sessions;
  return sessions.filter(s => s.machineId === selectedMachine);
}, [sessions, selectedMachine]);
```

Add component before session list:
```jsx
<MachineSelector
  machines={machines}
  currentMachine={selectedMachine}
  onSelect={setSelectedMachine}
/>
```

Use `filteredSessions` instead of `sessions` in the session list.

**Step 3: Build and test**

```bash
cd packages/server/frontend
npm run build
```

Expected: Build succeeds

**Step 4: Deploy and verify**

```bash
# Copy to server
scp -r dist/ root@SERVER_IP_REDACTED:/opt/ccfeishu/packages/server/frontend/

# Restart server and test in browser
```

Expected: See machine selector dropdown in Dashboard

**Step 5: Commit**

```bash
git add packages/server/frontend/src/MachineSelector.jsx \
        packages/server/frontend/src/Dashboard.jsx
git commit -m "feat(ui): add machine selector dropdown to filter sessions"
```

---

## Task 4: Frontend - Add Password Change Modal

**Files:**
- Create: `packages/server/frontend/src/ChangePasswordModal.jsx`
- Modify: `packages/server/frontend/src/Dashboard.jsx`

**Step 1: Create ChangePasswordModal component**

Create `packages/server/frontend/src/ChangePasswordModal.jsx`:

```jsx
import { useState } from 'react';
import { useTheme, makeInputBase } from './theme';

export default function ChangePasswordModal({ onClose, onSuccess }) {
  const T = useTheme();
  const inputBase = makeInputBase(T);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (newPassword.length < 6) {
      setError('新密码至少6个字符');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ oldPassword, newPassword })
      });

      if (res.ok) {
        onSuccess();
      } else {
        const { error: msg } = await res.json();
        setError(msg || '修改失败');
      }
    } catch {
      setError('连接服务器失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: T.bgCard, border: `1px solid ${T.border}`,
        borderRadius: T.radiusLg, padding: '1.5rem',
        width: '100%', maxWidth: '400px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)'
      }}>
        <h3 style={{ margin: '0 0 1rem 0', color: T.textPrimary, fontSize: '1.1rem' }}>
          修改密码
        </h3>

        {error && (
          <div style={{
            background: T.dangerDim, border: `1px solid rgba(239,68,68,0.25)`,
            borderRadius: T.radiusSm, padding: '0.5rem 0.75rem',
            color: '#fca5a5', fontSize: '0.82rem', marginBottom: '1rem'
          }}>{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', color: T.textSecondary, fontSize: '0.8rem', marginBottom: '0.35rem' }}>
              旧密码
            </label>
            <input
              type="password"
              name="old-password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={e => setOldPassword(e.target.value)}
              style={inputBase}
              autoFocus
            />
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', color: T.textSecondary, fontSize: '0.8rem', marginBottom: '0.35rem' }}>
              新密码
            </label>
            <input
              type="password"
              name="new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              style={inputBase}
            />
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', color: T.textSecondary, fontSize: '0.8rem', marginBottom: '0.35rem' }}>
              确认新密码
            </label>
            <input
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              style={inputBase}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                flex: 1, padding: '0.5rem',
                background: T.bgHover, color: T.textPrimary,
                border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                cursor: 'pointer', fontSize: '0.875rem'
              }}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{
                flex: 1, padding: '0.5rem',
                background: loading ? T.bgHover : T.accent,
                color: '#fff', border: 'none', borderRadius: T.radiusSm,
                cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem', fontWeight: 600,
                opacity: loading ? 0.7 : 1
              }}
            >
              {loading ? '修改中...' : '确认修改'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

**Step 2: Add to Dashboard**

Modify `packages/server/frontend/src/Dashboard.jsx`:

Add import:
```javascript
import ChangePasswordModal from './ChangePasswordModal';
```

Add state:
```javascript
const [showPasswordModal, setShowPasswordModal] = useState(false);
```

Add button in header (near logout button):
```jsx
<button
  onClick={() => setShowPasswordModal(true)}
  style={{
    padding: '0.4rem 0.75rem',
    background: T.bgHover,
    border: `1px solid ${T.border}`,
    borderRadius: T.radiusSm,
    color: T.textPrimary,
    cursor: 'pointer',
    fontSize: '0.8rem'
  }}
>
  修改密码
</button>
```

Add modal at end of component:
```jsx
{showPasswordModal && (
  <ChangePasswordModal
    onClose={() => setShowPasswordModal(false)}
    onSuccess={() => {
      setShowPasswordModal(false);
      alert('密码修改成功，请重新登录');
      onLogout();
    }}
  />
)}
```

**Step 3: Build and test**

```bash
cd packages/server/frontend
npm run build
```

Expected: Build succeeds

**Step 4: Deploy and test in browser**

```bash
scp -r dist/ root@SERVER_IP_REDACTED:/opt/ccfeishu/packages/server/frontend/
```

Test:
1. Click "修改密码" button
2. Enter old password: `admin123`
3. Enter new password: `newpass123`
4. Confirm new password: `newpass123`
5. Click "确认修改"

Expected: Success message, redirected to login

**Step 5: Commit**

```bash
git add packages/server/frontend/src/ChangePasswordModal.jsx \
        packages/server/frontend/src/Dashboard.jsx
git commit -m "feat(ui): add password change modal with validation"
```

---

## Task 5: Integration Testing

**Step 1: Test machine selector**

1. Open Dashboard with multiple machines connected
2. Select a machine from dropdown
3. Verify only that machine's sessions are shown
4. Select "所有开发机"
5. Verify all sessions are shown

**Step 2: Test password change**

1. Login with current password
2. Click "修改密码"
3. Test validation:
   - Wrong old password → Error
   - New password < 6 chars → Error
   - Passwords don't match → Error
4. Change password successfully
5. Logout and login with new password

**Step 3: Test edge cases**

1. Change password while another session is active
2. Try to access API without token
3. Try to change password with empty fields

**Step 4: Document in README**

Add to README.md:

```markdown
## 新功能

### 开发机切换
- Dashboard 顶部显示开发机选择器
- 可以按开发机筛选 session 列表
- 显示每台机器的 session 数量

### 修改密码
- 登录后点击"修改密码"按钮
- 需要验证旧密码
- 新密码至少 6 个字符
- 修改成功后需要重新登录
```

**Step 5: Final commit**

```bash
git add README.md
git commit -m "docs: document machine selector and password change features"
```

---

## Deployment Checklist

- [ ] All tests pass
- [ ] Frontend builds without errors
- [ ] Backend starts without errors
- [ ] Machine selector works with multiple machines
- [ ] Password change validates correctly
- [ ] Old password verification works
- [ ] New password is saved correctly
- [ ] Documentation updated
- [ ] Code committed and pushed

---

## Rollback Plan

If issues occur:

```bash
# Revert to previous version
git revert HEAD~5..HEAD

# Rebuild frontend
cd packages/server/frontend && npm run build

# Redeploy
scp -r dist/ root@SERVER_IP_REDACTED:/opt/ccfeishu/packages/server/frontend/

# Restart server
ssh root@SERVER_IP_REDACTED "pkill -f 'node.*index.js' && \
  cd /opt/ccfeishu && \
  HOST=TAILSCALE_IP_REDACTED MACHINE_TOKENS=<token> \
  nohup node packages/server/index.js > /var/log/ccfeishu.log 2>&1 &"
```
