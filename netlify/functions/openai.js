import { Buffer } from "node:buffer";

import { handleProxyRequest } from "../../src/proxy.js";

const INTERNAL_PREFIX = "/.netlify/functions/openai";

export async function handler(event) {
  const method = event.httpMethod || "GET";
  const body =
    event.body == null
      ? undefined
      : event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body;

  const sourceUrl = new URL(resolveRawUrl(event));
  sourceUrl.pathname = stripPrefix(sourceUrl.pathname, INTERNAL_PREFIX);
  if (!sourceUrl.pathname) {
    sourceUrl.pathname = "/";
  }

  const request = new Request(sourceUrl.toString(), {
    method,
    headers: event.headers || {},
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });

  const response = await handleProxyRequest(request, process.env);
  return toNetlifyResponse(response);
}

function resolveRawUrl(event) {
  if (event.rawUrl) return event.rawUrl;
  const proto = event.headers?.["x-forwarded-proto"] || "https";
  const host = event.headers?.host || "localhost";
  const path = event.path || "/";
  const query = event.rawQuery ? `?${event.rawQuery}` : "";
  return `${proto}://${host}${path}${query}`;
}

function stripPrefix(pathname, prefix) {
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) {
    return pathname.slice(prefix.length) || "/";
  }
  return pathname;
}

async function toNetlifyResponse(response) {
  const headers = Object.fromEntries(response.headers.entries());
  const body = await response.text();
  return {
    statusCode: response.status,
    headers,
    body,
  };
}
