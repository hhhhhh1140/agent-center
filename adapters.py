import json
import os
import shutil
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


AGENTS = {
    "claude": {"name": "Claude Code", "role": "统筹 · 拆解与汇总", "initial": "CL"},
    "codex": {"name": "Codex", "role": "代码与验证", "initial": "CX"},
    "muse": {"name": "Muse Code", "role": "实现与设计", "initial": "MU"},
    "deepseek": {"name": "DeepSeek Harness", "role": "实现与排查", "initial": "DS"},
    "workbuddy": {"name": "WorkBuddy", "role": "资料与文档", "initial": "WB"},
    "grok": {"name": "Grok Bot", "role": "调研与复核", "initial": "GB"},
}
LOCAL = ("codex", "muse", "deepseek")
DISTRIBUTION = {
    "claude": [],
    "codex": ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"],
    "muse": [],
    "deepseek": ["/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"],
}


def executable(agent):
    name = "dsh" if agent == "deepseek" else agent
    override = os.environ.get(f"AGENT_CENTER_{agent.upper()}_BIN")
    candidates = [os.path.expanduser(override)] if override else [
        shutil.which(name), str(Path.home() / ".local/bin" / name),
        f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}", *DISTRIBUTION[agent],
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return os.path.abspath(candidate)
    return None


def inventory():
    entries = []
    for key, info in AGENTS.items():
        if key in DISTRIBUTION:
            state = "cli" if executable(key) else "missing"
        elif key == "workbuddy":
            state = "api" if os.getenv("WORKBUDDY_ACCESS_TOKEN") else "manual"
        else:
            state = "webhook" if os.getenv("GROK_BOT_WEBHOOK_URL") and os.getenv("GROK_BOT_WEBHOOK_KEY") else "manual"
        entries.append({"id": key, "mode": state, **info})
    return entries


def claude_command(schema=None):
    argv = [executable("claude"), "-p", "--safe-mode", "--tools", "",
            "--disallowedTools", "mcp__*", "--output-format", "json"]
    if schema:
        argv += ["--json-schema", json.dumps(schema, ensure_ascii=True)]
    return argv


def claude_result(raw, structured=False):
    try:
        envelope = json.loads(raw)
        value = envelope.get("structured_output" if structured else "result")
        if not envelope.get("is_error") and value:
            return value
    except (ValueError, AttributeError):
        pass
    raise RuntimeError("Claude 没有返回有效结果。请检查 CLI 日志与登录状态。")


def worker_command(agent, prompt):
    binary = executable(agent)
    if not binary:
        raise RuntimeError(f"找不到 {AGENTS[agent]['name']} CLI。")
    if agent == "codex":
        return [binary, "exec", "--sandbox", "workspace-write", "--color", "never", "-"], prompt
    if agent == "muse":
        return [binary, "exec", prompt], None
    return [binary, "--profile", "headless", prompt], None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, token, data=None):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    body = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data, ensure_ascii=False).encode()
    try:
        with build_opener(NoRedirect).open(Request(url, data=body, headers=headers), timeout=15) as response:
            raw = response.read(524288)
            return response.status, raw
    except HTTPError as exc:
        raise RuntimeError(f"外部服务返回 HTTP {exc.code}。") from None
    except (URLError, OSError, ValueError):
        raise RuntimeError("连接外部服务失败。请检查地址与网络，再到服务端确认任务状态。") from None


def workbuddy(prompt, stop, on_sent):
    token = os.environ["WORKBUDDY_ACCESS_TOKEN"]
    url = "https://www.workbuddy.cn/openapi/v2/localassistant/message"
    marker = f"AGENT_CENTER_DONE_{uuid.uuid4().hex}"
    def data(endpoint, payload=None):
        response = json.loads(request(endpoint, token, payload)[1])
        if response.get("code") != 0:
            raise RuntimeError(f"WorkBuddy 返回错误码 {response.get('code')}。")
        return response["data"]

    cursor = data(url, {"content": f"{prompt}\n交付结果后，在最后一行原样写入任务回执 {marker}。",
                        "msg_type": "text"})["message_id"]
    on_sent(cursor)
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline and not stop.wait(4):
        messages = data(url + "?" + urlencode({"message_id": cursor}))["messages"]
        for msg in messages:
            if msg.get("role") != "assistant":
                continue
            content = "\n".join(part for part in msg.get("content", []) if isinstance(part, str))
            if marker in content:
                result = content.replace(marker, "").strip()
                if result:
                    return result
    if not stop.is_set():
        raise RuntimeError("等待 WorkBuddy 回执超时。请到 WorkBuddy 检查任务结果。")


def grok_dispatch(prompt, job_id):
    url = os.environ["GROK_BOT_WEBHOOK_URL"]
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("Grok Bot Webhook 必须是 HTTPS 地址。")
    status, _ = request(url, os.environ["GROK_BOT_WEBHOOK_KEY"],
                        {"task_id": job_id, "prompt": prompt})
    if status != 200:
        raise RuntimeError(f"Grok Bot Webhook 返回 HTTP {status}。")
