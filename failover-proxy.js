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

db.exec(`
  CREATE TABLE IF NOT EXISTS budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    daily_limit REAL DEFAULT 10.0,
    monthly_limit REAL DEFAULT 200.0,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);
db.exec(`INSERT OR IGNORE INTO budget (id, daily_limit, monthly_limit) VALUES (1, 10.0, 200.0)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now','localtime')),
    level TEXT NOT NULL,
    type TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    current_value REAL,
    threshold REAL,
    message TEXT,
    acknowledged INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS alert_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    warn_threshold REAL DEFAULT 80,
    critical_threshold REAL DEFAULT 90,
    max_threshold REAL DEFAULT 100,
    sound_enabled INTEGER DEFAULT 1,
    check_interval_sec INTEGER DEFAULT 30,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);
db.exec(`INSERT OR IGNORE INTO alert_config (id) VALUES (1)`);

// ─── 告警系统 ───────────────────────────────────────────────────────
const ALERT_LEVELS = { warn: 'warn', critical: 'critical', max: 'max' };
const ALERT_COOLDOWN_MS = 300_000;
let lastAlertFired = {};

function getAlertConfig() {
  return db.prepare(`SELECT * FROM alert_config WHERE id = 1`).get();
}

function updateAlertConfig(cfg) {
  db.prepare(`UPDATE alert_config SET warn_threshold=?, critical_threshold=?, max_threshold=?, sound_enabled=?, check_interval_sec=?, updated_at=datetime('now','localtime') WHERE id=1`)
    .run(cfg.warn_threshold, cfg.critical_threshold, cfg.max_threshold, cfg.sound_enabled ? 1 : 0, cfg.check_interval_sec);
}

function insertAlert(alert) {
  db.prepare(`INSERT INTO alerts (level, type, provider, model, current_value, threshold, message) VALUES (?,?,?,?,?,?,?)`)
    .run(alert.level, alert.type, alert.provider, alert.model, alert.current_value, alert.threshold, alert.message);
}

function checkAlerts() {
  const config = getAlertConfig();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

  const budget = db.prepare(`SELECT * FROM budget WHERE id = 1`).get();
  const dailySpent = db.prepare(`SELECT COALESCE(SUM(cost),0) as cost FROM requests WHERE date(ts) = ?`).get(today).cost;
  const monthlySpent = db.prepare(`SELECT COALESCE(SUM(cost),0) as cost FROM requests WHERE date(ts) >= ?`).get(monthStart).cost;

  const checks = [
    { type: 'daily_budget', current: dailySpent, limit: budget.daily_limit, provider: null, model: null },
    { type: 'monthly_budget', current: monthlySpent, limit: budget.monthly_limit, provider: null, model: null },
  ];

  for (const p of PROVIDERS) {
    for (const m of p.models) {
      const usage = db.prepare(`SELECT COALESCE(SUM(total_tokens),0) as tok FROM requests WHERE provider=? AND model=? AND date(ts)=?`).get(p.name, m, today).tok;
      checks.push({ type: 'token_usage', current: usage, limit: 1000000, provider: p.name, model: m });
    }
  }

  for (const c of checks) {
    if (c.limit <= 0) continue;
    const pct = (c.current / c.limit) * 100;
    const thresholds = [
      { level: ALERT_LEVELS.max, threshold: config.max_threshold, pctThreshold: config.max_threshold },
      { level: ALERT_LEVELS.critical, threshold: config.critical_threshold, pctThreshold: config.critical_threshold },
      { level: ALERT_LEVELS.warn, threshold: config.warn_threshold, pctThreshold: config.warn_threshold },
    ];

    for (const t of thresholds) {
      if (pct >= t.pctThreshold) {
        const key = `${c.type}_${c.provider || 'all'}_${c.model || 'all'}_${t.level}`;
        if (lastAlertFired[key] && Date.now() - lastAlertFired[key] < ALERT_COOLDOWN_MS) break;
        lastAlertFired[key] = Date.now();

        const levelLabel = t.level === ALERT_LEVELS.max ? '🔴 严重' : t.level === ALERT_LEVELS.critical ? '🟠 警告' : '🟡 注意';
        const typeLabel = c.type === 'daily_budget' ? '每日预算' : c.type === 'monthly_budget' ? '每月预算' : 'Token 用量';
        const detail = c.provider ? `${c.provider}/${c.model}` : typeLabel;
        let msg;
        if (c.type === 'token_usage') {
          msg = `${levelLabel}: ${detail} 今日 Token 用量 ${pct.toFixed(1)}% (${c.current.toLocaleString()}/${c.limit.toLocaleString()})`;
        } else {
          msg = `${levelLabel}: ${detail} 已使用 ${pct.toFixed(1)}% ($${c.current.toFixed(4)}/$${c.limit.toFixed(2)})`;
        }

        insertAlert({ level: t.level, type: c.type, provider: c.provider, model: c.model, current_value: c.current, threshold: t.threshold, message: msg });
        break;
      }
    }
  }
}

