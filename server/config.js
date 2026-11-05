/**
 * 应用配置
 */
const path = require('path');

module.exports = {
  DB_PATH: path.join(__dirname, '..', 'inventory.db'),
  HOST: process.env.HOST || '0.0.0.0',
  PORT: Number(process.env.PORT) || 4000,
  JWT_SECRET: 'inventory-system-secret-key-2026',
  JWT_EXPIRES: '7d',
};
