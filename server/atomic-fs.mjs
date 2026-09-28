// server/atomic-fs.mjs — 原子写文件的**唯一实现**（v1.14，可靠性审阅）：临时文件 + rename 进位。
//
// 为什么要有它：`fs.writeFileSync(目标)` 直接覆盖时，进程若在写到一半被打断（被杀 / 断电 / 磁盘满），
// 目标文件就留下半截内容——世界线索引、逐轮快照、素材这些「读到一半即坏」的文件都会因此报废。
// 先写**同目录**临时文件、写全了再 rename 进位，读者要么看到旧文件、要么看到新文件，永远看不到半截。
// 同目录是关键：tmp 与目标同卷，rename 才是原子的（跨卷会退化成「先删后拷」，等于没保护）。
//
// 调用约定：目录由调用方先建好（本模块只管文件的原子落盘，不揽建目录的活——各调用点的目录权限不同，
// 如 credentials 的 0700）。任何一步失败都清掉临时文件并把异常原样抛出，由调用方按各自语义兜底。
import fs from "fs";

/**
 * 原子写文件：`<file>.tmp-<pid>-<时间>` 写入 → rename 到 `file`；失败清 tmp 并抛出。
 * @param {string} file 目标文件绝对路径
 * @param {string|Buffer} data 要写入的内容
 * @param {{mode?: number}} [opts] `mode` = 显式给落盘文件设权限（如凭据 0600）；缺省沿用 umask
 * @returns {void}
 */
export function writeFileAtomic(file, data, { mode } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data, mode == null ? undefined : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清临时文件也失败就随它去：残留的 .tmp- 前缀文件不在任何扫描面内（重新写会覆盖自己的 tmp 名） */
    }
    throw e;
  }
}
