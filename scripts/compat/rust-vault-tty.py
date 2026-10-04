"""Exercise the native Vault selector on a real POSIX pseudo-terminal."""
import json
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
    child = subprocess.Popen(
        base + ["decrypt", "key.txt", "--vault-config", "vault.json"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
    )
    os.close(slave)
    output = bytearray()
    sent_select = sent_confirm = False
    deadline = time.time() + 12
    while time.time() < deadline and child.poll() is None:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
        if not sent_select and b"Select Vault entries" in output:
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
    assert sent_select and sent_confirm
    print("Native Vault PTY selection and confirmation passed.")
