// lib/token-scanner.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { batchInsertTokenUsage } = require('./token-storage');
const { getMachineId, getBaseDir } = require('./config');

const BATCH_SIZE = 100;
const PROGRESS_FILE = path.join(getBaseDir(), 'scan-progress.json');

function getClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return {
      lastScannedFile: null,
      lastScannedLine: 0,
      totalFiles: 0,
      scannedFiles: 0,
      totalMessages: 0,
      insertedMessages: 0,
      startTime: Date.now(),
      lastUpdateTime: Date.now()
    };
  }

  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveProgress(progress) {
  const tmpFile = PROGRESS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(progress, null, 2), 'utf-8');
  fs.renameSync(tmpFile, PROGRESS_FILE);
}

function extractTokenData(message, filePath) {
  try {
    if (message.type !== 'assistant') return null;
    if (!message.message || !message.message.usage) return null;

    const usage = message.message.usage;
    const sessionId = message.sessionId || path.basename(filePath, '.jsonl');
    const projectPath = message.cwd || '/unknown';

    return {
      machine_id: getMachineId(),
      session_id: sessionId,
      project_path: projectPath,
      message_id: message.uuid,
      model: message.message.model || 'unknown',
      timestamp: Date.parse(message.timestamp) || Date.now(),
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0
    };
  } catch (err) {
    console.error('[token-scanner] Extract failed:', err.message);
    return null;
  }
}

async function parseTranscriptFile(filePath, startLine = 0) {
  const batch = [];
  let lineNumber = 0;

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    lineNumber++;
    if (lineNumber <= startLine) continue;

    try {
      const message = JSON.parse(line);
      const tokenData = extractTokenData(message, filePath);
      if (tokenData) {
        batch.push(tokenData);
      }
    } catch (err) {
      // 跳过解析失败的行
    }
  }

  return batch;
}

async function scanAllTranscripts(onProgress) {
  const projectsDir = getClaudeProjectsDir();
  if (!fs.existsSync(projectsDir)) {
    console.log('[token-scanner] Projects directory not found:', projectsDir);
    return { totalMessages: 0, insertedMessages: 0 };
  }

  const progress = loadProgress() || {
    lastScannedFile: null,
    lastScannedLine: 0,
    totalFiles: 0,
    scannedFiles: 0,
    totalMessages: 0,
    insertedMessages: 0,
    startTime: Date.now(),
    lastUpdateTime: Date.now()
  };

  // 查找所有 .jsonl 文件
  const files = [];
  function findJsonlFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findJsonlFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  findJsonlFiles(projectsDir);
  progress.totalFiles = files.length;

  console.log(`[token-scanner] Found ${files.length} transcript files`);

  // 从上次中断的地方继续
  let startIndex = 0;
  if (progress.lastScannedFile) {
    startIndex = files.indexOf(progress.lastScannedFile);
    if (startIndex < 0) startIndex = 0;
  }

  for (let i = startIndex; i < files.length; i++) {
    const file = files[i];
    const startLine = (file === progress.lastScannedFile) ? progress.lastScannedLine : 0;

    console.log(`[token-scanner] Scanning ${i + 1}/${files.length}: ${file}`);

    try {
      const batch = await parseTranscriptFile(file, startLine);
      progress.totalMessages += batch.length;

      if (batch.length > 0) {
        const inserted = await batchInsertTokenUsage(batch);
        progress.insertedMessages += inserted;
      }

      progress.scannedFiles = i + 1;
      progress.lastScannedFile = file;
      progress.lastScannedLine = 0; // 文件扫描完成，重置行号
      progress.lastUpdateTime = Date.now();

      saveProgress(progress);

      if (onProgress) {
        onProgress(progress);
      }
    } catch (err) {
      console.error(`[token-scanner] Failed to scan ${file}:`, err.message);
    }
  }

  console.log(`[token-scanner] Scan complete: ${progress.insertedMessages}/${progress.totalMessages} messages inserted`);
  return progress;
}

module.exports = {
  scanAllTranscripts,
  parseTranscriptFile,
  extractTokenData,
  loadProgress,
  saveProgress
};
