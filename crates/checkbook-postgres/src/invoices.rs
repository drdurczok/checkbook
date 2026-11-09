use checkbook_domain::{InvoiceLine, calculate_invoice};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

use crate::tenant;

#[derive(Debug, Clone)]
pub struct BuyerRecord {
    pub id: Uuid,
    pub name: String,
    pub nip: String,
    pub address: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct TemplateRecord {
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct InvoiceLineRecord {
    pub description: String,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    pub vat_rate: String,
    pub unit: String,
    pub currency: String,
}

#[derive(Debug, Clone)]
pub struct InvoiceRecord {
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
    pub conversion_rate: Decimal,
    pub subtotal: Decimal,
    pub tax_amount: Decimal,
    pub total_amount: Decimal,
    pub payment_terms: String,
    pub notes: String,
    pub revision_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct TemplateDetails {
    pub template: TemplateRecord,
    pub lines: Vec<InvoiceLineRecord>,
}

#[derive(Debug, Clone)]
pub struct TemplateInput {
    pub name: String,
    pub title: String,
    pub seller_name: String,
    pub seller_details: String,
    pub buyer_name: String,
    pub buyer_details: String,
    pub currency: String,
    pub payment_terms: String,
    pub notes: String,
    pub line_items: Vec<TemplateLineInput>,
}

#[derive(Debug, Clone)]
pub struct TemplateLineInput {
    pub description: String,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    pub vat_rate: String,
    pub unit: String,
    pub currency: String,
}

#[derive(Debug, Clone)]
pub struct InvoiceDetails {
    pub invoice: InvoiceRecord,
    pub lines: Vec<InvoiceLineRecord>,
}

#[derive(Debug, Clone)]
pub struct InvoiceWriteInput {
    pub template_id: Option<Uuid>,
    pub save_template: bool,
    pub template_name: Option<String>,
    pub invoice_number: Option<String>,
    pub title: String,
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
    pub conversion: InvoiceConversionInput,
    pub payment_terms: String,
    pub notes: String,
    pub line_items: Vec<TemplateLineInput>,
}

#[derive(Debug, Clone)]
pub struct InvoiceConversionInput {
    pub enabled: bool,
    pub currency: String,
    pub rate: Decimal,
}

#[derive(Debug, thiserror::Error)]
pub enum InvoiceStoreError {
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("invoice number already exists")]
    InvoiceNumberExists,
    #[error("invoice not found")]
    InvoiceNotFound,
    #[error("invoice template not found")]
    TemplateNotFound,
    #[error("income source not found")]
    IncomeSourceNotFound,
    #[error("template name is required")]
    TemplateNameRequired,
    #[error("invoice calculation failed: {0}")]
    Calculation(String),
}

pub async fn list_buyers(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<Vec<BuyerRecord>, sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        BuyerRecord,
        "SELECT id, name, nip, address, created_at, updated_at
         FROM buyers WHERE household_id = $1 ORDER BY name",
        household_id
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows)
}

pub async fn create_buyer(
    pool: &PgPool,
    household_id: Uuid,
    name: &str,
    nip: &str,
    address: &str,
) -> Result<BuyerRecord, sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, false).await?;
    let row = sqlx::query_as!(
        BuyerRecord,
        "INSERT INTO buyers (household_id, name, nip, address)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, nip, address, created_at, updated_at",
        household_id,
        name.trim(),
        nip.trim(),
        address.trim()
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn list_templates(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<Vec<TemplateDetails>, sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        TemplateRecord,
        "SELECT id, name, title, seller_name, seller_details, buyer_name,
                buyer_details, currency, payment_terms, notes, created_at, updated_at
         FROM invoice_templates WHERE household_id = $1 ORDER BY name",
        household_id
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        result.push(TemplateDetails {
            lines: load_template_lines_in_transaction(&mut tx, household_id, row.id).await?,
            template: row,
        });
    }
    tx.commit().await?;
    Ok(result)
}

pub async fn create_template(
    pool: &PgPool,
    household_id: Uuid,
    input: TemplateInput,
) -> Result<TemplateDetails, sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, false).await?;
    let row = insert_template_in_transaction(&mut tx, household_id, &input).await?;
    let lines = load_template_lines_in_transaction(&mut tx, household_id, row.id).await?;
    tx.commit().await?;
    Ok(TemplateDetails {
        template: row,
        lines,
    })
}