setInterval(checkAlerts, 30000);

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
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    status: 'ok', failUntil: 0, lastError: null,
  },
  {
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    apiKey: 'sk-cp-0J0H-xxJh0ne85xgU0K6JKpjysHEWHUKhb0OKnvMK4Eyx0n47V7sQ7RWjM4JYRpCgvTeJh7w0WpCaPspjQUtMvkp8EMNMLCsag5SDKeizatlBquzeK3c1hg',
    channel: 'MiniMax',
    models: ['MiniMax-M2.7'],
    status: 'ok', failUntil: 0, lastError: null,
  },
  {
    name: 'Alibaba',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.ALIBABA_API_KEY || 'sk-alibaba-key',
    channel: '阿里云百炼',
    models: ['qwen-turbo', 'qwen3.6-plus'],
    status: 'ok', failUntil: 0, lastError: null,
  },
];

// 启动告警检查
checkAlerts();
setInterval(checkAlerts, 30000);

const FALLBACK_MAP = {
  'mimo-v2.5-pro': 'MiniMax-M2.7',
  'mimo-v2.5': 'MiniMax-M2.7',
  'qwen-turbo': 'qwen3.6-plus',
  'qwen3.6-plus': 'qwen-turbo',
};
const COOLDOWN_MS = 60_000;

