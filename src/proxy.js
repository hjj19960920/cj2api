const CHATJIMMY_DEFAULT_URL = "https://chatjimmy.ai/api/chat";
const DEFAULT_MODEL = "llama3.1-8B";
const DEFAULT_TOP_K = 8;

export async function handleProxyRequest(request, env = {}, forcedPathname = null) {
  const url = new URL(request.url);
  const rawPathname = normalizePath(forcedPathname || url.pathname);
  const pathname = normalizePath(mapAliasPath(rawPathname));

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(env),
    });
  }

  if (pathname === "/" || pathname === "/health") {
    return jsonResponse({ status: "ok" }, 200, env);
  }

  if (pathname === "/v1/models") {
    if (request.method !== "GET") {
      return methodNotAllowed(env);
    }
    return listModels(env);
  }

  if (pathname === "/v1/chat/completions") {
    if (request.method !== "POST") {
      return methodNotAllowed(env);
    }
    const authError = validateAuth(request, env);
    if (authError) {
      return authError;
    }
    return handleChatCompletion(request, env);
  }

  return openaiError("Not found", 404, env, "invalid_request_error", "not_found");
}

function mapAliasPath(pathname) {
  const aliases = {
    "/api": "/",
    "/api/health": "/health",
    "/api/v1-models": "/v1/models",
    "/api/v1-chat-completions": "/v1/chat/completions",
  };
  return aliases[pathname] || pathname;
}

function normalizePath(pathname) {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "");
  }
  return pathname;
}

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type",
    "access-control-max-age": "86400",
  };
}

function baseHeaders(env) {
  return {
    ...corsHeaders(env),
    "content-type": "application/json; charset=utf-8",
  };
}

function jsonResponse(data, status, env, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...baseHeaders(env),
      ...extraHeaders,
    },
  });
}

function openaiError(message, status, env, type = "invalid_request_error", code = null) {
  return jsonResponse(
    {
      error: {
        message,
        type,
        param: null,
        code,
      },
    },
    status,
    env
  );
}

function methodNotAllowed(env) {
  return openaiError("Method not allowed", 405, env, "invalid_request_error", "method_not_allowed");
}

function validateAuth(request, env) {
  const expected = String(env.OPENAI_API_KEY || "").trim();
  if (!expected) {
    return null;
  }
  const authorization = request.headers.get("authorization") || "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!actual || actual !== expected) {
    return openaiError("Invalid API key", 401, env, "invalid_api_key", "invalid_api_key");
  }
  return null;
}

function listModels(env) {
  const now = Math.floor(Date.now() / 1000);
  const modelEnv = String(env.CHATJIMMY_MODELS || "").trim();
  const models = modelEnv
    ? modelEnv
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : [];
  const defaultModel = String(env.CHATJIMMY_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  if (!models.includes(defaultModel)) {
    models.unshift(defaultModel);
  }
  return jsonResponse(
    {
      object: "list",
      data: models.map((id) => ({
        id,
        object: "model",
        created: now,
        owned_by: "chatjimmy",
      })),
    },
    200,
    env
  );
}

async function handleChatCompletion(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return openaiError("Request body must be JSON", 400, env);
  }

  const rawMessages = payload?.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return openaiError("messages must be a non-empty array", 400, env);
  }

  const chatOptions = isObject(payload.chatOptions) ? payload.chatOptions : {};
  const model =
    String(payload.model || chatOptions.selectedModel || env.CHATJIMMY_MODEL || DEFAULT_MODEL).trim() ||
    DEFAULT_MODEL;

  const topK = parseTopK(
    payload.top_k ?? payload.topK ?? chatOptions.topK ?? env.CHATJIMMY_TOP_K ?? DEFAULT_TOP_K
  );

  const systemParts = [];
  const convertedMessages = [];
  for (const msg of rawMessages) {
    if (!isObject(msg)) continue;
    const role = String(msg.role || "user");
    const content = contentToText(msg.content);
    if (role === "system") {
      if (content) systemParts.push(content);
      continue;
    }
    convertedMessages.push({ role, content });
  }

  if (convertedMessages.length === 0) {
    return openaiError("no valid non-system messages found", 400, env);
  }

  const systemPrompt = systemParts.join("\n").trim() || String(chatOptions.systemPrompt || "");
  const upstreamPayload = {
    messages: convertedMessages,
    chatOptions: {
      selectedModel: model,
      systemPrompt,
      topK,
    },
    attachment: null,
  };

  const upstreamUrl = String(env.CHATJIMMY_URL || CHATJIMMY_DEFAULT_URL).trim() || CHATJIMMY_DEFAULT_URL;
  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err) {
    return openaiError(`upstream request failed: ${String(err)}`, 502, env, "api_error", "upstream_error");
  }

  const upstreamText = await upstreamResp.text();
  if (!upstreamResp.ok) {
    return openaiError(
      `upstream returned ${upstreamResp.status}: ${upstreamText.slice(0, 500)}`,
      502,
      env,
      "api_error",
      "upstream_status_error"
    );
  }

  const { text, stats } = extractTextAndStats(upstreamText);
  const completion = buildOpenAICompletion(model, text, stats);
  if (payload.stream === true) {
    return streamResponse(completion, env);
  }
  return jsonResponse(completion, 200, env);
}

function parseTopK(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_TOP_K;
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (isObject(item) && typeof item.text === "string") {
          return item.text;
        }
        if (typeof item === "string") {
          return item;
        }
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join("\n");
  }
  if (isObject(content)) {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function extractTextAndStats(rawText) {
  const patterns = [
    /<\|stats\|>([\s\S]*?)<\|\/stats\|>/,
    /<stats>([\s\S]*?)<\/stats>/,
  ];

  let statsRaw = "";
  let text = rawText;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    statsRaw = (match[1] || "").trim();
    text = text.replace(pattern, "").trim();
    break;
  }

  if (!statsRaw) {
    return { text: text.trim(), stats: {} };
  }

  let stats = {};
  try {
    stats = JSON.parse(statsRaw);
  } catch {
    stats = { raw: statsRaw };
  }
  return { text: text.trim(), stats };
}

function buildOpenAICompletion(model, text, stats) {
  const created = Math.floor(Date.now() / 1000);
  const promptTokens = safeInt(stats.prefill_tokens);
  const completionTokens = safeInt(stats.decode_tokens);
  const totalTokens = safeInt(stats.total_tokens, promptTokens + completionTokens);
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
    chatjimmy_stats: stats,
  };
}

function streamResponse(completion, env) {
  const encoder = new TextEncoder();
  const headers = {
    ...corsHeaders(env),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };

  const chunk1 = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: completion.choices?.[0]?.message?.content || "",
        },
        finish_reason: null,
      },
    ],
  };
  const chunk2 = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

function safeInt(value, fallback = 0) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
