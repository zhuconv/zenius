#!/usr/bin/env python3
"""A tiny ACP agent for the tests.

    mock_agent.py LOG [--claude] [--slow-start SECONDS]

It writes every message it receives to LOG (one JSON object per line). By
default it looks like codex-acp: settings `model` and `reasoning_effort`, a
system prompt it appends, and sessions it can close, resume (any session id,
as if from a transcript on disk) and fork at a message. With --claude it looks
like claude-agent-acp, minus resuming and forking: settings `model` and
`effort`, and a system prompt it can only replace. --slow-start delays the
answer to `initialize`.

Each message of an answer has an id (`messageId`). Each session's questions
and message ids are kept in LOG.history.json, like transcripts on disk, so a
restarted agent can fork a session too. session/fork takes the fork point the
way both real adapters do, in `_meta.jetbrains.air.fork.messageId`: the new
session has the turns up to the one with that message.

Prompts are answered according to a keyword in the prompt text:

  CRASH       exit at once
  SLOW        stream 60 words, 0.1 s apart, until cancelled
  PERMISSION  ask the client for permission and report the answer
  MARKDOWN    answer with Markdown that also tries to inject a script
  DOCUMENT    answer with a Markdown file and a Python script in code blocks
  TOOL        say something, report a tool call, then answer
  SCENARIO:<name>  (zen-sidebar) a scripted browser task through the real
              `zenius mcp` (MOCK_ZENIUS_MCP, on ZENIUS_INSTANCE), each call
              reported as claude-agent-acp reports an MCP tool call:
              flights, trip, prices, weather (see SCENARIOS)
  BASHSTEP    (zen-sidebar) a Bash call with a description, as Claude Code
              reports `zenius nodejs` before the MCP server
  ECHOTASK:<name>  (zen-sidebar) a shell call that only echoes
              taskSpace("<name>") and open's first sentence for it: no task
              starts, so the chat must stay unlinked
  OPENCUT:<name>  (zen-sidebar) one open through the real `zenius mcp`, with
              <name> as the task's name, its result's name cut at 60
              characters ("…") as an older `zenius mcp` cut it
  OPENASK:<name>  (zen-sidebar) one open with <name> as the task's name,
              then an answer that ends with a question
  QUESTION    (zen-sidebar) an answer that ends with a question
  SUMMARY     (zen-sidebar) a three-point summary of the test article
  HISTORY     list the questions the session had before this one, and the
              number of attached resources
  (anything else)  echo the question, the number of attached resources and
                   the session's model and effort, then the number of
                   images when there are any
"""

import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time

LOG = sys.argv[1]
CLAUDE = "--claude" in sys.argv
SLOW_START = float(sys.argv[sys.argv.index("--slow-start") + 1]) if "--slow-start" in sys.argv else 0
EFFORT = "effort" if CLAUDE else "reasoning_effort"
MODELS = [("opus", "Opus"), ("sonnet", "Sonnet")] if CLAUDE else [("mock-model", "Mock Model"), ("mock-fast", "Mock Fast")]
EFFORTS = ["low", "medium", "high", "xhigh"]
DOCUMENT = (
    "Here is the file:\n\n"
    "```markdown\n# Reading notes: **Mamba**\n\n- selective state spaces\n- `linear` time\n```\n\n"
    "And a script:\n\n"
    "```python\nprint(\"hi\")\n```\n"
)

write_lock = threading.Lock()
sessions = {}  # session id -> {"model": ..., "effort": ...}
cancelled = set()
waiting = {}  # request id -> {"event": Event, "result": ...}
next_id = [1000]
HISTORY = LOG + ".history.json"
history_lock = threading.Lock()
histories = {}  # session id -> [{"question": ..., "messages": [message ids]}]
counters = {"message": 0, "fork": 0}


def load_histories():
    try:
        with open(HISTORY) as f:
            histories.update(json.load(f))
    except (OSError, ValueError):
        pass


