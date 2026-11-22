/**
 * 统一客户端 IP 取值（审计/会话共用）
 *
 * 安全约定：只有请求来自本机回环地址（127.0.0.1 / ::1，即 Nginx 反代）时，
 * 才采信 CF-Connecting-IP / X-Forwarded-For；来自局域网的直连请求一律用 socket 地址，
 * 杜绝客户端自带 XFF 头伪造 IP。Cloudflare 隧道场景下 CF-Connecting-IP 优先级最高。
 */
function normalize(ip) {
  let s = String(ip || '').trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}

function firstOf(value) {
  return normalize(String(value || '').split(',')[0].trim());
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function clientIp(req) {
  const remote = normalize(req && req.socket && req.socket.remoteAddress);
  if (isLoopback(remote)) {
    const cf = firstOf(req.headers && req.headers['cf-connecting-ip']);
    if (cf) return cf;
    const xff = firstOf(req.headers && req.headers['x-forwarded-for']);
    if (xff) return xff;
  }
  return remote;
}

module.exports = { clientIp, normalize };
