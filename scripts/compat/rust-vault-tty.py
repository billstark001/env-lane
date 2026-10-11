"""Exercise the native Vault selector on a real POSIX pseudo-terminal."""
import fcntl
import json
import re
import signal
import struct
import termios
import os
import pathlib
import pty
import select
import subprocess
import sys
import tempfile
import time

binary = pathlib.Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="env-lane-tty-") as temporary:
    root = pathlib.Path(temporary)
    (root / "package.json").write_text('{"name":"tty-fixture"}')
    (root / "env-lane.config.json").write_text(json.dumps({"vault": {"enabled": True, "configFile": "vault.json"}}))
    (root / "vault.json").write_text(json.dumps({
        "envFiles": [".env"],
        "outputDir": ".vault",
        "outputFile": "store.dat",
        "disableUnsafeWarning": True,
    }))
    (root / "key.txt").write_text("synthetic-test-key")
    (root / ".env").write_text("A=vault-value\n")
    base = [str(binary), "--cwd", temporary, "vault"]
    created = subprocess.run(
        base + ["encrypt", "key.txt", "--vault-config", "vault.json"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert created.returncode == 0, (created.stdout, created.stderr)
    (root / ".env").write_text("A=local-value\n")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 16, 80, 0, 0))
    child = subprocess.Popen(
        base + ["decrypt", "key.txt", "--vault-config", "vault.json"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
    )
    os.close(slave)
    output = bytearray()
    sent_select = sent_confirm = sent_details = sent_resize = False
    resize_offset = 0
    deadline = time.time() + 12
    while time.time() < deadline and child.poll() is None:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
        if not sent_details and b"Select Vault entries" in output:
            os.write(master, b"v")
            sent_details = True
        if sent_details and not sent_resize and b"v back" in output:
            resize_offset = len(output)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 10, 40, 0, 0))
            os.kill(child.pid, signal.SIGWINCH)
            os.write(master, b"v")
            sent_resize = True
        if sent_resize and not sent_select and b"v details" in output[resize_offset:]:
            os.write(master, b"\r")
            sent_select = True
        if sent_select and not sent_confirm and b"selected entries?" in output:
            os.write(master, b"y")
            sent_confirm = True
    if child.poll() is None:
        child.kill()
    child.wait()
    os.close(master)
    assert child.returncode == 0, (child.returncode, output[-1000:])
    assert (root / ".env").read_text() == "A=vault-value\n"
    assert sent_select and sent_confirm and sent_details and sent_resize
    # In raw mode a newline cannot be trusted to reset the column. Every paint
    # uses absolute row coordinates and contains no raw LF, including after resize.
    raw = bytes(output).split(b"\x1b[?1049h", 1)[1].split(b"\x1b[?1049l", 1)[0]
    assert b"\n" not in raw, raw
    frames = raw.split(b"\x1b[2J")[1:]
    assert frames
    for frame in frames:
        for row, column in re.findall(rb"\x1b\[(\d+);(\d+)H", frame):
            assert 1 <= int(row) <= 16
            assert int(column) == 1
    assert b"\x1b[?7h" in output and b"\x1b[?25h" in output
    resized = bytes(output[resize_offset:]).split(b"\x1b[?1049l", 1)[0]
    for row, column in re.findall(rb"\x1b\[(\d+);(\d+)H", resized):
        assert 1 <= int(row) <= 10
        assert int(column) == 1
    print("Native Vault PTY selection and confirmation passed.")
