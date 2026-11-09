use std::collections::BTreeSet;

use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use checkbook_api::{ApiState, openapi_document, router};
use checkbook_postgres::{connect, migrate};
use serde::Deserialize;
use serde_json::{Value, json};
use tower::ServiceExt;

#[derive(Deserialize)]
struct Contract {
    operations: Vec<String>,
}

#[test]
fn generated_openapi_matches_the_reviewed_frontend_operation_snapshot() -> anyhow::Result<()> {
    let contract: Contract =
        serde_json::from_str(include_str!("../../../tests/contract/openapi-paths.json"))?;
    let expected = contract.operations.into_iter().collect::<BTreeSet<_>>();
    let document = openapi_document()?;
    let paths = document["paths"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("OpenAPI paths missing"))?;
    let actual = paths
        .iter()
        .filter(|(path, _)| path.starts_with("/api/"))
        .flat_map(|(path, item)| {
            item.as_object().into_iter().flat_map(move |operations| {
                operations
                    .keys()
                    .filter(|method| {
                        matches!(method.as_str(), "get" | "post" | "put" | "patch" | "delete")
                    })
                    .map(move |method| format!("{} {path}", method.to_ascii_uppercase()))
            })
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(actual, expected);
    let operation_ids = paths
        .iter()
        .filter(|(path, _)| path.starts_with("/api/"))
        .flat_map(|(_, item)| {
            item.as_object()
                .into_iter()
                .flat_map(|operations| operations.values())
        })
        .filter_map(|operation| operation["operationId"].as_str())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();
    let mut expected_operation_ids = frontend_api_method_names(&[
        (
            "assetsApi",
            include_str!("../../../frontend/src/api/assets.ts"),
        ),
        ("authApi", include_str!("../../../frontend/src/api/auth.ts")),
        (
            "backupsApi",
            include_str!("../../../frontend/src/api/backups.ts"),
        ),
        (
            "dashboardApi",
            include_str!("../../../frontend/src/api/dashboard.ts"),
        ),
        (
            "expensesApi",
            include_str!("../../../frontend/src/api/expenses.ts"),
        ),
        (
            "householdApi",
            include_str!("../../../frontend/src/api/household.ts"),
        ),
        (
            "importsApi",
            include_str!("../../../frontend/src/api/imports.ts"),
        ),
        (
            "incomeApi",
            include_str!("../../../frontend/src/api/income.ts"),
        ),
        (
            "invoicesApi",
            include_str!("../../../frontend/src/api/invoices.ts"),
        ),
        (
            "paydayPlannerApi",
            include_str!("../../../frontend/src/api/payday-planner.ts"),
        ),
        (
            "utilitiesApi",
            include_str!("../../../frontend/src/api/utilities.ts"),
        ),
    ])?;
    expected_operation_ids.insert("createInvoiceTemplate".to_owned());
    assert_eq!(
        operation_ids, expected_operation_ids,
        "OpenAPI operation IDs drifted from the frontend API modules"
    );
    Ok(())
}

#[tokio::test]
async fn retired_planning_routes_are_not_served() -> anyhow::Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgresql://unused:unused@localhost/unused")?;
    let app = router(
        ApiState {
            pool,
            dev_auth_enabled: false,
            session_hours: 24,
            cloudflare: None,
            google: None,
            backup_admin_root: None,
        },
        Vec::new(),
    );
    for (method, path) in [
        ("GET", "/api/planning"),
        ("GET", "/api/planning/board"),
        ("POST", "/api/planning/cards"),
        ("POST", "/api/planning/cards/copy"),
        ("PUT", "/api/planning/cards/expense/unused"),
        ("DELETE", "/api/planning/cards/expense/unused"),
        ("PATCH", "/api/planning/cards/expense/unused/move"),
        ("POST", "/api/planning/cards/expense/unused/duplicate"),
        ("PUT", "/api/planning/loan-overpayments"),
        ("POST", "/api/planning/recurring-commitments"),
        ("PUT", "/api/planning/recurring-commitments/unused"),
        ("DELETE", "/api/planning/recurring-commitments/unused"),
        ("POST", "/api/planning/goals"),
        ("PUT", "/api/planning/goals/unused"),
        ("DELETE", "/api/planning/goals/unused"),
        ("POST", "/api/planning/scenarios"),
        ("PUT", "/api/planning/baseline"),
        ("GET", "/api/planning/projection"),
        ("GET", "/api/planning/projection/unused"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
    }
    Ok(())
}

#[tokio::test]
async fn every_protected_frontend_operation_has_the_standard_auth_boundary() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let app = router(
        ApiState {
            pool,
            dev_auth_enabled: true,
            session_hours: 24,
            cloudflare: None,
            google: None,
            backup_admin_root: None,
        },
        Vec::new(),
    );
    let contract: Contract =
        serde_json::from_str(include_str!("../../../tests/contract/openapi-paths.json"))?;

    for operation in contract.operations {
        let Some((method, template)) = operation.split_once(' ') else {
            anyhow::bail!("invalid contract operation: {operation}");
        };
        if matches!(
            (method, template),
            ("POST", "/api/auth/cloudflare-session")
                | ("POST", "/api/auth/google")
                | ("POST", "/api/auth/dev-login")
        ) {
            continue;
        }
        let path = concrete_path(template);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::from_bytes(method.as_bytes())?)
                    .uri(&path)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path} did not apply the standard authentication boundary"
        );
        let bytes = to_bytes(response.into_body(), 64 * 1024).await?;
        let body: Value = serde_json::from_slice(&bytes)?;
        assert_eq!(
            body,
            json!({"detail": "Authentication required."}),
            "{method} {path} returned an incompatible authentication error"
        );
    }
    Ok(())
}

