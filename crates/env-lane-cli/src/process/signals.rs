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
                let requested = if signal == SIGINT {
                    rustix::process::Signal::INT
                } else {
                    rustix::process::Signal::TERM
                };
                if let Some(pid) = rustix::process::Pid::from_raw(child.id() as i32) {
                    self.send(pid, requested);
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while Instant::now() < deadline {
                        if child.try_wait()?.is_some() {
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    if child.try_wait()?.is_none() {
                        self.send(pid, rustix::process::Signal::KILL);
                        let _ = child.wait();
                    }
                }
                signal_hook::low_level::emulate_default_handler(signal)?;
            }
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
        }
    }

    fn send(&self, pid: rustix::process::Pid, signal: rustix::process::Signal) {
        if self.isolated_group {
            let _ = rustix::process::kill_process_group(pid, signal);
        } else {
            let _ = rustix::process::kill_process(pid, signal);
        }
    }
}

impl Drop for Termination {
    fn drop(&mut self) {
        self.handle.close();
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
}
