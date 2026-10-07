//! Scope POSIX signal ownership to a single CLI child invocation.
use signal_hook::{
    consts::{SIGINT, SIGTERM},
    iterator::{Handle, Signals},
};
use std::{
    io,
    process::{Child, ExitStatus},
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(super) struct Termination {
    signals: Receiver<i32>,
    handle: Handle,
    listener: Option<JoinHandle<()>>,
    isolated_group: bool,
}

impl Termination {
    pub(super) fn listen(isolated_group: bool) -> io::Result<Self> {
        let mut signals = Signals::new([SIGINT, SIGTERM])?;
        let handle = signals.handle();
        let (sender, receiver) = mpsc::channel();
        let listener = thread::Builder::new()
            .name("child-termination".into())
            .spawn(move || {
                for signal in signals.forever() {
                    if sender.send(signal).is_err() {
                        break;
                    }
                }
            })?;
        Ok(Self {
            signals: receiver,
            handle,
            listener: Some(listener),
            isolated_group,
        })
    }

    pub(super) fn wait(&self, child: &mut Child) -> io::Result<ExitStatus> {
        loop {
            if let Ok(signal) = self.signals.recv_timeout(Duration::from_millis(10)) {
                if let Some(pid) = rustix::process::Pid::from_raw(child.id() as i32) {
                    self.shutdown(child, pid, signal)?;
                }
                signal_hook::low_level::emulate_default_handler(signal)?;
            }
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
        }
    }

    fn shutdown(
        &self,
        child: &mut Child,
        pid: rustix::process::Pid,
        signal: i32,
    ) -> io::Result<()> {
        self.send(pid, requested_signal(signal));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let child_running = child.try_wait()?.is_none();
            // Reaping the leader does not mean its owned group is empty. Probe
            // the group independently until it disappears or grace expires.
            let group_running = self.isolated_group
                && rustix::process::test_kill_process_group(pid) != Err(rustix::io::Errno::SRCH);
            if !child_running && !group_running {
                return Ok(());
            }
            if Instant::now() >= deadline {
                self.send(pid, rustix::process::Signal::KILL);
                if child_running {
                    child.wait()?;
                }
                return Ok(());
            }
            if let Ok(next) = self.signals.recv_timeout(Duration::from_millis(10)) {
                // Relay further requests during grace without extending it.
                // The runner still exits with the first requested signal.
                self.send(pid, requested_signal(next));
            }
        }
    }

    fn send(&self, pid: rustix::process::Pid, signal: rustix::process::Signal) {
        if self.isolated_group {
            let _ = rustix::process::kill_process_group(pid, signal);
        } else if signal != rustix::process::Signal::INT || !shares_foreground_terminal() {
            let _ = rustix::process::kill_process(pid, signal);
        }
    }
}

fn requested_signal(signal: i32) -> rustix::process::Signal {
    if signal == SIGINT {
        rustix::process::Signal::INT
    } else {
        rustix::process::Signal::TERM
    }
}

fn shares_foreground_terminal() -> bool {
    // The child inherits our group and streams in interactive runs. A terminal
    // interrupt has already reached that group, so relaying SIGINT duplicates
    // it. Portable signal APIs cannot distinguish a terminal interrupt from a
    // SIGINT sent only to the runner PID; both are left to the terminal here.
    let group = rustix::process::getpgrp();
    rustix::termios::tcgetpgrp(std::io::stdin()).ok() == Some(group)
        || rustix::termios::tcgetpgrp(std::io::stdout()).ok() == Some(group)
        || rustix::termios::tcgetpgrp(std::io::stderr()).ok() == Some(group)
}

impl Drop for Termination {
    fn drop(&mut self) {
        self.handle.close();
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
}
