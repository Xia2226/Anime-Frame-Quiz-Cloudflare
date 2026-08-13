import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LIBRARIES = [
  { path: resolve(ROOT, "public/data/anime-library.json"), version: 2, requireEnabled: true },
  { path: resolve(ROOT, "public/data/anime-library-old.json"), version: 1, requireEnabled: false },
];

const summaries = [];
for (const options of LIBRARIES) summaries.push(await validateLibrary(options));

for (const summary of summaries) console.log(JSON.stringify(summary));
console.log(`题库校验通过：${summaries.length} 个文件。`);

async function validateLibrary({ path, version, requireEnabled }) {
  const displayPath = relative(ROOT, path).replaceAll("\\", "/");
  let data;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(displayPath, `无法读取有效 JSON：${error.message}`);
  }

  assert(data && typeof data === "object" && !Array.isArray(data), displayPath, "顶层必须是对象");
  assert(data.version === version, displayPath, `version 必须为 ${version}`);
  assert(
    typeof data.imageBase === "string" && /^https:\/\//.test(data.imageBase),
    displayPath,
    "imageBase 必须是 HTTPS 地址",
  );
  assert(Array.isArray(data.anime) && data.anime.length > 0, displayPath, "anime 必须是非空数组");
  assert(Array.isArray(data.tags), displayPath, "tags 必须是数组");
  assert(data.stats && typeof data.stats === "object", displayPath, "stats 必须是对象");

  const bgmIds = new Set();
  const anidbIds = new Set();
  const imageIds = new Set();
  const computedTagCounts = new Map();
  let imageCount = 0;

  for (const [index, anime] of data.anime.entries()) {
    const label = `${displayPath} anime[${index}]`;
    assert(anime && typeof anime === "object" && !Array.isArray(anime), label, "必须是对象");
    assertPositiveInteger(anime.bgmId, label, "bgmId");
    assertPositiveInteger(anime.anidbId, label, "anidbId");
    assert(!bgmIds.has(anime.bgmId), label, `bgmId 重复：${anime.bgmId}`);
    assert(!anidbIds.has(anime.anidbId), label, `anidbId 重复：${anime.anidbId}`);
    bgmIds.add(anime.bgmId);
    anidbIds.add(anime.anidbId);

    assert(typeof anime.title === "string" && anime.title.trim(), label, "title 不能为空");
    assert(Array.isArray(anime.imageIds) && anime.imageIds.length > 0, label, "imageIds 必须是非空数组");
    assertStringArray(anime.tags, label, "tags");
    assertStringArray(anime.metaTags, label, "metaTags");
    if (requireEnabled) assert(typeof anime.enabled === "boolean", label, "enabled 必须是布尔值");

    for (const imageId of anime.imageIds) {
      assertPositiveInteger(imageId, label, "imageId");
      assert(!imageIds.has(imageId), label, `imageId 跨番剧重复：${imageId}`);
      imageIds.add(imageId);
      imageCount += 1;
    }
    for (const tag of new Set([...anime.tags, ...anime.metaTags])) {
      computedTagCounts.set(tag, (computedTagCounts.get(tag) || 0) + 1);
    }
  }

  const tagNames = new Set();
  for (const [index, tag] of data.tags.entries()) {
    const label = `${displayPath} tags[${index}]`;
    assert(tag && typeof tag === "object" && !Array.isArray(tag), label, "必须是对象");
    assert(typeof tag.name === "string" && tag.name.trim(), label, "name 不能为空");
    assert(!tagNames.has(tag.name), label, `标签重复：${tag.name}`);
    tagNames.add(tag.name);
    assertPositiveInteger(tag.animeCount, label, "animeCount");
    assert(
      tag.animeCount === (computedTagCounts.get(tag.name) || 0),
      label,
      `animeCount 应为 ${computedTagCounts.get(tag.name) || 0}，实际为 ${tag.animeCount}`,
    );
  }

  assert(data.stats.animeCount === data.anime.length, displayPath, "stats.animeCount 与 anime 长度不一致");
  assert(data.stats.imageCount === imageCount, displayPath, "stats.imageCount 与 imageIds 总数不一致");
  assert(data.stats.tagCount === data.tags.length, displayPath, "stats.tagCount 与 tags 长度不一致");

  return {
    file: displayPath,
    version: data.version,
    animeCount: data.anime.length,
    imageCount,
    tagCount: data.tags.length,
  };
}

function assertStringArray(value, label, fieldName) {
  assert(Array.isArray(value), label, `${fieldName} 必须是数组`);
  const unique = new Set();
  for (const item of value) {
    assert(typeof item === "string" && item.trim(), label, `${fieldName} 只能包含非空字符串`);
    assert(!unique.has(item), label, `${fieldName} 包含重复项：${item}`);
    unique.add(item);
  }
}

function assertPositiveInteger(value, label, fieldName) {
  assert(Number.isSafeInteger(value) && value > 0, label, `${fieldName} 必须是正整数`);
}

function assert(condition, label, message) {
  if (!condition) fail(label, message);
}

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}
