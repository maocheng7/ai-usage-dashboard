const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

const PORT = 9090;
const DB_PATH = path.join(__dirname, 'stats.db');

// ─── 数据库 ────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT,
    ts TEXT DEFAULT (datetime('now','localtime')),
    model TEXT,
    stream INTEGER DEFAULT 0,
    source TEXT DEFAULT 'API',
    client_ip TEXT,
    channel TEXT,
    api_key TEXT,
    provider TEXT,
    status TEXT DEFAULT 'ok',
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cache_read INTEGER DEFAULT 0,
    cache_write INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    latency_ms INTEGER DEFAULT 0,
    ttft_ms INTEGER DEFAULT 0
  )
`);

function insertRequest(info) {
  db.prepare(`
    INSERT INTO requests (request_id, model, stream, source, client_ip, channel, api_key, provider, status,
      input_tokens, output_tokens, total_tokens, cache_read, cache_write, cost, latency_ms, ttft_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    info.request_id, info.model, info.stream ? 1 : 0, info.source, info.client_ip,
    info.channel, info.api_key, info.provider, info.status,
    info.input_tokens, info.output_tokens, info.total_tokens,
    info.cache_read, info.cache_write, info.cost, info.latency_ms, info.ttft_ms
  );
}

// ─── 服务商配置 ───────────────────────────────────────────────────
const PROVIDERS = [
  {
    name: 'MiMo',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    apiKey: 'tp-c8x9pz0lpghao0frcjwobmh5u6js8htnbv61r1als4rn4sup',
    channel: 'Mimo 订阅',
    models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro', 'mimo-v2-omni'],
    status: 'ok', failUntil: 0, lastError: null,
  },
  {
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    apiKey: 'sk-cp-0J0H-xxJh0ne85xgU0K6JKpjysHEWHUKhb0OKnvMK4Eyx0n47V7sQ7RWjM4JYRpCgvTeJh7w0WpCaPspjQUtMvkp8EMNMLCsag5SDKeizatlBquzeK3c1hg',
    channel: 'MiniMax',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'],
    status: 'ok', failUntil: 0, lastError: null,
  },
];

const FALLBACK_MAP = {
  'mimo-v2.5-pro': 'MiniMax-M2.7',
  'mimo-v2.5': 'MiniMax-M2.7',
  'mimo-v2-pro': 'MiniMax-M2.7',
  'mimo-v2-omni': 'MiniMax-M2.7',
};
const COOLDOWN_MS = 60_000;

function pickProvider(model) {
  for (const p of PROVIDERS) {
    if (p.status === 'cooling' && Date.now() < p.failUntil) continue;
    p.status = 'ok';
    return { provider: p, model };
  }
  return { provider: PROVIDERS[0], model };
}
function markFailed(p, err) { p.status = 'cooling'; p.failUntil = Date.now() + COOLDOWN_MS; p.lastError = err; }
function markOk(p) { p.status = 'ok'; p.lastError = null; }
function maskKey(k) { return k ? k.slice(0, 6) + '...' + k.slice(-4) : '-'; }

// 获取服务器真实 IP（公网 IPv4）
let SERVER_IP = '127.0.0.1';

// 尝试获取公网 IPv4
function fetchPublicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data.trim()));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 初始化时获取公网 IP
(async () => {
  try {
    const publicIp = await fetchPublicIp();
    if (publicIp && publicIp.includes('.')) {
      SERVER_IP = publicIp;
      console.log(`服务器公网 IPv4: ${SERVER_IP}`);
    } else {
      // 使用用户指定的公网 IP
      SERVER_IP = '120.53.230.157';
      console.log(`使用指定公网 IP: ${SERVER_IP}`);
    }
  } catch {
    SERVER_IP = '120.53.230.157';
    console.log(`使用指定公网 IP: ${SERVER_IP}`);
  }
})();

// 费用计算（每百万 token 价格，单位美元）
const PRICING = {
  'MiMo': {
    'mimo-v2.5-pro': { input: 2.0, output: 8.0, cached: 0.5 },
    'mimo-v2.5': { input: 1.0, output: 4.0, cached: 0.25 },
    'mimo-v2-pro': { input: 2.0, output: 8.0, cached: 0.5 },
    'mimo-v2-omni': { input: 2.0, output: 8.0, cached: 0.5 },
  },
  'MiniMax': {
    'MiniMax-M2.7': { input: 2.0, output: 8.0, cached: 0 },
    'MiniMax-M2.7-highspeed': { input: 3.0, output: 12.0, cached: 0 },
    'MiniMax-M2.5': { input: 1.0, output: 4.0, cached: 0 },
  },
};