function pickProvider(model) {
  for (const p of PROVIDERS) {
    if (p.models.includes(model)) {
      if (p.status === 'cooling' && Date.now() < p.failUntil) continue;
      p.status = 'ok';
      return { provider: p, model };
    }
  }
  // 前缀匹配: qwen* -> Alibaba, mimo* -> MiMo, MiniMax* -> MiniMax
  const prefixMap = { MiMo: ['mimo'], MiniMax: ['minimax'], Alibaba: ['qwen'] };
  for (const p of PROVIDERS) {
    const prefixes = prefixMap[p.name] || [];
    if (prefixes.some(pf => model.toLowerCase().startsWith(pf.toLowerCase()))) {
      if (p.status === 'cooling' && Date.now() < p.failUntil) continue;
      p.status = 'ok';
      return { provider: p, model };
    }
  }
  // 默认使用第一个可用的 provider
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
  },
  'MiniMax': {
    'MiniMax-M2.7': { input: 2.0, output: 8.0, cached: 0 },
  },
  'Alibaba': {
    'qwen-turbo': { input: 0.5, output: 2.0, cached: 0 },
    'qwen3.6-plus': { input: 2.0, output: 8.0, cached: 0 },
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
            // 兼容多种 token 字段名
            const inp = usage.prompt_tokens || usage.input_tokens || usage.promptTokens || 0;
            const out = usage.completion_tokens || usage.output_tokens || usage.completionTokens || 0;
            const total = usage.total_tokens || usage.totalTokens || (inp + out);
            let cached = 0;
            if (usage.prompt_tokens_details) {
              cached = usage.prompt_tokens_details.cached_tokens || 0;
            } else if (usage.usage) {
              cached = usage.usage.prompt_tokens_details?.cached_tokens || 0;
            }
            const cost = calcCost(provider.name, model, inp, out, cached);
            insertRequest({
              request_id: requestId, model, stream: true, source: 'API', client_ip: clientIp,
              channel: provider.channel, api_key: maskKey(provider.apiKey), provider: provider.name,
              status: 'ok', input_tokens: inp, output_tokens: out, total_tokens: total,
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
          const latency = Date.now() - startTime;
          insertRequest({
            request_id: requestId, model, stream: false, source: 'API', client_ip: clientIp,
            channel: provider.channel, api_key: maskKey(provider.apiKey), provider: provider.name,
            status: 'failed', input_tokens: 0, output_tokens: 0, total_tokens: 0,
            cache_read: 0, cache_write: 0, cost: 0, latency_ms: latency, ttft_ms: 0,
          });
          const fb = FALLBACK_MAP[model] || 'MiniMax-M2.7';
          const { provider: np, model: nm } = pickProvider(fb);
          if (np === provider) { res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' }); res.end(data); return; }
          forwardRequest(np, nm, body, res, startTime, clientIp, requestId);
          return;
        }
        markOk(provider);
        let usage = {};
        try { usage = JSON.parse(data).usage || usage; } catch {}
        const inp = usage.prompt_tokens || usage.input_tokens || 0;
        const out = usage.completion_tokens || usage.output_tokens || 0;
        const total = usage.total_tokens || (inp + out);
        let cached = 0;
        if (usage.prompt_tokens_details) cached = usage.prompt_tokens_details.cached_tokens || 0;
        const cost = calcCost(provider.name, model, inp, out, cached);
        insertRequest({
          request_id: requestId, model, stream: false, source: 'API', client_ip: clientIp,
          channel: provider.channel, api_key: maskKey(provider.apiKey), provider: provider.name,
          status: 'ok', input_tokens: inp, output_tokens: out, total_tokens: total,
          cache_read: cached, cache_write: 0, cost, latency_ms: latency, ttft_ms: 0,
        });
        res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    }
  });

  req.on('error', (e) => {
    markFailed(provider, e.message);
    const latency = Date.now() - startTime;
    insertRequest({
      request_id: requestId, model, stream: false, source: 'API', client_ip: clientIp,
      channel: provider.channel, api_key: maskKey(provider.apiKey), provider: provider.name,
      status: 'error', input_tokens: 0, output_tokens: 0, total_tokens: 0,
      cache_read: 0, cache_write: 0, cost: 0, latency_ms: latency, ttft_ms: 0,
    });
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
  
  // 分页参数
  const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit')) || 50));
  const offset = (page - 1) * limit;
  
  // 筛选参数
  const filterProvider = url.searchParams.get('provider');
  const filterModel = url.searchParams.get('model');
  const filterStatus = url.searchParams.get('status');
  const filterSearch = url.searchParams.get('search');
  
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
  
  // 构建筛选条件
  const conditions = [];
  const filterParams = [];
  
  if (filterProvider) {
    conditions.push('provider = ?');
    filterParams.push(filterProvider);
  }
  if (filterModel) {
    conditions.push('model = ?');
    filterParams.push(filterModel);
  }
  if (filterStatus) {
    conditions.push('status = ?');
    filterParams.push(filterStatus);
  }
  if (filterSearch) {
    conditions.push('(request_id LIKE ? OR model LIKE ? OR provider LIKE ? OR client_ip LIKE ?)');
    const searchPattern = `%${filterSearch}%`;
    filterParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }
  
  // 合并筛选条件
  const allConditions = [];
  if (dateFilter) allConditions.push(dateFilter.replace('WHERE ', ''));
  allConditions.push("provider != 'Claude'");
  conditions.forEach(c => allConditions.push(c));
  
  const whereClause = allConditions.length > 0 ? 'WHERE ' + allConditions.join(' AND ') : '';
  const allParams = [...dateParams, ...filterParams];
  const summary = db.prepare(`SELECT COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cache_read) as cached, SUM(cost) as cost, SUM(latency_ms) as latency FROM requests ${whereClause}`).all(...allParams)[0];
  const todaySummary = db.prepare(`SELECT COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cache_read) as cached, SUM(cost) as cost FROM requests WHERE date(ts)=? AND provider != 'Claude'`).all(today)[0];
  const byProvider = db.prepare(`SELECT provider, COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cost) as cost FROM requests ${whereClause} GROUP BY provider`).all(...allParams);
  const byModel = db.prepare(`SELECT model, provider, COUNT(*) as cnt, SUM(input_tokens) as inp, SUM(output_tokens) as out, SUM(total_tokens) as tok, SUM(cache_read) as cached FROM requests ${whereClause} GROUP BY model, provider`).all(...allParams);
  
  // 请求日志分页
  const totalRequests = db.prepare(`SELECT COUNT(*) as total FROM requests ${whereClause}`).all(...allParams)[0].total;
  const recent = db.prepare(`SELECT * FROM requests ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...allParams, limit, offset);
  const totalPages = Math.ceil(totalRequests / limit);
  
  const providers = PROVIDERS.map(p => ({ name: p.name, status: p.status, lastError: p.lastError, models: p.models, channel: p.channel }));

  // 按时间统计（补全所有时间点，含模型明细）
  let dailyStats = [];
  if (range === 'today') {
    // 今天按小时，补全 24 小时
    const hourlyData = db.prepare(`
      SELECT strftime('%H', ts) as hour, provider, model, COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cache_read) as cached, SUM(cost) as cost
      FROM requests WHERE date(ts) = ? AND provider != 'Claude'
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
      FROM requests WHERE ts >= datetime('now', '-6 days', 'localtime') AND provider != 'Claude'
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
      FROM requests WHERE ts >= datetime('now', '-29 days', 'localtime') AND provider != 'Claude'
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
      FROM requests WHERE date(ts) >= ? AND date(ts) <= ? AND provider != 'Claude'
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
  res.end(JSON.stringify({ providers, summary, todaySummary, byProvider, byModel, recent, dailyStats, range, todayDate: today, pagination: { page, limit, totalRequests, totalPages } }));
}

// ─── Provider 对比接口 ─────────────────────────────────────────────
function handleCompare(res, url) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const range = url.searchParams.get('range') || 'today';

  let dateFilter = '';
  let dateParams = [];
  if (range === 'today') {
    dateFilter = 'WHERE date(ts) = ?';
    dateParams = [today];
  } else if (range === '7days') {
    dateFilter = "WHERE ts >= datetime('now', '-7 days', 'localtime')";
  } else if (range === '30days') {
    dateFilter = "WHERE ts >= datetime('now', '-30 days', 'localtime')";
  }

  // 各服务商汇总
  const providerSummary = db.prepare(`
    SELECT provider,
      COUNT(*) as cnt,
      SUM(input_tokens) as inp,
      SUM(output_tokens) as out,
      SUM(total_tokens) as tok,
      SUM(cache_read) as cached,
      SUM(cost) as cost,
      AVG(latency_ms) as avg_latency
    FROM requests ${dateFilter} AND provider != 'Claude'
    GROUP BY provider
  `).all(...dateParams);

  // 各模型汇总（含服务商）
  const modelSummary = db.prepare(`
    SELECT model, provider,
      COUNT(*) as cnt,
      SUM(total_tokens) as tok,
      SUM(cost) as cost
    FROM requests ${dateFilter} AND provider != 'Claude'
    GROUP BY model, provider
  `).all(...dateParams);

  // 按天/小时的趋势数据（每个服务商独立趋势）
  let trends = [];
  if (range === 'today') {
    const hourlyData = db.prepare(`
      SELECT strftime('%H', ts) as period, provider,
        COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cost) as cost
      FROM requests WHERE date(ts) = ? AND provider != 'Claude'
      GROUP BY strftime('%H', ts), provider
    `).all(today);
    const periodMap = {};
    hourlyData.forEach(h => {
      if (!periodMap[h.period]) periodMap[h.period] = {};
      periodMap[h.period][h.provider] = { cnt: h.cnt, tok: h.tok, cost: h.cost };
    });
    for (let i = 0; i < 24; i++) {
      const h = String(i).padStart(2, '0');
      trends.push({ period: h + ':00', data: periodMap[h] || {} });
    }
  } else if (range === '7days') {
    const dailyData = db.prepare(`
      SELECT date(ts) as period, provider,
        COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cost) as cost
      FROM requests WHERE ts >= datetime('now', '-6 days', 'localtime') AND provider != 'Claude'
      GROUP BY date(ts), provider
    `).all();
    const periodMap = {};
    dailyData.forEach(d => {
      if (!periodMap[d.period]) periodMap[d.period] = {};
      periodMap[d.period][d.provider] = { cnt: d.cnt, tok: d.tok, cost: d.cost };
    });
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      trends.push({ period: dateStr.slice(5), data: periodMap[dateStr] || {} });
    }
  } else if (range === '30days') {
    const dailyData = db.prepare(`
      SELECT date(ts) as period, provider,
        COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cost) as cost
      FROM requests WHERE ts >= datetime('now', '-29 days', 'localtime') AND provider != 'Claude'
      GROUP BY date(ts), provider
    `).all();
    const periodMap = {};
    dailyData.forEach(d => {
      if (!periodMap[d.period]) periodMap[d.period] = {};
      periodMap[d.period][d.provider] = { cnt: d.cnt, tok: d.tok, cost: d.cost };
    });
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      trends.push({ period: dateStr.slice(5), data: periodMap[dateStr] || {} });
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ providerSummary, modelSummary, trends, range }));
}

