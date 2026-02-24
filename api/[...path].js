import { handleProxyRequest } from "../src/proxy.js";

export const config = {
  runtime: "edge",
};

export default async function handler(request) {
  const forwardedRequest = stripPrefix(request, "/api");
  return handleProxyRequest(forwardedRequest, process.env);
}

function stripPrefix(request, prefix) {
  const url = new URL(request.url);
  if (url.pathname === prefix) {
    url.pathname = "/";
  } else if (url.pathname.startsWith(`${prefix}/`)) {
    url.pathname = url.pathname.slice(prefix.length) || "/";
  }
  return new Request(url.toString(), request);
}
