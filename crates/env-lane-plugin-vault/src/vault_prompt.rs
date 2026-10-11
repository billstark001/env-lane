//! Vault TTY selection. The domain plan supplies only redacted previews.
use crossterm::{
    cursor::{Hide, MoveTo, Show},
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute, queue,
    style::Print,
    terminal::{
        self, Clear, ClearType, DisableLineWrap, EnableLineWrap, EnterAlternateScreen,
        LeaveAlternateScreen,
    },
};
use env_lane_core::error::{Error, Result};
use env_lane_vault::{
    restore::{Action, Decision, DecisionChoice, Entry, Plan},
    selection::PreparedFilter,
};
use std::{
    io::{self, IsTerminal, Write},
    path::Path,
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
        if let Err(error) = execute!(
            io::stderr().lock(),
            EnterAlternateScreen,
            DisableLineWrap,
            Hide
        ) {
            let _ = execute!(
                io::stderr().lock(),
                Show,
                EnableLineWrap,
                LeaveAlternateScreen
            );
            let _ = terminal::disable_raw_mode();
            return Err(input_error(error));
        }
        Ok(Self)
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = execute!(
            io::stderr().lock(),
            Show,
            EnableLineWrap,
            LeaveAlternateScreen
        );
        let _ = terminal::disable_raw_mode();
    }
}
struct Frame {
    lines: Vec<String>,
}
fn list_lines(
    entries: &[&Entry],
    selected: &[bool],
    cursor: usize,
    root: &Path,
    columns: usize,
) -> (Vec<String>, usize) {
    use env_lane_core::{
        paths::relative_path,
        presentation::{group_keys, inline, truncate, width},
    };
    let mut lines = Vec::new();
    let mut current = 0;
    let mut start = 0;
    let key_width = entries
        .iter()
        .map(|entry| width(&entry.key))
        .max()
        .unwrap_or(0)
        .min(columns.saturating_sub(18))
        .min(48);
    while start < entries.len() {
        let file = &entries[start].file_path;
        let end = entries[start..]
            .iter()
            .position(|entry| entry.file_path != *file)
            .map_or(entries.len(), |offset| start + offset);
        lines.push(relative_path(root, file));
        let keys = entries[start..end]
            .iter()
            .map(|entry| entry.key.clone())
            .collect::<Vec<_>>();
        for group in group_keys(&keys) {
            if let Some(prefix) = group.prefix {
                lines.push(format!("  {prefix} ({})", group.keys.len()));
            }
            for key in group.keys {
                let index = (start..end)
                    .find(|index| entries[*index].key == key)
                    .unwrap();
                let entry = entries[index];
                if index == cursor {
                    current = lines.len();
                }
                let name = truncate(&entry.key, key_width);
                let marker = if index == cursor { '❯' } else { ' ' };
                let checkbox = if selected[index] { 'x' } else { ' ' };
                let line = if columns < 40 {
                    format!(
                        "{marker}[{checkbox}] {} {}",
                        action(entry.action),
                        inline(&entry.key)
                    )
                } else {
                    let padding = " ".repeat(key_width.saturating_sub(width(&name)));
                    format!(
                        "{marker} [{checkbox}] {:<8} {name}{padding}  {} → {}",
                        action(entry.action),
                        inline(&entry.preview.current),
                        inline(&entry.preview.vault)
                    )
                };
                lines.push(line);
            }
        }
        start = end;
    }
    (lines, current)
}
#[derive(Clone, Copy)]
struct View<'a> {
    entries: &'a [&'a Entry],
    selected: &'a [bool],
    cursor: usize,
    root: &'a Path,
    redaction: &'a str,
    reveal: Option<(u8, u8)>,
    expanded: bool,
    scroll: usize,
}
fn frame(view: &View<'_>, columns: usize, rows: usize) -> Frame {
    let View {
        entries,
        selected,
        cursor,
        root,
        redaction,
        reveal,
        expanded,
        scroll,
    } = *view;
    use env_lane_core::presentation::{inline, truncate};
    let width = columns.saturating_sub(1);
    let reveal = reveal.map_or(String::new(), |(start, end)| {
        format!(", reveal: {start}:{end}")
    });
    let mut lines = vec![format!(
        "Select Vault entries to apply ({redaction}{reveal})"
    )];
    if expanded {
        let entry = entries[cursor];
        let text = format!(
            "{}\n{} {}\nCurrent: {}\nVault: {}",
            env_lane_core::paths::relative_path(root, &entry.file_path),
            action(entry.action),
            inline(&entry.key),
            inline(&entry.preview.current),
            inline(&entry.preview.vault)
        );
        let detail = env_lane_core::presentation::wrap(&text, width);
        let height = rows.saturating_sub(2);
        let scroll = scroll.min(detail.len().saturating_sub(height));
        lines.extend(detail.into_iter().skip(scroll).take(height));
        lines.push("v back • ↑↓ scroll • esc/q cancel".into());
    } else {
        let details = if rows >= 8 { 3 } else { 0 };
        let body_height = rows.saturating_sub(2 + details);
        let (body, focus) = list_lines(entries, selected, cursor, root, width);
        let start = focus.saturating_sub(body_height.saturating_sub(1));
        lines.extend(body.into_iter().skip(start).take(body_height));
        if details > 0 {
            let entry = entries[cursor];
            lines.push(format!(
                "{} · {} [{} / {}]",
                inline(&entry.key),
                env_lane_core::paths::relative_path(root, &entry.file_path),
                cursor + 1,
                entries.len()
            ));
            lines.push(format!("Current: {}", inline(&entry.preview.current)));
            lines.push(format!("Vault:   {}", inline(&entry.preview.vault)));
        }
        lines.push(if width >= 90 { "↑↓ navigate • space select • a all • i invert • v details • enter submit • esc/q cancel" } else { "↑↓ move • space select • v details • enter apply • q cancel" }.into());
    }
    Frame {
        lines: lines
            .into_iter()
            .take(rows)
            .map(|line| truncate(&line, width))
            .collect(),
    }
}
fn paint(frame: &Frame) -> Result<()> {
    let mut stderr = io::stderr().lock();
    queue!(stderr, MoveTo(0, 0), Clear(ClearType::All)).map_err(input_error)?;
    for (row, line) in frame.lines.iter().enumerate() {
        queue!(stderr, MoveTo(0, row as u16), Print(line)).map_err(input_error)?;
    }
    stderr.flush().map_err(input_error)
}
fn draw(view: &View<'_>) -> Result<()> {
    let (columns, rows) = terminal::size().unwrap_or((80, 24));
    paint(&frame(view, usize::from(columns), usize::from(rows)))
}