// ─── 预算接口 ───────────────────────────────────────────────────────
function handleBudget(res, req) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

  const budget = db.prepare(`SELECT * FROM budget WHERE id = 1`).get();
  const dailySpent = db.prepare(`SELECT COALESCE(SUM(cost),0) as cost FROM requests WHERE date(ts) = ?`).get(today).cost;
  const monthlySpent = db.prepare(`SELECT COALESCE(SUM(cost),0) as cost FROM requests WHERE date(ts) >= ?`).get(monthStart).cost;

  const result = {
    daily: { limit: budget.daily_limit, spent: dailySpent, remaining: Math.max(0, budget.daily_limit - dailySpent), percent: budget.daily_limit > 0 ? (dailySpent / budget.daily_limit * 100) : 0 },
    monthly: { limit: budget.monthly_limit, spent: monthlySpent, remaining: Math.max(0, budget.monthly_limit - monthlySpent), percent: budget.monthly_limit > 0 ? (monthlySpent / budget.monthly_limit * 100) : 0 },
    updated_at: budget.updated_at,
  };

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(result));
}

function handleBudgetUpdate(res, body) {
  try {
    const data = JSON.parse(body);
    const daily = parseFloat(data.daily_limit);
    const monthly = parseFloat(data.monthly_limit);
    if (isNaN(daily) || isNaN(monthly) || daily < 0 || monthly < 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid budget values' }));
      return;
    }
    db.prepare(`UPDATE budget SET daily_limit = ?, monthly_limit = ?, updated_at = datetime('now','localtime') WHERE id = 1`).run(daily, monthly);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── 告警接口 ───────────────────────────────────────────────────────
function handleAlerts(res, url) {
  const action = url.searchParams.get('action') || 'list';
  if (action === 'config') {
    const config = getAlertConfig();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(config));
    return;
  }
  if (action === 'update') {
    try {
      const cfg = {
        warn_threshold: parseFloat(url.searchParams.get('warn')) || 80,
        critical_threshold: parseFloat(url.searchParams.get('critical')) || 90,
        max_threshold: parseFloat(url.searchParams.get('max')) || 100,
        sound_enabled: url.searchParams.get('sound') === '1' ? 1 : 0,
        check_interval_sec: parseInt(url.searchParams.get('interval')) || 30,
      };
      updateAlertConfig(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (action === 'ack') {
    const id = url.searchParams.get('id');
    if (id) db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ?`).run(parseInt(id));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (action === 'ack_all') {
    db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0`).run();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const limit = parseInt(url.searchParams.get('limit')) || 50;
  const unackOnly = url.searchParams.get('unack') === '1';
  const query = unackOnly
    ? `SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM alerts ORDER BY id DESC LIMIT ?`;
  const alerts = db.prepare(query).all(limit);
  const unackCount = db.prepare(`SELECT COUNT(*) as cnt FROM alerts WHERE acknowledged = 0`).get().cnt;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ alerts, unack_count: unackCount }));
}

// ─── CSV 导出 ─────────────────────────────────────────────────────
function handleExportCsv(res, url) {
  const range = url.searchParams.get('range') || '30days';
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  let dateFilter = '';
  let dateParams = [];
  if (range === 'today') { dateFilter = 'WHERE date(ts) = ?'; dateParams = [today]; }
  else if (range === '7days') { dateFilter = "WHERE ts >= datetime('now', '-7 days', 'localtime')"; }
  else if (range === '30days') { dateFilter = "WHERE ts >= datetime('now', '-30 days', 'localtime')"; }
  const whereClause = dateFilter ? `${dateFilter} AND provider != 'Claude'` : `WHERE provider != 'Claude'`;
  const rows = db.prepare(`SELECT * FROM requests ${whereClause} ORDER BY id DESC`).all(...dateParams);
  const header = 'ID,RequestID,Model,Stream,Source,ClientIP,Channel,Provider,Status,InputTokens,OutputTokens,TotalTokens,CacheRead,CacheWrite,Cost,LatencyMs,TtftMs,Time\n';
  const csv = header + rows.map(r =>
    `${r.id},"${r.request_id}","${r.model}",${r.stream},"${r.source}","${r.client_ip}","${r.channel}","${r.provider}","${r.status}",${r.input_tokens},${r.output_tokens},${r.total_tokens},${r.cache_read},${r.cache_write},${r.cost},${r.latency_ms},${r.ttft_ms},"${r.ts}"`
  ).join('\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename=ai-usage-${today}.csv`, 'Access-Control-Allow-Origin': '*' });
  res.end('\uFEFF' + csv);
}

// ─── 模型性能对比 ──────────────────────────────────────────────────
function handleModelPerf(res, url) {
  const range = url.searchParams.get('range') || '7days';
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  let dateFilter = '';
  let dateParams = [];
  if (range === 'today') { dateFilter = 'WHERE date(ts) = ?'; dateParams = [today]; }
  else if (range === '7days') { dateFilter = "WHERE ts >= datetime('now', '-7 days', 'localtime')"; }
  else if (range === '30days') { dateFilter = "WHERE ts >= datetime('now', '-30 days', 'localtime')"; }
  const whereClause = dateFilter ? `${dateFilter} AND provider != 'Claude'` : `WHERE provider != 'Claude'`;
  
  const models = db.prepare(`
    SELECT model, provider,
      COUNT(*) as total_reqs,
      SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok_reqs,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed_reqs,
      SUM(total_tokens) as total_tokens,
      SUM(cost) as total_cost,
      AVG(CASE WHEN status='ok' THEN latency_ms ELSE NULL END) as avg_latency,
      MIN(CASE WHEN status='ok' THEN latency_ms ELSE NULL END) as min_latency,
      MAX(CASE WHEN status='ok' THEN latency_ms ELSE NULL END) as max_latency,
      SUM(cache_read) as cache_read
    FROM requests ${whereClause}
    GROUP BY model, provider
    ORDER BY total_reqs DESC
  `).all(...dateParams);
  
  const enriched = models.map(m => ({
    ...m,
    success_rate: m.total_reqs > 0 ? (m.ok_reqs / m.total_reqs * 100) : 0,
    cost_per_1k_tokens: m.total_tokens > 0 ? (m.total_cost / m.total_tokens * 1000) : 0,
    cache_hit_rate: m.total_tokens > 0 ? (m.cache_read / m.total_tokens * 100) : 0,
  }));
  
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ models: enriched, range }));
}

