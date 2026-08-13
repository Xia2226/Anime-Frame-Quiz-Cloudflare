import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE_ROOTS = ["public", "scripts", "src", "test", "tools"];
const sourceFiles = [
  resolve(ROOT, "worker.mjs"),
];

for (const directory of SOURCE_ROOTS) {
  sourceFiles.push(...await findJavaScriptFiles(resolve(ROOT, directory)));
}

sourceFiles.sort((left, right) => left.localeCompare(right, "en"));

for (const file of sourceFiles) {
  const displayPath = relative(ROOT, file);
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    console.error(`JavaScript 语法检查失败：${displayPath}`);
    process.exit(result.status || 1);
  }
}

console.log(`JavaScript 语法检查通过：${sourceFiles.length} 个文件。`);

async function findJavaScriptFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findJavaScriptFiles(path));
    } else if (entry.isFile() && [".js", ".mjs"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}