def save_histories():
    with open(HISTORY, "w") as f:
        json.dump(histories, f)


def new_message(session):
    """An id for a message of the answer, kept in the session's history."""
    with history_lock:
        counters["message"] += 1
        message = f"m{os.getpid()}-{counters['message']}"
        histories[session][-1]["messages"].append(message)
        save_histories()
    return message


def fork(params):
    """session/fork: the source's turns up to the one with the fork point's
    message. Returns (session, error)."""
    source = params["sessionId"]
    point = (((params.get("_meta") or {}).get("jetbrains") or {}).get("air") or {}).get("fork") or {}
    with history_lock:
        turns = histories.get(source)
        if turns is None:
            return None, {"code": -32002, "message": f"Session {source} not found"}
        if point.get("messageId"):
            end = next((i for i, t in enumerate(turns) if point["messageId"] in t["messages"]), None)
            if end is None:
                return None, {"code": -32602, "message": f"Fork point message {point['messageId']} was not found in session {source}"}
            turns = turns[:end + 1]
        counters["fork"] += 1
        session = f"s{os.getpid()}-f{counters['fork']}"
        histories[session] = json.loads(json.dumps(turns))
        save_histories()
    sessions[session] = dict(sessions.get(source) or {"model": MODELS[0][0], "effort": "low"})
    return session, None


def send(message):
    with write_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def log(message):
    with open(LOG, "a") as f:
        f.write(json.dumps(message) + "\n")


def options(session):
    state = sessions[session]
    return [
        {"id": "mode", "name": "Mode", "type": "select", "currentValue": "default",
         "options": [{"value": "default", "name": "Default"}]},
        {"id": "model", "name": "Model", "type": "select", "currentValue": state["model"],
         "options": [{"value": v, "name": n} for v, n in MODELS]},
        {"id": EFFORT, "name": "Effort", "type": "select", "currentValue": state["effort"],
         "options": [{"value": v, "name": v} for v in EFFORTS]},
    ]


def update(session, data):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": data}})


def say(session, text, size=12, message=None):
    """One message of the answer, streamed in chunks."""
    message = message or new_message(session)
    for i in range(0, len(text), size):
        update(session, {"sessionUpdate": "agent_message_chunk", "messageId": message, "content": {"type": "text", "text": text[i:i + size]}})


# --- zen-sidebar: scripted browser tasks through the real zenius MCP server ------

WWW = os.environ.get("MOCK_WWW", "http://127.0.0.1:47231")
SCENARIOS = {
    "flights": [
        ("say", "On it. I'll search in my own tabs, so you can keep reading."),
        ("tool", "open", {"url": f"{WWW}/flights.html?from=SFO&to=TYO&token=SECRET", "task": "Tokyo flights"}),
        ("tool", "fill", {"element": "From", "target": "#from", "text": "SFO"}),
        ("tool", "fill", {"element": "To", "target": "#to", "text": "Tokyo"}),
        ("hold", "click", {"element": "Search", "target": "#search"}),
    ],
    "trip": [
        ("say", "I'll look at your saved trips first."),
        ("tool", "open", {"url": f"{WWW}/signin.html", "task": "Trip planner"}),
        ("tool", "hand_off", {"message": "Sign in to Accounts so I can see your saved trips."}),
        ("tool", "wait", {"user": True, "seconds": 600}),
        ("say", "Thanks, I'm in."),
    ],
    "prices": [
        ("say", "Checking the camera's price at a few shops."),
        ("tool", "open", {"url": f"{WWW}/shop.html", "task": "Price tracker"}),
        ("tool", "read_page", {}),
        ("hold", "open", {"url": f"{WWW}/shop.html?shop=2"}),
    ],
    "weather": [
        ("tool", "open", {"url": f"{WWW}/article.html", "task": "Weekend reading"}),
        ("tool", "read_page", {}),
        ("tool", "finish", {"keep": ["p1"]}),
        ("say", "Saved the article for the weekend: it's open in your Agents space."),
    ],
}