pub async fn delete_invoice(
    pool: &PgPool,
    household_id: Uuid,
    actor_user_id: Uuid,
    invoice_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, false).await?;
    let deleted = sqlx::query!(
        "DELETE FROM invoices WHERE household_id = $1 AND id = $2",
        household_id,
        invoice_id
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if deleted == 0 {
        tx.commit().await?;
        return Ok(false);
    }
    sqlx::query!(
        "INSERT INTO audit_events
            (household_id, actor_user_id, event_type, resource_type, resource_id)
         VALUES ($1,$2,'invoice_deleted','invoice',$3)",
        household_id,
        actor_user_id,
        invoice_id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn list_invoices(
    pool: &PgPool,
    household_id: Uuid,
    income_source_id: Option<Uuid>,
) -> Result<Vec<InvoiceDetails>, InvoiceStoreError> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        InvoiceRecord,
        "SELECT i.id, i.invoice_number, r.title, r.template_id, r.template_name,
                r.income_source_id, r.seller_name, r.seller_details, r.buyer_name,
                r.buyer_details, r.buyer_nip, r.buyer_address, r.issue_date,
                r.sale_date, r.due_date, r.currency, r.status, r.conversion_enabled,
                r.conversion_currency, r.conversion_rate, r.subtotal, r.tax_amount,
                r.total_amount, r.payment_terms, r.notes, r.id AS revision_id,
                i.created_at, i.updated_at
         FROM invoices i
         JOIN invoice_revisions r
           ON r.household_id = i.household_id
          AND r.invoice_id = i.id
          AND r.revision = i.current_revision
         WHERE i.household_id = $1
           AND ($2::uuid IS NULL OR r.income_source_id = $2)
         ORDER BY r.issue_date DESC, i.created_at DESC",
        household_id,
        income_source_id
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let lines =
            load_invoice_lines_in_transaction(&mut tx, household_id, row.revision_id).await?;
        result.push(InvoiceDetails {
            invoice: row,
            lines,
        });
    }
    tx.commit().await?;
    Ok(result)
}

pub async fn load_invoice_details(
    pool: &PgPool,
    household_id: Uuid,
    invoice_id: Uuid,
) -> Result<InvoiceDetails, InvoiceStoreError> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    let invoice = load_invoice_in_transaction(&mut tx, household_id, invoice_id).await?;
    let lines =
        load_invoice_lines_in_transaction(&mut tx, household_id, invoice.revision_id).await?;
    tx.commit().await?;
    Ok(InvoiceDetails { invoice, lines })
}

pub async fn generate_invoice(
    pool: &PgPool,
    household_id: Uuid,
    input: InvoiceWriteInput,
) -> Result<InvoiceDetails, InvoiceStoreError> {
    let mut tx = tenant::begin(pool, household_id, false).await?;
    tenant::advisory_lock(&mut tx, household_id).await?;
    ensure_foreign_keys_in_transaction(&mut tx, household_id, &input).await?;
    let saved_template =
        save_requested_template_in_transaction(&mut tx, household_id, &input).await?;
    let template_id = saved_template
        .as_ref()
        .map(|template| template.id)
        .or(input.template_id);
    let template_name = saved_template
        .as_ref()
        .map(|template| template.name.clone())
        .or(load_template_name_in_transaction(&mut tx, household_id, input.template_id).await?)
        .unwrap_or_default();
    let number = match input
        .invoice_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_owned(),
        None => next_invoice_number_in_transaction(&mut tx, household_id).await?,
    };
    let invoice_id = sqlx::query!(
        "INSERT INTO invoices (household_id, invoice_number)
         VALUES ($1, $2) RETURNING id",
        household_id,
        &number
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(map_invoice_write)?
    .id;
    insert_revision_in_transaction(
        &mut tx,
        household_id,
        invoice_id,
        1,
        template_id,
        &template_name,
        &input,
    )
    .await?;
    let invoice = load_invoice_in_transaction(&mut tx, household_id, invoice_id).await?;
    let lines =
        load_invoice_lines_in_transaction(&mut tx, household_id, invoice.revision_id).await?;
    tx.commit().await?;
    Ok(InvoiceDetails { invoice, lines })
}

