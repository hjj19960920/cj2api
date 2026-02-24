import { handleProxyRequest } from "../src/proxy.js";

export const config = {
  runtime: "edge",
};

export default async function handler(request) {
  const url = new URL(request.url);
  url.pathname = "/v1/models";
  return handleProxyRequest(new Request(url.toString(), request), process.env);
}