class Mcp:
    """One `zenius mcp` per session, as a real agent starts its MCP servers."""

    def __init__(self):
        self.proc = subprocess.Popen(
            shlex.split(os.environ["MOCK_ZENIUS_MCP"]),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        self.next = 0
        self.lock = threading.Lock()
        self.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                 "clientInfo": {"name": "claude-code", "version": "0"}})

    def call(self, method, params):
        with self.lock:
            self.next += 1
            ident = self.next
            self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": ident, "method": method, "params": params}) + "\n")
            self.proc.stdin.flush()
            while True:
                line = self.proc.stdout.readline()
                if not line:
                    raise RuntimeError("zenius mcp exited")
                message = json.loads(line)
                if message.get("id") == ident:
                    return message

    def close(self):
        try:
            self.proc.kill()
        except OSError:
            pass


mcps = {}
tool_counter = [0]


def tool_update(session, call_id, full, args, **fields):
    update(session, {"sessionUpdate": "tool_call_update", "toolCallId": call_id,
                     "_meta": {"claudeCode": {"toolName": full}}, **fields})


def run_tool(session, name, args, hold=False, cut_name=None):
    """One MCP tool call, reported as claude-agent-acp reports it. With hold,
    the call shows running until the turn is cancelled. With cut_name, a
    started task's name in the result is cut to that many characters ("…"),
    as an older `zenius mcp` reported it."""
    tool_counter[0] += 1
    call_id = f"toolu_{os.getpid()}_{tool_counter[0]}"
    full = f"mcp__zenius__{name}"
    update(session, {"sessionUpdate": "tool_call", "toolCallId": call_id, "name": full, "title": full,
                     "kind": "other", "status": "pending", "rawInput": args, "content": [],
                     "_meta": {"claudeCode": {"toolName": full}}})
    tool_update(session, call_id, full, args, status="in_progress")
    if hold:
        while session not in cancelled:
            time.sleep(0.1)
        tool_update(session, call_id, full, args, status="failed")
        return False
    mcp = mcps.get(session) or mcps.setdefault(session, Mcp())
    box = {}
    worker = threading.Thread(target=lambda: box.update(r=mcp.call("tools/call", {"name": name, "arguments": args})), daemon=True)
    worker.start()
    while worker.is_alive():
        if session in cancelled:
            mcp.close()
            mcps.pop(session, None)
            tool_update(session, call_id, full, args, status="failed")
            return False
        worker.join(0.1)
    result = (box.get("r") or {}).get("result") or {}
    text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
    failed = bool(result.get("isError"))
    # The server's text is its step line, then what the call did.
    started = re.search(r'^Started the task "(.*?)"\. ', text, re.M)
    if cut_name and started and len(started.group(1)) > cut_name:
        text = text[:started.start()] + f'Started the task "{started.group(1)[:cut_name - 1]}…". ' + text[started.end():]
    shown = f"```\n{text}\n```" if failed else text
    tool_update(session, call_id, full, args, status="failed" if failed else "completed",
                content=[{"type": "content", "content": {"type": "text", "text": shown}}])
    return not failed


def run_scenario(session, name):
    for step in SCENARIOS.get(name, []):
        if session in cancelled:
            return "cancelled"
        kind = step[0]
        if kind == "say":
            say(session, step[1], size=16)
            time.sleep(0.2)
        elif kind == "tool":
            if not run_tool(session, step[1], step[2]) and session in cancelled:
                return "cancelled"
        elif kind == "hold":
            run_tool(session, step[1], step[2], hold=True)
            return "cancelled"
    return "end_turn"


