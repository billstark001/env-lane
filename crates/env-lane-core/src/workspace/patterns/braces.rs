//! Expand brace alternatives before choosing filesystem scan roots. Unlike shell
//! expansion, whitespace is part of a pathname and must never split a pattern.
use crate::error::{Error, Result};
use indexmap::IndexSet;

const MAX_RANGE: usize = 1000;
const MAX_PATTERNS: usize = 10000;

pub(super) fn expand(pattern: &str) -> Result<Vec<String>> {
    let mut pending = vec![pattern.to_owned()];
    let mut result = IndexSet::new();
    while let Some(pattern) = pending.pop() {
        if let Some((start, end, alternatives)) = find_expansion(&pattern)? {
            if pending.len() + result.len() + alternatives.len() > MAX_PATTERNS {
                return Err(limit_error());
            }
            for alternative in alternatives.into_iter().rev() {
                pending.push(format!(
                    "{}{alternative}{}",
                    &pattern[..start],
                    &pattern[end + 1..]
                ));
            }
        } else if !pattern.is_empty() {
            result.insert(pattern);
        }
    }
    Ok(result.into_iter().collect())
}

type Expansion = (usize, usize, Vec<String>);
fn find_expansion(pattern: &str) -> Result<Option<Expansion>> {
    let mut openings = Vec::new();
    let mut escaped = false;
    for (index, character) in pattern.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '{' => openings.push(index),
            '}' => {
                if let Some(start) = openings.pop()
                    && let Some(alternatives) = alternatives(&pattern[start + 1..index])?
                {
                    return Ok(Some((start, index, alternatives)));
                }
            }
            _ => {}
        }
    }
    Ok(None)
}

fn alternatives(content: &str) -> Result<Option<Vec<String>>> {
    let mut commas = Vec::new();
    let mut depth = 0_usize;
    let mut escaped = false;
    for (index, character) in content.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => commas.push(index),
            _ => {}
        }
    }
    if !commas.is_empty() {
        let mut values = Vec::new();
        let mut start = 0;
        for end in commas {
            values.push(content[start..end].to_owned());
            start = end + 1;
        }
        values.push(content[start..].to_owned());
        return Ok(Some(values));
    }
    range(content)
}

fn range(content: &str) -> Result<Option<Vec<String>>> {
    let parts: Vec<_> = content.split("..").collect();
    if !(2..=3).contains(&parts.len()) {
        return Ok(None);
    }
    let step = match parts.get(2) {
        Some(value) => match value.parse::<i64>() {
            Ok(value) => value.unsigned_abs().max(1),
            Err(_) => return Ok(None),
        },
        None => 1,
    };
    let numeric = parts[0]
        .parse::<i64>()
        .ok()
        .zip(parts[1].parse::<i64>().ok());
    let (start, end, width, alphabetic) = if let Some((start, end)) = numeric {
        let padded = parts[..2].iter().any(|part| {
            part.trim_start_matches('-').starts_with('0') && part.trim_start_matches('-').len() > 1
        });
        (
            start,
            end,
            if padded {
                parts[0].len().max(parts[1].len())
            } else {
                0
            },
            false,
        )
    } else if parts[..2]
        .iter()
        .all(|part| part.len() == 1 && part.as_bytes()[0].is_ascii_alphabetic())
    {
        (
            i64::from(parts[0].as_bytes()[0]),
            i64::from(parts[1].as_bytes()[0]),
            0,
            true,
        )
    } else {
        return Ok(None);
    };
    let count = u128::from(start.abs_diff(end)) / u128::from(step) + 1;
    if count > MAX_RANGE as u128 {
        return Err(limit_error());
    }
    let mut values = Vec::new();
    for offset in 0..count as u64 {
        let distance = i128::from(offset) * i128::from(step);
        let value = i128::from(start) + if end >= start { distance } else { -distance };
        values.push(if alphabetic {
            char::from(value as u8).to_string()
        } else {
            format!("{value:0width$}")
        });
    }
    Ok(Some(values))
}

fn limit_error() -> Error {
    Error::new(
        "INVALID_WORKSPACE_GLOB",
        "Workspace brace expansion exceeds its pattern limit.",
    )
}
