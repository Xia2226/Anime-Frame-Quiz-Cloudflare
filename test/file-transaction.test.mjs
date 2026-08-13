import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { replaceFilesWithRollback } from "../scripts/lib/file-transaction.mjs";

test("replaceFilesWithRollback replaces every file and removes temporary files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anime-quiz-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "first.txt");
  const second = join(directory, "second.txt");
  await Promise.all([writeFile(first, "old-1"), writeFile(second, "old-2")]);

  await replaceFilesWithRollback([
    { path: first, content: "new-1", original: "old-1" },
    { path: second, content: "new-2", original: "old-2" },
  ]);

  assert.equal(await readFile(first, "utf8"), "new-1");
  assert.equal(await readFile(second, "utf8"), "new-2");
  assert.deepEqual((await readdir(directory)).sort(), ["first.txt", "second.txt"]);
});

test("replaceFilesWithRollback restores earlier files when a later replace fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anime-quiz-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "first.txt");
  const second = join(directory, "second.txt");
  await Promise.all([writeFile(first, "old-1"), writeFile(second, "old-2")]);
  let injectedFailure = false;

  await assert.rejects(() => replaceFilesWithRollback([
    { path: first, content: "new-1", original: "old-1" },
    { path: second, content: "new-2", original: "old-2" },
  ], {
    rename: async (source, destination) => {
      if (!injectedFailure && destination === second && source.includes(".new.tmp")) {
        injectedFailure = true;
        throw new Error("injected replace failure");
      }
      return rename(source, destination);
    },
  }), /injected replace failure/);

  assert.equal(await readFile(first, "utf8"), "old-1");
  assert.equal(await readFile(second, "utf8"), "old-2");
  assert.deepEqual((await readdir(directory)).sort(), ["first.txt", "second.txt"]);
});
