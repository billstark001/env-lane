"""Native run regressions using real terminal input and owned process groups."""

import json
import os
import pathlib
import pty
import signal
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = pathlib.Path(__file__).resolve()
BINARY = pathlib.Path(sys.argv[1]).resolve()
NODE = os.environ.get("ENV_LANE_TEST_NODE", "node")

# Node matches the reported terminal reproduction and serializes signal
# callbacks. Python can coalesce or reenter handlers for closely spaced signals.
TERMINAL_CHILD = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [root, mode] = process.argv.slice(1);
const received = [];
const write = (name, value = '') => {
  const file = path.join(root, name);
  fs.writeFileSync(file + '.tmp', value);
  fs.renameSync(file + '.tmp', file);
};
const done = () => { write('child.done'); process.exit(0); };
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => {
  received.push(name);
  write('child.signals', JSON.stringify(received));
  if (mode === 'ignore' || (mode === 'twice' && received.length < 2)) return;
  if (mode === 'reset') process.removeAllListeners(name);
  setTimeout(done, 300);
});
write('child.pid', String(process.pid));
write('child.signals', '[]');
const ready = () => {
  write('child.ready');
  if (mode === 'pid-only') setTimeout(done, 600);
};
if (mode !== 'ignore' && process.stdin.isTTY) {
  write('input.ready');
  process.stdin.once('data', data => {
    assert.equal(data.toString(), 'ping\n');
    process.stdin.pause();
    write('input.received');
    ready();
  });
} else ready();
setInterval(() => {}, 1000);
"""


def until(predicate, description, timeout=4):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError(description)
        time.sleep(0.01)


def running(pid):
    # Orphaned grandchildren can briefly remain zombies (especially under a
    # container's PID 1). They are terminated, even though kill(pid, 0) succeeds.
    result = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True
    )
    status = result.stdout.strip()
    return bool(status) and not status.startswith("Z")


def write(root, name, value):
    # Signal observations are polled concurrently; publish complete files.
    temporary = root / f"{name}.tmp"
    temporary.write_text(value)
    temporary.replace(root / name)


def fixture(root, mode):
    root = pathlib.Path(root)
    role = "grandchild" if mode.startswith("grandchild-") else "child"
    write(root, f"{role}.pid", str(os.getpid()))
    write(root, f"{role}.group", str(os.getpgrp()))
    signals = []
    stopped = None

    def received(number, _frame):
        nonlocal stopped
        signals.append(signal.Signals(number).name)
        write(root, f"{role}.signals", json.dumps(signals))
        if mode in ("ignore", "grandchild-ignore"):
            return
        if mode == "twice" and len(signals) < 2:
            return
        stopped = time.monotonic() + 0.3

    signal.signal(signal.SIGINT, received)
    signal.signal(signal.SIGTERM, received)
    write(root, f"{role}.signals", "[]")

    if mode in ("stubborn-tree", "graceful-tree", "slow-tree", "normal-tree", "detached-tree"):
        grandchild_mode = {
            "graceful-tree": "grandchild-graceful",
            "slow-tree": "grandchild-graceful",
        }.get(mode, "grandchild-ignore")
        descendant = subprocess.Popen(
            [sys.executable, str(SCRIPT), str(BINARY), "__child__", str(root), grandchild_mode],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=mode == "detached-tree",
        )
        until(lambda: (root / "grandchild.ready").exists(), "Grandchild did not start")

        def stop_tree(number, _frame):
            write(root, "child.signals", json.dumps([signal.Signals(number).name]))
            if mode == "graceful-tree":
                descendant.wait(timeout=2)
            sys.exit(0)

        signal.signal(signal.SIGINT, stop_tree)
        signal.signal(signal.SIGTERM, stop_tree)

    (root / f"{role}.ready").touch()
    if mode == "normal-tree":
        return
    while stopped is None or time.monotonic() < stopped:
        time.sleep(0.01)
    (root / f"{role}.done").touch()


def supervisor(root, mode, mixed):
    # Remain in the shared foreground group to catch accidental group SIGKILL.
    # A handled disposition is reset by exec, so the runner installs its own.
    signal.signal(signal.SIGINT, lambda *_: None)
    signal.signal(signal.SIGTERM, lambda *_: None)
    root = pathlib.Path(root)
    runner = subprocess.Popen(
        command(root, mode, terminal=True), stdin=subprocess.DEVNULL if mixed else None
    )
    write(root, "runner.pid", str(runner.pid))
    write(root, "supervisor.group", str(os.getpgrp()))
    write(root, "runner.result", str(runner.wait(timeout=10)))


def command(root, mode, terminal=False):
    child = (
        [NODE, "-e", TERMINAL_CHILD, str(root), mode] if terminal else
        [sys.executable, str(SCRIPT), str(BINARY), "__child__", str(root), mode]
    )
    return [str(BINARY), "run", "--build", "local", "--quiet", "app", "--", *child]


class RunSignals(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="env-lane-signals-")
        self.root = pathlib.Path(self.temporary.name)
        (self.root / ".env").touch()
        (self.root / "env-lane.config.json").write_text(json.dumps({
            "selector": {"envKey": "ENV_BUILD", "defaultBuild": "local", "builds": ["local"]},
            "workspace": {"aliases": {"app": "."}},
            "dotenv": {"order": [".env"], "includeProcessEnv": True},
        }))
        self.runner = None
        self.terminal_pid = None
        self.master = None

    def tearDown(self):
        # Clean fixture PIDs on both success and assertion failure; never send
        # to the harness's own/shared group.
        for file in self.root.glob("*.pid"):
            try:
                os.kill(int(file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
        if self.runner:
            if self.runner.poll() is None:
                self.runner.kill()
            self.runner.wait(timeout=2)
        if self.terminal_pid:
            exited, _ = os.waitpid(self.terminal_pid, os.WNOHANG)
            if not exited:
                try:
                    os.kill(self.terminal_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(self.terminal_pid, 0)
        if self.master is not None:
            os.close(self.master)
        self.temporary.cleanup()

    def ready(self):
        until(lambda: (self.root / "child.ready").exists(), "Child did not start")

    def received(self, role="child"):
        return json.loads((self.root / f"{role}.signals").read_text())

    def start(self, mode):
        self.runner = subprocess.Popen(
            command(self.root, mode), cwd=self.root, start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.ready()
        self.assertEqual(
            int((self.root / "child.group").read_text()),
            int((self.root / "child.pid").read_text()),
        )

    def start_terminal(self, mode, mixed=False):
        # fork() + controlling PTY creates a genuine foreground group. Merely
        # attaching openpty() descriptors cannot reproduce terminal Ctrl+C.
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(self.root)
            os.execl(sys.executable, sys.executable, str(SCRIPT), str(BINARY),
                     "__supervisor__", str(self.root), mode, str(int(mixed)))
        self.terminal_pid, self.master = pid, master
        if not mixed and mode in ("once", "reset", "twice", "pid-only"):
            until(lambda: (self.root / "input.ready").exists(), "Child cannot read terminal stdin")
            os.write(master, b"ping\n")
        self.ready()
        self.assertEqual(os.getpgid(int((self.root / "child.pid").read_text())), pid)
        until(lambda: (self.root / "runner.pid").exists(), "Runner PID missing")

    def terminal_result(self, expected):
        until(lambda: (self.root / "runner.result").exists(), "Runner did not finish", timeout=8)
        self.assertEqual(int((self.root / "runner.result").read_text()), -expected)
        self.assertEqual(int((self.root / "supervisor.group").read_text()), self.terminal_pid)

    def test_terminal_single_interrupt_and_stdin(self):
        self.start_terminal("once")
        os.write(self.master, b"\x03")
        self.terminal_result(signal.SIGINT)
        self.assertEqual(self.received(), ["SIGINT"])
        self.assertTrue((self.root / "input.received").exists())
        self.assertTrue((self.root / "child.done").exists())

    def test_terminal_child_restores_default_handler(self):
        self.start_terminal("reset")
        os.write(self.master, b"\x03")
        self.terminal_result(signal.SIGINT)
        self.assertEqual(self.received(), ["SIGINT"])
        self.assertTrue((self.root / "child.done").exists(), "Duplicate SIGINT interrupted cleanup")

    def test_terminal_multiple_interrupts(self):
        self.start_terminal("twice")
        os.write(self.master, b"\x03")
        until(lambda: self.received() == ["SIGINT"], "First interrupt was duplicated")
        os.write(self.master, b"\x03")
        self.terminal_result(signal.SIGINT)
        self.assertEqual(self.received(), ["SIGINT", "SIGINT"])
        self.assertTrue((self.root / "child.done").exists())

    def test_terminal_stdout_only(self):
        self.start_terminal("once", mixed=True)
        os.write(self.master, b"\x03")
        self.terminal_result(signal.SIGINT)
        self.assertEqual(self.received(), ["SIGINT"])

    def test_terminal_pid_only_sigint_policy(self):
        self.start_terminal("pid-only")
        os.kill(int((self.root / "runner.pid").read_text()), signal.SIGINT)
        self.terminal_result(signal.SIGINT)
        self.assertEqual(self.received(), [])
        self.assertTrue((self.root / "child.done").exists())

    def test_terminal_timeout_keeps_shared_group_alive(self):
        self.start_terminal("ignore")
        started = time.monotonic()
        os.kill(int((self.root / "runner.pid").read_text()), signal.SIGTERM)
        self.terminal_result(signal.SIGTERM)
        self.assertGreaterEqual(time.monotonic() - started, 4.8)
        self.assertEqual(self.received(), ["SIGTERM"])
        self.assertFalse(running(int((self.root / "child.pid").read_text())))

    def test_tty_without_foreground_ownership_forwards_sigint(self):
        # Inheriting a TTY descriptor alone does not make this session its
        # foreground owner. A signal targeted at the runner must still relay.
        master, slave = pty.openpty()
        self.master = master
        try:
            self.runner = subprocess.Popen(
                command(self.root, "graceful"), cwd=self.root, start_new_session=True,
                stdin=slave, stdout=slave, stderr=slave,
            )
        finally:
            os.close(slave)
        self.ready()
        self.assertEqual(os.getpgid(self.runner.pid), int((self.root / "child.group").read_text()))
        self.runner.send_signal(signal.SIGINT)
        self.assertEqual(self.runner.wait(timeout=3), -signal.SIGINT)
        self.assertEqual(self.received(), ["SIGINT"])
        self.assertTrue((self.root / "child.done").exists())

    def test_non_tty_targeted_signals(self):
        for requested in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=requested):
                # Each signal needs a fresh child and readiness files.
                self.start("graceful")
                self.runner.send_signal(requested)
                self.assertEqual(self.runner.wait(timeout=3), -requested)
                self.assertEqual(self.received(), [signal.Signals(requested).name])
                self.assertTrue((self.root / "child.done").exists())
                for file in self.root.glob("child.*"):
                    file.unlink()

    def test_non_tty_repeated_requests_keep_first_signal(self):
        self.start("twice")
        self.runner.send_signal(signal.SIGINT)
        until(lambda: self.received() == ["SIGINT"], "First signal missing")
        self.runner.send_signal(signal.SIGTERM)
        self.assertEqual(self.runner.wait(timeout=3), -signal.SIGINT)
        self.assertEqual(self.received(), ["SIGINT", "SIGTERM"])

    def test_owned_group_outlives_leader(self):
        self.start("stubborn-tree")
        descendant = int((self.root / "grandchild.pid").read_text())
        self.assertEqual(os.getpgid(descendant), int((self.root / "child.pid").read_text()))
        started = time.monotonic()
        self.runner.send_signal(signal.SIGTERM)
        until(lambda: not running(int((self.root / "child.pid").read_text())), "Leader did not exit")
        self.assertTrue(running(descendant))
        self.assertIsNone(self.runner.poll(), "Runner abandoned its owned group")
        self.assertEqual(self.runner.wait(timeout=7), -signal.SIGTERM)
        self.assertGreaterEqual(time.monotonic() - started, 4.8)
        until(lambda: not running(descendant), "Grandchild survived escalation")
        self.assertEqual(self.received("grandchild"), ["SIGTERM"])

    def test_owned_group_graceful_shutdown(self):
        self.start("graceful-tree")
        self.runner.send_signal(signal.SIGTERM)
        self.assertEqual(self.runner.wait(timeout=3), -signal.SIGTERM)
        self.assertTrue((self.root / "grandchild.done").exists())
        self.assertEqual(self.received("grandchild"), ["SIGTERM"])

    def test_owned_group_grace_after_leader_exit(self):
        self.start("slow-tree")
        self.runner.send_signal(signal.SIGTERM)
        self.assertEqual(self.runner.wait(timeout=7), -signal.SIGTERM)
        self.assertTrue((self.root / "grandchild.done").exists(), "Descendant grace was cut short")

    def test_owned_group_timeout_with_live_leader(self):
        self.start("ignore")
        started = time.monotonic()
        self.runner.send_signal(signal.SIGINT)
        until(lambda: self.received() == ["SIGINT"], "First interrupt missing")
        time.sleep(3)
        self.runner.send_signal(signal.SIGTERM)
        self.assertEqual(self.runner.wait(timeout=4), -signal.SIGINT)
        self.assertGreaterEqual(time.monotonic() - started, 4.8)
        self.assertLess(time.monotonic() - started, 6.5)
        self.assertEqual(self.received(), ["SIGINT", "SIGTERM"])
        self.assertFalse(running(int((self.root / "child.pid").read_text())))

    def test_normal_completion_keeps_descendants(self):
        self.start("normal-tree")
        self.assertEqual(self.runner.wait(timeout=3), 0)
        self.assertTrue(running(int((self.root / "grandchild.pid").read_text())))

    def test_requested_stop_excludes_detached_descendants(self):
        self.start("detached-tree")
        descendant = int((self.root / "grandchild.pid").read_text())
        self.assertNotEqual(os.getpgid(descendant), int((self.root / "child.group").read_text()))
        self.runner.send_signal(signal.SIGTERM)
        self.assertEqual(self.runner.wait(timeout=3), -signal.SIGTERM)
        self.assertTrue(running(descendant))


if len(sys.argv) > 2 and sys.argv[2] == "__child__":
    fixture(sys.argv[3], sys.argv[4])
elif len(sys.argv) > 2 and sys.argv[2] == "__supervisor__":
    supervisor(sys.argv[3], sys.argv[4], bool(int(sys.argv[5])))
else:
    unittest.main(argv=[sys.argv[0], *sys.argv[2:]], verbosity=2)
