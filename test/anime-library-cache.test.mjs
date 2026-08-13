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
    assert.equal(
      response.headers.get("Cache-Control"),
      "private, no-store, max-age=0, must-revalidate",
    );
    assert.deepEqual(await response.json(), {
      anime: [{ anidbId: "42", enabled: false }],
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("anime library keeps the one-hour cache internal and never exposes client caching", async () => {
  const originalCaches = globalThis.caches;
  let storedResponse;
  const backgroundTasks = [];
  globalThis.caches = {
    default: {
      match: async () => storedResponse?.clone(),
      put: async (_request, response) => {
        storedResponse = response;
      },
    },
  };
  try {
    const env = {
      ASSETS: {
        fetch: async () => new Response(JSON.stringify({
          anime: [{ anidbId: "42", enabled: true }],
        }), {
          headers: {
            "Content-Type": "application/json",
            ETag: '"asset-version"',
          },
        }),
      },
      DB: {
        prepare: (sql) => {
          if (sql.includes("anime_library_cache_version")) {
            return { first: async () => ({ version: 7, updated_at: 123 }) };
          }
          if (sql.includes("SELECT anidb_id, enabled FROM anime_override")) {
            return { all: async () => ({ results: [{ anidb_id: "42", enabled: 0 }] }) };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      },
    };
    const context = {
      waitUntil: (task) => backgroundTasks.push(task),
    };

    const first = await worker.fetch(
      new Request("https://example.test/data/anime-library.json"),
      env,
      context,
    );
    assert.equal(
      first.headers.get("Cache-Control"),
      "private, no-store, max-age=0, must-revalidate",
    );
    assert.equal(first.headers.get("Cloudflare-CDN-Cache-Control"), null);
    assert.deepEqual(await first.json(), {
      anime: [{ anidbId: "42", enabled: false }],
    });
    await Promise.all(backgroundTasks);
    assert.equal(storedResponse.headers.get("Cache-Control"), "public, max-age=3600");

    const second = await worker.fetch(
      new Request("https://example.test/data/anime-library.json"),
      env,
      context,
    );
    assert.equal(
      second.headers.get("Cache-Control"),
      "private, no-store, max-age=0, must-revalidate",
    );
    assert.deepEqual(await second.json(), {
      anime: [{ anidbId: "42", enabled: false }],
    });
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
