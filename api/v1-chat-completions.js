import { handleProxyRequest } from "../src/proxy.js";

export const config = {
  runtime: "edge",
};

export default async function handler(request) {
  return handleProxyRequest(request, process.env, "/v1/chat/completions");
}
