pub mod admin_data_loads;
pub mod assets;
pub mod auth;
pub mod backups;
pub mod cloudflare;
pub mod dashboard;
pub mod dto;
pub mod error;
pub mod expenses;
pub mod google;
pub mod holding_prices;
pub mod household;
pub mod imports;
pub mod invoices;
pub mod metrics;
pub mod payday;
pub mod records;
pub mod recurring_expenses;
pub mod settings;
pub mod utilities;

use std::{path::PathBuf, time::Duration};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderName, HeaderValue, Method},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use checkbook_postgres::ready;
use serde::Serialize;
use sqlx::PgPool;
use tokio::sync::{Semaphore, SemaphorePermit};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use utoipa::OpenApi;

const API_OPERATIONS: &[(&str, &str, &str)] = &[
    ("post", "/api/auth/cloudflare-session", "cloudflareSession"),
    ("post", "/api/auth/google", "googleLogin"),
    ("post", "/api/auth/dev-login", "devLogin"),
    ("get", "/api/auth/session", "getSession"),
    ("post", "/api/auth/logout", "logout"),
    ("get", "/api/household/me", "getHouseholdContext"),
    ("get", "/api/household/categories", "getCategories"),
    ("get", "/api/household/groups", "getGroups"),
    ("post", "/api/household/groups", "createGroup"),
    ("put", "/api/household/groups/{group_id}", "updateGroup"),
    ("delete", "/api/household/groups/{group_id}", "deleteGroup"),
    ("get", "/api/household/loans", "getLoans"),
    ("post", "/api/household/loans", "createLoan"),
    ("put", "/api/household/loans/{loan_id}", "updateLoan"),
    ("get", "/api/household/assets", "getAssets"),
    (
        "get",
        "/api/household/assets/{asset_id}/holding-prices",
        "getHoldingPrices",
    ),
    ("post", "/api/household/assets", "createAsset"),
    ("put", "/api/household/assets/{asset_id}", "updateAsset"),
    ("delete", "/api/household/assets/{asset_id}", "deleteAsset"),
    (
        "post",
        "/api/household/assets/{asset_id}/own-category",
        "createOwnPropertyCategory",
    ),
    (
        "get",
        "/api/household/assets/{asset_id}/valuations",
        "getPropertyValuations",
    ),
    (
        "post",
        "/api/household/assets/{asset_id}/valuations",
        "createPropertyValuation",
    ),
    (
        "delete",
        "/api/household/assets/{asset_id}/valuations/{valuation_id}",
        "deletePropertyValuation",
    ),
    (
        "get",
        "/api/household/utility-field-catalog",
        "getUtilityFieldCatalog",
    ),
    (
        "post",
        "/api/household/utility-field-catalog",
        "createUtilityField",
    ),
    (
        "post",
        "/api/household/utility-field-order",
        "reorderUtilityFields",
    ),
    (
        "put",
        "/api/household/utility-field-catalog/{key}",
        "updateUtilityField",
    ),
    (
        "get",
        "/api/household/utility-field-catalog/{key}/audit",
        "listUtilityFieldAudit",
    ),
    (
        "patch",
        "/api/household/utility-field-catalog/{key}/lifecycle",
        "updateUtilityFieldLifecycle",
    ),
    (
        "delete",
        "/api/household/utility-field-catalog/{key}",
        "deleteUtilityField",
    ),
    (
        "get",
        "/api/household/utilities/contracts",
        "listUtilityContracts",
    ),
    (
        "post",
        "/api/household/utilities/contracts",
        "createUtilityContract",
    ),
    (
        "put",
        "/api/household/utilities/contracts/{id}",
        "updateUtilityContract",
    ),
    (
        "post",
        "/api/household/utilities/contracts/reorder",
        "reorderUtilityContracts",
    ),
    (
        "get",
        "/api/household/utilities/contracts/{id}/prices",
        "listUtilityContractPrices",
    ),
    (
        "post",
        "/api/household/utilities/contracts/{id}/prices",
        "createUtilityContractPrice",
    ),
    (
        "put",
        "/api/household/utilities/contracts/{id}/prices/{price_id}",
        "updateUtilityContractPrice",
    ),
    ("get", "/api/household/utilities/board", "getUtilityBoard"),
    ("get", "/api/household/utilities/form", "getUtilityForm"),
    (
        "post",
        "/api/household/utilities/upsert",
        "upsertUtilityEntries",
    ),
    (
        "post",
        "/api/household/utilities/track-field",
        "trackUtilityField",
    ),
    (
        "post",
        "/api/household/utilities/untrack-field",
        "untrackUtilityField",
    ),
    (
        "post",
        "/api/household/utilities/reassign",
        "reassignUtilities",
    ),
    ("post", "/api/household/utilities", "createUtility"),
    ("get", "/api/household/buyers", "getBuyers"),
    ("post", "/api/household/buyers", "createBuyer"),
    ("get", "/api/household/invoices", "getInvoices"),
    (
        "get",
        "/api/household/invoice-templates",
        "getInvoiceTemplates",
    ),
    (
        "post",
        "/api/household/invoice-templates",
        "createInvoiceTemplate",
    ),
    (
        "post",
        "/api/household/invoices/generate",
        "generateInvoice",
    ),
    (
        "put",
        "/api/household/invoices/{invoice_id}",
        "updateInvoice",
    ),
    (
        "delete",
        "/api/household/invoices/{invoice_id}",
        "deleteInvoice",
    ),
    (
        "get",
        "/api/household/invoices/{invoice_id}/pdf",
        "downloadInvoicePdf",
    ),
    ("get", "/api/backups/config", "getBackupConfig"),
    ("put", "/api/backups/config", "updateBackupConfig"),
    ("post", "/api/backups/test", "testBackupLocation"),
    ("get", "/api/backups", "listBackups"),
    ("post", "/api/backups", "createBackup"),
    ("delete", "/api/backups/{name}", "deleteBackup"),
    ("post", "/api/backups/{name}/restore", "restoreBackup"),
    ("get", "/api/backups/{name}/download", "downloadBackup"),
    ("get", "/api/backups/export.csv", "exportCsv"),
    ("post", "/api/backups/import", "importBackup"),
    ("get", "/api/household/invitations", "getInvitations"),
    ("post", "/api/household/invitations", "createInvitation"),
    ("post", "/api/household/expenses", "createExpense"),
    ("get", "/api/household/expenses/board", "getExpensesBoard"),
    (
        "get",
        "/api/household/expenses/recurring",
        "getRecurringExpenses",
    ),
    (
        "post",
        "/api/household/expenses/recurring",
        "createRecurringExpense",
    ),
    (
        "put",
        "/api/household/expenses/recurring/{id}",
        "updateRecurringExpense",
    ),
    (
        "post",
        "/api/household/expenses/recurring/{id}/expense-now",
        "expenseRecurringNow",
    ),
    (
        "post",
        "/api/household/expenses/recurring/{id}/retire",
        "retireRecurringExpense",
    ),
    (
        "get",
        "/api/household/expenses/suggestions",
        "getExpenseNameSuggestions",
    ),
    (
        "put",
        "/api/household/expenses/{entry_id}",
        "updateExpenseEntry",
    ),
    (
        "delete",
        "/api/household/expenses/{entry_id}",
        "deleteExpenseEntry",
    ),
    (
        "post",
        "/api/household/expense-groups",
        "createExpenseGroup",
    ),
    (
        "put",
        "/api/household/expense-groups/{group_id}",
        "updateExpenseGroup",
    ),
    (
        "delete",
        "/api/household/expense-groups/{group_id}",
        "deleteExpenseGroup",
    ),
    (
        "post",
        "/api/household/expense-categories",
        "createExpenseCategory",
    ),
    (
        "get",
        "/api/household/expense-categories/{category_id}",
        "getExpenseCategoryDetail",
    ),
    (
        "put",
        "/api/household/expense-categories/{category_id}",
        "updateExpenseCategory",
    ),
    (
        "delete",
        "/api/household/expense-categories/{category_id}",
        "deleteExpenseCategory",
    ),
    ("post", "/api/household/income", "createIncome"),
    ("get", "/api/household/income-sources", "getIncomeSources"),
    (
        "post",
        "/api/household/income-sources",
        "createIncomeSource",
    ),
    (
        "put",
        "/api/household/income-sources/{source_id}",
        "updateIncomeSource",
    ),
    (
        "delete",
        "/api/household/income-sources/{source_id}",
        "deleteIncomeSource",
    ),
    (
        "post",
        "/api/household/income-sources/{source_id}/entries",
        "createIncomeSourceEntry",
    ),
    (
        "put",
        "/api/household/income-sources/{source_id}/entries/{entry_id}",
        "updateIncomeSourceEntry",
    ),
    ("get", "/api/dashboard/overview", "getDashboardOverview"),
    ("get", "/api/dashboard/analytics", "getAnalytics"),
    (
        "put",
        "/api/household/net-worth/months/{period}",
        "updateNetWorthMonth",
    ),
    ("get", "/api/imports/history", "getImportHistory"),
    ("get", "/api/imports/raw-data", "getImportRawData"),
    ("post", "/api/imports/bulk", "bulkImport"),
    ("get", "/api/settings", "getSettings"),
    ("put", "/api/settings", "updateSettings"),
];

