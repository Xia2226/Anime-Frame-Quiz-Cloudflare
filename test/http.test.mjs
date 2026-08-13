import assert from "node:assert/strict";
import test from "node:test";

import {
  httpError,
  json,
  readJsonBody,
  redactLogMessage,
  requireMethod,
  withSecurityHeaders,
} from "../src/http.mjs";

test("readJsonBody parses bounded JSON", async () => {
  const request = new Request("https://example.test/api", {
    method: "POST",
    body: JSON.stringify({ ok: true }),
    headers: { "Content-Type": "application/json" },
  });
  assert.deepEqual(await readJsonBody(request, 1024), { ok: true });
});

test("readJsonBody rejects oversized and malformed bodies", async () => {
  const oversized = new Request("https://example.test/api", {
    method: "POST",
    body: "12345",
  });
  await assert.rejects(() => readJsonBody(oversized, 4), (error) => error.statusCode === 413);

  const malformed = new Request("https://example.test/api", {
    method: "POST",
    body: "{",
  });
  await assert.rejects(() => readJsonBody(malformed, 4), (error) => error.statusCode === 400);
});

test("requireMethod returns a typed 405 error", () => {
  const request = new Request("https://example.test/api", { method: "POST" });
  assert.throws(
    () => requireMethod(request, "GET"),
    (error) => error.statusCode === 405 && error.code === "METHOD_NOT_ALLOWED",
  );
});

test("response helpers preserve cache overrides and security headers", async () => {
  const apiResponse = json({ ok: true }, 200, { "Cache-Control": "public, max-age=30" });
  assert.equal(apiResponse.headers.get("Cache-Control"), "public, max-age=30");
  assert.deepEqual(await apiResponse.json(), { ok: true });

  const secured = withSecurityHeaders(new Response("ok"));
  assert.equal(secured.headers.get("X-Frame-Options"), "DENY");
  assert.match(secured.headers.get("Content-Security-Policy"), /object-src 'none'/);
});

test("httpError and log redaction do not expose bearer tokens", () => {
  assert.equal(httpError(404, "missing").statusCode, 404);
  const output = redactLogMessage("Bearer sk-secret_token_value");
  assert.equal(output.includes("sk-secret_token_value"), false);
  assert.match(output, /REDACTED/);
});
