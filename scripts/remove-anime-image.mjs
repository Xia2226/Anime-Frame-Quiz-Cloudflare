// 用法: node scripts/remove-anime-image.mjs <图片URL>
// 不加参数运行时会在终端提示输入图片地址。
//
// 功能:
//   1. 根据图片 URL 在 resources/fancaps_anime_images.jsonl 中找到对应番剧;
//   2. 从该番剧的 images 中删除该图片, 并同步 image_count;
//   3. 在 public/data/anime-library.json 中按 bgmId 找到同一番剧,
//      从 imageIds 中删除对应的图片 ID, 并同步 stats.imageCount;
//   4. 输出番剧信息、删除前后图片数, 并校验两个文件均删除成功。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { replaceFilesWithRollback } from "./lib/file-transaction.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FANCAPS_FILE = resolve(ROOT, "resources/fancaps_anime_images.jsonl");
const LIBRARY_FILE = resolve(ROOT, "public/data/anime-library.json");

// 与 AnimeShotDB-tools 的题库格式保持一致
const IMAGE_PATTERN = /^https:\/\/cdni\.fancaps\.net\/file\/fancaps-animeimages\/(\d+)\.jpg(?:[?#].*)?$/i;

const extractImageId = (url) => {
  const m = IMAGE_PATTERN.exec(String(url).trim());
  return m ? Number(m[1]) : null;
};

// ---------- 获取输入 ----------
let inputUrl = (process.argv[2] ?? "").trim();
if (!inputUrl) {
  const rl = createInterface({ input: stdin, output: stdout });
  inputUrl = (await rl.question("请输入图片地址: ")).trim();
  rl.close();
}
const imageId = extractImageId(inputUrl);
if (imageId == null) {
  console.error("[错误] 图片地址格式不正确, 应为: https://cdni.fancaps.net/file/fancaps-animeimages/<数字>.jpg");
  process.exit(1);
}
console.log(`图片 ID: ${imageId}`);
console.log(`输入地址: ${inputUrl}`);
console.log();

// ---------- 处理 fancaps_anime_images.jsonl ----------
const jsonlRaw = await readFile(FANCAPS_FILE, "utf8");
const jsonlEndsWithNewline = jsonlRaw.endsWith("\n");
const jsonlLines = jsonlRaw.replace(/\n$/, "").split("\n");

let hitLineIndex = -1;
let jsonlHit = null; // 该行解析后的对象
for (let i = 0; i < jsonlLines.length; i++) {
  const raw = jsonlLines[i];
  if (!raw.trim()) continue;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    continue;
  }
  if (!Array.isArray(obj.images)) continue;
  // 优先精确匹配 URL, 其次按 ID 匹配(兼容 URL 格式差异)
  const exact = obj.images.includes(inputUrl) || obj.images.includes(`https://cdni.fancaps.net/file/fancaps-animeimages/${imageId}.jpg`);
  const byId = !exact && obj.images.some((u) => extractImageId(u) === imageId);
  if (exact || byId) {
    hitLineIndex = i;
    jsonlHit = obj;
    break;
  }
}

if (!jsonlHit) {
  console.error(`[错误] 在 ${FANCAPS_FILE} 中未找到图片 ID ${imageId} 对应的番剧, 未做任何修改。`);
  process.exit(1);
}

const jsonlRemoved = jsonlHit.images.filter((u) => extractImageId(u) === imageId);
const jsonlOriginalCount = jsonlHit.image_count ?? jsonlHit.images.length;
if (jsonlRemoved.length === 0) {
  console.error(`[错误] 在番剧「${jsonlHit.label_text}」中未找到该图片, 未做任何修改。`);
  process.exit(1);
}

// 先在内存中生成 JSONL 修改结果，不提前覆盖任一文件
jsonlHit.images = jsonlHit.images.filter((u) => extractImageId(u) !== imageId);
if (jsonlHit.images.length === 0) {
  console.error(`[错误] 不能删除番剧「${jsonlHit.label_text}」的最后一张图片，未做任何修改。`);
  process.exit(1);
}
jsonlHit.image_count = jsonlHit.images.length;
jsonlLines[hitLineIndex] = JSON.stringify(jsonlHit);
const newJsonlRaw = jsonlLines.join("\n") + (jsonlEndsWithNewline ? "\n" : "");

// ---------- 处理 anime-library.json ----------
const libraryRaw = await readFile(LIBRARY_FILE, "utf8");
const libraryEndsWithNewline = libraryRaw.endsWith("\n");
const library = JSON.parse(libraryRaw);
if (!Array.isArray(library.anime) || !library.stats || typeof library.stats.imageCount !== "number") {
  console.error("[错误] public/data/anime-library.json 结构无效，未做任何修改。");
  process.exit(1);
}
const computedOriginalImageCount = library.anime.reduce(
  (total, anime) => total + (Array.isArray(anime?.imageIds) ? anime.imageIds.length : 0),
  0,
);
if (computedOriginalImageCount !== library.stats.imageCount) {
  console.error("[错误] public/data/anime-library.json 的 stats.imageCount 与实际图片数不一致，未做任何修改。");
  process.exit(1);
}

const removedFromLibrary = [];
for (const anime of library.anime) {
  if (!Array.isArray(anime.imageIds)) continue;
  if (anime.imageIds.includes(imageId)) {
    anime.imageIds = anime.imageIds.filter((id) => id !== imageId);
    removedFromLibrary.push(anime);
  }
}

if (removedFromLibrary.length !== 1) {
  console.error(`[错误] 精简题库中图片 ID ${imageId} 命中了 ${removedFromLibrary.length} 部番剧，未做任何修改。`);
  process.exit(1);
}
const libraryHit = removedFromLibrary[0];
if (String(libraryHit.bgmId) !== String(jsonlHit.bgm_id)) {
  console.error("[错误] 原始题库与精简题库中的番剧关联不一致，未做任何修改。");
  process.exit(1);
}
if (libraryHit.imageIds.length === 0) {
  console.error(`[错误] 不能删除番剧「${libraryHit.title}」的最后一张图片，未做任何修改。`);
  process.exit(1);
}

const statsOriginalImageCount = library.stats.imageCount;
library.stats.imageCount -= 1;

const newLibraryRaw = JSON.stringify(library) + (libraryEndsWithNewline ? "\n" : "");

// 两份结果全部解析和校验完成后再提交。每个目标通过同目录临时文件替换；
// 任一替换失败时自动用备份回滚已替换的文件。
await replaceFilesWithRollback([
  { path: FANCAPS_FILE, content: newJsonlRaw, original: jsonlRaw },
  { path: LIBRARY_FILE, content: newLibraryRaw, original: libraryRaw },
]);

// ---------- 输出结果 ----------
console.log("========== 删除结果 ==========");
console.log(`番剧: ${jsonlHit.label_text}  (bgmId: ${jsonlHit.bgm_id})`);
console.log(`删除图片 ID: ${imageId}`);
console.log(`实际删除的地址: ${jsonlRemoved[0]}`);
console.log();
console.log(`[resources/fancaps_anime_images.jsonl]`);
console.log(`  原图片数: ${jsonlOriginalCount}`);
console.log(`  修改后图片数: ${jsonlHit.images.length}`);
console.log(`  已删除: ${jsonlRemoved.length} 张  ->  ${FANCAPS_FILE}`);
console.log();
console.log(`[public/data/anime-library.json]`);
console.log(`  命中番剧: ${removedFromLibrary.map((a) => `${a.title}(bgmId:${a.bgmId})`).join(", ") || "未找到"}`);
console.log(`  stats.imageCount: ${statsOriginalImageCount} -> ${library.stats?.imageCount}`);
console.log();

// ---------- 校验 ----------
const verifyJsonl = await readFile(FANCAPS_FILE, "utf8");
const verifyLibrary = await readFile(LIBRARY_FILE, "utf8");
const jsonlOk = !verifyJsonl.split("\n").some((raw) => {
  if (!raw.trim()) return false;
  try {
    const o = JSON.parse(raw);
    return Array.isArray(o.images) && o.images.some((u) => extractImageId(u) === imageId);
  } catch {
    return false;
  }
});
const libOk = !JSON.parse(verifyLibrary).anime.some((a) => Array.isArray(a.imageIds) && a.imageIds.includes(imageId));

if (jsonlOk && libOk) {
  console.log(`校验通过: 两个文件均已成功删除该图片 (ID ${imageId})。`);
  console.log(`最终结果: 原图片数 ${jsonlOriginalCount} -> 修改后图片数 ${jsonlHit.images.length}`);
} else {
  console.error(`[警告] 校验未通过: jsonl=${jsonlOk ? "OK" : "仍包含该图片"}  library=${libOk ? "OK" : "仍包含该图片"}`);
  process.exit(1);
}