static BLOCKING_TASKS: Semaphore = Semaphore::const_new(4);

pub(crate) async fn blocking_permit() -> Result<SemaphorePermit<'static>, crate::error::ApiError> {
    BLOCKING_TASKS
        .acquire()
        .await
        .map_err(|_| crate::error::ApiError(checkbook_application::ApplicationError::Storage))
}

#[derive(Clone)]
pub struct ApiState {
    pub pool: PgPool,
    pub dev_auth_enabled: bool,
    pub session_hours: i64,
    pub cloudflare: Option<cloudflare::CloudflareVerifier>,
    pub google: Option<google::GoogleVerifier>,
    pub backup_admin_root: Option<PathBuf>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
struct HealthResponse {
    status: &'static str,
}

#[utoipa::path(get, path = "/health", responses((status = 200, body = HealthResponse)))]
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

#[utoipa::path(
    get,
    path = "/health/ready",
    responses(
        (status = 200, body = HealthResponse),
        (status = 503, body = HealthResponse)
    )
)]
async fn readiness(State(state): State<ApiState>) -> (http::StatusCode, Json<HealthResponse>) {
    if ready(&state.pool).await {
        (http::StatusCode::OK, Json(HealthResponse { status: "ok" }))
    } else {
        (
            http::StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthResponse {
                status: "unavailable",
            }),
        )
    }
}

