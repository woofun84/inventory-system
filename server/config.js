/**
 * 应用配置
 *
 * 敏感配置一律从环境变量读取，本地开发放在项目根目录的 .env
 * （已被 .gitignore 忽略，模板见 .env.example）。
 * 进程环境中已存在的同名变量优先于 .env 文件中的值。
 */
const path = require('path');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // .env 不存在时忽略，其余错误（格式错误等）直接暴露
  }
}

const JWT_SECRET = String(process.env.JWT_SECRET || '').trim();

if (JWT_SECRET.length < 32) {
  throw new Error(
    '配置错误：JWT_SECRET 未配置或长度不足 32 个字符。\n' +
    '  1) 复制 .env.example 为项目根目录的 .env\n' +
    '  2) 生成随机密钥：node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
    '  3) 把生成结果写入 .env 的 JWT_SECRET=...\n' +
    '  注意：.env 已被 .gitignore 忽略，切勿把真实密钥提交到仓库。'
  );
}

module.exports = {
  DB_PATH: path.join(__dirname, '..', 'inventory.db'),
  HOST: process.env.HOST || '0.0.0.0',
  PORT: Number(process.env.PORT) || 4000,
  JWT_SECRET,
  JWT_EXPIRES: '7d',
  INITIAL_ADMIN_USERNAME: String(process.env.INITIAL_ADMIN_USERNAME || '').trim() || 'admin',
};
