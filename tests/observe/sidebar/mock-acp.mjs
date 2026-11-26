// A mock ACP agent for tests/observe/sidebarlimits.test.mjs. It records what
// the sidebar hands an agent's process, one JSON line per event in LOG:
//   {event: "start", argv, cwd, env}   the process as the sidebar started it
//   {event: "request", method, params} every request the sidebar sends
//   {event: "permission", asked, outcome} the answer to a permission request
// Each line has the process's pid, which tells apart the processes that
// share a LOG (a Codex Work chat has one of its own).
// A prompt whose text holds PERMISSION:<tool> asks the sidebar for
// permission to run <tool> (claude-agent-acp's shape, its tool call first, as
// ensureToolCallEmitted sends it) before it answers.
// One that holds NOTICE starts its answer with a config warning, as
// codex-acp 2.6.0 sends Codex's: a session notice to a client whose
// initialize declared session.notices, else text in the answer. NOTICE:error
// sends an error notice instead (the sidebar), as claude-agent-acp's v2
// sends an API error.
// --no-close: an agent that declares no sessionCapabilities.close.
//   node mock-acp.mjs LOG [--no-close]
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.argv[2];
const NO_CLOSE = process.argv.includes("--no-close");
const log = entry => appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

log({ event: "start", argv: process.argv.slice(2), cwd: process.cwd(), env: process.env });

let nextSession = 1;
let nextId = 1000;
let notices = false; // the client's session.notices capability
const waiting = new Map();

function answer(id, result) {
  send({ id, result });
}

async function ask(sessionId, tool) {
  const id = nextId++;
  const outcome = new Promise(resolve => waiting.set(id, resolve));
  const toolCall = { toolCallId: `t${id}`, title: tool, kind: "execute", rawInput: {}, _meta: { claudeCode: { toolName: tool } } };
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", status: "pending", ...toolCall } } });
  send({
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  // A sidebar that never answers fails the test instead of hanging it.
  const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve(null), 15000))]);
  log({ event: "permission", asked: tool, outcome: result?.outcome ?? null });
  const allowed = result?.outcome?.optionId === "allow";
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: allowed ? "completed" : "failed" } } });
  return result;
}

async function prompt(id, params) {
  const text = (params.prompt ?? []).map(block => block.text ?? "").join(" ");
  const wanted = /PERMISSION:(\S+)/.exec(text);
  let reply = "ok";
  const notice = /\bNOTICE(?::(\w+))?\b/.exec(text);
  if (notice) {
    const severity = notice[1] ?? "warning";
    const [title, description] =
      severity === "error" ? ["API error", "529 Overloaded. Try again in a moment."] : ["`[features].multi_agent` is deprecated."];
    send({
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: notices
          ? { sessionUpdate: "notice", severity, title, ...(description ? { description } : {}) }
          : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Warning: ${title}\n\n` } },
      },
    });
  }
  if (wanted) {
    const result = await ask(params.sessionId, wanted[1]);
    reply = `permission outcome: ${JSON.stringify(result?.outcome ?? null)}`;
  }
  send({
    method: "session/update",
    params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } },
  });
  answer(id, { stopReason: "end_turn" });
}

createInterface({ input: process.stdin }).on("line", line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined) {
    // A response to one of our requests.
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  log({ event: "request", method: message.method, params: message.params });
  switch (message.method) {
    case "initialize": {
      const declared = message.params?.clientCapabilities?.session?.notices;
      notices = typeof declared === "object" && declared !== null && !Array.isArray(declared);
      answer(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, fork: {}, ...(NO_CLOSE ? {} : { close: {} }) } },
        agentInfo: { name: "mock-acp", version: "1" },
      });
      break;
    }
    case "session/new":
    case "session/fork":
      answer(message.id, { sessionId: `mock-${nextSession++}` });
      break;
    case "session/resume":
    case "session/load":
      answer(message.id, {});
      break;
    case "session/prompt":
      prompt(message.id, message.params);
      break;
    case "session/close":
    case "session/cancel":
      if (message.id !== undefined) {
        answer(message.id, {});
      }
      break;
    default:
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: `${message.method} isn't mocked` } });
      }
  }
});
