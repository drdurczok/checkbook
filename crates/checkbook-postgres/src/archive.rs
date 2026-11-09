use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read, Write},
};

use crate::backup::{BACKUP_TABLES, HouseholdSnapshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const ARCHIVE_FORMAT: &str = "checkbook-backup";
const MAX_ARCHIVE_ENTRIES: usize = 128;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_TABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct ArchiveManifest {
    format: String,
    format_version: u32,
    schema_version: i64,
    household_id: uuid::Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    tables: Vec<ArchiveTable>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ArchiveTable {
    name: String,
    row_count: usize,
    json_path: String,
    json_sha256: String,
    csv_path: String,
    csv_sha256: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BackupArchiveError {
    #[error("backup archive is invalid")]
    Invalid,
    #[error("backup archive exceeds safety limits")]
    Limit,
    #[error("backup archive checksum validation failed")]
    Checksum,
    #[error("backup archive is incompatible with this application")]
    Incompatible,
    #[error("backup archive could not be serialized")]
    Serialization,
}

pub fn build_archive(snapshot: &HouseholdSnapshot) -> Result<Vec<u8>, BackupArchiveError> {
    let mut table_files = Vec::with_capacity(BACKUP_TABLES.len());
    let mut manifest_tables = Vec::with_capacity(BACKUP_TABLES.len());
    for table in BACKUP_TABLES {
        let rows = snapshot
            .tables
            .get(*table)
            .and_then(Value::as_array)
            .ok_or(BackupArchiveError::Serialization)?;
        let json = serde_json::to_vec(rows).map_err(|_| BackupArchiveError::Serialization)?;
        let csv = table_csv(rows)?;
        let json_path = format!("tables/{table}.json");
        let csv_path = format!("csv/{table}.csv");
        manifest_tables.push(ArchiveTable {
            name: (*table).to_owned(),
            row_count: rows.len(),
            json_path: json_path.clone(),
            json_sha256: digest(&json),
            csv_path: csv_path.clone(),
            csv_sha256: digest(&csv),
        });
        table_files.push((json_path, json, csv_path, csv));
    }
    let manifest = ArchiveManifest {
        format: ARCHIVE_FORMAT.to_owned(),
        format_version: snapshot.format_version,
        schema_version: snapshot.schema_version,
        household_id: snapshot.household_id,
        created_at: snapshot.created_at,
        tables: manifest_tables,
    };
    let manifest =
        serde_json::to_vec_pretty(&manifest).map_err(|_| BackupArchiveError::Serialization)?;
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let cursor = Cursor::new(Vec::new());
    let mut archive = ZipWriter::new(cursor);
    archive
        .start_file("manifest.json", options)
        .map_err(|_| BackupArchiveError::Serialization)?;
    archive
        .write_all(&manifest)
        .map_err(|_| BackupArchiveError::Serialization)?;
    for (json_path, json, csv_path, csv) in table_files {
        archive
            .start_file(json_path, options)
            .map_err(|_| BackupArchiveError::Serialization)?;
        archive
            .write_all(&json)
            .map_err(|_| BackupArchiveError::Serialization)?;
        archive
            .start_file(csv_path, options)
            .map_err(|_| BackupArchiveError::Serialization)?;
        archive
            .write_all(&csv)
            .map_err(|_| BackupArchiveError::Serialization)?;
    }
    archive
        .finish()
        .map(Cursor::into_inner)
        .map_err(|_| BackupArchiveError::Serialization)
}

pub fn parse_archive(bytes: &[u8]) -> Result<HouseholdSnapshot, BackupArchiveError> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|_| BackupArchiveError::Invalid)?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(BackupArchiveError::Limit);
    }
    let mut total_size = 0_u64;
    let mut files = BTreeMap::<String, Vec<u8>>::new();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| BackupArchiveError::Invalid)?;
        let enclosed = file
            .enclosed_name()
            .ok_or(BackupArchiveError::Invalid)?
            .to_string_lossy()
            .replace('\\', "/");
        if enclosed.ends_with('/') || files.contains_key(&enclosed) {
            return Err(BackupArchiveError::Invalid);
        }
        let limit = if enclosed == "manifest.json" {
            MAX_MANIFEST_BYTES
        } else {
            MAX_TABLE_BYTES
        };
        if file.size() > limit {
            return Err(BackupArchiveError::Limit);
        }
        total_size = total_size.saturating_add(file.size());
        if total_size > MAX_UNCOMPRESSED_BYTES {
            return Err(BackupArchiveError::Limit);
        }
        let mut content = Vec::with_capacity(
            usize::try_from(file.size()).map_err(|_| BackupArchiveError::Limit)?,
        );
        file.read_to_end(&mut content)
            .map_err(|_| BackupArchiveError::Invalid)?;
        files.insert(enclosed, content);
    }
    let manifest_bytes = files
        .get("manifest.json")
        .ok_or(BackupArchiveError::Invalid)?;
    let manifest: ArchiveManifest =
        serde_json::from_slice(manifest_bytes).map_err(|_| BackupArchiveError::Invalid)?;
    let mut expected_tables = BACKUP_TABLES.iter().copied().collect::<BTreeSet<_>>();
    // Historical archives predate these tables; schema upgrade reconstructs contracts.
    if (4..=16).contains(&manifest.schema_version) {
        expected_tables.remove("utility_contracts");
        expected_tables.remove("utility_contract_prices");
        expected_tables.remove("utility_contract_import_sources");
    }
    if (4..=13).contains(&manifest.schema_version) {
        expected_tables.remove("utility_months");
    }
    if (4..=12).contains(&manifest.schema_version) {
        expected_tables.remove("holding_price_cache");
    }
    if (4..=10).contains(&manifest.schema_version) {
        expected_tables.remove("account_holdings");
    }
    if (4..=8).contains(&manifest.schema_version) {
        expected_tables.remove("payday_templates");
        expected_tables.remove("payday_months");
        expected_tables.remove("payday_allocations");
    }
    if (4..=7).contains(&manifest.schema_version) {
        expected_tables.remove("recurring_expenses");
    }
    if (4..=6).contains(&manifest.schema_version) {
        expected_tables.remove("net_worth_months");
        expected_tables.remove("net_worth_month_components");
    }
    if manifest.format != ARCHIVE_FORMAT
        || manifest.tables.len() != expected_tables.len()
        || manifest
            .tables
            .iter()
            .map(|table| table.name.as_str())
            .collect::<BTreeSet<_>>()
            != expected_tables
    {
        return Err(BackupArchiveError::Incompatible);
    }
    let mut expected_files = BTreeSet::from(["manifest.json".to_owned()]);
    let mut tables = BTreeMap::new();
    for table in manifest.tables {
        if table.json_path != format!("tables/{}.json", table.name)
            || table.csv_path != format!("csv/{}.csv", table.name)
        {
            return Err(BackupArchiveError::Invalid);
        }
        let json = files
            .get(&table.json_path)
            .ok_or(BackupArchiveError::Invalid)?;
        let csv = files
            .get(&table.csv_path)
            .ok_or(BackupArchiveError::Invalid)?;
        if digest(json) != table.json_sha256 || digest(csv) != table.csv_sha256 {
            return Err(BackupArchiveError::Checksum);
        }
        let rows: Value = serde_json::from_slice(json).map_err(|_| BackupArchiveError::Invalid)?;
        if rows.as_array().map(Vec::len) != Some(table.row_count) {
            return Err(BackupArchiveError::Invalid);
        }
        expected_files.insert(table.json_path);
        expected_files.insert(table.csv_path);
        tables.insert(table.name, rows);
    }
    if files.keys().cloned().collect::<BTreeSet<_>>() != expected_files {
        return Err(BackupArchiveError::Invalid);
    }
    Ok(HouseholdSnapshot {
        format_version: manifest.format_version,
        schema_version: manifest.schema_version,
        household_id: manifest.household_id,
        created_at: manifest.created_at,
        tables,
    })
}

