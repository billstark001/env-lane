//! Vault TTY selection. The domain plan supplies only redacted previews.
use crossterm::{
    cursor::MoveTo,
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use env_lane_core::error::{Error, Result};
use env_lane_vault::{
    restore::{Action, Decision, DecisionChoice, Entry, Plan},
    selection::PreparedFilter,
};
use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
};

fn input_error(error: io::Error) -> Error {
    Error::new("INPUT_FAILED", error.to_string())
}
fn cancelled() -> Error {
    Error::new(
        "VAULT_CANCELLED",
        "Vault operation cancelled. No files were changed.",
    )
}
fn non_interactive() -> Error {
    Error::new(
        "NON_INTERACTIVE_INPUT",
        "An interactive terminal is required. Re-run with --non-interactive --yes and explicit policies.",
    )
}
fn action(action: Action) -> &'static str {
    match action {
        Action::Add => "add",
        Action::Modify => "modify",
        Action::Delete => "delete",
        Action::Conflict => "conflict",
        Action::Identical => "identical",
    }
}
struct Terminal;
impl Terminal {
    fn enter() -> Result<Self> {
        if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
            return Err(non_interactive());
        }
        terminal::enable_raw_mode().map_err(input_error)?;
        if let Err(error) = execute!(io::stderr().lock(), EnterAlternateScreen) {
            let _ = terminal::disable_raw_mode();
            return Err(input_error(error));
        }
        Ok(Self)
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = execute!(io::stderr().lock(), LeaveAlternateScreen);
        let _ = terminal::disable_raw_mode();
    }
}
fn draw(
    entries: &[&Entry],
    selected: &[bool],
    cursor: usize,
    redaction: &str,
    reveal: Option<(u8, u8)>,
) -> Result<()> {
    let (columns, rows) = terminal::size().unwrap_or((80, 24));
    let page = usize::from(rows.saturating_sub(4).clamp(1, 10));
    let start = cursor / page * page;
    let mut stderr = io::stderr().lock();
    execute!(stderr, MoveTo(0, 0), Clear(ClearType::All)).map_err(input_error)?;
    let reveal = reveal.map_or(String::new(), |(start, end)| {
        format!(", reveal: {start}:{end}")
    });
    writeln!(
        stderr,
        "Select Vault entries to apply (preview redaction: {redaction}{reveal})"
    )
    .map_err(input_error)?;
    let mut last_file = PathBuf::new();
    for (index, entry) in entries.iter().enumerate().skip(start).take(page) {
        if entry.file_path != last_file {
            last_file = entry.file_path.clone();
            writeln!(stderr, "  {}", last_file.display()).map_err(input_error)?;
        }
        let name: String = entry.key.chars().take(64).collect();
        let name = if entry.key.chars().count() > 64 {
            format!("{}…", name.chars().take(63).collect::<String>())
        } else {
            name
        };
        let current = serde_json::to_string(&entry.preview.current).unwrap_or_default();
        let vault = serde_json::to_string(&entry.preview.vault).unwrap_or_default();
        let line = format!(
            "{} [{}] {:<8} {:<64}  {} → {}",
            if index == cursor { '❯' } else { ' ' },
            if selected[index] { 'x' } else { ' ' },
            action(entry.action),
            name,
            current.trim_matches('"'),
            vault.trim_matches('"')
        );
        writeln!(
            stderr,
            "{}",
            line.chars().take(usize::from(columns)).collect::<String>()
        )
        .map_err(input_error)?;
    }
    writeln!(
        stderr,
        "↑↓ navigate • space select • a all • i invert • ⏎ submit • esc/q cancel"
    )
    .map_err(input_error)?;
    stderr.flush().map_err(input_error)
}

pub fn choose(
    plan: &Plan,
    filter: &PreparedFilter,
    loop_navigation: bool,
    redaction: &str,
    reveal: Option<(u8, u8)>,
) -> Result<Vec<Decision>> {
    let mut entries = Vec::new();
    for entry in plan.files.iter().flat_map(|file| &file.entries) {
        if entry.action != Action::Identical
            && filter.selected(&entry.file_path, &entry.key, action(entry.action))?
        {
            entries.push(entry);
        }
    }
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let _terminal = Terminal::enter()?;
    let mut selected: Vec<bool> = entries
        .iter()
        .map(|entry| {
            entry.action != Action::Conflict
                && (entry.action != Action::Delete || filter.approve_deletes)
        })
        .collect();
    let mut cursor = 0_usize;
    loop {
        draw(&entries, &selected, cursor, redaction, reveal)?;
        let Event::Key(key) = event::read().map_err(input_error)? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => return Err(cancelled()),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return Err(cancelled());
            }
            KeyCode::Up => {
                if cursor > 0 {
                    cursor -= 1;
                } else if loop_navigation {
                    cursor = entries.len() - 1;
                }
            }
            KeyCode::Down => {
                if cursor + 1 < entries.len() {
                    cursor += 1;
                } else if loop_navigation {
                    cursor = 0;
                }
            }
            KeyCode::Char(' ') => selected[cursor] = !selected[cursor],
            KeyCode::Char('a') => selected.fill(true),
            KeyCode::Char('i') => selected.iter_mut().for_each(|value| *value = !*value),
            KeyCode::Enter => break,
            _ => {}
        }
    }
    let count = selected.iter().filter(|value| **value).count();
    execute!(io::stderr().lock(), MoveTo(0, 0), Clear(ClearType::All)).map_err(input_error)?;
    write!(
        io::stderr().lock(),
        "Apply {count} selected entries? [y/N] "
    )
    .map_err(input_error)?;
    io::stderr().flush().map_err(input_error)?;
    loop {
        let Event::Key(key) = event::read().map_err(input_error)? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Char('y' | 'Y') => break,
            KeyCode::Char('n' | 'N') | KeyCode::Enter => {
                return Err(Error::new(
                    "VAULT_CANCELLED",
                    "Vault apply cancelled. No files were changed.",
                ));
            }
            KeyCode::Esc | KeyCode::Char('q') => return Err(cancelled()),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return Err(cancelled());
            }
            _ => {}
        }
    }
    Ok(plan
        .files
        .iter()
        .flat_map(|file| &file.entries)
        .filter(|entry| entry.action != Action::Identical)
        .map(|entry| {
            let selected_index = entries
                .iter()
                .position(|candidate| candidate.entry_id == entry.entry_id);
            let choice = if selected_index.is_some_and(|index| selected[index]) {
                DecisionChoice::ApplyVault
            } else if entry.action == Action::Conflict {
                DecisionChoice::KeepLocal
            } else {
                DecisionChoice::Skip
            };
            Decision {
                entry_id: entry.entry_id.clone(),
                decision: choice,
            }
        })
        .collect())
}
