use std::collections::BTreeMap;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::backup::{BackupStoreError, HouseholdSnapshot};

// Mirrors migration 0033 without inferring ownership for standalone legacy groups.
pub(super) fn upgrade_utility_contracts(
    snapshot: &mut HouseholdSnapshot,
) -> Result<(), BackupStoreError> {
    let rows = |table: &str| -> Result<Vec<Value>, BackupStoreError> {
        let Some(value) = snapshot.tables.get(table) else {
            return Ok(Vec::new());
        };
        let rows = value.as_array().ok_or_else(|| {
            BackupStoreError::Validation(format!("table {table} must contain an array"))
        })?;
        if rows.iter().any(|row| !row.is_object()) {
            return Err(BackupStoreError::Validation(format!(
                "table {table} contains a non-object row"
            )));
        }
        Ok(rows.clone())
    };
    let mut services = rows("utility_services")?;
    let mut bills = rows("utility_bills")?;
    let mut links = rows("utility_subject_services")?;
    // Legacy snapshots omit households and its timezone. Use the historical
    // application default for link-only dates; bill charge dates remain exact.
    let timezone = "Europe/Warsaw";
    let mut pairs = BTreeMap::<(String, String), String>::new();
    for row in bills.iter().chain(links.iter()) {
        let (Some(property), Some(service)) =
            (row["property_id"].as_str(), row["service_id"].as_str())
        else {
            continue;
        };
        let date = if let Some(date) = row["charge_date"].as_str() {
            date.to_owned()
        } else {
            let timestamp = row["created_at"].as_str().ok_or_else(|| {
                BackupStoreError::Validation(
                    "legacy utility relationship has no activation date".to_owned(),
                )
            })?;
            let instant = chrono::DateTime::parse_from_rfc3339(timestamp).map_err(|error| {
                BackupStoreError::Validation(format!(
                    "invalid utility activation timestamp: {error}"
                ))
            })?;
            checkbook_domain::time::local_date_at(timezone, instant.with_timezone(&chrono::Utc))
                .map_err(|error| BackupStoreError::Validation(error.to_string()))?
                .to_string()
        };
        let date = date.as_str();
        pairs
            .entry((property.to_owned(), service.to_owned()))
            .and_modify(|existing| {
                if date < existing.as_str() {
                    *existing = date.to_owned();
                }
            })
            .or_insert_with(|| date.to_owned());
    }
    let mut contracts = Vec::new();
    let mut prices = Vec::new();
    let mut import_sources = Vec::new();
    for ((property, old_service), fallback_start) in pairs {
        let service = services
            .iter()
            .find(|s| s["id"].as_str() == Some(&old_service))
            .cloned()
            .ok_or_else(|| {
                BackupStoreError::Validation(
                    "legacy utility references an unknown service".to_owned(),
                )
            })?;
        let digest = Sha256::digest(
            format!("{}:{property}:{old_service}", snapshot.household_id).as_bytes(),
        );
        let mut bytes = [0_u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        let id = Uuid::from_bytes(bytes).to_string();
        let start = bills
            .iter()
            .filter(|b| {
                b["property_id"].as_str() == Some(&property)
                    && b["service_id"].as_str() == Some(&old_service)
            })
            .filter_map(|b| b["charge_date"].as_str())
            .min()
            .unwrap_or(&fallback_start)
            .to_owned();
        import_sources.push(json!({"id":Uuid::new_v4(),"household_id":snapshot.household_id,"property_id":property,"source_service_key":service["service_key"],"utility_contract_id":id}));
        let mut cloned = service.clone();
        cloned["id"] = json!(id);
        cloned["service_key"] = json!(format!("contract_{id}"));
        cloned["is_system"] = json!(false);
        services.push(cloned);
        let order = links
            .iter()
            .find(|l| {
                l["property_id"].as_str() == Some(&property)
                    && l["service_id"].as_str() == Some(&old_service)
            })
            .map_or_else(
                || service["sort_order"].clone(),
                |l| l["sort_order"].clone(),
            );
        // A rate cleared after priced history still describes automatic
        // tracking; derive the mode from the latest priced bill.
        let tracking = if service["unit_rate"].is_null() {
            bills
                .iter()
                .filter(|b| {
                    b["property_id"].as_str() == Some(&property)
                        && b["service_id"].as_str() == Some(&old_service)
                        && !b["unit_rate"].is_null()
                })
                .max_by(|a, b| a["charge_date"].as_str().cmp(&b["charge_date"].as_str()))
                .and_then(|b| b["entry_mode"].as_str())
                .map_or_else(|| json!("actual"), |mode| json!(mode))
        } else {
            service["entry_mode"].clone()
        };
        contracts.push(json!({"id":id,"household_id":snapshot.household_id,"property_id":property,"service_id":id,"start_date":start,"end_date":null,"tracking_mode":tracking,"sort_order":order,"created_at":service["created_at"],"updated_at":service["updated_at"]}));
        let mut observations = BTreeMap::<String, Value>::new();
        let mut matching: Vec<_> = bills
            .iter_mut()
            .filter(|b| {
                b["property_id"].as_str() == Some(&property)
                    && b["service_id"].as_str() == Some(&old_service)
            })
            .collect();
        matching.sort_by(|a, b| {
            a["charge_date"]
                .as_str()
                .cmp(&b["charge_date"].as_str())
                .then_with(|| a["updated_at"].as_str().cmp(&b["updated_at"].as_str()))
                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        });
        for bill in matching {
            bill["service_id"] = json!(id);
            bill["utility_contract_id"] = json!(id);
            if !bill["unit_rate"].is_null() {
                let month = bill["charge_date"]
                    .as_str()
                    .and_then(|d| d.get(..7))
                    .ok_or_else(|| {
                        BackupStoreError::Validation("legacy bill has invalid date".to_owned())
                    })?;
                observations.insert(format!("{month}-01"), bill["unit_rate"].clone());
            }
        }
        // Automatic contracts need a price covering their start month; the
        // configured service rate wins, otherwise the earliest observation
        // backfills months before the first priced bill.
        if tracking.as_str() != Some("actual") {
            let start_month = format!(
                "{}-01",
                start.get(..7).ok_or_else(|| {
                    BackupStoreError::Validation("legacy utility has invalid start date".to_owned())
                })?
            );
            if observations.range(..=start_month.clone()).next().is_none() {
                let fallback = if service["unit_rate"].is_null() {
                    observations.values().next().cloned().ok_or_else(|| {
                        BackupStoreError::Validation(
                            "automatic legacy contract has no tariff evidence".to_owned(),
                        )
                    })?
                } else {
                    service["unit_rate"].clone()
                };
                observations.insert(start_month, fallback);
            }
        }
        for (effective_on, price) in observations {
            prices.push(json!({"id":Uuid::new_v4(),"household_id":snapshot.household_id,"utility_contract_id":id,"effective_on":effective_on,"price":price,"created_at":service["created_at"],"updated_at":service["updated_at"]}));
        }
        for link in &mut links {
            if link["property_id"].as_str() == Some(&property)
                && link["service_id"].as_str() == Some(&old_service)
            {
                link["service_id"] = json!(id);
            }
        }
    }
    for bill in &mut bills {
        let object = bill.as_object_mut().ok_or_else(|| {
            BackupStoreError::Validation("utility_bills contains a non-object row".to_owned())
        })?;
        let source = if object.get("unit_rate").is_some_and(|rate| !rate.is_null()) {
            "auto"
        } else {
            "actual"
        };
        object.entry("utility_contract_id").or_insert(Value::Null);
        object.insert("amount_source".to_owned(), json!(source));
    }
    snapshot
        .tables
        .insert("utility_services".to_owned(), json!(services));
    snapshot
        .tables
        .insert("utility_subject_services".to_owned(), json!(links));
    snapshot
        .tables
        .insert("utility_bills".to_owned(), json!(bills));
    snapshot
        .tables
        .insert("utility_contracts".to_owned(), json!(contracts));
    snapshot
        .tables
        .insert("utility_contract_prices".to_owned(), json!(prices));
    snapshot.tables.insert(
        "utility_contract_import_sources".to_owned(),
        json!(import_sources),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn upgrades_property_pairs_without_touching_financial_or_standalone_history()
    -> Result<(), BackupStoreError> {
        let household = Uuid::new_v4();
        let property = Uuid::new_v4();
        let other_property = Uuid::new_v4();
        let cleared_property = Uuid::new_v4();
        let service = Uuid::new_v4();
        let cleared_service = Uuid::new_v4();
        let bill = Uuid::new_v4();
        let jan_bill = Uuid::new_v4();
        let cleared_jan = Uuid::new_v4();
        let cleared_feb = Uuid::new_v4();
        let group = Uuid::new_v4();
        let reading = json!({"id":Uuid::new_v4(),"utility_bill_id":bill,"reading":"100.1234","previous_reading_id":Uuid::new_v4()});
        let standalone = json!({"id":Uuid::new_v4(),"household_id":household,"property_id":null,"contract_id":group,"service_id":service,"charge_date":"2020-01-01","amount":"7.77","unit_rate":null,"source_key":"standalone"});
        let mut snapshot = HouseholdSnapshot {
            format_version: 2,
            schema_version: 16,
            household_id: household,
            created_at: Utc::now(),
            tables: BTreeMap::from([
                (
                    "utility_services".to_owned(),
                    json!([
                        {"id":service,"household_id":household,"service_key":"power","label":"Power","unit_rate":"0.123456","entry_mode":"meter","sort_order":3,"retired":true,"created_at":"2019-01-01T00:00:00Z","updated_at":"2020-01-01T00:00:00Z"},
                        {"id":cleared_service,"household_id":household,"service_key":"cleared","label":"Cleared","unit_rate":null,"entry_mode":"meter","sort_order":4,"created_at":"2019-01-01T00:00:00Z","updated_at":"2020-01-01T00:00:00Z"}
                    ]),
                ),
                (
                    "utility_bills".to_owned(),
                    json!([
                        {"id":jan_bill,"household_id":household,"property_id":property,"service_id":service,"charge_date":"2020-01-05","amount":"5.55","unit_rate":null,"source_key":"jan"},
                        {"id":bill,"household_id":household,"property_id":property,"service_id":service,"charge_date":"2020-02-17","amount":"12.34","unit_rate":"0.123456","source_key":"unchanged"},
                        standalone.clone(),
                        {"id":cleared_jan,"household_id":household,"property_id":cleared_property,"service_id":cleared_service,"charge_date":"2020-01-06","amount":"7.70","unit_rate":null,"source_key":"cleared-jan"},
                        {"id":cleared_feb,"household_id":household,"property_id":cleared_property,"service_id":cleared_service,"charge_date":"2020-02-06","amount":"8.80","unit_rate":"0.42","entry_mode":"meter","source_key":"cleared-feb"}
                    ]),
                ),
                (
                    "utility_subject_services".to_owned(),
                    json!([
                        {"id":Uuid::new_v4(),"property_id":other_property,"service_id":service,"created_at":"2021-03-04T00:00:00Z","sort_order":1},
                        {"id":Uuid::new_v4(),"property_id":cleared_property,"service_id":cleared_service,"created_at":"2021-03-04T00:00:00Z","sort_order":2}
                    ]),
                ),
                (
                    "utility_meter_readings".to_owned(),
                    json!([reading.clone()]),
                ),
            ]),
        };
        upgrade_utility_contracts(&mut snapshot)?;
        assert_eq!(
            snapshot.tables["utility_contracts"]
                .as_array()
                .map(Vec::len),
            Some(3)
        );
        assert_eq!(
            snapshot.tables["utility_services"].as_array().map(Vec::len),
            Some(5)
        );
        assert_eq!(
            snapshot.tables["utility_contract_prices"]
                .as_array()
                .map(Vec::len),
            Some(5)
        );
        let prices: Vec<&Value> = snapshot.tables["utility_contract_prices"]
            .as_array()
            .into_iter()
            .flatten()
            .collect();
        let price_rows = |contract_id: &str| -> Vec<(String, String)> {
            prices
                .iter()
                .filter(|p| p["utility_contract_id"].as_str() == Some(contract_id))
                .filter_map(|p| {
                    Some((
                        p["effective_on"].as_str()?.to_owned(),
                        p["price"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        };
        let contract_summaries: Vec<(String, String, String)> =
            snapshot.tables["utility_contracts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| {
                    Some((
                        c["property_id"].as_str()?.to_owned(),
                        c["id"].as_str()?.to_owned(),
                        c["tracking_mode"].as_str()?.to_owned(),
                    ))
                })
                .collect();
        let summary_for = |want: Uuid| -> (String, String) {
            contract_summaries
                .iter()
                .find(|(property, _, _)| *property == want.to_string())
                .map(|(_, id, tracking)| (id.clone(), tracking.clone()))
                .unwrap_or_default()
        };
        let (rated_id, rated_tracking) = summary_for(property);
        assert_eq!(rated_tracking, "meter");
        // January actual history precedes the February snapshot, so the start
        // month is backfilled from the configured service rate.
        assert_eq!(
            price_rows(&rated_id),
            vec![
                ("2020-01-01".to_owned(), "0.123456".to_owned()),
                ("2020-02-01".to_owned(), "0.123456".to_owned())
            ]
        );
        let (cleared_id, cleared_tracking) = summary_for(cleared_property);
        // A rate cleared after priced history stays automatic; the earliest
        // observation covers the start month.
        assert_eq!(cleared_tracking, "meter");
        assert_eq!(
            price_rows(&cleared_id),
            vec![
                ("2020-01-01".to_owned(), "0.42".to_owned()),
                ("2020-02-01".to_owned(), "0.42".to_owned())
            ]
        );
        let migrated = &snapshot.tables["utility_bills"][1];
        assert_eq!(migrated["id"], json!(bill));
        assert_eq!(migrated["amount"], "12.34");
        assert_eq!(migrated["unit_rate"], "0.123456");
        assert_eq!(migrated["source_key"], "unchanged");
        assert_eq!(migrated["amount_source"], "auto");
        let january = &snapshot.tables["utility_bills"][0];
        assert_eq!(january["amount"], "5.55");
        assert_eq!(january["amount_source"], "actual");
        assert_eq!(
            snapshot.tables["utility_bills"][2]["service_id"],
            standalone["service_id"]
        );
        assert!(snapshot.tables["utility_bills"][2]["utility_contract_id"].is_null());
        assert_eq!(snapshot.tables["utility_meter_readings"][0], reading);
        for contract in snapshot.tables["utility_contracts"]
            .as_array()
            .into_iter()
            .flatten()
        {
            assert!(contract["end_date"].is_null());
        }
        assert_eq!(
            snapshot.tables["utility_contract_import_sources"]
                .as_array()
                .map(Vec::len),
            Some(3)
        );
        Ok(())
    }
}
