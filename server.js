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

// 加载数据库（执行迁移）
require('./server/db');

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

// ==================== 路由挂载 ====================
// 以下 /api 接口需要登录（login 单独放行）
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login') return next();
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
app.use(require('./server/routes/adjustments'));
app.use(require('./server/routes/stocktake'));
app.use(require('./server/routes/purchase'));
app.use(require('./server/routes/params'));
app.use(require('./server/routes/audit'));

// 前端 SPA 兜底
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
