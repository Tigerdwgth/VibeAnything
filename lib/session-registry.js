const fs = require('node:fs');
const path = require('node:path');
const { getIpcDir } = require('./ipc');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

function getSessionsDir() {
  const dir = path.join(getIpcDir(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFileName(machineId, sessionId) {
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe(machineId)}_${safe(sessionId)}.json`;
}

function sessionFilePath(machineId, sessionId) {
  return path.join(getSessionsDir(), sessionFileName(machineId, sessionId));
}

function registerSession({ machineId, sessionId, cwd, pid }) {
  const now = Date.now();
  const existing = getSession(machineId, sessionId);
  const data = {
    machineId,
    sessionId,
    cwd: cwd || '',
    pid: pid || process.pid,
    registeredAt: existing?.registeredAt || now,
    lastActivity: now
  };
  fs.writeFileSync(sessionFilePath(machineId, sessionId), JSON.stringify(data), 'utf-8');
  return data;
}

function getSession(machineId, sessionId) {
  const fp = sessionFilePath(machineId, sessionId);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

function touchSession(machineId, sessionId) {
  const sess = getSession(machineId, sessionId);
  if (!sess) return;
  sess.lastActivity = Date.now();
  fs.writeFileSync(sessionFilePath(machineId, sessionId), JSON.stringify(sess), 'utf-8');
}

function removeSession(machineId, sessionId) {
  const fp = sessionFilePath(machineId, sessionId);
  try { fs.unlinkSync(fp); } catch {}
}

function listActiveSessions() {
  const dir = getSessionsDir();
  const now = Date.now();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const sessions = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (now - data.lastActivity < SESSION_TTL_MS) {
        sessions.push(data);
      }
    } catch {}
  }
  return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
}

module.exports = {
  registerSession,
  getSession,
  touchSession,
  removeSession,
  listActiveSessions,
  getSessionsDir,
  SESSION_TTL_MS
};
