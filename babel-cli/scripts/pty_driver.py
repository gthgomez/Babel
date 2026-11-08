#!/usr/bin/env python3
"""Real pseudo-terminal driver for installed-Babel terminal qualification.

Spawns a command on an actual PTY, applies window sizes with TIOCSWINSZ, feeds
scripted input, and reports timestamped ANSI-stripped output plus timings.
"""
import argparse
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]")


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def strip(data):
    return ANSI.sub(b"", data).decode("utf-8", "replace")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--rows", type=int, default=24)
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("--timeout-ms", type=int, default=120000)
    parser.add_argument("--transcript")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command and args.command[0] == "--" else args.command
    if not command:
        raise SystemExit("command required after --")
    steps = json.load(open(args.script))

    started = time.monotonic()
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(args.cwd)
        os.execvpe(command[0], command, os.environ)
    set_size(master, args.rows, args.cols)
    os.set_blocking(master, False)

    raw = bytearray()
    events = []
    pending = bytearray()
    first_byte_ms = None
    answer_ms = None

    def drain(wait_ms):
        nonlocal first_byte_ms
        deadline = time.monotonic() + wait_ms / 1000.0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            ready, _, _ = select.select([master], [], [], min(remaining, 0.05))
            if not ready:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EIO):
                    return
                raise
            if not chunk:
                return
            raw.extend(chunk)
            pending.extend(chunk)
            at_ms = int((time.monotonic() - started) * 1000)
            if first_byte_ms is None:
                first_byte_ms = at_ms
            events.append({"at_ms": at_ms, "bytes": len(chunk)})

    try:
        for step in steps:
            if "wait_for" in step:
                needle = step["wait_for"]
                deadline = time.monotonic() + step.get("timeout_ms", 20000) / 1000.0
                found = None
                search_from = 0
                while time.monotonic() < deadline:
                    drain(50)
                    text = strip(bytes(raw))
                    idx = text.find(needle, search_from)
                    if idx >= 0:
                        found = int((time.monotonic() - started) * 1000)
                        break
                if found is None:
                    events.append({"error": f"wait_for timeout: {needle}"})
                    print(json.dumps({"ok": False, "error": f"wait_for timeout: {needle}",
                                      "last_output": strip(bytes(raw))[-2000:]}, ensure_ascii=False))
                    return 2
                # This is when the scripted answer arrived, not the first
                # rendered byte. Keep the two metrics distinct.
                if answer_ms is None:
                    answer_ms = found
                events.append({"wait_for": needle, "at_ms": found})
            elif "send" in step:
                sent_at = time.monotonic()
                os.write(master, step["send"].encode())
                events.append({"send": step["send"], "at_ms": int((sent_at - started) * 1000)})
            elif "key" in step:
                key = step["key"]
                data = {"enter": b"\r", "ctrl-c": b"\x03", "esc": b"\x1b",
                        "tab": b"\t", "up": b"\x1b[A", "down": b"\x1b[B",
                        "pgup": b"\x1b[5~", "pgdn": b"\x1b[6~"}.get(key)
                if data is None:
                    data = key.encode()
                os.write(master, data)
                events.append({"key": key, "at_ms": int((time.monotonic() - started) * 1000)})
            elif "resize" in step:
                rows, cols = step["resize"]
                set_size(master, rows, cols)
                os.kill(pid, signal.SIGWINCH)
                events.append({"resize": [rows, cols], "at_ms": int((time.monotonic() - started) * 1000)})
            elif "sleep_ms" in step:
                drain(step["sleep_ms"])
            else:
                raise SystemExit(f"unknown step: {step}")

        # Give the process a moment to exit after its scripted input.
        deadline = time.monotonic() + 10
        status = None
        while time.monotonic() < deadline:
            drain(50)
            done, st = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                status = st
                break
        if status is None:
            os.killpg(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
        exit_code = os.waitstatus_to_exitcode(status)
        text = strip(bytes(raw))
        # Terminal restoration: the renderer hides the cursor while painting;
        # a clean exit must leave it visible again. Report the raw evidence.
        last_hide = raw.rfind(b"\x1b[?25l")
        last_show = raw.rfind(b"\x1b[?25h")
        tail = bytes(raw[-400:])
        if args.transcript:
            open(args.transcript, "w", encoding="utf-8").write(text)
        print(json.dumps({
            "ok": True,
            "exit_code": exit_code,
            "first_output_ms": first_byte_ms,
            "first_byte_ms": first_byte_ms,
            "answer_ms": answer_ms,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "events": events,
            "bytes": len(raw),
            "cursor_restored": last_hide < 0 or last_show > last_hide,
            "sgr_reset_at_exit": bool(re.search(rb"\x1b\[(?:0)?m", tail)),
            "transcript_tail": text[-4000:],
        }, ensure_ascii=False))
        return 0 if exit_code == 0 else 1
    finally:
        try:
            os.close(master)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
