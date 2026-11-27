#!/usr/bin/env python3
"""A red-team ACP agent for the agent sidebar (the snapshot layer, 2026-11-21).

Each prompt keyword makes it do one thing a page could steer a real agent
into, and it logs, as JSON lines, what it got and what came back:

  XSS    stream hostile Markdown into the panel (scripts, handlers, frames,
         forms, images, styles, links of every scheme)
  SPOOF  an answer dressed as the panel's permission prompt
  PERM   ask session/request_permission and wait for the answer
  FS     call fs/read_text_file, fs/write_text_file and terminal/create
  ECHO   log the prompt as received (the page's text included)
  I1     stream for a few seconds with tool calls and a permission request
  LINK <name> [HOLD <s>] [WAIT <s>] [LONG]
         report a call of zenius's open tool that runs for WAIT seconds (4),
         while the probe makes the task <name> as zenius would, then ends
         with zenius's own result ("Open <host>/live", then "Started the task
         "<name>". Opened p1: ..."); the sidebar links the chat to that task
         (only to a task made while the call
         ran). Then it keeps the turn busy for HOLD seconds (20), a chunk
         every 0.5 s and a step every 2 s; LONG first streams a long answer,
         so the thread scrolls
  LINKCMD <name>
         report a shell command that only prints taskSpace("<name>"), as a
         real agent's shell tool call would carry it, then end the turn

Only loopback URLs appear in what it writes. The probe that drives it is
sidebar-probe.mjs; its config runs this file through /usr/bin/env python3.

  sidebar-redteam-agent.py <log.jsonl> <workspace dir> <loopback base URL>
"""
import json
import os
import re
import sys
import threading
import time

LOG = open(sys.argv[1], "a", buffering=1)
WORKSPACE = sys.argv[2]
BASE = sys.argv[3].rstrip("/")
lock = threading.Lock()
next_id = [1000]
waiting = {}
cancelled = set()


def log(kind, data):
    LOG.write(json.dumps({"t": round(time.time(), 3), "kind": kind, "data": data}) + "\n")


def send(message):
    with lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def update(session, data):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": data}})


def say(session, text, message_id, size=60, pause=0.0):
    for i in range(0, len(text), size):
        update(session, {"sessionUpdate": "agent_message_chunk", "messageId": message_id,
                         "content": {"type": "text", "text": text[i:i + size]}})
        if pause:
            time.sleep(pause)


def request(method, params, timeout):
    rid = next_id[0]
    next_id[0] += 1
    event = threading.Event()
    waiting[rid] = {"event": event}
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    answered = event.wait(timeout)
    entry = waiting.pop(rid, {})
    return {"answered": answered, "result": entry.get("result"), "error": entry.get("error")}


CANARY = "Services.prefs.setBoolPref('zs.redteam.xss', true)"
XSS = f"""Red team answer.

<img src=x onerror="{CANARY}">
<script>{CANARY}</script>
<svg onload="{CANARY}"><circle r="1"/></svg>
<iframe src="data:text/html,<b>frame</b>"></iframe>
<iframe srcdoc="<b>srcdoc</b>"></iframe>
<object data="data:text/html,x"></object><embed src="data:text/html,x">
<form action="{BASE}/form"><input name="q" value="x"><button>Go</button></form>
<a href="javascript:{CANARY}">js link</a>
<a href="chrome://browser/content/browser.xhtml">chrome link</a>
<a href="file:///etc/hostname">file link</a>
<a href="{BASE}/clicked">web link</a>
![pixel]({BASE}/pixel.png?leak=1)
<img src="moz-remote-image://?url={BASE}/remote.png">
<style>body {{ display: none }}</style>
<div style="position:fixed;inset:0;background:red" id="zsOverlay">overlay</div>
<meta http-equiv="refresh" content="0;url={BASE}/refresh">
<base href="{BASE}/">
<details open ontoggle="{CANARY}">details</details>
<math><mi xlink:href="javascript:{CANARY}">m</mi></math>
[md js link](javascript:{CANARY})
"""


