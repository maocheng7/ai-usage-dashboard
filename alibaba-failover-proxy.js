const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 9091;
const AUTH_JSON = '/home/ubuntu/.local/share/opencode/auth.json';
const ALI_API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Keys
const PRIMARY_KEY = 'sk-sp-eaccac62a96c4236a12ac9259f2ca4c6';
const BACKUP_KEY = 'sk-sp-4b313e1123e24aba9003603c0758600e';

// State
let currentKey = PRIMARY_KEY;
let primaryFailed = false;
let primaryFailUntil = 0;
let lastSwitchTime = 0;

function maskKey(k) { return k ? k.slice(0, 10) + '...' + k.slice(-4) : '-'; }

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function updateAuthJson(key) {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_JSON, 'utf-8'));
    auth['alibaba-coding-plan-cn'].key = key;
    fs.writeFileSync(AUTH_JSON, JSON.stringify(auth, null, 2) + '\n');
    log(`auth.json updated: ${maskKey(key)}`);
  } catch (e) {
    log(`Failed to update auth.json: ${e.message}`);
  }
}

function switchToBackup() {
  if (currentKey === BACKUP_KEY) return;
  currentKey = BACKUP_KEY;
  primaryFailed = true;
  primaryFailUntil = Date.now() + COOLDOWN_MS;
  lastSwitchTime = Date.now();
  updateAuthJson(BACKUP_KEY);
  log(`SWITCHED to backup key: ${maskKey(BACKUP_KEY)}`);
}

function switchToPrimary() {
  if (currentKey === PRIMARY_KEY) return;
  currentKey = PRIMARY_KEY;
  primaryFailed = false;
  primaryFailUntil = 0;
  lastSwitchTime = Date.now();
  updateAuthJson(PRIMARY_KEY);
  log(`SWITCHED to primary key: ${maskKey(PRIMARY_KEY)}`);
}

function maybeRecoverPrimary() {
  if (!primaryFailed) return;
  if (Date.now() > primaryFailUntil) {
    log(`Cooldown expired, trying primary key again...`);
    switchToPrimary();
  }
}

function forwardRequest(apiKey, body, res, startTime, isRetry) {
  const url = new URL(ALI_API_BASE + '/chat/completions');
  const payload = JSON.stringify(body);
  const isStream = body.stream === true;

  const req = https.request(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (upstream) => {
    if (isStream) {
      res.writeHead(upstream.statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      upstream.on('data', (chunk) => res.write(chunk));
      upstream.on('end', () => {
        res.end();
        if (upstream.statusCode === 401) {
          log(`401 on streaming response, key invalid`);
          if (apiKey === PRIMARY_KEY) switchToBackup();
        }
      });
    } else {
      let data = '';
      upstream.on('data', c => data += c);
      upstream.on('end', () => {
        const latency = Date.now() - startTime;
        if (upstream.statusCode === 401 || upstream.statusCode === 403) {
          log(`HTTP ${upstream.statusCode} on key ${maskKey(apiKey)}`);
          if (apiKey === PRIMARY_KEY && !isRetry) {
            switchToBackup();
            // Retry with backup
            forwardRequest(BACKUP_KEY, body, res, startTime, true);
            return;
          }
          res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
          return;
        }
        if (upstream.statusCode >= 500 && !isRetry) {
          log(`HTTP ${upstream.statusCode}, retrying...`);
          forwardRequest(currentKey, body, res, startTime, true);
          return;
        }
        res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
        log(`OK (${latency}ms) key=${maskKey(currentKey)}`);
      });
    }
  });

  req.on('error', (e) => {
    log(`Network error: ${e.message}`);
    if (!isRetry) {
      forwardRequest(currentKey, body, res, startTime, true);
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  });

  req.write(payload);
  req.end();
}

// Health check endpoint
function handleHealth(res) {
  maybeRecoverPrimary();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    currentKey: maskKey(currentKey),
    primaryFailed: primaryFailed,
    primaryFailUntil: primaryFailUntil > 0 ? new Date(primaryFailUntil).toISOString() : null,
    uptime: process.uptime(),
  }));
}

// Force switch endpoint
function handleForceSwitch(res, url) {
  const target = url.searchParams.get('to');
  if (target === 'primary') {
    switchToPrimary();
  } else if (target === 'backup') {
    switchToBackup();
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Use ?to=primary or ?to=backup' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, currentKey: maskKey(currentKey) }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') return handleHealth(res);
  if (url.pathname === '/switch') return handleForceSwitch(res, url);

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        maybeRecoverPrimary();
        const parsed = JSON.parse(body);
        log(`Request: model=${parsed.model || 'unknown'} stream=${!!parsed.stream} key=${maskKey(currentKey)}`);
        forwardRequest(currentKey, parsed, res, Date.now(), false);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      }
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    // Proxy models listing
    const url2 = new URL(ALI_API_BASE + '/models');
    https.get(url2, { headers: { 'Authorization': `Bearer ${currentKey}` } }, (upstream) => {
      let data = '';
      upstream.on('data', c => data += c);
      upstream.on('end', () => {
        res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    }).on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Alibaba Coding Plan failover proxy started on port ${PORT}`);
  log(`Primary key: ${maskKey(PRIMARY_KEY)}`);
  log(`Backup key:  ${maskKey(BACKUP_KEY)}`);
  log(`Health:      http://localhost:${PORT}/health`);
  log(`Force switch: http://localhost:${PORT}/switch?to=backup`);
});
