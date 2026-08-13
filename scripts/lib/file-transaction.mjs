import { randomUUID } from "node:crypto";
import {
  rename as renameFile,
  rm as removeFile,
  writeFile,
} from "node:fs/promises";

export async function replaceFilesWithRollback(updates, io = {}) {
  const write = io.writeFile || writeFile;
  const rename = io.rename || renameFile;
  const remove = io.rm || removeFile;
  const transactionId = randomUUID();
  const paths = new Set();
  const staged = updates.map((update) => {
    if (!update || typeof update.path !== "string" || typeof update.content !== "string"
      || typeof update.original !== "string") {
      throw new TypeError("文件更新必须包含 path、content 和 original 字符串");
    }
    if (paths.has(update.path)) throw new Error(`文件更新路径重复：${update.path}`);
    paths.add(update.path);
    return {
      ...update,
      newPath: `${update.path}.${transactionId}.new.tmp`,
      backupPath: `${update.path}.${transactionId}.backup.tmp`,
      committed: false,
      rolledBack: false,
    };
  });

  try {
    for (const item of staged) {
      await write(item.newPath, item.content, { encoding: "utf8", flag: "wx" });
      await write(item.backupPath, item.original, { encoding: "utf8", flag: "wx" });
    }

    for (const item of staged) {
      await rename(item.newPath, item.path);
      item.committed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...staged].reverse()) {
      if (!item.committed) continue;
      try {
        await rename(item.backupPath, item.path);
        item.rolledBack = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    await cleanupTemporaryFiles(staged, remove, { preserveFailedBackups: true });
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "文件更新失败，且至少一个原文件未能自动恢复；请使用保留的 .backup.tmp 文件恢复",
      );
    }
    throw error;
  }

  await cleanupTemporaryFiles(staged, remove);
}

async function cleanupTemporaryFiles(staged, remove, options = {}) {
  for (const item of staged) {
    await remove(item.newPath, { force: true }).catch(() => {});
    if (!options.preserveFailedBackups || !item.committed || item.rolledBack) {
      await remove(item.backupPath, { force: true }).catch(() => {});
    }
  }
}