#[derive(OpenApi)]
#[openapi(
    paths(
        utilities::list_contracts,
        utilities::create_contract,
        utilities::update_contract,
        utilities::reorder_contracts,
        utilities::list_contract_prices,
        utilities::create_contract_price,
        utilities::update_contract_price,
        utilities::create_config,
        utilities::reorder_fields,
        utilities::update_config,
        utilities::update_lifecycle,
        utilities::delete_config,
        utilities::config_audit,
        health,
        readiness,
        assets::update_loan,
        holding_prices::get_holding_prices,
        expenses::name_suggestions,
        recurring_expenses::list,
        recurring_expenses::create,
        recurring_expenses::update,
        recurring_expenses::expense_now,
        recurring_expenses::retire,
        dashboard::update_net_worth_month,
        payday::get,
        payday::preview,
        payday::templates,
        payday::create,
        payday::update,
        payday::delete,
        payday::apply,
        payday::create_template,
        payday::update_template,
        payday::delete_template
    ),
    components(schemas(
        holding_prices::HoldingPricesResponse,
        holding_prices::HoldingPrice,
        HealthResponse,
        error::ErrorBody,
        dto::UtilityBoardResponse,
        dto::UtilityEntryFormResponse,
        dto::UtilityEntriesUpsert,
        dto::LoanUpdatePayload,
        dto::LoanSchedulePaymentPayload,
        dto::LoanSummary,
        dto::NetWorthMonthPayload,
        dto::NetWorthMonthComponentPayload,
        dto::NetWorthComponentRowResponse,
        dto::NetWorthComponentGroupResponse,
        dto::ExpenseGroupResponse,
        dto::ExpenseCategorySummaryResponse,
        dto::ExpenseCategoryDetailResponse
    ))
)]
pub struct ApiDoc;