function calcCost(provider, model, inputTokens, outputTokens, cachedTokens) {
  const providerPricing = PRICING[provider];
  if (!providerPricing) return 0;
  const pricing = providerPricing[model];
  if (!pricing) return 0;
  const nonCachedInput = inputTokens - cachedTokens;
  const inputCost = (nonCachedInput / 1000000) * pricing.input;
  const cachedCost = (cachedTokens / 1000000) * (pricing.cached || pricing.input * 0.5);
  const outputCost = (outputTokens / 1000000) * pricing.output;
  return inputCost + cachedCost + outputCost;
}

// ─── 外部数据同步 ───────────────────────────────────────────────────
const CLAUDE_JSON = '/home/ubuntu/.claude.json';
let lastSyncHash = '';

function syncExternal() {
  try {
    if (!fs.existsSync(CLAUDE_JSON)) return;
    const cj = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf-8'));
    const proj = cj.projects?.['/home/ubuntu'];
    if (!proj?.lastModelUsage) return;
    const hash = JSON.stringify(proj.lastModelUsage);
    if (hash === lastSyncHash) return;
    lastSyncHash = hash;
    db.exec(`DELETE FROM requests WHERE provider='Claude'`);
    const ins = db.prepare(`INSERT INTO requests (request_id,model,stream,source,client_ip,channel,api_key,provider,status,input_tokens,output_tokens,total_tokens,cache_read,cache_write,cost,latency_ms,ttft_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [model, u] of Object.entries(proj.lastModelUsage)) {
      const inp = u.inputTokens || 0;
      const out = u.outputTokens || 0;
      const cached = u.cacheReadInputTokens || 0;
      const cost = u.costUSD || 0;
      ins.run('sync-' + Date.now(), model.replace('[1m]', ''), 0, 'CLI', '127.0.0.1', 'Claude Code', '-', 'Claude', 'ok', inp, out, inp + out, cached, 0, cost, 0, 0);
    }
  } catch {}
}
setInterval(syncExternal, 5000);
syncExternal();

// ─── 代理处理 ───────────────────────────────────────────────────────
function forwardRequest(provider, model, body, res, startTime, clientIp, requestId) {
  const url = new URL(provider.baseUrl + '/chat/completions');
  const payload = JSON.stringify({ ...body, model });
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const isStream = body.stream === true;

  const req = mod.request(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
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
      let firstChunk = true;
      let ttft = 0;
      let buffer = '';
      let usage = {};

      upstream.on('data', (chunk) => {
        if (firstChunk) { ttft = Date.now() - startTime; firstChunk = false; }
        res.write(chunk);
        buffer += chunk.toString();
        // 解析 SSE 数据获取用量信息
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const d = JSON.parse(line.slice(6));
              if (d.usage) usage = d.usage;
            } catch {}
          }
        }
      });

      upstream.on('end', () => {
        res.end();
        const latency = Date.now() - startTime;
        markOk(provider);
        const inp = usage.prompt_tokens || 0;
        const out = usage.completion_tokens || 0;
        const cached = usage.prompt_tokens_details?.cached_tokens || 0;
        const cost = calcCost(provider.name, model, inp, out, cached);
        insertRequest({
          request_id: requestId, model, stream: true, source: 'API', client_ip: clientIp,
          channel: provider.channel, api_key: maskKey(provider.apiKey), provider: provider.name,
          status: 'ok', input_tokens: inp, output_tokens: out, total_tokens: inp + out,
          cache_read: cached, cache_write: 0, cost, latency_ms: latency, ttft_ms: ttft,
        });
      });
    } else {
      let data = '';
      upstream.on('data', c => data += c);
      upstream.on('end', () => {
        const latency = Date.now() - startTime;
        if (upstream.statusCode === 429 || upstream.statusCode === 401 || upstream.statusCode >= 500) {
          markFailed(provider, `HTTP ${upstream.statusCode}`);
          const fb = FALLBACK_MAP[model] || 'MiniMax-M2.7';
          const { provider: np, model: nm } = pickProvider(fb);
          if (np === provider) { res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' }); res.end(data); return; }
          forwardRequest(np, nm, body, res, startTime, clientIp, requestId);
          return;
        }
        markOk(provider);
        let usage = {};
        try { usage = JSON.parse(data).usage || usage; } catch {}
        const inp = usage.prompt_tokens || 0;
        const out = usage.completion_tokens || 0;
        const cached = usage.prompt_tokens_details?.cached_tokens || 0;
        const cost = calcCost(provider.name, model, inp, out, cached);
        insertRequest({
          request_id: requestId, model, stream: false, source: 'API', client_ip: clientIp,
          channel: provider.channel, api_key: maskKey(provider.apiKey), provider: provider.name,
          status: 'ok', input_tokens: inp, output_tokens: out, total_tokens: inp + out,
          cache_read: cached, cache_write: 0, cost, latency_ms: latency, ttft_ms: 0,
        });
        res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    }
  });

  req.on('error', (e) => {
    markFailed(provider, e.message);
    const fb = FALLBACK_MAP[model] || 'MiniMax-M2.7';
    const { provider: np, model: nm } = pickProvider(fb);
    if (np === provider) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })); return; }
    forwardRequest(np, nm, body, res, startTime, clientIp, requestId);
  });

  req.write(payload);
  req.end();
}

// ─── 统计接口 ───────────────────────────────────────────────────────
function handleStats(res, url) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  
  // 获取日期范围参数
  const range = url.searchParams.get('range') || 'today';
  const startDate = url.searchParams.get('start');
  const endDate = url.searchParams.get('end');
  
  let dateFilter = '';
  let dateParams = [];
  
  if (range === 'today') {
    dateFilter = 'WHERE date(ts) = ?';
    dateParams = [today];
  } else if (range === '7days') {
    dateFilter = "WHERE ts >= datetime('now', '-7 days', 'localtime')";
  } else if (range === '30days') {
    dateFilter = "WHERE ts >= datetime('now', '-30 days', 'localtime')";
  } else if (range === 'custom' && startDate && endDate) {
    dateFilter = 'WHERE date(ts) >= ? AND date(ts) <= ?';
    dateParams = [startDate, endDate];
  }
  
  const summary = db.prepare(`SELECT COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cache_read) as cached, SUM(cost) as cost, SUM(latency_ms) as latency FROM requests ${dateFilter}`).all(...dateParams)[0];
  const todaySummary = db.prepare(`SELECT COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cache_read) as cached, SUM(cost) as cost FROM requests WHERE date(ts)=?`).all(today)[0];
  const byProvider = db.prepare(`SELECT provider, COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cost) as cost FROM requests ${dateFilter} GROUP BY provider`).all(...dateParams);
  const byModel = db.prepare(`SELECT model, provider, COUNT(*) as cnt, SUM(input_tokens) as inp, SUM(output_tokens) as out, SUM(total_tokens) as tok, SUM(cache_read) as cached FROM requests ${dateFilter} GROUP BY model, provider`).all(...dateParams);
  const recent = db.prepare(`SELECT * FROM requests ${dateFilter} ORDER BY id DESC LIMIT 100`).all(...dateParams);
  const providers = PROVIDERS.map(p => ({ name: p.name, status: p.status, lastError: p.lastError, models: p.models, channel: p.channel }));

  // 按时间统计（补全所有时间点，含模型明细）
  let dailyStats = [];
  if (range === 'today') {
    // 今天按小时，补全 24 小时
    const hourlyData = db.prepare(`
      SELECT strftime('%H', ts) as hour, provider, model, COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cache_read) as cached, SUM(cost) as cost
      FROM requests WHERE date(ts) = ?
      GROUP BY strftime('%H', ts), provider, model
    `).all(today);
    const hourMap = {};
    hourlyData.forEach(h => {
      if (!hourMap[h.hour]) hourMap[h.hour] = { cnt: 0, tok: 0, cached: 0, cost: 0, models: {} };
      hourMap[h.hour].cnt += h.cnt;
      hourMap[h.hour].tok += h.tok;
      hourMap[h.hour].cached += h.cached;
      hourMap[h.hour].cost += h.cost;
      const key = h.provider + '/' + h.model;
      hourMap[h.hour].models[key] = (hourMap[h.hour].models[key] || 0) + h.tok;
    });
    for (let i = 0; i < 24; i++) {
      const h = String(i).padStart(2, '0');
      const d = hourMap[h] || { cnt: 0, tok: 0, cached: 0, cost: 0, models: {} };
      dailyStats.push({ date: h, count: d.cnt, tokens: d.tok, cached: d.cached, cost: d.cost, models: d.models });
    }
  } else if (range === '7days') {
    const dailyData = db.prepare(`
      SELECT date(ts) as date, provider, model, COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cache_read) as cached, SUM(cost) as cost
      FROM requests WHERE ts >= datetime('now', '-6 days', 'localtime')
      GROUP BY date(ts), provider, model
    `).all();
    const dayMap = {};
    dailyData.forEach(d => {
      if (!dayMap[d.date]) dayMap[d.date] = { cnt: 0, tok: 0, cached: 0, cost: 0, models: {} };
      dayMap[d.date].cnt += d.cnt;
      dayMap[d.date].tok += d.tok;
      dayMap[d.date].cached += d.cached;
      dayMap[d.date].cost += d.cost;
      const key = d.provider + '/' + d.model;
      dayMap[d.date].models[key] = (dayMap[d.date].models[key] || 0) + d.tok;
    });
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const data = dayMap[dateStr] || { cnt: 0, tok: 0, cached: 0, cost: 0, models: {} };
      dailyStats.push({ date: dateStr, count: data.cnt, tokens: data.tok, cached: data.cached, cost: data.cost, models: data.models });
    }
  } else if (range === '30days') {
    const dailyData = db.prepare(`
      SELECT date(ts) as date, provider, model, COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cache_read) as cached, SUM(cost) as cost
      FROM requests WHERE ts >= datetime('now', '-29 days', 'localtime')
      GROUP BY date(ts), provider, model
    `).all();
    const dayMap = {};
    dailyData.forEach(d => {
      if (!dayMap[d.date]) dayMap[d.date] = { cnt: 0, tok: 0, cached: 0, cost: 0, models: {} };
      dayMap[d.date].cnt += d.cnt;
      dayMap[d.date].tok += d.tok;
      dayMap[d.date].cached += d.cached;
      dayMap[d.date].cost += d.cost;
      const key = d.provider + '/' + d.model;
      dayMap[d.date].models[key] = (dayMap[d.date].models[key] || 0) + d.tok;
    });
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const data = dayMap[dateStr] || { cnt: 0, tok: 0, cached: 0, cost: 0, models: {} };
      dailyStats.push({ date: dateStr, count: data.cnt, tokens: data.tok, cached: data.cached, cost: data.cost, models: data.models });
    }
  } else if (range === 'custom' && startDate && endDate) {
    const dailyData = db.prepare(`
      SELECT date(ts) as date, provider, model, COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cache_read) as cached, SUM(cost) as cost
      FROM requests WHERE date(ts) >= ? AND date(ts) <= ?
      GROUP BY date(ts), provider, model
    `).all(startDate, endDate);
    const dayMap = {};
    dailyData.forEach(d => {
      if (!dayMap[d.date]) dayMap[d.date] = { cnt: 0, tok: 0, cached: 0, cost: 0, models: {} };
      dayMap[d.date].cnt += d.cnt;
      dayMap[d.date].tok += d.tok;
      dayMap[d.date].cached += d.cached;
      dayMap[d.date].cost += d.cost;
      const key = d.provider + '/' + d.model;
      dayMap[d.date].models[key] = (dayMap[d.date].models[key] || 0) + d.tok;
    });
    const start = new Date(startDate);
    const end = new Date(endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const data = dayMap[dateStr] || { cnt: 0, tok: 0, cached: 0, cost: 0, models: {} };
      dailyStats.push({ date: dateStr, count: data.cnt, tokens: data.tok, cached: data.cached, cost: data.cost, models: data.models });
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ providers, summary, todaySummary, byProvider, byModel, recent, dailyStats, range, todayDate: today }));
}

// ─── 监控面板 ───────────────────────────────────────────────────────
function handleDashboard(res) {
  const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ─── 服务器 ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/' || url.pathname === '/dashboard') return handleDashboard(res);
  if (url.pathname === '/api/stats') return handleStats(res, url);
  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    const all = PROVIDERS.flatMap(p => p.models.map(m => ({ id: m, object: 'model', owned_by: p.name })));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: all }));
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const model = parsed.model || 'mimo-v2.5-pro';
        const { provider, model: resolvedModel } = pickProvider(model);
        const clientIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 
          (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' ? SERVER_IP : req.socket.remoteAddress) || 'unknown';
        const requestId = 'req-' + crypto.randomUUID().slice(0, 12);
        forwardRequest(provider, resolvedModel, parsed, res, Date.now(), clientIp, requestId);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`代理服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`优先级: ${PROVIDERS.map(p => p.name).join(' -> ')}`);
});