pub async fn update_invoice(
    pool: &PgPool,
    household_id: Uuid,
    invoice_id: Uuid,
    input: InvoiceWriteInput,
) -> Result<InvoiceDetails, InvoiceStoreError> {
    let mut tx = tenant::begin(pool, household_id, false).await?;
    ensure_foreign_keys_in_transaction(&mut tx, household_id, &input).await?;
    let current = load_invoice_in_transaction(&mut tx, household_id, invoice_id).await?;
    let number = input
        .invoice_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&current.invoice_number);
    let revision = sqlx::query!(
        "UPDATE invoices
         SET invoice_number = $3, current_revision = current_revision + 1, updated_at = now()
         WHERE household_id = $1 AND id = $2
         RETURNING current_revision",
        household_id,
        invoice_id,
        number
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_invoice_write)?
    .map(|row| row.current_revision)
    .ok_or(InvoiceStoreError::InvoiceNotFound)?;
    let template_name = load_template_name_in_transaction(&mut tx, household_id, input.template_id)
        .await?
        .unwrap_or_default();
    insert_revision_in_transaction(
        &mut tx,
        household_id,
        invoice_id,
        revision,
        input.template_id,
        &template_name,
        &input,
    )
    .await?;
    let invoice = load_invoice_in_transaction(&mut tx, household_id, invoice_id).await?;
    let lines =
        load_invoice_lines_in_transaction(&mut tx, household_id, invoice.revision_id).await?;
    tx.commit().await?;
    Ok(InvoiceDetails { invoice, lines })
}

async fn insert_template_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    input: &TemplateInput,
) -> Result<TemplateRecord, sqlx::Error> {
    let row = sqlx::query_as!(
        TemplateRecord,
        "INSERT INTO invoice_templates
            (household_id, name, title, seller_name, seller_details, buyer_name,
             buyer_details, currency, payment_terms, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, name, title, seller_name, seller_details, buyer_name,
                   buyer_details, currency, payment_terms, notes, created_at, updated_at",
        household_id,
        input.name.trim(),
        input.title.trim(),
        input.seller_name.trim(),
        input.seller_details.trim(),
        input.buyer_name.trim(),
        input.buyer_details.trim(),
        &input.currency,
        input.payment_terms.trim(),
        input.notes.trim()
    )
    .fetch_one(&mut **tx)
    .await?;
    insert_template_lines_in_transaction(tx, household_id, row.id, &input.line_items).await?;
    Ok(row)
}

async fn insert_template_lines_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    template_id: Uuid,
    lines: &[TemplateLineInput],
) -> Result<(), sqlx::Error> {
    for (sort_order, line) in lines.iter().enumerate() {
        let sort_order = i32::try_from(sort_order).unwrap_or(i32::MAX);
        sqlx::query!(
            "INSERT INTO invoice_template_lines
                (household_id, template_id, description, quantity, unit_price,
                 vat_rate, unit, currency, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            household_id,
            template_id,
            line.description.trim(),
            line.quantity,
            line.unit_price,
            &line.vat_rate,
            line.unit.trim(),
            &line.currency,
            sort_order
        )
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn load_template_lines_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    template_id: Uuid,
) -> Result<Vec<InvoiceLineRecord>, sqlx::Error> {
    sqlx::query_as!(
        InvoiceLineRecord,
        "SELECT description, quantity, unit_price, vat_rate, unit, currency
         FROM invoice_template_lines
         WHERE household_id = $1 AND template_id = $2
         ORDER BY sort_order, id",
        household_id,
        template_id
    )
    .fetch_all(&mut **tx)
    .await
}

async fn ensure_foreign_keys_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    input: &InvoiceWriteInput,
) -> Result<(), InvoiceStoreError> {
    if let Some(template_id) = input.template_id {
        let found = sqlx::query!(
            "SELECT EXISTS(
                SELECT 1 FROM invoice_templates WHERE household_id = $1 AND id = $2
             ) AS \"found!\"",
            household_id,
            template_id
        )
        .fetch_one(&mut **tx)
        .await?
        .found;
        if !found {
            return Err(InvoiceStoreError::TemplateNotFound);
        }
    }
    if let Some(source_id) = input.income_source_id {
        let found = sqlx::query!(
            "SELECT EXISTS(
                SELECT 1 FROM income_sources WHERE household_id = $1 AND id = $2
             ) AS \"found!\"",
            household_id,
            source_id
        )
        .fetch_one(&mut **tx)
        .await?
        .found;
        if !found {
            return Err(InvoiceStoreError::IncomeSourceNotFound);
        }
    }
    Ok(())
}

