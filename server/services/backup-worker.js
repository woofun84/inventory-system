/**
 * 自动备份工作线程
 *
 * 打包过程（VACUUM INTO + 读图片 + 计算 SHA256 + 写 ZIP）全部是同步 CPU/IO 操作，
 * 放在独立线程执行，避免大库备份期间阻塞 HTTP 请求处理线程。
 * 结果通过 postMessage 回传，失败时回传错误信息由主线程统一记审计与状态。
 */
const { parentPort, workerData } = require('worker_threads');
const { createPackage } = require('./backup-package');

try {
  const result = createPackage(workerData.dest);
  parentPort.postMessage({ ok: true, result });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.stack) || e) });
}
