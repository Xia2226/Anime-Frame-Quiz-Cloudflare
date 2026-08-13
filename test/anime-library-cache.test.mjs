import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.mjs";

test("anime library falls back without caching when the cache version query fails", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const env = {
      ASSETS: {
        fetch: async () => new Response(JSON.stringify({
          anime: [{ anidbId: "42", enabled: true }],
        }), {
          headers: {
            "Content-Type": "application/json",
            ETag: "\"asset-version\"",
          },
        }),
      },
      DB: {
        prepare: (sql) => {
          if (sql.includes("anime_library_cache_version")) {
            return { first: async () => { throw new Error("missing migration"); } };
          }
          if (sql.includes("SELECT anidb_id, enabled FROM anime_override")) {
            return { all: async () => ({ results: [{ anidb_id: "42", enabled: 0 }] }) };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      },
    };
    const context = {
      waitUntil: () => assert.fail("degraded responses must not be cached"),
    };

    const response = await worker.fetch(
      new Request("https://example.test/data/anime-library.json"),
      env,
      context,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), {
      anime: [{ anidbId: "42", enabled: false }],
    });
  } finally {
    console.error = originalConsoleError;
  }
});