// ─── 请求详情 ─────────────────────────────────────────────────────
function handleRequestDetail(res, id) {
  const row = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(parseInt(id));
  if (!row) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(row));
}

// ─── 用量热力图 ────────────────────────────────────────────────────
function handleHeatmap(res, url) {
  const months = parseInt(url.searchParams.get('months')) || 3;
  const data = db.prepare(`
    SELECT date(ts) as date, COUNT(*) as cnt, SUM(total_tokens) as tok, SUM(cost) as cost
    FROM requests WHERE ts >= datetime('now', ? || ' months', 'localtime') AND provider != 'Claude'
    GROUP BY date(ts) ORDER BY date(ts)
  `).all(String(-months));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ months, data }));
}

// ─── 数据清理 ─────────────────────────────────────────────────────
function handleCleanup(res, body) {
  try {
    const { days } = JSON.parse(body);
    if (!days || days < 1) throw new Error('Invalid days');
    const result = db.prepare(`DELETE FROM requests WHERE ts < datetime('now', '-' + ? + ' days', 'localtime')`).run(days);
    const alerts = db.prepare(`DELETE FROM alerts WHERE ts < datetime('now', '-' + ? + ' days', 'localtime')`).run(days);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, deleted_requests: result.changes, deleted_alerts: alerts.changes }));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── 数据统计 ─────────────────────────────────────────────────────