SUMMARY = (
    "1. Every page runs in its own **compartment**, and code reaches another one only through wrappers.\n"
    "2. **Xrays** let the browser read a page's DOM without seeing anything the page's scripts changed.\n"
    "3. **Sandboxes** run code with a page's rights, or fewer, while still seeing through Xrays."
)


def prompt(request):
    session = request["params"]["sessionId"]
    blocks = request["params"]["prompt"]
    text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    resources = [b for b in blocks if b.get("type") == "resource"]
    images = [b for b in blocks if b.get("type") == "image"]
    question = text.strip().splitlines()[-1] if text.strip() else ""
    with history_lock:
        turns = histories.setdefault(session, [])
        earlier = [t["question"] for t in turns]
        turns.append({"question": question, "messages": []})
        save_histories()
    cancelled.discard(session)
    stop = "end_turn"
    if "CRASH" in text:
        os._exit(3)
    elif "SLOW" in text:
        message = new_message(session)
        for i in range(60):
            if session in cancelled:
                stop = "cancelled"
                break
            say(session, f"word{i} ", message=message)
            time.sleep(0.1)
    elif "HISTORY" in text:
        say(session, f"History: {' / '.join(earlier) or '(none)'} | resources={len(resources)}")
    elif "PERMISSION" in text:
        next_id[0] += 1
        rid = next_id[0]
        waiting[rid] = {"event": threading.Event()}
        send({
            "jsonrpc": "2.0", "id": rid, "method": "session/request_permission",
            "params": {
                "sessionId": session,
                "toolCall": {"toolCallId": "t1", "title": "Run `ls`", "kind": "execute"},
                "options": [
                    {"optionId": "allow", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "deny", "name": "Deny", "kind": "reject_once"},
                ],
            },
        })
        waiting[rid]["event"].wait(30)
        say(session, "permission outcome: " + json.dumps(waiting.pop(rid).get("result")))
    elif "MARKDOWN" in text:
        say(session, (
            "## Heading\n\n- item **bold**\n\n`inline`\n\n```py\nprint(1)\n```\n\n"
            "[a link](https://example.com/from-answer)\n\n"
            "<script>window.pwned = 1</script><img src=x onerror=\"window.pwned = 2\">"
        ), size=20)
    elif "DOCUMENT" in text:
        say(session, DOCUMENT, size=20)
    elif "SCENARIO:" in text:
        name = text.split("SCENARIO:", 1)[1].split()[0].strip(" .")
        stop = run_scenario(session, name)
    elif "BASHSTEP" in text:
        say(session, "Opening the flight search.")
        update(session, {"sessionUpdate": "tool_call", "toolCallId": "b1", "name": "Bash", "title": "zenius nodejs <<'EOF'",
                         "kind": "execute", "status": "in_progress",
                         "rawInput": {"command": "zenius nodejs <<'EOF'\nconst task = await taskSpace(\"Bash flights\");\nawait task.page(\"p1\").goto(\"https://flights.example.com\");\nEOF",
                                      "description": "Open the flight search"},
                         "_meta": {"claudeCode": {"toolName": "Bash"}}})
        time.sleep(0.3)
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "b1", "status": "completed",
                         "content": [{"type": "content", "content": {"type": "text", "text": "ok"}}]})
        say(session, "The search page is open.")
    elif "ECHOTASK:" in text:
        name = text.split("ECHOTASK:", 1)[1].split("\n")[0].strip()
        command = f"echo 'taskSpace(\"{name}\")'; echo 'Started the task \"{name}\". Opened p1'"
        update(session, {"sessionUpdate": "tool_call", "toolCallId": "e1", "name": "Bash", "title": command,
                         "kind": "execute", "status": "in_progress",
                         "rawInput": {"command": command, "description": "Echo a task's name"},
                         "_meta": {"claudeCode": {"toolName": "Bash"}}})
        time.sleep(0.3)
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "e1", "status": "completed",
                         "content": [{"type": "content", "content": {"type": "text",
                                      "text": f'taskSpace("{name}")\nStarted the task "{name}". Opened p1'}}]})
        say(session, "Echoed.")
    elif "OPENASK:" in text:
        name = text.split("OPENASK:", 1)[1].split("\n")[0].strip()
        if run_tool(session, "open", {"url": f"{WWW}/article.html", "task": name}):
            say(session, "I found two nonstop flights under $900. Do you want the morning one or the evening one?")
    elif "OPENCUT:" in text:
        name = text.split("OPENCUT:", 1)[1].split("\n")[0].strip()
        if run_tool(session, "open", {"url": f"{WWW}/article.html", "task": name}, cut_name=60):
            say(session, "The page is open.")
    elif "QUESTION" in text:
        say(session, "I found two nonstop flights under $900. Do you want the morning one or the evening one?")
    elif "SUMMARY" in text:
        say(session, SUMMARY, size=24)
    elif "TOOL" in text:
        say(session, "before the tool")
        update(session, {"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "Searching the web", "kind": "search", "status": "in_progress"})
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed"})
        say(session, "after the tool")
    else:
        update(session, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}})
        state = sessions[session]
        extra = f" | images={len(images)}" if images else ""
        say(session, f"Echo: {question} | resources={len(resources)} | model={state['model']} effort={state['effort']}{extra}")
    send({"jsonrpc": "2.0", "id": request["id"], "result": {"stopReason": stop}})


