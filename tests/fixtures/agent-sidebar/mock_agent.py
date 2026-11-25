#!/usr/bin/env python3
"""A tiny ACP agent for the tests.

    mock_agent.py LOG [--claude] [--uuid] [--slow-start SECONDS] [--no-steer]

It writes every message it receives to LOG (one JSON object per line). By
default it looks like codex-acp: settings `model` and `reasoning_effort`, a
system prompt it appends, and sessions it can close, resume (any session id,
as if from a transcript on disk) and fork at a message. With --claude it looks
like claude-agent-acp, minus resuming and forking: settings `model` and
`effort`, and a system prompt it can only replace. --uuid gives sessions
claude-agent-acp's ids (random UUIDs), which Chat's lists of URLs it may
fetch go by, and with --claude it forks too, as claude-agent-acp does.
--slow-start delays the answer to `initialize`. MOCK_MODELS in its
environment replaces its models, as [[value, name, description?], ...].
It refuses a model it doesn't list, as both adapters do (zen-sidebar).

It takes `_session/steering` as both real adapters do (claude-agent-acp
0.107.0, codex-acp 2.6.0), advertised in initialize's `_meta.steering`: a
steer during a SLOW answer joins the turn. The message it cut gets one more
word, which reaches the client after the steer every run, as a real agent's
words still on their way do; then the turn answers the steer in a message of
its own ("Steered: ...") and ends. With no turn running it answers
{outcome: "promptRequired"} (the client's `idleBehavior` opt-in). A steer
whose text holds RACE meets the turn's end, as a real one can:
promptRequired, and the turn ends at once.
--no-steer makes it an agent without steering (zen-sidebar).

Each message of an answer has an id (`messageId`). Each session's questions
and message ids are kept in LOG.history.json, like transcripts on disk, so a
restarted agent can fork a session too. session/fork takes the fork point the
way both real adapters do, in `_meta.jetbrains.air.fork.messageId`: the new
session has the turns up to the one with that message.

MOCK_ROUTES, a JSON object of {message: keyword} (zen-eval's renders), lets a
message read as a user writes it: a text block that is exactly one of its
messages acts on that message's keyword too, as if the keyword came first in
the prompt, so a screenshot of the chat shows no keyword. The session still
keeps the user's words as the question.

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
              flights, trip, prices, weather, handsteer (see SCENARIOS).
              handsteer hands off, then waits for the user; a steer moves
              the running wait to the background as Claude Code 2.1.286
              and later does (issue #3): the call ends at once with Claude
              Code's words, its wait goes on in the server, and the agent
              answers the steer by asking again. When that wait ends (the
              user's Resume agent), Claude Code goes on in a cycle of its
              own, with no prompt open, as claude-agent-acp 0.107.0
              streams one: a message, then a read_page. handsteer-end is the
              same hand-off as Claude Code runs it with its MCP calls kept in
              the foreground (CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0): the steer
              interrupts the wait with Claude Code's words (MESSAGE_ENDED)
              while the server's wait goes on, and inside the same turn the agent
              answers, waits again, and goes on once the user resumes it
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
  FAILLATER   (zen-sidebar) stream 5 words, then fail the prompt (an error)
  HOLDBARE    (zen-sidebar) a zenius click that runs until Stop, then ends
              failed with no result at all, as codex-acp may when Codex gives
              the interrupted call none
  FAILBARE    (zen-sidebar) a zenius click that fails at once with no result,
              then a short answer
  ASKSTEER    (zen-sidebar) ask for permission to run a zenius tool (a Work
              chat shows the card), then answer with its outcome and the
              steer that came with the reply ("Steered: ...")
  HOLDTURN    (zen-ux) one word, then the turn waits until Stop (a minute
              at most): the agent asks in the middle of it
  THINKTITLES (zen-sidebar) Codex at a high effort: a reasoning title, a
              second later another, a second later the answer
  THINKMUTE   (zen-sidebar) Claude Code, whose thinking shows no words: two
              seconds with nothing, then the answer
  THINKSTOP   (zen-sidebar) a reasoning title, then it thinks until Stop
              (a minute at most)
  THINKSEARCH (zen-sidebar) a reasoning title, a ToolSearch call (a step
              the sidebar hides), then the answer a second later
  THINKAGAIN  (zen-ux) a reasoning title for a second, a word, then another
              title for a second, another word, then the turn waits until
              Stop (a minute at most): a wait after the first words
  THINKCLAUDE (zen-sidebar) Claude Code with summarized thinking, which
              thinks between parts of its answer: a short summary and the
              first part, then summaries in prose paragraphs (the second
              arrives in two pieces) over two seconds, then the rest
  THINKSTEPS  (zen-sidebar) a step, then a reasoning title while it thinks
              about the step's result, a second later another step, then
              the answer
  THINKPARTS  (zen-sidebar) an answer in three parts, with 1.5 s of
              thinking in words between them; the first part has a code
              block, the second the answer's first heading
  THINKLONG   (zen-sidebar) Claude Code's summary of a long sentence, then
              it thinks until Stop (a minute at most)
  OPENSTAY:<name>  (zen-ux) one open with <name> as the task's name, the
              task and its tab left open
  READAGAIN   (zen-ux) one read_page with no open before it: it reads the
              task the session's server has, if any
  QUESTION    (zen-sidebar) an answer that ends with a question
  CHOICES     (zen-sidebar) a question, its choices as a numbered list, then
              a closing line over 80 characters (zen-eval's retake,
              2026-11-22, word for word)
  SUMMARY     (zen-sidebar) a three-point summary of the test article
  HISTORY     list the questions the session had before this one, and the
              number of attached resources
  ASKFORM     (zen-sidebar) Claude Code's AskUserQuestion as claude-agent-acp
              sends it: its tool call, then elicitation/create with one
              single-pick question (options with descriptions) and its
              question_0_custom box; then "ask outcome: <the answer>"
  ASKMULTI    (zen-sidebar) the same with two questions, the second a
              several-pick
  ASKOTP      (zen-sidebar) the same for a verification code, with the two
              options Claude offers beside its box (AskUserQuestion takes 2
              to 4): "I'll type it" and "No code yet"
              With QUIET too, any ask's outcome isn't said back: the answer
              is "Thanks, I have your answer." (zen-sidebar, for Chat's
              saved threads)
  ASKCODEX    (zen-sidebar) Codex's request_user_input as codex-acp sends it:
              its generic message, a question with "None of the above" and
              its note field, and a secret question
  ASKWITHDRAW (zen-sidebar) ASKCODEX's request, withdrawn after 0.5 s with
              $/cancel_request, as codex-acp does when its timeout passes
  ASKMCP      (zen-sidebar) an MCP server's own form: a number, a yes or no,
              an enum with names, and words
  ASKODD      (zen-sidebar) an MCP server's form with an object field
  ASKURL      (zen-sidebar) an MCP server's url-mode elicitation
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
import uuid

LOG = sys.argv[1]
CLAUDE = "--claude" in sys.argv
UUID = "--uuid" in sys.argv
STEER = "--no-steer" not in sys.argv
SLOW_START = float(sys.argv[sys.argv.index("--slow-start") + 1]) if "--slow-start" in sys.argv else 0
EFFORT = "effort" if CLAUDE else "reasoning_effort"
MODELS = [("opus", "Opus"), ("sonnet", "Sonnet")] if CLAUDE else [("mock-model", "Mock Model"), ("mock-fast", "Mock Fast")]
# A test's own list, as [[value, name, description?], ...] (the model picker's
# generations; claude-agent-acp names its "default" model in the description).
if os.environ.get("MOCK_MODELS"):
    MODELS = [tuple(m) for m in json.loads(os.environ["MOCK_MODELS"])]
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
        session = str(uuid.uuid4()) if UUID else f"s{os.getpid()}-f{counters['fork']}"
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
         "options": [{"value": m[0], "name": m[1], **({"description": m[2]} if len(m) > 2 else {})} for m in MODELS]},
        {"id": EFFORT, "name": "Effort", "type": "select", "currentValue": state["effort"],
         "options": [{"value": v, "name": v} for v in EFFORTS]},
    ]


def update(session, data):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": data}})


def thought(session, text):
    """A chunk of the agent's thinking, as codex-acp sends Codex's reasoning summary."""
    update(session, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": text}})


def say(session, text, size=12, message=None):
    """One message of the answer, streamed in chunks."""
    message = message or new_message(session)
    for i in range(0, len(text), size):
        update(session, {"sessionUpdate": "agent_message_chunk", "messageId": message, "content": {"type": "text", "text": text[i:i + size]}})


# --- zen-sidebar: scripted browser tasks through the real zenius MCP server ------

WWW = os.environ.get("MOCK_WWW", "http://127.0.0.1:47231")
# zen-eval's renders: {message: keyword} (MOCK_ROUTES, in the docstring).
ROUTES = json.loads(os.environ.get("MOCK_ROUTES") or "{}")
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
        ("tool", "hand_off", {"message": "Sign in to Accounts so I can see your saved trips.", "reason": "sign_in"}),
        ("tool", "wait", {"user": True, "seconds": 600}),
        ("say", "Thanks, I'm in."),
    ],
    "handsteer": [
        ("say", "I'll look at your saved trips first."),
        ("tool", "open", {"url": f"{WWW}/signin.html", "task": "Trip planner"}),
        ("tool", "hand_off", {"message": "Sign in to Accounts with your work account, not the personal one, then press Resume agent so I can read your saved trips.",
                              "reason": "other"}),
        ("background", "wait", {"user": True, "seconds": 600}, [
            ("say", "Thanks, you're signed in. Reading your saved trips now."),
            ("tool", "read_page", {}),
        ]),
        ("answer", "Please sign in to Accounts in the Trip planner tab, then press Resume agent in Zen so I can see your saved trips."),
    ],
    "handsteer-end": [
        ("say", "I'll look at your saved trips first."),
        ("tool", "open", {"url": f"{WWW}/signin.html", "task": "Trip planner"}),
        ("tool", "hand_off", {"message": "Sign in to Accounts with your work account, not the personal one, then press Resume agent so I can read your saved trips.",
                              "reason": "other"}),
        ("ends", "wait", {"user": True, "seconds": 600}),
        ("answer", "Your work account: the one you use for the office. Sign in with it, then press Resume agent."),
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
    # The agent's code hooks the page (a style sheet), so zenius loads it
    # afresh when finish ends the task (pagesReloaded).
    "reloadend": [
        ("tool", "open", {"url": f"{WWW}/article.html", "task": "Article check"}),
        ("tool", "evaluate", {"code": "() => { document.head.append(document.createElement('style')); return 1; }"}),
        ("tool", "finish", {"keep": ["p1"]}),
        ("say", "Checked the article: it's open in your Agents space."),
    ],
}


def zenius_spec(params):
    """How a session starts its zenius server, as the real adapters take it
    (zen-ux, for the resumed Work chat on Codex): the session's own ACP
    mcpServers entry named zenius, which both adapters start, from
    session/new, load, resume or fork; else, as codex-acp does, CODEX_CONFIG's
    mcp_servers.zenius, which every session of the process shares; else
    None, and Mcp falls back to MOCK_ZENIUS_MCP, for a mock dressed as
    neither."""
    for server in (params or {}).get("mcpServers") or []:
        if server.get("name") == "zenius" and server.get("command"):
            env = {e["name"]: e["value"] for e in server.get("env") or [] if "name" in e}
            return [server["command"], *(server.get("args") or [])], env
    if not CLAUDE:
        try:
            own = (json.loads(os.environ.get("CODEX_CONFIG") or "{}").get("mcp_servers") or {}).get("zenius")
        except ValueError:
            own = None
        if own and own.get("enabled", True) and own.get("command"):
            return [own["command"], *(own.get("args") or [])], {k: str(v) for k, v in (own.get("env") or {}).items()}
    return None


# Each session's zenius server, as its last session/new, load, resume or
# fork gave it.
zenius_specs = {}


class Mcp:
    """One `zenius mcp` per session, as a real agent starts its MCP servers.
    It goes when its session closes, or with the process."""

    def __init__(self, spec=None):
        argv, env = spec or (shlex.split(os.environ["MOCK_ZENIUS_MCP"]), {})
        self.proc = subprocess.Popen(
            argv, env={**os.environ, **env},
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


# How claude-agent-acp 0.107.0 ends a call that a cancel cut short.
CANCELLED_CALL = {"content": [{"type": "content", "content": {"type": "text",
                  "text": "The turn was cancelled before this tool call returned a result."}}]}

# How claude-agent-acp 0.107.0 ends a running MCP call that a steered message
# interrupted, when Claude Code 2.1.332 keeps the call in the foreground
# (CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0), as a real run showed: failed, Claude
# Code's text fenced, the kind in _meta. Claude Code sends the server
# notifications/cancelled; zenius's server takes it only after the call, so
# the call goes on there.
MESSAGE_ENDED = ("The tool call was interrupted before a result was received. It may or may not have completed "
                 "on the server \u2014 verify before assuming it succeeded, and retry if needed.")

# How Claude Code answers a running MCP call that a steered message moved to
# the background, word for word as the user's daily got it (issue #3); the
# call goes on in the server.
BACKGROUNDED = ('MCP tool "zenius/{name}" was moved to the background as task {task} so that a message that arrived '
                "while it was running can reach you; it was not interrupted and keeps running; you'll receive a "
                "notification with the result when it completes.")


def run_tool(session, name, args, hold=False, cut_name=None, bare=False, background=False, then=(), ends=False):
    """One MCP tool call, reported as claude-agent-acp reports it. With hold,
    the call shows running until the turn is cancelled, then ends as
    claude-agent-acp ends a cut call (with bare, with no result at all). With
    cut_name, a started task's name in the result is cut to that many
    characters ("…"), as an older `zenius mcp` reported it. With background,
    a steer while the call runs ends it at once with Claude Code's words
    (BACKGROUNDED), and the call goes on in the server; when it ends there,
    the steps of `then` run as Claude Code's own cycle (run_cycle). With
    ends, a steer ends the call at once as failed with MESSAGE_ENDED, and the
    call goes on in the server."""
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
        tool_update(session, call_id, full, args, status="failed", **({} if bare else CANCELLED_CALL))
        return False
    mcp = mcps.get(session) or mcps.setdefault(session, Mcp(zenius_specs.get(session)))
    box = {}
    worker = threading.Thread(target=lambda: box.update(r=mcp.call("tools/call", {"name": name, "arguments": args})), daemon=True)
    worker.start()
    while worker.is_alive():
        if session in cancelled:
            mcp.close()
            mcps.pop(session, None)
            tool_update(session, call_id, full, args, status="failed", **CANCELLED_CALL)
            return False
        if ends and steers.get(session):
            tool_update(session, call_id, full, args, status="failed",
                        content=[{"type": "content", "content": {"type": "text", "text": f"```\n{MESSAGE_ENDED}\n```"}}],
                        _meta={"claudeCode": {"toolName": full, "nonExecutionKind": "interrupted"}})
            return False
        if background and steers.get(session):
            text = BACKGROUNDED.format(name=name, task=f"b{tool_counter[0]}x7k2")
            tool_update(session, call_id, full, args, status="completed",
                        content=[{"type": "content", "content": {"type": "text", "text": text}}])
            threading.Thread(target=run_cycle, args=(session, worker, list(then)), daemon=True).start()
            return True
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


def run_cycle(session, call, steps):
    """Claude Code's own cycle: once a call it moved to the background ends
    in the server (`call`, its thread), its notification starts a model
    cycle that no prompt asked for, and claude-agent-acp 0.107.0 streams its
    updates with no turn open (startAutonomousCycle)."""
    call.join()
    # A session closed meanwhile took its server with it: nothing goes on.
    if session in cancelled or session not in mcps:
        return
    for step in steps:
        if step[0] == "say":
            say(session, step[1], size=16)
            time.sleep(0.2)
        elif step[0] == "tool":
            run_tool(session, step[1], step[2])
    # Claude Code's result ends the cycle: claude-agent-acp sends its
    # usage_update, with the cycle's origin.
    update(session, {
        "sessionUpdate": "usage_update",
        "used": 1000,
        "size": 200000,
        "_meta": {"_claude/origin": {"kind": "task-notification"}},
    })


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
        elif kind == "ends":
            run_tool(session, step[1], step[2], ends=True)
            if session in cancelled:
                return "cancelled"
        elif kind == "background":
            then = step[3] if len(step) > 3 else ()
            if not run_tool(session, step[1], step[2], background=True, then=then) and session in cancelled:
                return "cancelled"
        elif kind == "answer":
            # The agent takes the steer that reached it, and answers.
            steers.pop(session, None)
            say(session, step[1], size=16)
    return "end_turn"


SUMMARY = (
    "1. Every page runs in its own **compartment**, and code reaches another one only through wrappers.\n"
    "2. **Xrays** let the browser read a page's DOM without seeing anything the page's scripts changed.\n"
    "3. **Sandboxes** run code with a page's rights, or fewer, while still seeing through Xrays."
)


# Steering (zen-sidebar): the sessions with a turn running, the steers that
# joined each one, and those whose turn ends at once (RACE).
running = set()
steers = {}
finish_now = set()

# --- zen-sidebar: the agent's own ask (elicitation/create) ------------------------

ASK_CHOICES = [
    {"const": "Nara", "title": "Nara", "description": "Deer park and temples"},
    {"const": "Uji", "title": "Uji", "description": "Tea and the Byodo-in"},
]
ASK_CUSTOM = {"type": "string", "title": "Other",
              "description": "Type your own answer, or add a note to the option you chose above (optional)."}
CODEX_ASK = {
    "mode": "form",
    "message": "Codex needs your input to continue.",
    "requestedSchema": {"type": "object", "properties": {
        "trip": {"title": "Which day trip do you want?", "description": "Day trip",
                 "_meta": {"codex": {"isOther": True, "isSecret": False}}, "type": "string",
                 "oneOf": ASK_CHOICES + [{"const": "None of the above", "title": "None of the above",
                                          "description": "Provide a different answer in the note field."}]},
        "trip_note": {"type": "string", "title": "Additional answer or note",
                      "_meta": {"codex": {"questionId": "trip", "role": "user_note", "isSecret": False}}},
        "code": {"title": "What's your booking code?", "description": "Code",
                 "_meta": {"codex": {"isOther": False, "isSecret": True}}, "type": "string"},
    }, "required": ["trip", "code"]},
    "_meta": {"codex": {"autoResolutionMs": None}},
}
# Each: the tool call that shows first (claude-agent-acp's), the request's
# toolCallId (codex-acp's is Codex's item, with no tool call), the request.
ASKS = {
    "ASKFORM": {"tool": "AskUserQuestion", "request": {
        "mode": "form",
        "message": "Which day trip do you want?",
        "requestedSchema": {"type": "object", "properties": {
            "question_0": {"type": "string", "title": "Day trip", "oneOf": ASK_CHOICES},
            "question_0_custom": ASK_CUSTOM,
        }},
    }},
    "ASKMULTI": {"tool": "AskUserQuestion", "request": {
        "mode": "form",
        "message": "Please answer the following questions.",
        "requestedSchema": {"type": "object", "properties": {
            "question_0": {"type": "string", "title": "Day trip", "description": "Which day trip do you want?", "oneOf": ASK_CHOICES},
            "question_0_custom": ASK_CUSTOM,
            "question_1": {"type": "array", "title": "Plans", "description": "What should the day include?", "items": {"anyOf": [
                {"const": "Temples", "title": "Temples"},
                {"const": "Food", "title": "Food", "description": "A lunch spot"},
                {"const": "Shopping", "title": "Shopping"},
            ]}},
            "question_1_custom": dict(ASK_CUSTOM, description="Type your own answer to add to your selection above (optional)."),
        }},
    }},
    "ASKOTP": {"tool": "AskUserQuestion", "request": {
        "mode": "form",
        "message": "What's the verification code from your email?",
        "requestedSchema": {"type": "object", "properties": {
            "question_0": {"type": "string", "title": "Code", "oneOf": [
                {"const": "I'll type it", "title": "I'll type it", "description": "Type the code in the box below"},
                {"const": "No code yet", "title": "No code yet", "description": "The email hasn't come yet"},
            ]},
            "question_0_custom": ASK_CUSTOM,
        }},
    }},
    "ASKCODEX": {"call": "call_codex_ask", "request": CODEX_ASK},
    "ASKWITHDRAW": {"call": "call_codex_ask", "withdraw": True,
                    "request": dict(CODEX_ASK, _meta={"codex": {"autoResolutionMs": 500}})},
    "ASKMCP": {"request": {
        "mode": "form",
        "message": "Confirm the booking details.",
        "requestedSchema": {"type": "object", "properties": {
            "seats": {"type": "integer", "title": "Seats"},
            "window": {"type": "boolean", "title": "Window seat?"},
            "cabin": {"type": "string", "title": "Cabin", "enum": ["economy", "business"], "enumNames": ["Economy", "Business"]},
            "note": {"type": "string", "title": "A note for the airline"},
        }, "required": ["seats"]},
    }},
    "ASKODD": {"request": {
        "mode": "form",
        "message": "Where to?",
        "requestedSchema": {"type": "object", "properties": {"place": {"type": "object", "title": "Place"}}},
    }},
    "ASKURL": {"request": {"mode": "url", "message": "Sign in to continue.", "url": "https://example.com/signin", "elicitationId": "e1"}},
}


def ask(session, keyword, quiet=False):
    """Ask the client as an adapter does, then say what came back, or with
    `quiet` only that something did: an agent that keeps the answer to
    itself, as one does with a code."""
    spec = ASKS[keyword]
    next_id[0] += 1
    rid = next_id[0]
    request = dict(spec["request"], sessionId=session)
    call = spec.get("call") or (f"ask{rid}" if spec.get("tool") else None)
    if call:
        request["toolCallId"] = call
    if spec.get("tool"):
        update(session, {"sessionUpdate": "tool_call", "toolCallId": call, "title": spec["tool"], "kind": "other",
                         "status": "pending", "rawInput": {}, "_meta": {"claudeCode": {"toolName": spec["tool"]}}})
    waiting[rid] = {"event": threading.Event()}
    send({"jsonrpc": "2.0", "id": rid, "method": "elicitation/create", "params": request})
    if spec.get("withdraw"):
        time.sleep(0.5)
        waiting.pop(rid, None)
        send({"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"requestId": rid}})
        say(session, "ask withdrawn")
        return "end_turn"
    waiting[rid]["event"].wait(30)
    result = waiting.pop(rid).get("result")
    if spec.get("tool"):
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": call, "status": "completed"})
    if quiet:
        say(session, "Thanks, I have your answer." if (result or {}).get("action") == "accept" else "No answer, then.")
    else:
        say(session, "ask outcome: " + json.dumps(result, sort_keys=True), size=400)
    return "cancelled" if session in cancelled else "end_turn"


def prompt(request):
    session = request["params"]["sessionId"]
    blocks = request["params"]["prompt"]
    text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    # MOCK_ROUTES: a message that is exactly one of its messages acts on that one's keyword, put first, so
    # the question (the text's last line) stays the user's words.
    keys = [str(ROUTES[b["text"].strip()]) for b in blocks if b.get("type") == "text" and b.get("text", "").strip() in ROUTES]
    if keys:
        text = "\n".join(keys + [text])
    resources = [b for b in blocks if b.get("type") == "resource"]
    images = [b for b in blocks if b.get("type") == "image"]
    question = text.strip().splitlines()[-1] if text.strip() else ""
    with history_lock:
        turns = histories.setdefault(session, [])
        earlier = [t["question"] for t in turns]
        turns.append({"question": question, "messages": []})
        save_histories()
    cancelled.discard(session)
    finish_now.discard(session)
    steers.pop(session, None)
    running.add(session)
    stop = "end_turn"
    if "CRASH" in text:
        os._exit(3)
    elif "THINKTITLES" in text:
        thought(session, "**Reading the paper**")
        time.sleep(1.0)
        thought(session, "\n\n**Weighing the sections**")
        time.sleep(1.0)
        say(session, "Here is the answer.")
    elif "THINKMUTE" in text:
        time.sleep(2.0)
        say(session, "Here is the answer.")
    elif "THINKSEARCH" in text:
        thought(session, "**Finding the right tool**")
        update(session, {"sessionUpdate": "tool_call", "toolCallId": "search1", "title": "ToolSearch", "kind": "other", "status": "completed",
                         "_meta": {"claudeCode": {"toolName": "ToolSearch"}}})
        time.sleep(1.2)
        say(session, "Here is the answer.")
    elif "THINKAGAIN" in text:
        # zen-ux: the first wait has its row; a later one only the status.
        thought(session, "**Reading the paper**")
        time.sleep(1.2)
        say(session, "word0 ")
        thought(session, "\n\n**Checking again**")
        time.sleep(1.2)
        say(session, "word1 ")
        for _ in range(600):
            if session in cancelled:
                stop = "cancelled"
                break
            time.sleep(0.1)
    elif "THINKCLAUDE" in text:
        for piece in ("I'll start with ", "the small cases.\n\n"):
            thought(session, piece)
        message = new_message(session)
        say(session, "Here's the first part.", message=message)
        time.sleep(0.5)
        for piece in ("I'm checking the roots ", "for 41 and 43 now. ", "Then 47.\n\n", "I'm testing 167 by"):
            thought(session, piece)
        time.sleep(1.5)
        thought(session, " hand, since it splits.\n\n")
        time.sleep(1.0)
        say(session, "And here's the rest.", message=message)
    elif "THINKSTEPS" in text:
        update(session, {"sessionUpdate": "tool_call", "toolCallId": "steps1", "title": "Searching the web", "kind": "search", "status": "in_progress"})
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "steps1", "status": "completed"})
        thought(session, "**Comparing the results**")
        time.sleep(1.2)
        update(session, {"sessionUpdate": "tool_call", "toolCallId": "steps2", "title": "Fetching the page", "kind": "fetch", "status": "in_progress"})
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "steps2", "status": "completed"})
        say(session, "Here's what I found.")
    elif "THINKPARTS" in text:
        message = new_message(session)
        say(session, "Part one.\n\n```sh\necho one\n```", message=message)
        for part, words in (("second", "## Part two\n\nThe middle."), ("third", "Part three.")):
            thought(session, f"I'm weighing the {part} part.\n\n")
            time.sleep(1.5)
            say(session, words, message=message)
    elif "THINKLONG" in text:
        thought(session, "I'm checking the roots for 41, 43, 47, 53 and 61 now, listing the n values in range that each prime divides, "
                         "and skipping n=1 for 43 since f(1) is itself prime.\n\n")
        for _ in range(600):
            if session in cancelled:
                stop = "cancelled"
                break
            time.sleep(0.1)
    elif "THINKSTOP" in text:
        thought(session, "**Reading the paper**")
        for _ in range(600):
            if session in cancelled:
                stop = "cancelled"
                break
            time.sleep(0.1)
    elif "HOLDTURN" in text:
        # zen-ux: a turn that stays open, for what the panel shows while
        # the agent waits on the user (its own question).
        say(session, "word0 ", message=new_message(session))
        for _ in range(600):
            if session in cancelled:
                stop = "cancelled"
                break
            time.sleep(0.1)
    elif "SLOW" in text:
        message = new_message(session)
        for i in range(60):
            if session in cancelled:
                stop = "cancelled"
                break
            if session in finish_now:
                break
            if steers.get(session):
                # The steer joined the turn. The message it cut goes on until
                # the agent takes the steer: its next word comes after the
                # steer, every run (zen-sidebar, for the steer race). Then the
                # turn answers the steer in a message of its own and runs a
                # little longer, as a real one does.
                say(session, f"word{i} ", message=message)
                time.sleep(0.3)
                say(session, "Steered: " + " / ".join(steers.pop(session)), message=new_message(session))
                break
            say(session, f"word{i} ", message=message)
            time.sleep(0.1)
    elif "FAILLATER" in text:
        message = new_message(session)
        for i in range(5):
            say(session, f"word{i} ", message=message)
            time.sleep(0.1)
        running.discard(session)
        send({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32603, "message": "the model failed"}})
        return
    elif "HOLDBARE" in text:
        say(session, "Searching.")
        run_tool(session, "click", {"element": "Search", "target": "#search"}, hold=True, bare=True)
        stop = "cancelled"
    elif "FAILBARE" in text:
        tool_counter[0] += 1
        call_id = f"toolu_{os.getpid()}_{tool_counter[0]}"
        full, args = "mcp__zenius__click", {"element": "Search", "target": "#search"}
        update(session, {"sessionUpdate": "tool_call", "toolCallId": call_id, "name": full, "title": full,
                         "kind": "other", "status": "pending", "rawInput": args, "content": [],
                         "_meta": {"claudeCode": {"toolName": full}}})
        tool_update(session, call_id, full, args, status="failed")
        say(session, "The search didn't run.")
    elif "ASKSTEER" in text:
        next_id[0] += 1
        rid = next_id[0]
        waiting[rid] = {"event": threading.Event()}
        send({
            "jsonrpc": "2.0", "id": rid, "method": "session/request_permission",
            "params": {
                "sessionId": session,
                "toolCall": {"toolCallId": "t2", "title": "mcp__zenius__click", "kind": "other", "rawInput": {"ref": "e5"},
                             "_meta": {"claudeCode": {"toolName": "mcp__zenius__click"}}},
                "options": [
                    {"optionId": "allow", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
                    {"optionId": "deny", "name": "Deny", "kind": "reject_once"},
                ],
            },
        })
        waiting[rid]["event"].wait(30)
        outcome = waiting.pop(rid).get("result")
        for _ in range(40):  # the steer follows the reply
            if steers.get(session):
                break
            time.sleep(0.05)
        steered = steers.pop(session, None)
        say(session, "permission outcome: " + json.dumps(outcome) + (" | Steered: " + " / ".join(steered) if steered else ""))
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
    elif any(keyword in text for keyword in ASKS):
        stop = ask(session, next(keyword for keyword in ASKS if keyword in text), quiet="QUIET" in text)
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
    elif "OPENSTAY:" in text:
        name = text.split("OPENSTAY:", 1)[1].split("\n")[0].strip()
        if run_tool(session, "open", {"url": f"{WWW}/article.html", "task": name}):
            say(session, "The page is open, and I've left the task and its tab open.")
    elif "READAGAIN" in text:
        if run_tool(session, "read_page", {}):
            say(session, "I read the page again, in the task I had open.")
        else:
            say(session, "I couldn't read the page again.")
    elif "OPENCUT:" in text:
        name = text.split("OPENCUT:", 1)[1].split("\n")[0].strip()
        if run_tool(session, "open", {"url": f"{WWW}/article.html", "task": name}, cut_name=60):
            say(session, "The page is open.")
    elif "QUESTION" in text:
        say(session, "I found two nonstop flights under $900. Do you want the morning one or the evening one?")
    elif "CHOICES" in text:
        say(session, "Wikivoyage's Kyoto guide lists these day trips under \"Go next\" — which one would you like?\n\n"
                     "1. Nara\n2. Uji\n3. Himeji\n\n"
                     "Once you pick, I'll look it up with Wikivoyage's search box and give you the train directions.")
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
    running.discard(session)
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
                session_caps = {"systemPrompt": {"mode": {"override": {}}}, "close": {}, **({"fork": {}} if UUID else {})}
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
                **({"_meta": {"steering": {"supported": True}}} if STEER else {}),
            }})
        elif method == "session/new":
            if CLAUDE and "systemPrompt" in message["params"]:
                send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32602, "message": "systemPrompt: only override is supported"}})
                continue
            # Unique across restarts, as real session ids are.
            session = str(uuid.uuid4()) if UUID else f"{'c' if CLAUDE else 's'}{os.getpid()}-{len(sessions) + 1}"
            sessions[session] = {"model": MODELS[0][0], "effort": "xhigh" if CLAUDE else "low"}
            zenius_specs[session] = zenius_spec(message["params"])
            with history_lock:
                histories[session] = []
                save_histories()
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"sessionId": session, "configOptions": options(session)}})
        elif method == "session/fork" and (not CLAUDE or UUID):
            session, error = fork(message["params"])
            if error:
                send({"jsonrpc": "2.0", "id": message["id"], "error": error})
            else:
                zenius_specs[session] = zenius_spec(message["params"])
                send({"jsonrpc": "2.0", "id": message["id"], "result": {"sessionId": session, "configOptions": options(session)}})
        elif method == "session/resume" and not CLAUDE:
            session = message["params"]["sessionId"]
            sessions.setdefault(session, {"model": MODELS[0][0], "effort": "low"})
            zenius_specs[session] = zenius_spec(message["params"])
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"configOptions": options(session)}})
        elif method == "session/set_config_option":
            params = message["params"]
            if params["configId"] == "model" and params["value"] not in [m[0] for m in MODELS]:
                # Both adapters refuse a model they don't list (zen-sidebar).
                send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32602, "message": f"Invalid value for config option model: {params['value']}"}})
                continue
            state = sessions[params["sessionId"]]
            state["model" if params["configId"] == "model" else "effort"] = params["value"]
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"configOptions": options(params["sessionId"])}})
        elif method == "session/prompt":
            threading.Thread(target=prompt, args=(message,), daemon=True).start()
        elif method == "session/close":
            closed = mcps.pop(message["params"]["sessionId"], None)
            if closed:
                closed.close()
            send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
        elif method == "_session/steering" and STEER:
            params = message["params"]
            session = params["sessionId"]
            text = "\n".join(b.get("text", "") for b in params.get("prompt") or [] if b.get("type") == "text").strip()
            idle = ((params.get("_meta") or {}).get("steering") or {}).get("idleBehavior")
            if session in running and "RACE" not in text:
                steers.setdefault(session, []).append(text.splitlines()[-1] if text else "")
                send({"jsonrpc": "2.0", "id": message["id"], "result": {"outcome": "injected"}})
            else:
                if session in running:
                    finish_now.add(session)  # RACE: the turn ends as the steer comes
                if idle == "promptRequired":
                    send({"jsonrpc": "2.0", "id": message["id"], "result": {"outcome": "promptRequired", "reason": "noRunningTurn"}})
                else:
                    send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32602, "message": "no running turn"}})
        else:
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": f"{method} not supported"}})
    elif method == "session/cancel":
        cancelled.add(message["params"]["sessionId"])
    elif "id" in message and message["id"] in waiting:
        waiting[message["id"]]["result"] = message.get("result")
        waiting[message["id"]]["event"].set()