function handleDataStats(res) {
  const stats = db.prepare(`SELECT COUNT(*) as total, MIN(ts) as oldest, MAX(ts) as newest FROM requests`).get();
  const byProvider = db.prepare(`SELECT provider, COUNT(*) as cnt FROM requests GROUP BY provider`).all();
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ ...stats, byProvider }));
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
  if (url.pathname === '/api/export') return handleExportCsv(res, url);
  if (url.pathname === '/api/model-perf') return handleModelPerf(res, url);
  if (url.pathname === '/api/heatmap') return handleHeatmap(res, url);
  if (url.pathname === '/api/data-stats') return handleDataStats(res);
  if (url.pathname.startsWith('/api/request/')) {
    const id = url.pathname.split('/').pop();
    return handleRequestDetail(res, id);
  }
  if (url.pathname === '/api/cleanup' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => handleCleanup(res, body));
    return;
  }
  if (url.pathname === '/api/budget' && req.method === 'GET') return handleBudget(res, req);
  if (url.pathname === '/api/budget' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => handleBudgetUpdate(res, body));
    return;
  }
  if (url.pathname === '/api/budget' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }
  if (url.pathname === '/api/compare') return handleCompare(res, url);
  if (url.pathname === '/api/alerts') return handleAlerts(res, url);
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
