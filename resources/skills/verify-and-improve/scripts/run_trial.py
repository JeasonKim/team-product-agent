#!/usr/bin/env python3
"""运行一次验证命令并保留证据；不推断业务是否达标。"""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


@dataclass(frozen=True)
class TrialRequest:
    command: list[str]
    output: Path
    cwd: Path
    timeout_seconds: float


class TrialInterrupted(Exception):
    def __init__(self, signum: int):
        self.signum = signum
        super().__init__(f"收到信号 {signum}")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_report(path: Path, report: dict) -> None:
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def tail_log(path: Path) -> str:
    try:
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            stream.seek(max(0, stream.tell() - 2048))
            return stream.read().decode("utf-8", errors="replace")
    except OSError as error:
        print(f"[trial] 无法读取日志片段 {path}：{error}", file=sys.stderr)
        return ""


def stop_process_group(process: subprocess.Popen) -> None:
    # 仅回收本次命令的进程组；父进程退出后仍可能有测试子进程存活。
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        print("[trial] 命令未在终止宽限期内退出，强制回收本次进程组。", file=sys.stderr)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass  # 进程组已正常退出，无剩余子进程。
    process.wait()


def interrupt_trial(signum: int, _frame) -> None:
    raise TrialInterrupted(signum)


def run_trial(request: TrialRequest) -> int:
    # 为本次试验分配独立目录，先留下开始记录，禁止覆盖或隐式重跑。
    request.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    report_path = request.output / "trial.json"
    report = {
        "schemaVersion": 1,
        "executionStatus": "running",
        "outcome": "unverified",
        "command": request.command,
        "cwd": str(request.cwd),
        "startedAt": utc_now(),
        "finishedAt": None,
        "durationSeconds": None,
        "timeoutSeconds": request.timeout_seconds,
        "exitCode": None,
        "error": None,
        "stdoutPath": str(request.output / "stdout.log"),
        "stderrPath": str(request.output / "stderr.log"),
    }
    write_report(report_path, report)
    started = time.monotonic()
    process = None
    result = 127
    previous_handlers = {
        sig: signal.signal(sig, interrupt_trial) for sig in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        # 直接传递参数，不经过 shell；日志写入文件以保留完整证据。
        with (request.output / "stdout.log").open("wb") as stdout:
            with (request.output / "stderr.log").open("wb") as stderr:
                process = subprocess.Popen(
                    request.command, cwd=request.cwd, stdin=subprocess.DEVNULL,
                    stdout=stdout, stderr=stderr, start_new_session=True,
                )
                exit_code = process.wait(timeout=request.timeout_seconds)
                report["executionStatus"] = "exited"
                result = exit_code if exit_code >= 0 else 128 - exit_code
    except subprocess.TimeoutExpired:
        report["executionStatus"] = "timed_out"
        report["error"] = f"超过单次试验时限 {request.timeout_seconds} 秒"
        print(f"[trial] {report['error']}，保留输出并停止命令。", file=sys.stderr)
        result = 124
    except TrialInterrupted as error:
        report["executionStatus"] = "interrupted"
        report["error"] = str(error)
        print(f"[trial] {error}，保存中断现场。", file=sys.stderr)
        result = 128 + error.signum
    except OSError as error:
        report["executionStatus"] = "launch_error"
        report["error"] = str(error)
        print(f"[trial] 命令未能正常启动：{error}", file=sys.stderr)
    finally:
        # 清理期间不再接受重复中断，保证结束记录可用于续做与诊断。
        for sig in previous_handlers:
            signal.signal(sig, signal.SIG_IGN)
        try:
            if process is not None:
                stop_process_group(process)
                report["exitCode"] = process.returncode
            report["finishedAt"] = utc_now()
            report["durationSeconds"] = round(time.monotonic() - started, 3)
            write_report(report_path, report)
        finally:
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)
    summary = {
        "report": str(report_path), "executionStatus": report["executionStatus"],
        "exitCode": report["exitCode"], "outcome": "unverified",
    }
    if result != 0:
        summary["error"] = report["error"]
        summary["stdoutTail"] = tail_log(request.output / "stdout.log")
        summary["stderrTail"] = tail_log(request.output / "stderr.log")
    print(json.dumps(summary, ensure_ascii=False))
    return result


def positive_seconds(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("时限必须是有限正数")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="本次试验的新目录，已存在则拒绝执行")
    parser.add_argument("--cwd", required=True, type=Path, help="验证命令的工作目录")
    parser.add_argument("--timeout-seconds", required=True, type=positive_seconds, help="单次执行时限")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- 后传入命令与参数，不经过 shell")
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("需要验证命令")
    if os.name != "posix":
        parser.error("运行器需要 macOS/Linux 的进程组支持")
    request = TrialRequest(
        command=command, output=args.out.expanduser().resolve(),
        cwd=args.cwd.expanduser().resolve(), timeout_seconds=args.timeout_seconds,
    )
    try:
        return run_trial(request)
    except OSError as error:
        print(f"[trial] 无法保存本次试验，未覆盖已有证据：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
