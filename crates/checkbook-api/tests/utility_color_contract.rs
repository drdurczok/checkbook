use checkbook_api::dto::{TrackedField, UtilityContractUpdate};
use serde_json::json;

#[test]
fn utility_color_transport_distinguishes_missing_null_and_string() -> anyhow::Result<()> {
    let mut payload = json!({
        "label": "Water", "unit": "m3", "tracking_mode": "meter", "start_date": "2026-01-01", "end_date": null
    });
    let missing: UtilityContractUpdate = serde_json::from_value(payload.clone())?;
    assert_eq!(missing.color, None);
    payload["color"] = serde_json::Value::Null;
    let clear: UtilityContractUpdate = serde_json::from_value(payload.clone())?;
    assert_eq!(clear.color, Some(None));
    payload["color"] = json!("#aB12Ef");
    let set: UtilityContractUpdate = serde_json::from_value(payload.clone())?;
    assert_eq!(set.color, Some(Some("#aB12Ef".to_owned())));
    payload["color"] = json!(123);
    assert!(serde_json::from_value::<UtilityContractUpdate>(payload).is_err());

    let legacy: TrackedField = serde_json::from_value(json!({
        "key": "water", "label": "Water", "kind": "metered", "unit": "m3"
    }))?;
    assert_eq!(legacy.color, None);
    assert!(serde_json::to_value(legacy)?["color"].is_null());
    Ok(())
}

#[test]
fn utility_color_openapi_is_optional_nullable_hex() -> anyhow::Result<()> {
    let document = checkbook_api::openapi_document()?;
    let config = &document["components"]["schemas"]["UtilityContractUpdate"];
    let required = config["required"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing required fields"))?;
    assert!(!required.contains(&json!("color")));
    assert_eq!(
        config["properties"]["color"]["pattern"],
        "^#[0-9A-Fa-f]{6}$"
    );
    for name in ["TrackedField", "UtilityEntryFormField"] {
        assert!(
            document["components"]["schemas"][name]["properties"]
                .get("color")
                .is_some()
        );
    }
    Ok(())
}
