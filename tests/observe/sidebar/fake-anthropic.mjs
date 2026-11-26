// A fake Anthropic Messages API on loopback, for sidebarcli.test.mjs: the
// real Claude Code CLI talks to it (ANTHROPIC_BASE_URL, a fake key), so a
// test can script what the model asks for and see what the CLI sends it:
// the system prompt, the tools it offers, and the results of tool calls.
//
//   const api = await startFakeAnthropic(reply);
//   reply(request) -> { text } | { tool: { name, input } } | { blocks: [...] }
//
// `blocks` are whole content blocks, as a server tool's turn has them: the
// answer to WebSearch's own request (server_tool_use, web_search_tool_result,
// text), added for Chat's fetch rule in the sidebar.
//   api.url, api.requests (each { system, tools, messages, last }), api.close()
//
// `last` is the newest user turn as plain text, tool results included
// ("[tool_result error] ..."), so a script can tell its steps apart.
import { createServer } from "node:http";

function plain(content) {
  if (typeof content === "string") {
    return content;
  }
  return (content ?? [])
    .map(block => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return `[tool_result${block.is_error ? " error" : ""}] ${plain(block.content)}`;
      }
      if (block.type === "tool_reference") {
        return `[tool_reference ${block.tool_name}]`;
      }
      return `[${block.type}]`;
    })
    .join("\n");
}

function summary(body) {
  const messages = body.messages ?? [];
  const users = messages.filter(m => m.role === "user");
  return {
    model: body.model,
    system: plain(body.system),
    tools: (body.tools ?? []).map(t => t.name ?? t.type),
    // Deferred tools (tool search) come as references the model can load.
    toolDefs: (body.tools ?? []).map(t => ({ name: t.name, type: t.type, defer: t.defer_loading })),
    messages: messages.map(m => ({ role: m.role, text: plain(m.content) })),
    last: users.length ? plain(users.at(-1).content) : "",
  };
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [type, data] of events) {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  res.end();
}

let nextId = 1;

/** A block's stream events, as the API sends them: text and tool input in
 * deltas, anything else (a server tool's result) whole at its start. */
function streamed(block, index) {
  if (block.type === "text") {
    return [
      ["content_block_start", { index, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }],
      ["content_block_stop", { index }],
    ];
  }
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    return [
      ["content_block_start", { index, content_block: { ...block, input: {} } }],
      ["content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } }],
      ["content_block_stop", { index }],
    ];
  }
  return [
    ["content_block_start", { index, content_block: block }],
    ["content_block_stop", { index }],
  ];
}

function answer(res, body, spec) {
  const id = `msg_fake_${nextId++}`;
  const blocks = spec.blocks ?? [
    spec.tool
      ? { type: "tool_use", id: `toolu_fake_${nextId++}`, name: spec.tool.name, input: spec.tool.input ?? {} }
      : { type: "text", text: spec.text ?? "ok" },
  ];
  const stop = spec.tool ? "tool_use" : "end_turn";
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: blocks, stop_reason: stop, stop_sequence: null, usage }));
    return;
  }
  sse(res, [
    ["message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }],
    ...blocks.flatMap(streamed),
    ["message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", {}],
  ]);
}

export async function startFakeAnthropic(reply) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {}
      if (req.method === "POST" && path === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (req.method === "POST" && path === "/v1/messages") {
        const request = summary(body);
        requests.push(request);
        let spec;
        try {
          spec = reply(request) ?? { text: "ok" };
        } catch (e) {
          spec = { text: `the test's script failed: ${e.message}` };
        }
        answer(res, body, spec);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `${req.method} ${path} isn't faked` } }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