fn table_csv(rows: &[Value]) -> Result<Vec<u8>, BackupArchiveError> {
    let columns = rows
        .iter()
        .filter_map(Value::as_object)
        .flat_map(|row| row.keys().cloned())
        .collect::<BTreeSet<_>>();
    let mut output = String::new();
    output.push_str(
        &columns
            .iter()
            .map(|column| csv_cell(column))
            .collect::<Vec<_>>()
            .join(","),
    );
    output.push('\n');
    for row in rows {
        let object = row.as_object().ok_or(BackupArchiveError::Serialization)?;
        output.push_str(
            &columns
                .iter()
                .map(|column| csv_value(object.get(column)))
                .collect::<Vec<_>>()
                .join(","),
        );
        output.push('\n');
    }
    Ok(output.into_bytes())
}

fn csv_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => csv_cell(value),
        Some(value) => csv_cell(&value.to_string()),
    }
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::backup::{
        BACKUP_FORMAT_VERSION, BACKUP_SCHEMA_VERSION, BACKUP_TABLES, HouseholdSnapshot,
    };
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    use super::{BackupArchiveError, MAX_MANIFEST_BYTES, build_archive, parse_archive};

    fn single_file_archive(
        name: &str,
        content: &[u8],
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        use std::io::{Cursor, Write};

        use zip::{ZipWriter, write::SimpleFileOptions};

        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        archive.start_file(name, SimpleFileOptions::default())?;
        archive.write_all(content)?;
        Ok(archive.finish()?.into_inner())
    }

    #[test]
    fn archive_rejects_non_zip_input() {
        assert!(matches!(
            parse_archive(b"not a zip archive"),
            Err(BackupArchiveError::Invalid)
        ));
    }

    #[test]
    fn archive_rejects_unsafe_member_paths() -> Result<(), Box<dyn std::error::Error>> {
        for name in [
            "../manifest.json",
            "/manifest.json",
            "tables/../../manifest.json",
        ] {
            let archive = single_file_archive(name, b"{}")?;
            assert!(matches!(
                parse_archive(&archive),
                Err(BackupArchiveError::Invalid)
            ));
        }
        Ok(())
    }

    #[test]
    fn archive_rejects_oversized_manifest() -> Result<(), Box<dyn std::error::Error>> {
        let content = vec![b' '; usize::try_from(MAX_MANIFEST_BYTES)? + 1];
        let archive = single_file_archive("manifest.json", &content)?;
        assert!(matches!(
            parse_archive(&archive),
            Err(BackupArchiveError::Limit)
        ));
        Ok(())
    }

    #[test]
    fn historical_archives_retain_exact_table_validation() -> Result<(), Box<dyn std::error::Error>>
    {
        use std::io::{Cursor, Read, Write};
        use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

        for version in [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] {
            let snapshot = HouseholdSnapshot {
                format_version: BACKUP_FORMAT_VERSION,
                schema_version: version,
                household_id: Uuid::new_v4(),
                created_at: Utc::now(),
                tables: BACKUP_TABLES
                    .iter()
                    .map(|table| ((*table).to_owned(), json!([])))
                    .collect(),
            };
            let bytes = build_archive(&snapshot)?;
            let mut archive = ZipArchive::new(Cursor::new(bytes))?;
            let mut historical = ZipWriter::new(Cursor::new(Vec::new()));
            let removed = |name: &str| {
                (version <= 16
                    && [
                        "utility_contracts",
                        "utility_contract_prices",
                        "utility_contract_import_sources",
                    ]
                    .contains(&name))
                    || (version <= 13 && name == "utility_months")
                    || (version <= 12 && name == "holding_price_cache")
                    || (version <= 10 && name == "account_holdings")
                    || (version <= 8
                        && ["payday_templates", "payday_months", "payday_allocations"]
                            .contains(&name))
                    || (version <= 7 && name == "recurring_expenses")
                    || (version <= 6
                        && ["net_worth_months", "net_worth_month_components"].contains(&name))
            };
            for index in 0..archive.len() {
                let mut file = archive.by_index(index)?;
                let name = file.name()?.into_owned();
                if name
                    .strip_prefix("tables/")
                    .and_then(|value| value.strip_suffix(".json"))
                    .is_some_and(removed)
                    || name
                        .strip_prefix("csv/")
                        .and_then(|value| value.strip_suffix(".csv"))
                        .is_some_and(removed)
                {
                    continue;
                }
                let mut content = Vec::new();
                file.read_to_end(&mut content)?;
                if name == "manifest.json" {
                    let mut manifest: super::ArchiveManifest = serde_json::from_slice(&content)?;
                    manifest.tables.retain(|table| !removed(&table.name));
                    content = serde_json::to_vec(&manifest)?;
                }
                historical.start_file(name, SimpleFileOptions::default())?;
                historical.write_all(&content)?;
            }
            let bytes = historical.finish()?.into_inner();
            let parsed = parse_archive(&bytes)?;
            let upgraded = crate::backup::upgrade_snapshot_schema(&parsed)?;
            assert_eq!(upgraded.schema_version, BACKUP_SCHEMA_VERSION);
            assert_eq!(upgraded.tables.len(), BACKUP_TABLES.len());
        }
        Ok(())
    }

    #[test]
    fn archive_round_trip_preserves_decimal_lexemes_and_all_tables()
    -> Result<(), super::BackupArchiveError> {
        let household_id = Uuid::new_v4();
        let mut tables = BACKUP_TABLES
            .iter()
            .map(|table| ((*table).to_owned(), json!([])))
            .collect::<BTreeMap<_, _>>();
        tables.insert(
            "buyers".to_owned(),
            json!([{
                "id": Uuid::new_v4(),
                "household_id": household_id,
                "name": "Zażółć",
                "amount": "1234567890.12345678"
            }]),
        );
        let snapshot = HouseholdSnapshot {
            format_version: BACKUP_FORMAT_VERSION,
            schema_version: BACKUP_SCHEMA_VERSION,
            household_id,
            created_at: Utc::now(),
            tables,
        };
        let archive = build_archive(&snapshot)?;
        let restored = parse_archive(&archive)?;
        assert_eq!(restored.household_id, household_id);
        assert_eq!(restored.tables["buyers"], snapshot.tables["buyers"]);
        assert_eq!(restored.tables.len(), BACKUP_TABLES.len());
        Ok(())
    }
}
