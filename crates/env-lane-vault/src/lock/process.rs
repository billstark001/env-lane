//! Probe ownership conservatively: an inaccessible process may still own a lock.
#[cfg(unix)]
pub(super) fn is_dead(pid: i64) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    let Some(pid) = rustix::process::Pid::from_raw(pid) else {
        return false;
    };
    matches!(
        rustix::process::test_kill_process(pid),
        Err(rustix::io::Errno::SRCH)
    )
}

#[cfg(windows)]
pub(super) fn is_dead(pid: i64) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    let current = Pid::from_u32(std::process::id());
    let requested = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[current, requested]),
        true,
        ProcessRefreshKind::nothing(),
    );
    // If enumeration failed even for this process, absence cannot prove death.
    system.process(current).is_some() && system.process(requested).is_none()
}
