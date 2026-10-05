use base64::{Engine, engine::general_purpose::STANDARD};
use env_lane_core::document::*;
use proptest::prelude::*;
use serde_json::{Value, json};

fn fixture(name: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/../../compat/fixtures/dotenv/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn shared_effective_values_and_document_metadata() {
    for case in fixture("effective-values")["cases"].as_array().unwrap() {
        let content = case["content"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                String::from_utf8_lossy(&STANDARD.decode(case["base64"].as_str().unwrap()).unwrap())
                    .into_owned()
            });
        let doc = Document::parse(&content);
        assert_eq!(
            json!(effective_values(&content)),
            case["values"],
            "{}",
            case["id"]
        );
        assert_eq!(
            json!(
                doc.current_map
                    .iter()
                    .map(|(k, v)| (k.clone(), json!(v.line_number)))
                    .collect::<serde_json::Map<_, _>>()
            ),
            case["lineNumbers"],
            "{}",
            case["id"]
        );
        assert_eq!(
            json!(doc.invalid_line_count),
            case["invalidLineCount"],
            "{}",
            case["id"]
        );
        assert_eq!(
            json!(doc.shadowed_entry_count),
            case["shadowedEntryCount"],
            "{}",
            case["id"]
        );
        assert_eq!(
            json!({"hasBom":doc.document.has_bom,"eol":doc.document.eol,"hasFinalNewline":doc.document.has_final_newline,"lineCount":doc.document.lines.len()}),
            case["document"],
            "{}",
            case["id"]
        );
        if let Some(occurrences) = case.get("occurrences") {
            assert_eq!(
                json!(
                    doc.occurrences_map
                        .iter()
                        .map(|(k, v)| (k.clone(), json!(v.len())))
                        .collect::<serde_json::Map<_, _>>()
                ),
                *occurrences
            );
        }
        let rendered = doc.document.render(&doc.document.lines, true, Eol::Auto);
        assert_eq!(effective_values(&rendered), effective_values(&content));
    }
}
#[test]
fn shared_patch_cases_and_idempotence() {
    for case in fixture("patches")["cases"].as_array().unwrap() {
        let patches = serde_json::from_value::<Vec<Patch>>(
            case.get("nativePatches")
                .unwrap_or(&case["patches"])
                .clone(),
        )
        .unwrap();
        let options = serde_json::from_value::<PatchOptions>(case["options"].clone()).unwrap();
        let result = patch(case["initial"].as_str().unwrap(), &patches, &options).unwrap();
        assert_eq!(json!(result.content), case["expected"], "{}", case["id"]);
        let again = patch(&result.content, &patches, &options).unwrap();
        assert!(!again.changed, "{}", case["id"]);
        assert!(again.written_keys.is_empty());
    }
}
#[test]
fn shared_format_values() {
    for case in fixture("format-values")["cases"].as_array().unwrap() {
        let result = format_value(case["value"].as_str().unwrap());
        if let Some(error) = case.get("error") {
            assert_eq!(json!(result.unwrap_err().code), *error);
        } else {
            assert_eq!(json!(result.unwrap()), case["formatted"], "{}", case["id"]);
        }
    }
}
proptest! {
    #[test]
    fn formatted_values_round_trip(value in ".{0,160}") {
        if let Ok(formatted) = format_value(&value) { let values = effective_values(&format!("KEY={formatted}")); prop_assert_eq!(values.get("KEY"),Some(&value)); }
    }
    #[test]
    fn document_render_is_stable(lines in prop::collection::vec("[^\r\n]{0,80}",0..20), bom in any::<bool>(), final_newline in any::<bool>()) {
        let mut content = lines.join("\n");
        if final_newline { content.push('\n'); }
        if bom { content.insert(0,'\u{feff}'); }
        let doc=Document::parse(&content);
        prop_assert_eq!(doc.document.render(&doc.document.lines,true,Eol::Auto),content);
    }
}

#[test]
fn minimized_differential_regressions() {
    for case in fixture("rust-regressions")["cases"].as_array().unwrap() {
        let content = case["content"].as_str().unwrap();
        let doc = Document::parse(content);
        assert_eq!(
            json!(effective_values(content)),
            case["values"],
            "{}",
            case["id"]
        );
        assert_eq!(json!(doc.invalid_line_count), case["invalidLineCount"]);
        let lines = json!(doc.parsed_lines);
        assert_eq!(
            json!(
                lines
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| l["kind"].clone())
                    .collect::<Vec<_>>()
            ),
            case["lineKinds"]
        );
    }
}