fn concrete_path(template: &str) -> String {
    template
        .replace("{entry_type}", "income")
        .replace("{name}", "contract.zip")
        .replace("{group_id}", "00000000-0000-0000-0000-000000000001")
        .replace("{asset_id}", "00000000-0000-0000-0000-000000000001")
        .replace("{valuation_id}", "00000000-0000-0000-0000-000000000001")
        .replace("{invoice_id}", "00000000-0000-0000-0000-000000000001")
        .replace("{source_id}", "00000000-0000-0000-0000-000000000001")
        .replace("{entry_id}", "00000000-0000-0000-0000-000000000001")
        .replace("{card_id}", "00000000-0000-0000-0000-000000000001")
        .replace("{item_id}", "00000000-0000-0000-0000-000000000001")
        .replace("{scenario_id}", "00000000-0000-0000-0000-000000000001")
}

fn frontend_api_method_names(sources: &[(&str, &str)]) -> anyhow::Result<BTreeSet<String>> {
    let mut methods = BTreeSet::new();
    for (object_name, source) in sources {
        methods.extend(frontend_api_object_method_names(object_name, source)?);
    }
    Ok(methods)
}

fn frontend_api_object_method_names(
    object_name: &str,
    source: &str,
) -> anyhow::Result<BTreeSet<String>> {
    let marker = format!("export const {object_name} = {{");
    let start = source
        .find(&marker)
        .ok_or_else(|| anyhow::anyhow!("frontend API object {object_name} is missing"))?
        + marker.len();
    let mut methods = BTreeSet::new();
    let mut depth = 1_i32;
    let mut line_start = start;
    let bytes = source.as_bytes();
    let mut index = start;
    let mut quote = None;
    let mut escaped = false;
    while index < bytes.len() && depth > 0 {
        if index == line_start && depth == 1 {
            let line_end = source[index..]
                .find('\n')
                .map_or(source.len(), |offset| index + offset);
            let line = source[index..line_end].trim();
            if let Some((name, _)) = line.split_once(':') {
                let name = name.trim();
                if !name.is_empty()
                    && name
                        .chars()
                        .all(|character| character == '_' || character.is_alphanumeric())
                {
                    methods.insert(name.to_owned());
                }
            }
        }
        let character = char::from(bytes[index]);
        if let Some(delimiter) = quote {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == delimiter {
                quote = None;
            }
        } else {
            match character {
                '\'' | '"' | '`' => quote = Some(character),
                '{' | '(' | '[' => depth += 1,
                '}' | ')' | ']' => depth -= 1,
                '\n' => {
                    line_start = index + 1;
                }
                _ => {}
            }
        }
        index += 1;
    }
    if depth != 0 {
        anyhow::bail!("frontend API object {object_name} is not balanced");
    }
    Ok(methods)
}

#[test]
fn utility_month_completion_is_optional_on_write_and_required_on_read() -> anyhow::Result<()> {
    let document = openapi_document()?;
    let schemas = &document["components"]["schemas"];
    for name in ["UtilityBoardMonth", "UtilityEntryFormResponse"] {
        assert_eq!(schemas[name]["properties"]["completed"]["type"], "boolean");
        assert!(
            schemas[name]["required"]
                .as_array()
                .is_some_and(|fields| fields.iter().any(|field| field == "completed"))
        );
    }
    assert!(schemas["UtilityEntriesUpsert"]["properties"]["completed"].is_object());
    assert!(
        !schemas["UtilityEntriesUpsert"]["required"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|field| field == "completed"))
    );
    Ok(())
}