pub fn openapi_document() -> Result<serde_json::Value, serde_json::Error> {
    let mut document = serde_json::to_value(ApiDoc::openapi())?;
    let paths = document
        .as_object_mut()
        .and_then(|document| document.get_mut("paths"))
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| serde::ser::Error::custom("generated OpenAPI paths are invalid"))?;
    for (method, path, operation_id) in API_OPERATIONS {
        let path_item = paths
            .entry((*path).to_owned())
            .or_insert_with(|| serde_json::json!({}));
        let operations = path_item
            .as_object_mut()
            .ok_or_else(|| serde::ser::Error::custom("generated OpenAPI path item is invalid"))?;
        if operations.contains_key(*method) {
            continue;
        }
        operations.insert(
            (*method).to_owned(),
            serde_json::json!({
                "operationId": operation_id,
                "responses": {
                    "200": {"description": "Successful response"},
                    "401": {
                        "description": "Authentication required",
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorBody"}}}
                    },
                    "403": {
                        "description": "Permission denied",
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorBody"}}}
                    },
                    "422": {
                        "description": "Validation error",
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorBody"}}}
                    }
                },
                "security": if path.starts_with("/api/auth/") {
                    serde_json::json!([])
                } else {
                    serde_json::json!([{"bearerAuth": []}])
                }
            }),
        );
    }
    let root = document
        .as_object_mut()
        .ok_or_else(|| serde::ser::Error::custom("generated OpenAPI document is invalid"))?;
    let components = root
        .entry("components")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| serde::ser::Error::custom("generated OpenAPI components are invalid"))?;
    components.insert(
        "securitySchemes".to_owned(),
        serde_json::json!({
            "bearerAuth": {
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "opaque session token"
            }
        }),
    );
    Ok(document)
}

async fn openapi_json() -> Result<Json<serde_json::Value>, (http::StatusCode, &'static str)> {
    openapi_document().map(Json).map_err(|_| {
        (
            http::StatusCode::INTERNAL_SERVER_ERROR,
            "OpenAPI generation failed",
        )
    })
}

