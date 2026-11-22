/**
 * 库存进出库管理系统 - 后端入口
 *
 * 按功能拆分为 server/ 下的模块：
 *   config.js          配置
 *   db.js              数据库连接与迁移
 *   permissions.js     角色权限矩阵
 *   middleware/auth.js 鉴权中间件
 *   services/stock.js  库存计算与业务辅助函数
 *   routes/*           各业务 API 路由
 */
const express = require('express');
const path = require('path');
const os = require('os');
let config;
try {
  config = require('./server/config');
} catch (e) {
  console.error(e.message); // 配置缺失/非法：只输出可读提示，不打印无关堆栈
  process.exit(1);
}
const { HOST, PORT } = config;
const { requireAuth } = require('./server/middleware/auth');
const { auditMiddleware } = require('./server/middleware/audit');
const audit = require('./server/services/audit');
const { clientIp } = require('./server/utils/client-ip');

// 加载数据库（执行迁移）
require('./server/db');
// 期初结存纳入流水，保证库存余额可由流水完整推导
require('./server/services/costing').ensureOpeningBalances();
// 自动覆盖式备份：按「参数设置」里保存的频率定时执行（设置存库，重启后仍生效）
require('./server/services/auto-backup').start();

const app = express();
app.use(express.json({ limit: '10mb' }));

// 请求体解析失败兜底 —— 必须紧跟 express.json() 注册
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求数据格式有误（JSON 解析失败）' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求数据过大' });
  }
  return next(err);
});

// 系统审计埋点：记录所有 /api 写操作（登录/新增/修改/删除/确认/作废/冲销）
app.use(auditMiddleware);

// 静态文件禁用缓存，确保浏览器每次加载最新 JS/CSS
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.js') || filepath.endsWith('.css') || filepath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

// 物料参考图片：文件名由服务端按物料 id 生成，只读静态访问
// 图片需要直接给 <img> 使用（无法附带 Authorization 头），因此不挂在 /api 鉴权下。
// 单独一条显式路由：Windows 上文件刚写入时可能被杀软短暂占用，express.static
// 遇到读取错误会 fall through 到 SPA 兜底并返回 HTML（<img> 变成破图），这里短暂重试。
const MATERIAL_IMG_DIR = path.join(__dirname, 'uploads', 'materials');
app.get('/uploads/materials/:name', (req, res, next) => {
  const name = String(req.params.name || '');
  if (!/^\d+\.(jpg|png|webp)$/.test(name)) return res.status(404).end();
  const abs = path.join(MATERIAL_IMG_DIR, name);
  let tries = 0;
  const send = () => {
    res.sendFile(abs, { maxAge: 0, headers: { 'Cache-Control': 'no-cache' } }, err => {
      if (!err) return;
      if (res.headersSent) return next(err);
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return res.status(404).end();
      if (tries++ < 4) return setTimeout(send, 40);
      next(err);
    });
  };
  send();
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// 健康检查：前端用它判断「服务器是否还在」，因此不要求登录
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, time: Date.now() });
});

// ==================== 路由挂载 ====================
// 以下 /api 接口需要登录（login 单独放行）
app.use('/api', (req, res, next) => {
  // login 与前端异常采样上报免鉴权（上报只收类型+消息，服务端限流，不碰业务数据）
  if (req.path === '/auth/login' || req.path === '/client-errors') return next();
  return requireAuth(req, res, next);
});

// 认证路由（login 免鉴权；me / change-password 由上方统一鉴权注入 req.user）
app.use(require('./server/routes/auth'));

app.use(require('./server/routes/users'));
app.use(require('./server/routes/dashboard'));
app.use(require('./server/routes/materials'));
app.use(require('./server/routes/suppliers'));
app.use(require('./server/routes/inbound'));
app.use(require('./server/routes/outbound'));
app.use(require('./server/routes/returns'));
app.use(require('./server/routes/stock'));
app.use(require('./server/routes/query'));
app.use(require('./server/routes/stocktake'));
app.use(require('./server/routes/purchase'));
app.use(require('./server/routes/params'));
app.use(require('./server/routes/settings-ops'));
app.use(require('./server/routes/audit'));

// 前端 SPA 兜底
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== 运行期异常入库 ====================
// 全局错误中间件（必须放在所有路由之后）：5xx 写一条 error 级审计，前端日志页可追溯。
function recordServerError(err, req, level) {
  try {
    const u = req && req.user ? req.user : {};
    const msg = String((err && err.message) || err || 'unknown error').slice(0, 400);
    audit.record({
      user_id: u.id || null, username: u.username || '', name: u.name || '', role: u.role || '',
      module: 'system', action: level === 'fatal' ? 'fatal-error' : 'server-error',
      target: req && req.path ? String(req.path).slice(0, 120) : '',
      method: req ? req.method || '' : '', path: req ? String(req.originalUrl || req.path || '').split('?')[0].slice(0, 160) : '',
      ip: req ? clientIp(req) : '', status: level === 'fatal' ? 500 : ((err && err.status) || 500),
      level, source: 'system',
      detail: { key: level === 'fatal' ? 'audit_detail_fatal_error' : 'audit_detail_server_error', params: { msg } },
    });
  } catch (e) { console.error('[audit] 异常入库失败:', e.message); }
}
app.use((err, req, res, next) => {
  recordServerError(err, req, 'error');
  console.error('[server] unhandled error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status((err && err.status) || 500).json({ error: '服务器内部错误，请稍后重试' });
});

// ==================== 局域网地址探测 ====================
function getLanIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (/^169\.254\./.test(net.address)) continue;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(net.address)) continue;
      ips.push({ name, address: net.address });
    }
  }
  return ips;
}

// 进程级兜底：只在 stderr 之外多写一条审计，随后按 Node 推荐做法退出，交给 systemd 重启。
process.on('uncaughtException', err => {
  console.error('[fatal] uncaughtException:', err && err.stack ? err.stack : err);
  recordServerError(err, null, 'fatal');
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  console.error('[fatal] unhandledRejection:', reason);
  recordServerError(reason instanceof Error ? reason : new Error(String(reason)), null, 'fatal');
  process.exit(1);
});

app.listen(PORT, HOST, () => {
  const lan = getLanIPs();
  console.log(`\n========================================`);
  console.log(`  库存进出库管理系统已启动`);
  console.log(`  本机访问: http://localhost:${PORT}`);
  if (lan.length) {
    console.log(`  局域网访问（同局域网电脑可用）:`);
    for (const it of lan) {
      console.log(`    - http://${it.address}:${PORT}    [${it.name}]`);
    }
  } else {
    console.log(`  局域网访问: 未检测到局域网 IP（请确认已连接 Wi-Fi / 网线）`);
  }
  console.log(`========================================\n`);
});
