//! Stable presentation helpers. Grouping never changes domain plans or decisions.
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct VariableGroup {
    pub prefix: Option<String>,
    pub keys: Vec<String>,
}

pub fn group_keys(keys: &[String]) -> Vec<VariableGroup> {
    let mut remaining: BTreeSet<String> = keys.iter().cloned().collect();
    let mut candidates: BTreeMap<Vec<String>, Vec<String>> = BTreeMap::new();
    for key in &remaining {
        let words: Vec<_> = key
            .split(['_', '-'])
            .filter(|word| !word.is_empty())
            .map(str::to_owned)
            .collect();
        for length in 1..=words.len() {
            candidates
                .entry(words[..length].to_vec())
                .or_default()
                .push(key.clone());
        }
    }
    let mut candidates: Vec<_> = candidates.into_iter().collect();
    candidates.sort_by(|(a, _), (b, _)| b.len().cmp(&a.len()).then(a.cmp(b)));
    let mut groups = Vec::new();
    for (words, members) in candidates {
        let members: Vec<_> = members
            .into_iter()
            .filter(|key| remaining.contains(key))
            .collect();
        if members.len() < 3 {
            continue;
        }
        for key in &members {
            remaining.remove(key);
        }
        groups.push(VariableGroup {
            prefix: Some(words.join("_")),
            keys: members,
        });
    }
    groups.sort_by(|a, b| a.prefix.cmp(&b.prefix));
    if !remaining.is_empty() {
        groups.push(VariableGroup {
            prefix: None,
            keys: remaining.into_iter().collect(),
        });
    }
    groups
}

/// Escape terminal controls before measuring or drawing text from user files.
pub fn inline(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            if character.is_control() {
                character.escape_default().collect::<Vec<_>>()
            } else {
                vec![character]
            }
        })
        .collect()
}

pub fn width(value: &str) -> usize {
    UnicodeWidthStr::width(value)
}

pub fn truncate(value: &str, columns: usize) -> String {
    let value = inline(value);
    if width(&value) <= columns {
        return value;
    }
    if columns == 0 {
        return String::new();
    }
    let mut result = String::new();
    for grapheme in value.graphemes(true) {
        if width(&result) + width(grapheme) + 1 > columns {
            break;
        }
        result.push_str(grapheme);
    }
    result.push('…');
    result
}

/// Wrap explicit detail views without splitting a grapheme or emitting controls.
pub fn wrap(value: &str, columns: usize) -> Vec<String> {
    if columns == 0 {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    for line in value.split('\n') {
        let value = inline(line);
        let mut piece = String::new();
        for grapheme in value.graphemes(true) {
            if width(&piece) + width(grapheme) > columns && !piece.is_empty() {
                lines.push(std::mem::take(&mut piece));
            }
            piece.push_str(&truncate(grapheme, columns));
        }
        lines.push(piece);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    proptest! {
        #[test]
        fn grouping_is_unique_order_independent_and_greedy(
            inputs in prop::collection::vec((prop::collection::vec(0u8..5, 1..5), any::<bool>()), 0..70)
        ) {
            let keys = inputs.iter().map(|(words, hyphen)| words.iter().map(u8::to_string).collect::<Vec<_>>().join(if *hyphen { "-" } else { "_" })).collect::<Vec<_>>();
            let groups = group_keys(&keys);
            let mut reordered = keys.clone();
            reordered.reverse();
            reordered.extend(keys.clone());
            prop_assert_eq!(&groups, &group_keys(&reordered));
            let rendered = groups.iter().flat_map(|group| group.keys.iter().cloned()).collect::<Vec<_>>();
            prop_assert_eq!(rendered.len(), keys.iter().collect::<BTreeSet<_>>().len());
            prop_assert_eq!(rendered.into_iter().collect::<BTreeSet<_>>(), keys.into_iter().collect());
            for group in groups.iter().filter(|group| group.prefix.is_some()) {
                prop_assert!(group.keys.len() >= 3);
                let prefix = group.prefix.as_ref().unwrap().split('_').collect::<Vec<_>>();
                let mut descendants: BTreeMap<Vec<&str>, usize> = BTreeMap::new();
                for key in &group.keys {
                    let words = key.split(['_', '-']).filter(|word| !word.is_empty()).collect::<Vec<_>>();
                    prop_assert!(words.starts_with(&prefix));
                    for length in prefix.len() + 1..=words.len() {
                        *descendants.entry(words[..length].to_vec()).or_default() += 1;
                    }
                }
                prop_assert!(descendants.values().all(|count| *count < 3));
            }
        }
    }
    #[test]
    fn groups_count_distinct_keys_and_include_complete_prefix_keys() {
        let keys = ["DB", "DB_HOST", "DB-PORT", "OTHER_A", "OTHER_A"].map(str::to_owned);
        let groups = group_keys(&keys);
        assert_eq!(groups[0].prefix.as_deref(), Some("DB"));
        assert_eq!(groups[0].keys.len(), 3);
        assert_eq!(groups[1].prefix, None);
        assert_eq!(groups[1].keys, ["OTHER_A"]);
    }
    #[test]
    fn greedy_groups_leave_parent_members_available() {
        let keys = [
            "AWS_S3_A",
            "AWS_S3_B",
            "AWS_S3_C",
            "AWS_EC2_A",
            "AWS_EC2_B",
            "AWS_EC2_C",
            "AWS_A",
            "AWS_B",
            "AWS_C",
            "AWS_C",
        ]
        .map(str::to_owned);
        let groups = group_keys(&keys);
        assert_eq!(
            groups
                .iter()
                .map(|group| group.prefix.as_deref())
                .collect::<Vec<_>>(),
            [Some("AWS"), Some("AWS_EC2"), Some("AWS_S3")]
        );
        assert!(groups.iter().all(|group| group.keys.len() == 3));
    }
    #[test]
    fn word_boundaries_case_and_display_width_are_preserved() {
        let groups = group_keys(&["DB-A", "DB_B", "DB_C", "DBA_D", "db_E"].map(str::to_owned));
        assert_eq!(groups[0].prefix.as_deref(), Some("DB"));
        for columns in 0..12 {
            assert!(width(&truncate("中文👨‍👩‍👧‍👦e\u{301}\n", columns)) <= columns);
        }
        assert_eq!(inline("a\x1bb\n"), "a\\u{1b}b\\n");
    }
}