async fn require_authenticated(
    State(state): State<ApiState>,
    request: Request,
    next: Next,
) -> Response {
    let token = match auth::bearer_token(request.headers()) {
        Ok(token) => token,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = checkbook_postgres::auth::authenticate(&state.pool, token).await {
        return auth::map_auth_error(error).into_response();
    }
    next.run(request).await
}

pub fn router(state: ApiState, allowed_origins: Vec<HeaderValue>) -> Router {
    let auth_state = state.clone();
    let request_id = HeaderName::from_static("x-request-id");
    let cors = CorsLayer::new()
        .allow_credentials(true)
        .allow_headers([http::header::AUTHORIZATION, http::header::CONTENT_TYPE])
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_origin(AllowOrigin::list(allowed_origins))
        .max_age(Duration::from_secs(600));

    let public = Router::new()
        .route("/health", get(health))
        .route("/health/live", get(health))
        .route("/health/ready", get(readiness))
        .route("/metrics", get(metrics::endpoint))
        .route("/openapi.json", get(openapi_json));
    let auth_public = Router::new()
        .route("/api/auth/dev-login", post(auth::dev_login))
        .route(
            "/api/auth/cloudflare-session",
            post(auth::cloudflare_session),
        )
        .route("/api/auth/google", post(auth::google_login))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::rate_limit_bootstrap,
        ));
    let protected = Router::new()
        .route("/api/auth/session", get(auth::get_session))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/household/me", get(household::get_household_me))
        .route(
            "/api/household/invitations",
            get(household::list_invitations).post(household::create_invitation),
        )
        .route("/api/household/categories", get(household::categories))
        .route("/api/household/expenses", post(records::create_expense))
        .route("/api/household/expenses/board", get(expenses::board))
        .route(
            "/api/household/expenses/recurring",
            get(recurring_expenses::list).post(recurring_expenses::create),
        )
        .route(
            "/api/household/expenses/recurring/{id}",
            put(recurring_expenses::update),
        )
        .route(
            "/api/household/expenses/recurring/{id}/expense-now",
            post(recurring_expenses::expense_now),
        )
        .route(
            "/api/household/expenses/recurring/{id}/retire",
            post(recurring_expenses::retire),
        )
        .route(
            "/api/household/expenses/suggestions",
            get(expenses::name_suggestions),
        )
        .route(
            "/api/household/expenses/{entry_id}",
            put(expenses::update_entry).delete(expenses::delete_entry),
        )
        .route(
            "/api/household/expense-groups",
            post(expenses::create_group),
        )
        .route(
            "/api/household/expense-groups/{group_id}",
            put(expenses::update_group).delete(expenses::delete_group),
        )
        .route(
            "/api/household/expense-categories",
            post(expenses::create_category),
        )
        .route(
            "/api/household/expense-categories/{category_id}",
            get(expenses::category_detail)
                .put(expenses::update_category)
                .delete(expenses::delete_category),
        )
        .route("/api/household/income", post(records::create_income))
        .route(
            "/api/household/assets",
            get(assets::list_assets).post(assets::create_asset),
        )
        .route(
            "/api/household/assets/{asset_id}",
            put(assets::update_asset).delete(assets::delete_asset),
        )
        .route(
            "/api/household/assets/{asset_id}/own-category",
            post(assets::create_own_category),
        )
        .route(
            "/api/household/assets/{asset_id}/holding-prices",
            get(holding_prices::get_holding_prices),
        )
        .route(
            "/api/household/assets/{asset_id}/valuations",
            get(assets::list_property_valuations).post(assets::create_property_valuation),
        )
        .route(
            "/api/household/assets/{asset_id}/valuations/{valuation_id}",
            delete(assets::delete_property_valuation),
        )
        .route(
            "/api/household/loans",
            get(assets::list_loans).post(assets::create_loan),
        )
        .route("/api/household/loans/{loan_id}", put(assets::update_loan))
        .route(
            "/api/household/net-worth/months/{period}",
            put(dashboard::update_net_worth_month),
        )
        .route(
            "/api/household/invoice-templates",
            get(invoices::list_templates).post(invoices::create_template),
        )
        .route(
            "/api/household/buyers",
            get(invoices::list_buyers).post(invoices::create_buyer),
        )
        .route("/api/household/invoices", get(invoices::list_invoices))
        .route(
            "/api/household/invoices/generate",
            post(invoices::generate_invoice),
        )
        .route(
            "/api/household/invoices/{invoice_id}/pdf",
            get(invoices::download_pdf),
        )
        .route(
            "/api/household/invoices/{invoice_id}",
            put(invoices::update_invoice).delete(invoices::delete_invoice),
        )
        .route(
            "/api/household/utility-field-catalog",
            get(utilities::field_catalog).post(utilities::create_config),
        )
        .route(
            "/api/household/utility-field-order",
            post(utilities::reorder_fields),
        )
        .route(
            "/api/household/utility-field-catalog/{key}",
            put(utilities::update_config).delete(utilities::delete_config),
        )
        .route(
            "/api/household/utility-field-catalog/{key}/lifecycle",
            axum::routing::patch(utilities::update_lifecycle),
        )
        .route(
            "/api/household/utility-field-catalog/{key}/audit",
            get(utilities::config_audit),
        )
        .route(
            "/api/household/utilities/contracts",
            get(utilities::list_contracts).post(utilities::create_contract),
        )
        .route(
            "/api/household/utilities/contracts/{id}",
            put(utilities::update_contract),
        )
        .route(
            "/api/household/utilities/contracts/reorder",
            post(utilities::reorder_contracts),
        )
        .route(
            "/api/household/utilities/contracts/{id}/prices",
            get(utilities::list_contract_prices).post(utilities::create_contract_price),
        )
        .route(
            "/api/household/utilities/contracts/{id}/prices/{price_id}",
            put(utilities::update_contract_price),
        )
        .route("/api/household/utilities/board", get(utilities::board))
        .route("/api/household/utilities/form", get(utilities::form))
        .route("/api/household/utilities/upsert", post(utilities::upsert))
        .route(
            "/api/household/utilities/track-field",
            post(utilities::track_field),
        )
        .route(
            "/api/household/utilities/untrack-field",
            post(utilities::untrack_field),
        )
        .route(
            "/api/household/utilities/reassign",
            post(utilities::reassign),
        )
        .route("/api/household/utilities", post(utilities::create_manual))
        .route(
            "/api/household/income-sources",
            get(records::income_sources).post(records::create_income_source),
        )
        .route(
            "/api/household/income-sources/{source_id}",
            put(records::update_income_source).delete(records::delete_income_source),
        )
        .route(
            "/api/household/income-sources/{source_id}/entries",
            post(records::create_income_source_entry),
        )
        .route(
            "/api/household/income-sources/{source_id}/entries/{entry_id}",
            put(records::update_income_source_entry),
        )
        .route(
            "/api/household/groups",
            get(household::groups).post(household::create_group),
        )
        .route(
            "/api/household/groups/{group_id}",
            put(household::update_group).delete(household::delete_group),
        )
        .route("/api/settings", get(settings::get).put(settings::update))
        .route("/api/dashboard/overview", get(dashboard::overview))
        .route("/api/dashboard/analytics", get(dashboard::analytics))
        .route(
            "/api/backups/config",
            get(backups::get_config).put(backups::update_config),
        )
        .route("/api/backups/test", post(backups::test_location))
        .route("/api/backups/export.csv", get(backups::export_csv))
        .route(
            "/api/backups/import",
            post(backups::import).layer(backups::import_body_limit()),
        )
        .route("/api/backups", get(backups::list).post(backups::create))
        .route("/api/backups/{name}/download", get(backups::download))
        .route("/api/backups/{name}/restore", post(backups::restore))
        .route(
            "/api/backups/{name}",
            axum::routing::delete(backups::delete),
        )
        .route("/api/imports/history", get(imports::history))
        .route("/api/imports/raw-data", get(imports::raw_data))
        .route("/api/imports/bulk", post(imports::bulk))
        .route("/api/payday-planner", get(payday::get))
        .route("/api/payday-planner/suggestions", get(payday::preview))
        .route("/api/payday-planner/apply", post(payday::apply))
        .route("/api/payday-planner/allocations", post(payday::create))
        .route(
            "/api/payday-planner/allocations/{id}",
            put(payday::update).delete(payday::delete),
        )
        .route(
            "/api/payday-planner/templates",
            get(payday::templates).post(payday::create_template),
        )
        .route(
            "/api/payday-planner/templates/{id}",
            put(payday::update_template).delete(payday::delete_template),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            auth_state,
            require_authenticated,
        ));

    public
        .merge(auth_public)
        .merge(protected)
        .with_state(state)
        .layer(axum::middleware::from_fn(metrics::record_request))
        .layer(PropagateRequestIdLayer::new(request_id.clone()))
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::with_status_code(
            http::StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(120),
        ))
        .layer(cors)
}