pub fn choose(
    plan: &Plan,
    root: &Path,
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
    let mut ordered = Vec::new();
    for file in &plan.files {
        let keys = entries
            .iter()
            .filter(|entry| entry.file_path == file.file_path)
            .map(|entry| entry.key.clone())
            .collect::<Vec<_>>();
        for group in env_lane_core::presentation::group_keys(&keys) {
            for key in group.keys {
                ordered.extend(
                    entries
                        .iter()
                        .filter(|entry| entry.file_path == file.file_path && entry.key == key)
                        .copied(),
                );
            }
        }
    }
    entries = ordered;
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
    let mut expanded = false;
    let mut scroll = 0;
    loop {
        draw(&View {
            entries: &entries,
            selected: &selected,
            cursor,
            root,
            redaction,
            reveal,
            expanded,
            scroll,
        })?;
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
            KeyCode::Char('v') => {
                expanded = !expanded;
                scroll = 0;
            }
            KeyCode::Up if expanded => scroll = scroll.saturating_sub(1),
            KeyCode::Down if expanded => scroll += 1,
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
    loop {
        let (columns, rows) = terminal::size().unwrap_or((80, 24));
        paint(&Frame {
            lines: if rows == 0 {
                vec![]
            } else {
                vec![env_lane_core::presentation::truncate(
                    &format!("Apply {count} selected entries? [y/N]"),
                    usize::from(columns).saturating_sub(1),
                )]
            },
        })?;
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_frame_fits_and_focus_survives_narrow_windows() {
        use env_lane_vault::restore::Preview;
        let entries = (0..24)
            .map(|index| Entry {
                entry_id: index.to_string(),
                file_path: format!("/workspace/long-path-{index}/.env.production").into(),
                key: format!("AWS_S3_LONG_KEY_{index}"),
                action: Action::Modify,
                preview: Preview {
                    current: "中文\nold value".into(),
                    vault: "new value with long text".into(),
                },
                occurrence_count: 1,
                conflict: false,
                vault_action: Action::Modify,
                conflict_reason: None,
            })
            .collect::<Vec<_>>();
        let refs = entries.iter().collect::<Vec<_>>();
        for columns in [1, 20, 40, 80, 160] {
            for rows in [1, 4, 8, 12, 24] {
                for expanded in [false, true] {
                    let selected = vec![true; 24];
                    let frame = frame(
                        &View {
                            entries: &refs,
                            selected: &selected,
                            cursor: 23,
                            root: Path::new("/workspace"),
                            redaction: "full",
                            reveal: None,
                            expanded,
                            scroll: 0,
                        },
                        columns,
                        rows,
                    );
                    assert!(frame.lines.len() <= rows);
                    assert!(
                        frame
                            .lines
                            .iter()
                            .all(|line| env_lane_core::presentation::width(line) < columns)
                    );
                    assert!(
                        frame
                            .lines
                            .iter()
                            .all(|line| !line.contains(['\n', '\r', '\x1b']))
                    );
                }
            }
        }
    }
}