load_histories()
for line in sys.stdin:
    message = json.loads(line)
    log(message)
    method = message.get("method")
    if method and "id" in message:
        if method == "initialize":
            time.sleep(SLOW_START)
            if CLAUDE:
                session_caps = {"systemPrompt": {"mode": {"override": {}}}, "close": {}}
            else:
                session_caps = {"systemPrompt": {}, "close": {}, "resume": {}, "fork": {}}
            send({"jsonrpc": "2.0", "id": message["id"], "result": {
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": not CLAUDE,
                    "promptCapabilities": {"embeddedContext": True, "image": True},
                    "sessionCapabilities": session_caps,
                },
                "authMethods": [],
                "agentInfo": {"name": "mock-claude" if CLAUDE else "mock-codex", "version": "0"},
            }})
        elif method == "session/new":
            if CLAUDE and "systemPrompt" in message["params"]:
                send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32602, "message": "systemPrompt: only override is supported"}})
                continue
            # Unique across restarts, as real session ids are.
            session = f"{'c' if CLAUDE else 's'}{os.getpid()}-{len(sessions) + 1}"
            sessions[session] = {"model": MODELS[0][0], "effort": "xhigh" if CLAUDE else "low"}
            with history_lock:
                histories[session] = []
                save_histories()
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"sessionId": session, "configOptions": options(session)}})
        elif method == "session/fork" and not CLAUDE:
            session, error = fork(message["params"])
            if error:
                send({"jsonrpc": "2.0", "id": message["id"], "error": error})
            else:
                send({"jsonrpc": "2.0", "id": message["id"], "result": {"sessionId": session, "configOptions": options(session)}})
        elif method == "session/resume" and not CLAUDE:
            session = message["params"]["sessionId"]
            sessions.setdefault(session, {"model": MODELS[0][0], "effort": "low"})
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"configOptions": options(session)}})
        elif method == "session/set_config_option":
            params = message["params"]
            state = sessions[params["sessionId"]]
            state["model" if params["configId"] == "model" else "effort"] = params["value"]
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"configOptions": options(params["sessionId"])}})
        elif method == "session/prompt":
            threading.Thread(target=prompt, args=(message,), daemon=True).start()
        elif method == "session/close":
            send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
        else:
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": f"{method} not supported"}})
    elif method == "session/cancel":
        cancelled.add(message["params"]["sessionId"])
    elif "id" in message and message["id"] in waiting:
        waiting[message["id"]]["result"] = message.get("result")
        waiting[message["id"]]["event"].set()
