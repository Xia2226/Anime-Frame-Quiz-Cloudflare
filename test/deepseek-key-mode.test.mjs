import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.mjs";

const context = {
  waitUntil() {},
};

async function getHardConfig(env = {}) {
  const response = await worker.fetch(
    new Request("https://example.test/api/hard/config"),
    env,
    context,
  );
  return { response, data: await response.json() };
}

async function resolveHardQuestions(env = {}, apiKey = "") {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-DeepSeek-Api-Key"] = apiKey;
  const response = await worker.fetch(
    new Request("https://example.test/api/hard/resolve", {
      method: "POST",
      headers,
      body: "{}",
    }),
    env,
    context,
  );
  return { response, data: await response.json() };
}

test("hard config defaults to user-provided API keys", async () => {
  const { response, data } = await getHardConfig();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(data, { apiKeyMode: "user" });
});

test("hard config exposes only the selected site mode", async () => {
  const { response, data } = await getHardConfig({
    DEEPSEEK_API_KEY_MODE: " SITE ",
    DEEPSEEK_API_KEY: "sk-site-secret",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(data, { apiKeyMode: "site" });
  assert.equal(JSON.stringify(data).includes("sk-site-secret"), false);
});

test("invalid hard API key modes fall back to user mode", async () => {
  const { data } = await getHardConfig({
    DEEPSEEK_API_KEY_MODE: "unknown",
    DEEPSEEK_API_KEY: "sk-site-secret",
  });

  assert.deepEqual(data, { apiKeyMode: "user" });
});

test("hard resolve enforces the configured API key source", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const userMissing = await resolveHardQuestions();
    assert.equal(userMissing.response.status, 400);
    assert.equal(
      userMissing.data.error,
      "\u8bf7\u5148\u8f93\u5165\u5e76\u786e\u8ba4 DeepSeek API Key",
    );

    const siteMissing = await resolveHardQuestions({
      DEEPSEEK_API_KEY_MODE: "site",
    });
    assert.equal(siteMissing.response.status, 503);
    assert.equal(
      siteMissing.data.error,
      "\u7f51\u7ad9 DeepSeek API Key \u5c1a\u672a\u914d\u7f6e\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458",
    );

    const siteConfigured = await resolveHardQuestions({
      DEEPSEEK_API_KEY_MODE: "site",
      DEEPSEEK_API_KEY: "sk-site-secret",
    });
    assert.equal(siteConfigured.response.status, 400);
    assert.equal(siteConfigured.data.error, "entries \u5fc5\u987b\u662f\u6570\u7ec4");
  } finally {
    console.error = originalConsoleError;
  }
});