async fn save_requested_template_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    input: &InvoiceWriteInput,
) -> Result<Option<TemplateRecord>, InvoiceStoreError> {
    if !input.save_template {
        return Ok(None);
    }
    let fallback = load_template_name_in_transaction(tx, household_id, input.template_id)
        .await?
        .unwrap_or_default();
    let name = input
        .template_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&fallback);
    if name.is_empty() {
        return Err(InvoiceStoreError::TemplateNameRequired);
    }
    let template = TemplateInput {
        name: name.to_owned(),
        title: input.title.clone(),
        seller_name: input.seller_name.clone(),
        seller_details: input.seller_details.clone(),
        buyer_name: input.buyer_name.clone(),
        buyer_details: input.buyer_details.clone(),
        currency: input.currency.clone(),
        payment_terms: input.payment_terms.clone(),
        notes: input.notes.clone(),
        line_items: input.line_items.clone(),
    };
    insert_template_in_transaction(tx, household_id, &template)
        .await
        .map(Some)
        .map_err(InvoiceStoreError::Database)
}

async fn insert_revision_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    invoice_id: Uuid,
    revision: i32,
    template_id: Option<Uuid>,
    template_name: &str,
    input: &InvoiceWriteInput,
) -> Result<(), InvoiceStoreError> {
    let calculated = calculate_totals(&input.line_items, &input.conversion)?;
    let revision_id = sqlx::query!(
        "INSERT INTO invoice_revisions
            (household_id, invoice_id, revision, title, template_id, template_name,
             income_source_id, seller_name, seller_details, buyer_name, buyer_details,
             buyer_nip, buyer_address, issue_date, sale_date, due_date, currency,
             status, conversion_enabled, conversion_currency, conversion_rate,
             subtotal, tax_amount, total_amount, payment_terms, notes)
         VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING id",
        household_id,
        invoice_id,
        revision,
        input.title.trim(),
        template_id,
        template_name,
        input.income_source_id,
        input.seller_name.trim(),
        input.seller_details.trim(),
        input.buyer_name.trim(),
        input.buyer_details.trim(),
        input.buyer_nip.trim(),
        input.buyer_address.trim(),
        input.issue_date,
        input.sale_date,
        input.due_date,
        &input.currency,
        input.status.trim().to_ascii_lowercase(),
        input.conversion.enabled,
        &input.conversion.currency,
        input.conversion.rate,
        calculated.subtotal,
        calculated.tax_amount,
        calculated.total_amount,
        input.payment_terms.trim(),
        input.notes.trim()
    )
    .fetch_one(&mut **tx)
    .await
    .map_err(map_invoice_write)?
    .id;
    for (sort_order, line) in input.line_items.iter().enumerate() {
        let factor = if input.conversion.enabled
            && !line.currency.trim().is_empty()
            && line
                .currency
                .trim()
                .eq_ignore_ascii_case(&input.conversion.currency)
        {
            input.conversion.rate
        } else {
            Decimal::ONE
        };
        let amounts = calculate_invoice(
            &[InvoiceLine {
                quantity: line.quantity,
                unit_price: line.unit_price,
                vat_rate: vat_fraction(&line.vat_rate)?,
            }],
            factor,
        )
        .map_err(|error| InvoiceStoreError::Calculation(error.to_string()))?;
        let sort_order = i32::try_from(sort_order).unwrap_or(i32::MAX);
        sqlx::query!(
            "INSERT INTO invoice_lines
                (household_id, invoice_revision_id, description, quantity, unit_price,
                 vat_rate, unit, currency, net_amount, tax_amount, gross_amount, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
            household_id,
            revision_id,
            line.description.trim(),
            line.quantity,
            line.unit_price,
            &line.vat_rate,
            line.unit.trim(),
            &line.currency,
            amounts.subtotal,
            amounts.tax_amount,
            amounts.total_amount,
            sort_order
        )
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn load_template_name_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    template_id: Option<Uuid>,
) -> Result<Option<String>, sqlx::Error> {
    let Some(template_id) = template_id else {
        return Ok(None);
    };
    Ok(sqlx::query!(
        "SELECT name FROM invoice_templates WHERE household_id = $1 AND id = $2",
        household_id,
        template_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .map(|row| row.name))
}

async fn next_invoice_number_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
) -> Result<String, sqlx::Error> {
    let highest = sqlx::query!(
        r#"SELECT COALESCE(MAX((regexp_match(invoice_number, '^INV-([0-9]+)$'))[1]::integer), 0) AS "highest!"
         FROM invoices WHERE household_id = $1"#,
        household_id
    )
    .fetch_one(&mut **tx)
    .await?
    .highest;
    Ok(format!("INV-{:04}", highest.saturating_add(1)))
}

async fn load_invoice_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    invoice_id: Uuid,
) -> Result<InvoiceRecord, InvoiceStoreError> {
    sqlx::query_as!(
        InvoiceRecord,
        "SELECT i.id, i.invoice_number, r.title, r.template_id, r.template_name,
                r.income_source_id, r.seller_name, r.seller_details, r.buyer_name,
                r.buyer_details, r.buyer_nip, r.buyer_address, r.issue_date,
                r.sale_date, r.due_date, r.currency, r.status, r.conversion_enabled,
                r.conversion_currency, r.conversion_rate, r.subtotal, r.tax_amount,
                r.total_amount, r.payment_terms, r.notes, r.id AS revision_id,
                i.created_at, i.updated_at
         FROM invoices i
         JOIN invoice_revisions r
           ON r.household_id = i.household_id
          AND r.invoice_id = i.id
         AND r.revision = i.current_revision
         WHERE i.household_id = $1 AND i.id = $2",
        household_id,
        invoice_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(InvoiceStoreError::InvoiceNotFound)
}

async fn load_invoice_lines_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    revision_id: Uuid,
) -> Result<Vec<InvoiceLineRecord>, sqlx::Error> {
    sqlx::query_as!(
        InvoiceLineRecord,
        "SELECT description, quantity, unit_price, vat_rate, unit, currency
         FROM invoice_lines
         WHERE household_id = $1 AND invoice_revision_id = $2
         ORDER BY sort_order, id",
        household_id,
        revision_id
    )
    .fetch_all(&mut **tx)
    .await
}

fn calculate_totals(
    lines: &[TemplateLineInput],
    conversion: &InvoiceConversionInput,
) -> Result<checkbook_domain::InvoiceAmounts, InvoiceStoreError> {
    let mut subtotal = Decimal::ZERO;
    let mut tax_amount = Decimal::ZERO;
    for line in lines {
        let factor = if conversion.enabled
            && !line.currency.trim().is_empty()
            && line
                .currency
                .trim()
                .eq_ignore_ascii_case(&conversion.currency)
        {
            conversion.rate
        } else {
            Decimal::ONE
        };
        let amounts = calculate_invoice(
            &[InvoiceLine {
                quantity: line.quantity,
                unit_price: line.unit_price,
                vat_rate: vat_fraction(&line.vat_rate)?,
            }],
            factor,
        )
        .map_err(|error| InvoiceStoreError::Calculation(error.to_string()))?;
        subtotal += amounts.subtotal;
        tax_amount += amounts.tax_amount;
    }
    Ok(checkbook_domain::InvoiceAmounts {
        subtotal,
        tax_amount,
        total_amount: subtotal + tax_amount,
    })
}

fn vat_fraction(value: &str) -> Result<Decimal, InvoiceStoreError> {
    let rate = value.trim().to_ascii_lowercase();
    if rate == "zw" {
        return Ok(Decimal::ZERO);
    }
    let percent = rate
        .parse::<Decimal>()
        .map_err(|_| InvoiceStoreError::Calculation("invalid VAT rate".to_owned()))?;
    Ok(percent / Decimal::from(100_u8))
}

fn map_invoice_write(error: sqlx::Error) -> InvoiceStoreError {
    if error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| code == "23505")
    {
        InvoiceStoreError::InvoiceNumberExists
    } else {
        InvoiceStoreError::Database(error)
    }
}
