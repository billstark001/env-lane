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
    time::Duration,
};

pub(super) struct Termination {
    signals: Receiver<i32>,
    handle: Handle,
    listener: Option<JoinHandle<()>>,
}

impl Termination {
    pub(super) fn listen() -> io::Result<Self> {
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
        })
    }

    pub(super) fn wait(&self, child: &mut Child) -> io::Result<ExitStatus> {
        loop {
            if let Ok(signal) = self.signals.recv_timeout(Duration::from_millis(10)) {
                // The CLI retains the signal that terminated it. Child cleanup
                // requests graceful termination even when the parent received INT.
                if let Some(pid) = rustix::process::Pid::from_raw(child.id() as i32) {
                    let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
                }
                signal_hook::low_level::emulate_default_handler(signal)?;
            }
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
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
