const REQUEST_TIMEOUT_MS = 20_000;
const MAX_UPSTREAM_ERROR_BYTES = 8 * 1024;

export function requireMethod(request, expected) {
  if (request.method !== expected) {
    const error = httpError(405, `仅支持 ${expected} 请求`);
    error.code = "METHOD_NOT_ALLOWED";
    throw error;
  }
}

export async function readJsonBody(request, maximumBytes) {
  const text = await readBodyTextWithLimit(
    request,
    maximumBytes,
    () => httpError(413, "请求体过大"),
  );
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw httpError(400, `JSON 格式错误: ${error.message}`);
  }
}

export async function readJsonResponse(response, maximumBytes, label) {
  const text = await readBodyTextWithLimit(
    response,
    maximumBytes,
    () => httpError(502, `${label}响应过大`),
  );
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw httpError(502, `${label}返回了无效 JSON: ${error.message}`);
  }
}

export async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const attempts = Math.max(1, retryOptions.attempts || 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        options,
        retryOptions.timeoutMs || REQUEST_TIMEOUT_MS,
      );
      if (response.ok) return response;
      const body = await readResponseSnippet(response).catch(() => "");
      const error = new Error(
        `${retryOptions.label || "上游 API"} HTTP ${response.status}`
        + `${body ? `: ${body.slice(0, 500)}` : ""}`,
      );
      error.status = response.status;
      lastError = error;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) {
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (error.status || attempt === attempts - 1) throw error;
    }
    await delay(500 * (2 ** attempt) + Math.round(Math.random() * 200));
  }
  throw lastError || new Error(`${retryOptions.label || "上游 API"} 请求失败`);
}

export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob: https://cdni.fancaps.net https://sakugabooru.com https://*.sakugabooru.com",
    "media-src 'self' blob: https://sakugabooru.com https://*.sakugabooru.com",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function json(value, status = 200, additionalHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      ...additionalHeaders,
    },
  });
}

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function redactLogMessage(value) {
  return String(value || "Unknown error")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, 500);
}

async function readBodyTextWithLimit(message, maximumBytes, tooLargeErrorFactory) {
  const declaredLength = Number(message.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw tooLargeErrorFactory();
  }
  if (!message.body) return "";

  const reader = message.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw tooLargeErrorFactory();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatenateBytes(chunks, totalBytes));
}

async function readResponseSnippet(response, maximumBytes = MAX_UPSTREAM_ERROR_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const remaining = maximumBytes - totalBytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.slice(0, remaining));
        totalBytes = maximumBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      if (totalBytes === maximumBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(concatenateBytes(chunks, totalBytes));
  return truncated ? `${text}…` : text;
}

function concatenateBytes(chunks, totalBytes) {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