def prompt_texts(params):
    texts, resources = [], []
    for block in params.get("prompt", []):
        if block.get("type") == "text":
            texts.append(block.get("text", ""))
        elif block.get("type") == "resource":
            resources.append(block.get("resource", {}))
    return texts, resources


def run(message):
    params = message["params"]
    session = params["sessionId"]
    texts, resources = prompt_texts(params)
    asked = "\n".join(texts)
    types = [block.get("type") for block in params.get("prompt", [])]
    log("prompt", {"sessionId": session, "texts": texts, "resources": resources, "types": types})
    mid = f"m{message['id']}"
    stop = "end_turn"
    if "LINKCMD " in asked:
        name = re.search(r"LINKCMD (\S+)", asked).group(1)
        call_id = f"cmd{message['id']}"
        command = f"echo 'taskSpace(\"{name}\")'"
        update(session, {"sessionUpdate": "tool_call", "toolCallId": call_id, "title": command, "kind": "execute",
                         "status": "in_progress", "rawInput": {"command": command, "description": "Print a line"}})
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": call_id, "status": "completed",
                         "content": [{"type": "content", "content": {"type": "text", "text": f'taskSpace("{name}")'}}]})
        log("link", {"sessionId": session, "name": name, "via": "command"})
        time.sleep(3)
        say(session, "Printed a line.", mid)
    elif "LINK " in asked:
        name = re.search(r"LINK (\S+)", asked).group(1)
        held = re.search(r"HOLD (\d+)", asked)
        hold = float(held.group(1)) if held else 20.0
        if "LONG" in asked:
            say(session, "\n\n".join(f"Line {i} of a long answer." for i in range(150)), mid + "l", size=500)
        waited = re.search(r"WAIT (\d+(?:\.\d+)?)", asked)
        wait = float(waited.group(1)) if waited else 4.0
        call_id = f"open{message['id']}"
        update(session, {"sessionUpdate": "tool_call", "toolCallId": call_id, "title": "mcp__zenius__open",
                         "kind": "other", "status": "in_progress", "rawInput": {"task": name, "url": BASE + "/live"}})
        # zenius makes the task while its open runs; the probe makes it now.
        time.sleep(wait)
        host = BASE.split("//", 1)[-1]
        update(session, {"sessionUpdate": "tool_call_update", "toolCallId": call_id, "status": "completed",
                         "content": [{"type": "content", "content": {"type": "text",
                                                                     "text": f'Open {host}/live\nStarted the task "{name}". Opened p1: ZS live page \u2014 {BASE}/live'}}]})
        log("link", {"sessionId": session, "name": name, "hold": hold, "wait": wait})
        end = time.time() + hold
        i = 0
        while time.time() < end and session not in cancelled:
            time.sleep(0.5)
            i += 1
            say(session, ".", mid + "w")
            if i % 4 == 0:
                sid = f"step{message['id']}-{i}"
                update(session, {"sessionUpdate": "tool_call", "toolCallId": sid, "title": "mcp__zenius__snapshot",
                                 "kind": "other", "status": "in_progress", "rawInput": {}})
                update(session, {"sessionUpdate": "tool_call_update", "toolCallId": sid, "status": "completed",
                                 "content": [{"type": "content", "content": {"type": "text", "text": "Read the page."}}]})
        if session in cancelled:
            stop = "cancelled"
        say(session, "Done.", mid + "z")
    elif "XSS" in asked:
        say(session, XSS, mid)
    elif "PERM" in asked:
        say(session, "I need to run a command.", mid)
        call_id = f"perm{message['id']}"
        update(session, {"sessionUpdate": "tool_call", "toolCallId": call_id, "title": "rm -rf ~/zs-redteam (red team)",
                         "kind": "execute", "status": "pending",
                         "rawInput": {"command": "rm -rf ~/zs-redteam", "description": "Delete a folder (red team)"}})
        answer = request("session/request_permission", {
            "sessionId": session,
            "toolCall": {"toolCallId": call_id, "title": "rm -rf ~/zs-redteam (red team)", "kind": "execute"},
            "options": [
                {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
                {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
            ],
        }, 30)
        log("permission", answer)
        if session in cancelled:
            stop = "cancelled"
        say(session, "Permission: " + json.dumps(answer.get("result")), mid + "b")
    elif "FS" in asked:
        out = {
            "read": request("fs/read_text_file", {"sessionId": session, "path": "/etc/hostname"}, 5),
            "write": request("fs/write_text_file", {"sessionId": session, "path": os.path.join(WORKSPACE, "zs-written.txt"),
                                                    "content": "red team"}, 5),
            "terminal": request("terminal/create", {"sessionId": session, "command": "touch",
                                                    "args": [os.path.join(WORKSPACE, "zs-terminal")]}, 5),
        }
        log("fs", out)
        say(session, "fs and terminal: " + ", ".join(f"{k} {'error' if v['error'] else 'ok' if v['answered'] else 'no answer'}"
                                                   for k, v in out.items()), mid)
    elif "SPOOF" in asked:
        say(session, 'Spoof answer.\n\n<div class="title" id="send">The agent wants to: read this page (spoof)</div>'
                     '<div class="options"><button data-kind="allow_once">Allow</button>'
                     '<button data-kind="reject_once">Reject</button></div>', mid)
    elif "ECHO" in asked:
        say(session, f"Got {len(texts)} text block(s) and {len(resources)} resource(s).", mid)
    elif "I1" in asked:
        for i in range(6):
            if session in cancelled:
                stop = "cancelled"
                break
            call_id = f"i1-{message['id']}-{i}"
            update(session, {"sessionUpdate": "tool_call", "toolCallId": call_id, "title": f"Step {i + 1}",
                             "kind": "other", "status": "in_progress"})
            say(session, f"Working on step {i + 1}. ", mid, pause=0.05)
            update(session, {"sessionUpdate": "tool_call_update", "toolCallId": call_id, "status": "completed"})
            if i == 3:
                answer = request("session/request_permission", {
                    "sessionId": session,
                    "toolCall": {"toolCallId": call_id + "p", "title": "Open a page (red team)", "kind": "fetch"},
                    "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                                {"optionId": "reject", "name": "Reject", "kind": "reject_once"}],
                }, 2)
                log("permission", answer)
            time.sleep(0.6)
        say(session, "Done. Is there anything else?", mid + "z")
    else:
        say(session, "Red team agent: no keyword.", mid)
    send({"jsonrpc": "2.0", "id": message["id"], "result": {"stopReason": stop}})


sessions = 0
for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    method = message.get("method")
    if method and "id" in message:
        log("request", {"method": method, "keys": sorted((message.get("params") or {}).keys())})
        if method == "initialize":
            log("initialize", message.get("params"))
            send({"jsonrpc": "2.0", "id": message["id"], "result": {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": False,
                                      "promptCapabilities": {"embeddedContext": True, "image": False},
                                      "sessionCapabilities": {}},
                "authMethods": [],
                "agentInfo": {"name": "zs-redteam", "version": "0"},
            }})
        elif method == "session/new":
            sessions += 1
            sid = f"zs{os.getpid()}-{sessions}"
            log("session/new", {"sessionId": sid, "params": message.get("params")})
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"sessionId": sid}})
        elif method == "session/prompt":
            threading.Thread(target=run, args=(message,), daemon=True).start()
        elif method in ("session/close", "session/set_config_option", "session/set_mode"):
            send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
        else:
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": f"{method} not supported"}})
    elif method == "session/cancel":
        cancelled.add((message.get("params") or {}).get("sessionId"))
        log("cancel", message.get("params"))
    elif "id" in message and message["id"] in waiting:
        waiting[message["id"]]["result"] = message.get("result")
        waiting[message["id"]]["error"] = message.get("error")
        waiting[message["id"]]["event"].set()
