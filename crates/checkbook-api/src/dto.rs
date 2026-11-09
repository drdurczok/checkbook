use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

/// Serializes `BTreeMap<String, Decimal>` values as JSON numbers instead of
/// `rust_decimal`'s default string representation. `rust_decimal::serde::float`
/// only covers bare `Decimal` fields, not map values, so amount-keyed maps
/// (expense/utility/net-worth breakdowns) need this explicitly or every entry
/// renders as a string on the frontend and silently breaks arithmetic there.
mod decimal_map {
    use std::collections::BTreeMap;

    use rust_decimal::Decimal;
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

    pub fn serialize<S>(map: &BTreeMap<String, Decimal>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use num_traits::ToPrimitive;
        let floats: BTreeMap<&String, f64> = map
            .iter()
            .map(|(key, value)| {
                value.to_f64().map(|float| (key, float)).ok_or_else(|| {
                    serde::ser::Error::custom("decimal value is not representable as f64")
                })
            })
            .collect::<Result<_, _>>()?;
        floats.serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<BTreeMap<String, Decimal>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let floats = BTreeMap::<String, f64>::deserialize(deserializer)?;
        floats
            .into_iter()
            .map(|(key, value)| {
                Decimal::try_from(value)
                    .map(|decimal| (key, decimal))
                    .map_err(D::Error::custom)
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UserSummary {
    pub id: Uuid,
    pub email: String,
    pub full_name: String,
    pub picture_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct HouseholdSummary {
    pub id: Uuid,
    pub name: String,
    pub base_currency: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct MembershipSummary {
    pub id: Uuid,
    pub role: String,
    pub relationship_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct HouseholdSettingsPayload {
    pub id: Uuid,
    pub privacy_mode: String,
    pub allow_cross_member_visibility: bool,
    pub projection_baseline_window_months: i32,
    pub projection_horizon_months: i32,
    pub savings_allocation_strategy: String,
    pub role_permissions: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SessionResponse {
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub user: UserSummary,
    pub household: HouseholdSummary,
    pub membership: MembershipSummary,
    pub settings: HouseholdSettingsPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RawHouseholdContextResponse {
    pub household: RawHousehold,
    pub membership: RawMembership,
    pub settings: RawSettings,
    pub user: RawUser,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RawHousehold {
    pub id: Uuid,
    pub name: String,
    pub base_currency: String,
    pub timezone: String,
    pub created_by_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RawMembership {
    pub id: Uuid,
    pub household_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub relationship_kind: String,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RawSettings {
    pub id: Uuid,
    pub household_id: Uuid,
    pub privacy_mode: String,
    pub allow_cross_member_visibility: bool,
    pub projection_baseline_window_months: i32,
    pub projection_horizon_months: i32,
    pub savings_allocation_strategy: String,
    pub role_permissions: Value,
    pub backup_config: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RawUser {
    pub id: Uuid,
    pub google_sub: String,
    pub email: String,
    pub full_name: String,
    pub picture_url: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct CategoryResponse {
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub normalized_name: String,
    pub parent_id: Option<Uuid>,
    pub is_system: bool,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct TrackedField {
    pub contract_id: Option<Uuid>,
    pub property_id: Option<Uuid>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub tracking_mode: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub retired: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub has_data: bool,
    #[serde(default = "default_utility_entry_mode")]
    pub entry_mode: String,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub unit_rate: Option<Decimal>,
    pub key: String,
    pub label: String,
    pub kind: String,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct EntryGroupPayload {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub group_type: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "empty_object")]
    pub metadata_payload: Value,
    #[serde(default)]
    pub tracked_fields: Vec<TrackedField>,
    #[serde(default)]
    pub sort_order: i32,
}

fn empty_object() -> Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct EntryGroupResponse {
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub group_type: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub metadata_payload: Value,
    pub tracked_fields: Vec<TrackedField>,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SettingsUpdateRequest {
    pub privacy_mode: Option<String>,
    pub allow_cross_member_visibility: Option<bool>,
    pub projection_baseline_window_months: Option<i32>,
    pub projection_horizon_months: Option<i32>,
    pub savings_allocation_strategy: Option<String>,
    pub role_permissions: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ManualRecordResponse {
    pub id: Uuid,
    pub record_type: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct BuyerPayload {
    pub name: String,
    #[serde(default)]
    pub nip: String,
    #[serde(default)]
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct BuyerResponse {
    pub id: Uuid,
    pub name: String,
    pub nip: String,
    pub address: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct InvoiceLineItem {
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub quantity: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub unit_price: Decimal,
    #[serde(default = "default_vat_rate")]
    pub vat_rate: String,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub currency: String,
}

fn default_vat_rate() -> String {
    "23".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct InvoiceTemplatePayload {
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub seller_name: String,
    #[serde(default)]
    pub seller_details: String,
    #[serde(default)]
    pub buyer_name: String,
    #[serde(default)]
    pub buyer_details: String,
    #[serde(default = "default_pln")]
    pub currency: String,
    #[serde(default)]
    pub payment_terms: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub line_items: Vec<InvoiceLineItem>,
}

fn default_pln() -> String {
    "PLN".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct InvoiceTemplateResponse {
    pub id: Uuid,
    pub name: String,
    pub title: String,
    pub seller_name: String,
    pub seller_details: String,
    pub buyer_name: String,
    pub buyer_details: String,
    pub currency: String,
    pub payment_terms: String,
    pub notes: String,
    pub line_items: Vec<InvoiceLineItem>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct InvoiceWritePayload {
    pub template_id: Option<Uuid>,
    #[serde(default)]
    pub save_template: bool,
    pub template_name: Option<String>,
    pub invoice_number: Option<String>,
    #[serde(default)]
    pub title: String,
    pub income_source_id: Option<Uuid>,
    #[serde(default)]
    pub seller_name: String,
    #[serde(default)]
    pub seller_details: String,
    pub buyer_name: String,
    #[serde(default)]
    pub buyer_details: String,
    #[serde(default)]
    pub buyer_nip: String,
    #[serde(default)]
    pub buyer_address: String,
    pub issue_date: NaiveDate,
    pub sale_date: Option<NaiveDate>,
    pub due_date: Option<NaiveDate>,
    #[serde(default = "default_pln")]
    pub currency: String,
    #[serde(default = "default_invoice_status")]
    pub status: String,
    #[serde(default)]
    pub conversion_enabled: bool,
    #[serde(default)]
    pub conversion_currency: String,
    #[serde(default = "decimal_one", with = "rust_decimal::serde::float")]
    pub conversion_rate: Decimal,
    #[serde(default)]
    pub payment_terms: String,
    #[serde(default)]
    pub notes: String,
    pub line_items: Vec<InvoiceLineItem>,
}

fn default_invoice_status() -> String {
    "draft".to_owned()
}

fn decimal_one() -> Decimal {
    Decimal::ONE
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct InvoiceResponse {
    pub id: Uuid,
    pub invoice_number: String,
    pub title: String,
    pub template_id: Option<Uuid>,
    pub template_name: String,
    pub income_source_id: Option<Uuid>,
    pub seller_name: String,
    pub seller_details: String,
    pub buyer_name: String,
    pub buyer_details: String,
    pub buyer_nip: String,
    pub buyer_address: String,
    pub issue_date: NaiveDate,
    pub sale_date: Option<NaiveDate>,
    pub due_date: Option<NaiveDate>,
    pub currency: String,
    pub status: String,
    pub conversion_enabled: bool,
    pub conversion_currency: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub conversion_rate: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub subtotal: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub tax_amount: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub total_amount: Decimal,
    pub notes: String,
    pub line_items: Vec<InvoiceLineItem>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct InvitePayload {
    pub email: String,
    #[serde(default = "contributor_role")]
    pub role: String,
    #[serde(default = "spouse_relationship")]
    pub relationship_kind: String,
}

fn contributor_role() -> String {
    "contributor".to_owned()
}

fn spouse_relationship() -> String {
    "spouse".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct InviteResponse {
    pub id: Uuid,
    pub email: String,
    pub role: String,
    pub relationship_kind: String,
    pub token: String,
    pub accepted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GoalProgressResponse {
    pub id: Uuid,
    pub name: String,
    pub goal_type: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub target_amount: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub projected_amount: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub progress_ratio: Decimal,
    pub target_date: Option<NaiveDate>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DashboardMetricResponse {
    pub label: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
    #[serde(with = "rust_decimal::serde::float_option")]
    pub delta: Option<Decimal>,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct MonthlyPointResponse {
    pub period: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct BreakdownPointResponse {
    pub label: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub share: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct MonthlyBreakdownPointResponse {
    pub period: String,
    #[serde(with = "decimal_map")]
    pub values: BTreeMap<String, Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct CashFlowPointResponse {
    pub period: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub income: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub expenses: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub net: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilitySeriesPointResponse {
    pub period: String,
    #[serde(with = "decimal_map")]
    pub values: BTreeMap<String, Decimal>,
    #[serde(with = "decimal_map")]
    pub usage: BTreeMap<String, Decimal>,
    pub units: BTreeMap<String, String>,
    #[serde(with = "rust_decimal::serde::float")]
    pub total: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct NetWorthComponentGroupResponse {
    #[serde(with = "rust_decimal::serde::float")]
    pub total: Decimal,
    #[serde(with = "decimal_map")]
    pub components: BTreeMap<String, Decimal>,
    #[serde(default, with = "decimal_map")]
    pub automatic_components: BTreeMap<String, Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct NetWorthComponentRowResponse {
    pub period: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub total: Decimal,
    #[serde(with = "rust_decimal::serde::float_option")]
    pub growth: Option<Decimal>,
    pub completed: bool,
    pub investing: NetWorthComponentGroupResponse,
    pub savings: NetWorthComponentGroupResponse,
    pub non_liquid_assets: NetWorthComponentGroupResponse,
    pub debt: NetWorthComponentGroupResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct NetWorthMonthComponentPayload {
    pub group_key: String,
    pub label: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct NetWorthMonthPayload {
    pub completed: bool,
    pub components: Vec<NetWorthMonthComponentPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct FeedItemResponse {
    pub id: Uuid,
    pub item_type: String,
    pub title: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    pub entry_date: NaiveDate,
    pub owner_scope: String,
    pub source: String,
    pub category: Option<String>,
    pub subcategory: Option<String>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UpcomingPlannedItemResponse {
    pub id: Uuid,
    pub name: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    pub planned_date: NaiveDate,
    pub owner_scope: String,
    pub description: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ImportRunResponse {
    pub id: Uuid,
    pub source_type: String,
    pub status: String,
    pub counts: Value,
    pub warnings: Value,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RawDataColumn {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RawDataTable {
    pub key: String,
    pub label: String,
    pub count: i64,
    pub columns: Vec<RawDataColumn>,
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RawDataResponse {
    pub tables: Vec<RawDataTable>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct BackupConfigPayload {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub retention: i32,
}

pub type BackupConfigResponse = BackupConfigPayload;

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct BackupTestResponse {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct BackupEntry {
    pub name: String,
    pub size: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct BackupRestoreResponse {
    pub ok: bool,
    pub restored: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DashboardOverviewResponse {
    pub metrics: Vec<DashboardMetricResponse>,
    pub net_worth_trend: Vec<MonthlyPointResponse>,
    pub net_worth_components: Vec<NetWorthComponentRowResponse>,
    pub cash_flow_trend: Vec<MonthlyPointResponse>,
    pub cash_flow_components: Vec<CashFlowPointResponse>,
    pub income_breakdown: Vec<BreakdownPointResponse>,
    pub expense_breakdown: Vec<BreakdownPointResponse>,
    pub expense_trend_by_category: Vec<MonthlyBreakdownPointResponse>,
    pub utility_trend: Vec<UtilitySeriesPointResponse>,
    pub savings_allocation: Vec<BreakdownPointResponse>,
    pub loans: Vec<LoanSummary>,
    pub upcoming_planned_expenses: Vec<UpcomingPlannedItemResponse>,
    pub recent_activity: Vec<FeedItemResponse>,
    pub goals: Vec<GoalProgressResponse>,
    pub last_successful_import: Option<ImportRunResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AnalyticsResponse {
    pub charts: BTreeMap<String, Vec<Value>>,
    pub owner_scope_options: Vec<String>,
    pub timeframe_options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseGroupWritePayload {
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub is_retired: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseNameSuggestion {
    pub description: String,
    pub category_id: Uuid,
    pub category_name: String,
    #[schema(required = true)]
    pub expense_group_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseGroupResponse {
    pub id: Uuid,
    pub name: String,
    pub color: String,
    pub notes: String,
    pub sort_order: i32,
    pub is_retired: bool,
    /// Directly linked to a property or vehicle; independent of deletion policy.
    pub is_source_linked: bool,
    pub can_delete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseCategoryWritePayload {
    pub name: String,
    #[serde(default)]
    pub expense_group_id: Option<Uuid>,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub is_retired: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseCategorySummaryResponse {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
    pub expense_group_id: Option<Uuid>,
    pub is_system: bool,
    pub sort_order: i32,
    #[serde(with = "rust_decimal::serde::float")]
    pub total_amount: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub monthly_average: Decimal,
    pub entry_count: i64,
    pub first_entry_date: Option<NaiveDate>,
    pub last_entry_date: Option<NaiveDate>,
    pub is_retired: bool,
    /// Directly linked to a loan or projected property utilities.
    pub is_source_linked: bool,
    #[serde(default)]
    pub utility_property_id: Option<Uuid>,
    pub can_delete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpensesBoardResponse {
    pub groups: Vec<ExpenseGroupResponse>,
    pub categories: Vec<ExpenseCategorySummaryResponse>,
    pub monthly_totals: Vec<ExpenseCategoryMonthlyPointResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseCategoryMonthlyPointResponse {
    pub category_id: Option<Uuid>,
    pub period: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseEntryResponse {
    pub id: Uuid,
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    pub entry_date: Option<NaiveDate>,
    pub owner_scope: String,
    pub notes: String,
    pub data_source: String,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub extra_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseMonthlyPointResponse {
    pub period: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseSubcategoryResponse {
    pub id: Uuid,
    pub name: String,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseCategoryDetailResponse {
    pub id: Uuid,
    pub name: String,
    pub expense_group_id: Option<Uuid>,
    pub is_system: bool,
    pub sort_order: i32,
    pub subcategories: Vec<ExpenseSubcategoryResponse>,
    pub monthly_totals: Vec<ExpenseMonthlyPointResponse>,
    pub entries: Vec<ExpenseEntryResponse>,
    pub is_retired: bool,
    /// Directly linked to a loan; excludes group membership and generic projects.
    pub is_source_linked: bool,
    pub can_delete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ExpenseEntryUpdatePayload {
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    pub entry_date: NaiveDate,
    #[serde(default = "joint_scope")]
    pub owner_scope: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub category_id: Option<Uuid>,
    #[serde(default)]
    pub subcategory_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ManualExpenseCreate {
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    pub entry_date: NaiveDate,
    #[serde(default = "joint_scope")]
    pub owner_scope: String,
    #[serde(default = "other_category")]
    pub category_name: String,
    pub subcategory_name: Option<String>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ManualIncomeCreate {
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    pub entry_date: NaiveDate,
    #[serde(default = "joint_scope")]
    pub owner_scope: String,
    #[serde(default = "income_category")]
    pub category_name: String,
    pub subcategory_name: Option<String>,
    pub income_source_id: Option<Uuid>,
    #[serde(default)]
    pub notes: String,
}

fn joint_scope() -> String {
    "joint".to_owned()
}

fn other_category() -> String {
    "Other".to_owned()
}

fn income_category() -> String {
    "Household income".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct IncomeCustomField {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct IncomeLine {
    #[serde(default)]
    pub label: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    #[serde(default = "monthly_frequency")]
    pub frequency: String,
    pub owner_scope: Option<String>,
    #[serde(default)]
    pub category: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub fields: Vec<IncomeCustomField>,
}

fn monthly_frequency() -> String {
    "monthly".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct IncomeMilestone {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct IncomeSourcePayload {
    pub name: String,
    #[serde(default = "employment_source")]
    pub source_type: String,
    #[serde(default = "joint_scope")]
    pub owner_scope: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub lines: Vec<IncomeLine>,
    #[serde(default)]
    pub fields: Vec<IncomeCustomField>,
    #[serde(default)]
    pub milestones: Vec<IncomeMilestone>,
    #[serde(default)]
    pub sort_order: i32,
}

fn employment_source() -> String {
    "employment".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct IncomeSourceEntryPayload {
    #[serde(default)]
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    pub entry_date: NaiveDate,
    pub owner_scope: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "empty_object")]
    pub extra_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct IncomeSourceEntryResponse {
    pub id: Uuid,
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    pub entry_date: Option<NaiveDate>,
    pub owner_scope: String,
    pub notes: String,
    pub extra_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct IncomeSourceResponse {
    pub id: Uuid,
    pub name: String,
    pub source_type: String,
    pub owner_scope: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub lines: Vec<IncomeLine>,
    pub fields: Vec<IncomeCustomField>,
    pub milestones: Vec<IncomeMilestone>,
    pub sort_order: i32,
    #[serde(with = "rust_decimal::serde::float")]
    pub annual_total: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub actual_total: Decimal,
    pub line_count: usize,
    pub entries: Vec<IncomeSourceEntryResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LoanSchedulePaymentPayload {
    pub id: Option<Uuid>,
    pub completed: Option<bool>,
    pub date: NaiveDate,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub payment: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub interest: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub principal: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub extra_principal: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub outstanding_loan_balance: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub interest_balance: Option<Decimal>,
    pub projected: Option<bool>,
}

impl From<LoanSchedulePaymentPayload> for checkbook_domain::LoanSchedulePayment {
    fn from(row: LoanSchedulePaymentPayload) -> Self {
        Self {
            id: row.id,
            completed: row.completed,
            date: row.date,
            payment: row.payment,
            interest: row.interest,
            principal: row.principal,
            extra_principal: row.extra_principal,
            outstanding_loan_balance: row.outstanding_loan_balance,
            interest_balance: row.interest_balance,
            projected: row.projected,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LoanUpdatePayload {
    pub name: String,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub current_balance: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub monthly_payment: Option<Decimal>,
    #[serde(with = "rust_decimal::serde::float")]
    pub interest_rate: Decimal,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub original_balance: Option<Decimal>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub notes: String,
    pub linked_property_id: Option<Uuid>,
    /// Omitted or null retains payment records; an array explicitly replaces them, including [].
    /// Incomplete rows recalculate at the current rate using the next base installment as a
    /// fixed payment, preserving extra principal; completed values remain authoritative.
    pub payment_schedule: Option<Vec<LoanSchedulePaymentPayload>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ManualLoanCreate {
    pub name: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub current_balance: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub monthly_payment: Decimal,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub original_balance: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float")]
    pub interest_rate: Decimal,
    #[serde(default = "loan_type")]
    pub liability_type: String,
    #[serde(default = "joint_scope")]
    pub owner_scope: String,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub linked_property_id: Option<Uuid>,
}

fn loan_type() -> String {
    "loan".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct LoanSummary {
    pub id: Uuid,
    pub name: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub current_balance: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub monthly_payment: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub interest_rate: Decimal,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub original_balance: Option<Decimal>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub notes: String,
    pub projected_payoff_months: Option<u32>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub interest_remaining: Option<Decimal>,
    pub details: Value,
    pub linked_property_id: Option<Uuid>,
}

/// Financial-account subtype of an account-category asset. Drives which
/// net-worth component group the account lands in ('stocks' and 'options'
/// → investing, 'savings' → savings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssetAccountType {
    Savings,
    Stocks,
    Options,
}

impl AssetAccountType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Savings => "savings",
            Self::Stocks => "stocks",
            Self::Options => "options",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "savings" => Some(Self::Savings),
            "stocks" => Some(Self::Stocks),
            "options" => Some(Self::Options),
            _ => None,
        }
    }
}

/// Tax registration of an account-category asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssetAccountRegistration {
    Regular,
    Retirement,
}

impl AssetAccountRegistration {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Regular => "regular",
            Self::Retirement => "retirement",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "regular" => Some(Self::Regular),
            "retirement" => Some(Self::Retirement),
            _ => None,
        }
    }
}

/// One ordered position (lot) on an account-category asset, written as part
/// of the full replacement list on every create/update.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AccountHoldingPayload {
    pub name: String,
    #[serde(default)]
    pub ticker: Option<String>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub quantity: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub unit_price: Option<Decimal>,
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
    #[serde(default)]
    pub purchased_on: Option<NaiveDate>,
    #[serde(default)]
    pub sold_on: Option<NaiveDate>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub sell_value: Option<Decimal>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AccountHoldingResponse {
    pub ticker: Option<String>,
    pub id: Uuid,
    pub name: String,
    #[serde(with = "rust_decimal::serde::float_option")]
    pub quantity: Option<Decimal>,
    #[serde(with = "rust_decimal::serde::float_option")]
    pub unit_price: Option<Decimal>,
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
    pub purchased_on: Option<NaiveDate>,
    pub sold_on: Option<NaiveDate>,
    #[serde(with = "rust_decimal::serde::float_option")]
    pub sell_value: Option<Decimal>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AssetWritePayload {
    pub name: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub total_cost: Decimal,
    pub valuation_date: NaiveDate,
    #[serde(default = "planned_status")]
    pub status: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "project_kind")]
    pub kind: String,
    #[serde(default = "property_category")]
    pub category: String,
    /// Account subtype; required when `category` is `account`, forbidden
    /// otherwise.
    #[serde(default)]
    pub account_type: Option<AssetAccountType>,
    /// Account tax registration; defaults to `regular` when omitted/null on
    /// an account, forbidden otherwise.
    #[serde(default)]
    pub account_registration: Option<AssetAccountRegistration>,
    /// Full replacement list of positions; only allowed when `category` is
    /// `account`.
    #[serde(default)]
    pub holdings: Option<Vec<AccountHoldingPayload>>,
    /// Signed monthly appreciation (positive) / depreciation (negative)
    /// fraction, e.g. `-0.02` for -2%/month. Compounds forward from
    /// `valuation`/`valuation_date`, which this write re-anchors to.
    #[serde(default, with = "rust_decimal::serde::float")]
    pub depreciation_rate: Decimal,
    /// Whether the depreciation/appreciation card is shown; the rate above
    /// is preserved even when this is false so re-enabling doesn't lose it.
    #[serde(default = "true_default")]
    pub depreciation_enabled: bool,
    /// Feature toggles: hides this property from other pages/areas
    /// (utilities board, projects filter, expense rollups) without
    /// deleting the underlying data. Default enabled.
    #[serde(default = "true_default")]
    pub utilities_enabled: bool,
    #[serde(default = "true_default")]
    pub projects_enabled: bool,
    #[serde(default = "true_default")]
    pub expenses_enabled: bool,
    /// Expense category ids whose spend rolls up against this property.
    #[serde(default)]
    pub linked_category_ids: Vec<Uuid>,
    #[serde(default = "empty_object")]
    pub details: Value,
}

fn true_default() -> bool {
    true
}

fn planned_status() -> String {
    "planned".to_owned()
}

fn project_kind() -> String {
    "project".to_owned()
}

fn property_category() -> String {
    "property".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AssetUpdatePayload {
    pub name: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub total_cost: Decimal,
    pub valuation_date: NaiveDate,
    #[serde(default = "completed_status")]
    pub status: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "property_category")]
    pub category: String,
    #[serde(default)]
    pub account_type: Option<AssetAccountType>,
    #[serde(default)]
    pub account_registration: Option<AssetAccountRegistration>,
    #[serde(default)]
    pub holdings: Option<Vec<AccountHoldingPayload>>,
    #[serde(default, with = "rust_decimal::serde::float")]
    pub depreciation_rate: Decimal,
    #[serde(default = "true_default")]
    pub depreciation_enabled: bool,
    #[serde(default = "true_default")]
    pub utilities_enabled: bool,
    #[serde(default = "true_default")]
    pub projects_enabled: bool,
    #[serde(default = "true_default")]
    pub expenses_enabled: bool,
    #[serde(default)]
    pub linked_category_ids: Vec<Uuid>,
    #[serde(default = "empty_object")]
    pub details: Value,
}

fn completed_status() -> String {
    "completed".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AssetSummary {
    pub id: Uuid,
    pub name: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub total_cost: Decimal,
    pub valuation_date: NaiveDate,
    pub status: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub details: Value,
    pub item_count: usize,
    pub completed_item_count: usize,
    #[serde(with = "rust_decimal::serde::float")]
    pub completed_cost: Decimal,
    #[serde(with = "rust_decimal::serde::float")]
    pub completion_percent: Decimal,
    pub derived_status: Option<String>,
    pub kind: String,
    pub category: String,
    pub account_type: Option<AssetAccountType>,
    pub account_registration: Option<AssetAccountRegistration>,
    pub holdings: Vec<AccountHoldingResponse>,
    pub account_id: Option<Uuid>,
    pub linked_asset_id: Option<Uuid>,
    pub linked_asset_name: Option<String>,
    /// Signed monthly appreciation/depreciation fraction applied to
    /// `original_total_cost` (as of `valuation_date`) to produce the live
    /// `total_cost`.
    #[serde(with = "rust_decimal::serde::float")]
    pub depreciation_rate: Decimal,
    /// Whether the depreciation/appreciation card is shown.
    pub depreciation_enabled: bool,
    /// The last manually-set value `total_cost` compounds forward from as
    /// of `valuation_date` — shown as secondary/"deeper" info alongside the
    /// live value.
    #[serde(with = "rust_decimal::serde::float")]
    pub original_total_cost: Decimal,
    /// Feature toggles: hides this property from other pages/areas
    /// (utilities board, projects filter, expense rollups) without
    /// deleting the underlying data.
    pub utilities_enabled: bool,
    pub projects_enabled: bool,
    pub expenses_enabled: bool,
    /// Expense category ids whose spend rolls up against this property.
    pub linked_category_ids: Vec<Uuid>,
    /// All-time sum of expenses tagged with any linked category.
    #[serde(with = "rust_decimal::serde::float")]
    pub linked_expense_total: Decimal,
}

/// A user-entered supplementary value/date history point for a property,
/// distinct from its `total_cost`/`valuation_date` compounding anchor.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct PropertyValuation {
    pub id: Uuid,
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
    pub effective_date: NaiveDate,
}

#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct PropertyValuationCreate {
    #[serde(with = "rust_decimal::serde::float")]
    pub value: Decimal,
    pub effective_date: NaiveDate,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityFieldState {
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub amount: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub meter_reading: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub usage_amount: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityBoardMonth {
    pub month: String,
    pub completed: bool,
    pub values: BTreeMap<String, UtilityFieldState>,
    #[serde(with = "rust_decimal::serde::float")]
    pub total: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilitySeriesPoint {
    pub period: String,
    #[serde(with = "decimal_map")]
    pub values: BTreeMap<String, Decimal>,
    #[serde(with = "decimal_map")]
    pub usage: BTreeMap<String, Decimal>,
    pub units: BTreeMap<String, String>,
    #[serde(with = "rust_decimal::serde::float")]
    pub total: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityBoardSubject {
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub group_type: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub tracked_fields: Vec<TrackedField>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityBoardResponse {
    pub subject: UtilityBoardSubject,
    pub trend: Vec<UtilitySeriesPoint>,
    pub months: Vec<UtilityBoardMonth>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityEntryFormField {
    pub contract_id: Option<Uuid>,
    pub property_id: Option<Uuid>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub tracking_mode: Option<String>,
    pub amount_source: String,
    #[serde(default)]
    pub color: Option<String>,
    pub entry_mode: String,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub unit_rate: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub usage_amount: Option<Decimal>,
    pub key: String,
    pub label: String,
    pub kind: String,
    pub unit: String,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub amount: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub meter_reading: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub previous_amount: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub previous_meter_reading: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub previous_usage: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityEntryFormResponse {
    pub month: String,
    pub completed: bool,
    pub fields: Vec<UtilityEntryFormField>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityEntryValue {
    #[serde(default)]
    pub amount_source: Option<String>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub usage_amount: Option<Decimal>,
    pub field_key: String,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub amount: Option<Decimal>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub meter_reading: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityEntriesUpsert {
    pub month: String,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub entries: Vec<UtilityEntryValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityReassignRequest {
    pub from_property_id: Uuid,
    pub to_property_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UtilityFieldLinkRequest {
    pub property_id: Uuid,
    pub field_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ManualUtilityCreate {
    #[serde(default = "manual_provider")]
    pub provider: String,
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    pub amount: Decimal,
    pub charge_date: NaiveDate,
    #[serde(default = "joint_scope")]
    pub owner_scope: String,
    #[serde(default = "other_category")]
    pub category_name: String,
    pub property_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    pub service_key: Option<String>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub usage_amount: Option<Decimal>,
    #[serde(default)]
    pub usage_unit: String,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub meter_reading: Option<Decimal>,
    #[serde(default)]
    pub notes: String,
}

fn manual_provider() -> String {
    "Manual".to_owned()
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, str::FromStr};

    use super::MonthlyBreakdownPointResponse;
    use rust_decimal::Decimal;

    #[test]
    fn monthly_breakdown_values_serialize_as_json_numbers_not_strings() -> anyhow::Result<()> {
        let mut values = BTreeMap::new();
        values.insert("Food".to_owned(), Decimal::from_str("450.00")?);
        values.insert("Transport".to_owned(), Decimal::from_str("120.50")?);
        let point = MonthlyBreakdownPointResponse {
            period: "2026-06".to_owned(),
            values,
        };
        let json: serde_json::Value = serde_json::to_value(&point)?;
        assert_eq!(json["values"]["Food"], serde_json::json!(450.0));
        assert_eq!(json["values"]["Transport"], serde_json::json!(120.5));
        assert!(
            json["values"]["Food"].is_number(),
            "expected a JSON number, not a string"
        );
        Ok(())
    }
}

fn default_utility_entry_mode() -> String {
    "meter".to_owned()
}

/// `rust_decimal::serde::float_option` rejects an explicit JSON null when the
/// payload is buffered through `#[serde(flatten)]`, which would refuse every
/// utility configuration sent without a unit price. Deserializing through
/// `Option<f64>` first keeps null working in flattened and standalone
/// payloads alike.
mod optional_decimal_rate {
    use rust_decimal::Decimal;
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Decimal>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Option::<f64>::deserialize(deserializer)?;
        value
            .map(Decimal::try_from)
            .transpose()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct UtilityConfigPayload {
    /// Omit to preserve the saved color, or send null to clear it.
    #[serde(default, deserialize_with = "deserialize_utility_color_update")]
    #[schema(value_type = Option<String>, pattern = "^#[0-9A-Fa-f]{6}$")]
    pub color: Option<Option<String>>,
    pub label: String,
    #[serde(default)]
    pub kind: String,
    pub unit: String,
    pub entry_mode: String,
    #[serde(with = "optional_decimal_rate")]
    pub unit_rate: Option<Decimal>,
}

fn deserialize_utility_color_update<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct UtilityConfigCreate {
    /// Omit to let the server derive a household-unique key from the label.
    #[serde(default)]
    pub key: Option<String>,
    #[serde(flatten)]
    pub config: UtilityConfigPayload,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct UtilityConfigAuditResponse {
    pub id: Uuid,
    pub actor_user_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub old_config: serde_json::Value,
    pub new_config: serde_json::Value,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct UtilityOrderPayload {
    pub keys: Vec<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct UtilityLifecyclePayload {
    pub retired: bool,
    pub hidden: bool,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct UtilityContract {
    #[schema(value_type = Option<String>, pattern = "^#[0-9A-Fa-f]{6}$")]
    pub color: Option<String>,
    pub id: Uuid,
    pub property_id: Uuid,
    pub key: String,
    pub label: String,
    pub tracking_mode: String,
    pub unit: String,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub retired: bool,
    pub sort_order: i32,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UtilityContractCreate {
    #[schema(value_type = Option<String>, pattern = "^#[0-9A-Fa-f]{6}$")]
    pub color: Option<String>,
    pub property_id: Uuid,
    pub label: String,
    pub tracking_mode: String,
    pub unit: String,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub initial_price: Option<Decimal>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UtilityContractUpdate {
    #[serde(default, deserialize_with = "deserialize_utility_color_update")]
    #[schema(value_type = Option<String>, pattern = "^#[0-9A-Fa-f]{6}$")]
    pub color: Option<Option<String>>,
    pub label: String,
    pub tracking_mode: String,
    pub unit: String,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UtilityContractReorder {
    pub property_id: Uuid,
    pub ordered_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct UtilityContractPrice {
    pub id: Uuid,
    pub effective_on: NaiveDate,
    #[serde(with = "rust_decimal::serde::float")]
    pub price: Decimal,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UtilityContractPriceInput {
    pub effective_on: NaiveDate,
    #[serde(with = "rust_decimal::serde::float")]
    pub price: Decimal,
}
