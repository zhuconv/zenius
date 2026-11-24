// The agent sidebar fixture's mock agent with MOCK_ROUTES, which renders use so that a user's message
// reads as a user writes it: a message that is exactly one of the routes' messages acts on its keyword.
// The mock runs as the sidebar runs it, over stdio, with no browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const MOCK = new URL("../fixtures/agent-sidebar/mock_agent.py", import.meta.url).pathname;
const ASKED = "Find a nonstop flight for Friday";
// The mock's QUESTION answer.
const QUESTION = "I found two nonstop flights under $900. Do you want the morning one or the evening one?";

/** A mock agent with these routes (none when null), and one session. */
async function mock(routes) {
  const dir = mkdtempSync(join(tmpdir(), "zenius-mock-routes-"));
  const env = { ...process.env };
  delete env.MOCK_ROUTES;
  if (routes) env.MOCK_ROUTES = JSON.stringify(routes);
  const child = spawn("python3", [MOCK, join(dir, "mock.log")], { env, stdio: ["pipe", "pipe", "inherit"] });
  const answers = new Map();
  const chunks = [];
  let rest = "";
  let id = 0;
  child.stdout.on("data", data => {
    rest += data;
    let end;
    while ((end = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, end).trim();
      rest = rest.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "session/update" && message.params.update.sessionUpdate === "agent_message_chunk") {
        chunks.push(message.params.update.content.text);
      } else if (message.id !== undefined && !message.method) {
        answers.get(message.id)?.(message);
      }
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10000);
      answers.set(n, message => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const session = (await call("session/new", { cwd: dir, mcpServers: [] })).result.sessionId;
  return {
    /** The answer's words to a prompt of these text blocks. */
    async ask(...texts) {
      chunks.length = 0;
      const done = await call("session/prompt", { sessionId: session, prompt: texts.map(text => ({ type: "text", text })) });
      assert.equal(done.result?.stopReason, "end_turn", JSON.stringify(done));
      return chunks.join("");
    },
    close() {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a message that is exactly one of MOCK_ROUTES' messages acts on its keyword; any other is answered as before", async () => {
  const agent = await mock({ [ASKED]: "QUESTION" });
  try {
    assert.equal(await agent.ask(ASKED), QUESTION);
    // Its own text block, after another (zenius's note before a send's words, for one).
    assert.equal(await agent.ask("<zenius-note>\nA note.\n</zenius-note>", ASKED), QUESTION);
    // Only the whole message: one more word, and it's an ordinary message.
    assert.match(await agent.ask(`${ASKED}, please`), new RegExp(`^Echo: ${ASKED}, please \\|`));
    // The session keeps the user's words as its questions, not the keyword.
    assert.match(await agent.ask("HISTORY"), new RegExp(`^History: ${ASKED} / ${ASKED} / ${ASKED}, please \\|`));
  } finally {
    agent.close();
  }
});

test("without MOCK_ROUTES, the same message is an ordinary one", async () => {
  const agent = await mock(null);
  try {
    assert.match(await agent.ask(ASKED), new RegExp(`^Echo: ${ASKED} \\|`));
  } finally {
    agent.close();
  }
});
