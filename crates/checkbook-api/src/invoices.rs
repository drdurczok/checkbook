use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
};
use checkbook_application::ApplicationError;
use checkbook_documents::{InvoiceDocument, InvoiceLineDocument, render_invoice_pdf};
use checkbook_postgres::invoices::{
    BuyerRecord, InvoiceConversionInput, InvoiceDetails, InvoiceLineRecord, InvoiceStoreError,
    InvoiceWriteInput, TemplateDetails, TemplateInput, TemplateLineInput,
    create_buyer as store_create_buyer, create_template as store_create_template,
    delete_invoice as store_delete_invoice, generate_invoice as store_generate_invoice,
    list_buyers as store_list_buyers, list_invoices as store_list_invoices,
    list_templates as store_list_templates, load_invoice_details,
    update_invoice as store_update_invoice,
};
use rust_decimal::Decimal;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    ApiState,
    auth::{authenticated, require_permission},
    dto::{
        BuyerPayload, BuyerResponse, InvoiceLineItem, InvoiceResponse, InvoiceTemplatePayload,
        InvoiceTemplateResponse, InvoiceWritePayload,
    },
    error::ApiError,
};

#[derive(Debug, Deserialize)]
pub struct InvoiceFilter {
    income_source_id: Option<Uuid>,
}

pub async fn list_buyers(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<BuyerResponse>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let rows = store_list_buyers(&state.pool, context.household.id)
        .await
        .map_err(storage)?;
    Ok(Json(rows.into_iter().map(buyer_response).collect()))
}

pub async fn create_buyer(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<BuyerPayload>,
) -> Result<Json<BuyerResponse>, ApiError> {
    validate_text(&payload.name, 1, 255, "name")?;
    validate_text(&payload.nip, 0, 64, "nip")?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let row = store_create_buyer(
        &state.pool,
        context.household.id,
        &payload.name,
        &payload.nip,
        &payload.address,
    )
    .await
    .map_err(storage)?;
    Ok(Json(buyer_response(row)))
}

pub async fn list_templates(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<InvoiceTemplateResponse>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let result = store_list_templates(&state.pool, context.household.id)
        .await
        .map_err(storage)?
        .into_iter()
        .map(template_response)
        .collect();
    Ok(Json(result))
}

pub async fn create_template(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<InvoiceTemplatePayload>,
) -> Result<Json<InvoiceTemplateResponse>, ApiError> {
    validate_template(&payload)?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let input = template_input(&payload)?;
    let response = store_create_template(&state.pool, context.household.id, input)
        .await
        .map_err(storage)
        .map(template_response)?;
    Ok(Json(response))
}

pub async fn list_invoices(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(filter): Query<InvoiceFilter>,
) -> Result<Json<Vec<InvoiceResponse>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let result = store_list_invoices(&state.pool, context.household.id, filter.income_source_id)
        .await
        .map_err(map_invoice_store_error)?
        .into_iter()
        .map(invoice_response)
        .collect();
    Ok(Json(result))
}

pub async fn generate_invoice(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<InvoiceWritePayload>,
) -> Result<Json<InvoiceResponse>, ApiError> {
    validate_invoice(&payload)?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let input = invoice_write_input(&payload)?;
    let response = invoice_response(
        store_generate_invoice(&state.pool, context.household.id, input)
            .await
            .map_err(map_invoice_store_error)?,
    );
    Ok(Json(response))
}

pub async fn update_invoice(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(invoice_id): Path<Uuid>,
    Json(payload): Json<InvoiceWritePayload>,
) -> Result<Json<InvoiceResponse>, ApiError> {
    validate_invoice(&payload)?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let input = invoice_write_input(&payload)?;
    let response = invoice_response(
        store_update_invoice(&state.pool, context.household.id, invoice_id, input)
            .await
            .map_err(map_invoice_store_error)?,
    );
    Ok(Json(response))
}

pub async fn delete_invoice(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(invoice_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "delete")?;
    let deleted = store_delete_invoice(
        &state.pool,
        context.household.id,
        context.user.id,
        invoice_id,
    )
    .await
    .map_err(storage)?;
    if !deleted {
        return Err(invoice_not_found());
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn download_pdf(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(invoice_id): Path<Uuid>,
) -> Result<Response<Body>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let details = load_invoice_details(&state.pool, context.household.id, invoice_id)
        .await
        .map_err(map_invoice_store_error)?;
    let row = details.invoice;
    let document = InvoiceDocument {
        invoice_number: row.invoice_number.clone(),
        title: row.title.clone(),
        seller_name: row.seller_name.clone(),
        seller_details: row.seller_details.clone(),
        buyer_name: row.buyer_name.clone(),
        buyer_details: row.buyer_details.clone(),
        buyer_nip: row.buyer_nip.clone(),
        buyer_address: row.buyer_address.clone(),
        issue_date: row.issue_date.to_string(),
        sale_date: row.sale_date.map(|date| date.to_string()),
        due_date: row.due_date.map(|date| date.to_string()),
        currency: row.currency.clone(),
        status: row.status.clone(),
        conversion_enabled: row.conversion_enabled,
        conversion_currency: row.conversion_currency.clone(),
        conversion_rate: row.conversion_rate,
        subtotal: row.subtotal,
        tax_amount: row.tax_amount,
        total_amount: row.total_amount,
        payment_terms: row.payment_terms.clone(),
        notes: row.notes.clone(),
        lines: details
            .lines
            .into_iter()
            .map(|line| InvoiceLineDocument {
                description: line.description,
                quantity: line.quantity,
                unit_price: line.unit_price,
                vat_rate: line.vat_rate,
                unit: line.unit,
                currency: line.currency,
            })
            .collect(),
    };
    let _blocking_permit = crate::blocking_permit().await?;
    let started = std::time::Instant::now();
    let rendered = tokio::task::spawn_blocking(move || render_invoice_pdf(&document)).await;
    let pdf = match rendered {
        Ok(Ok(pdf)) => {
            crate::metrics::observe_pdf_render(true, started.elapsed());
            pdf
        }
        Ok(Err(_)) | Err(_) => {
            crate::metrics::observe_pdf_render(false, started.elapsed());
            return Err(storage_message());
        }
    };
    let filename = format!("{}.pdf", row.invoice_number.replace('"', ""));
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
        .map_err(|_| storage_message())?;
    let mut response = Response::new(Body::from(pdf));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/pdf"),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, disposition);
    Ok(response)
}

fn template_input(payload: &InvoiceTemplatePayload) -> Result<TemplateInput, ApiError> {
    Ok(TemplateInput {
        name: payload.name.trim().to_owned(),
        title: payload.title.trim().to_owned(),
        seller_name: payload.seller_name.trim().to_owned(),
        seller_details: payload.seller_details.trim().to_owned(),
        buyer_name: payload.buyer_name.trim().to_owned(),
        buyer_details: payload.buyer_details.trim().to_owned(),
        currency: normalize_currency(&payload.currency)?,
        payment_terms: payload.payment_terms.trim().to_owned(),
        notes: payload.notes.trim().to_owned(),
        line_items: payload
            .line_items
            .iter()
            .map(|line| {
                Ok(TemplateLineInput {
                    description: line.description.trim().to_owned(),
                    quantity: line.quantity,
                    unit_price: line.unit_price,
                    vat_rate: normalize_vat(&line.vat_rate)?,
                    unit: line.unit.trim().to_owned(),
                    currency: normalize_optional_currency(&line.currency)?,
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?,
    })
}

fn invoice_write_input(payload: &InvoiceWritePayload) -> Result<InvoiceWriteInput, ApiError> {
    let currency = payload.conversion_currency.trim().to_ascii_uppercase();
    let conversion = if payload.conversion_enabled
        && !currency.is_empty()
        && payload.conversion_rate > Decimal::ZERO
    {
        validate_currency(&currency)?;
        InvoiceConversionInput {
            enabled: true,
            currency,
            rate: payload.conversion_rate,
        }
    } else {
        InvoiceConversionInput {
            enabled: false,
            currency: String::new(),
            rate: Decimal::ONE,
        }
    };

    Ok(InvoiceWriteInput {
        template_id: payload.template_id,
        save_template: payload.save_template,
        template_name: payload
            .template_name
            .as_ref()
            .map(|value| value.trim().to_owned()),
        invoice_number: payload
            .invoice_number
            .as_ref()
            .map(|value| value.trim().to_owned()),
        title: payload.title.trim().to_owned(),
        income_source_id: payload.income_source_id,
        seller_name: payload.seller_name.trim().to_owned(),
        seller_details: payload.seller_details.trim().to_owned(),
        buyer_name: payload.buyer_name.trim().to_owned(),
        buyer_details: payload.buyer_details.trim().to_owned(),
        buyer_nip: payload.buyer_nip.trim().to_owned(),
        buyer_address: payload.buyer_address.trim().to_owned(),
        issue_date: payload.issue_date,
        sale_date: payload.sale_date,
        due_date: payload.due_date,
        currency: normalize_currency(&payload.currency)?,
        status: payload.status.trim().to_ascii_lowercase(),
        conversion,
        payment_terms: payload.payment_terms.trim().to_owned(),
        notes: payload.notes.trim().to_owned(),
        line_items: payload
            .line_items
            .iter()
            .map(|line| {
                Ok(TemplateLineInput {
                    description: line.description.trim().to_owned(),
                    quantity: line.quantity,
                    unit_price: line.unit_price,
                    vat_rate: normalize_vat(&line.vat_rate)?,
                    unit: line.unit.trim().to_owned(),
                    currency: normalize_optional_currency(&line.currency)?,
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?,
    })
}

fn invoice_response(details: InvoiceDetails) -> InvoiceResponse {
    let row = details.invoice;
    InvoiceResponse {
        id: row.id,
        invoice_number: row.invoice_number,
        title: row.title,
        template_id: row.template_id,
        template_name: row.template_name,
        income_source_id: row.income_source_id,
        seller_name: row.seller_name,
        seller_details: row.seller_details,
        buyer_name: row.buyer_name,
        buyer_details: row.buyer_details,
        buyer_nip: row.buyer_nip,
        buyer_address: row.buyer_address,
        issue_date: row.issue_date,
        sale_date: row.sale_date,
        due_date: row.due_date,
        currency: row.currency,
        status: row.status,
        conversion_enabled: row.conversion_enabled,
        conversion_currency: row.conversion_currency,
        conversion_rate: row.conversion_rate,
        subtotal: row.subtotal,
        tax_amount: row.tax_amount,
        total_amount: row.total_amount,
        notes: row.notes,
        line_items: details.lines.into_iter().map(line_record_item).collect(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn template_response(details: TemplateDetails) -> InvoiceTemplateResponse {
    let row = details.template;
    InvoiceTemplateResponse {
        id: row.id,
        name: row.name,
        title: row.title,
        seller_name: row.seller_name,
        seller_details: row.seller_details,
        buyer_name: row.buyer_name,
        buyer_details: row.buyer_details,
        currency: row.currency,
        payment_terms: row.payment_terms,
        notes: row.notes,
        line_items: details.lines.into_iter().map(line_record_item).collect(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn line_record_item(row: InvoiceLineRecord) -> InvoiceLineItem {
    InvoiceLineItem {
        description: row.description,
        quantity: row.quantity,
        unit_price: row.unit_price,
        vat_rate: row.vat_rate,
        unit: row.unit,
        currency: row.currency,
    }
}

fn buyer_response(row: BuyerRecord) -> BuyerResponse {
    BuyerResponse {
        id: row.id,
        name: row.name,
        nip: row.nip,
        address: row.address,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn validate_invoice(payload: &InvoiceWritePayload) -> Result<(), ApiError> {
    validate_text(&payload.buyer_name, 1, 255, "buyer_name")?;
    validate_text(&payload.buyer_nip, 0, 64, "buyer_nip")?;
    validate_text(&payload.title, 0, 255, "title")?;
    validate_text(&payload.seller_name, 0, 255, "seller_name")?;
    validate_currency(&payload.currency)?;
    if !matches!(
        payload.status.trim().to_ascii_lowercase().as_str(),
        "draft" | "issued" | "paid" | "cancelled"
    ) {
        return Err(validation("Invalid invoice status."));
    }
    if payload.line_items.is_empty() {
        return Err(ApiError(ApplicationError::BadRequest(
            "Invoice requires at least one line item.".to_owned(),
        )));
    }
    validate_lines(&payload.line_items)?;
    Ok(())
}

fn validate_template(payload: &InvoiceTemplatePayload) -> Result<(), ApiError> {
    validate_text(&payload.name, 1, 255, "name")?;
    validate_text(&payload.title, 0, 255, "title")?;
    validate_currency(&payload.currency)?;
    validate_lines(&payload.line_items)
}

fn validate_lines(lines: &[InvoiceLineItem]) -> Result<(), ApiError> {
    for line in lines {
        validate_text(&line.description, 1, 255, "description")?;
        validate_text(&line.unit, 0, 32, "unit")?;
        if line.quantity <= Decimal::ZERO {
            return Err(validation("quantity must be greater than 0."));
        }
        if line.unit_price < Decimal::ZERO {
            return Err(validation("unit_price must be greater than or equal to 0."));
        }
        normalize_vat(&line.vat_rate)?;
        normalize_optional_currency(&line.currency)?;
    }
    Ok(())
}

fn validate_text(value: &str, minimum: usize, maximum: usize, field: &str) -> Result<(), ApiError> {
    let count = value.trim().chars().count();
    if count < minimum || count > maximum {
        return Err(validation(&format!("Invalid {field}.")));
    }
    Ok(())
}

fn normalize_currency(value: &str) -> Result<String, ApiError> {
    let currency = value.trim().to_ascii_uppercase();
    validate_currency(&currency)?;
    Ok(currency)
}

fn normalize_optional_currency(value: &str) -> Result<String, ApiError> {
    let currency = value.trim().to_ascii_uppercase();
    if currency.is_empty() {
        return Ok(currency);
    }
    validate_currency(&currency)?;
    Ok(currency)
}

fn validate_currency(value: &str) -> Result<(), ApiError> {
    let currency = value.trim();
    if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return Err(validation("Currency must be a three-letter code."));
    }
    Ok(())
}

fn normalize_vat(value: &str) -> Result<String, ApiError> {
    let rate = value.trim().to_ascii_lowercase();
    vat_fraction(&rate)?;
    Ok(rate)
}

fn vat_fraction(value: &str) -> Result<Decimal, ApiError> {
    let rate = value.trim().to_ascii_lowercase();
    if rate == "zw" {
        return Ok(Decimal::ZERO);
    }
    let percent = rate
        .parse::<Decimal>()
        .map_err(|_| validation("Invalid VAT rate."))?;
    if percent < Decimal::ZERO || percent > Decimal::from(100_u8) {
        return Err(validation("Invalid VAT rate."));
    }
    Ok(percent / Decimal::from(100_u8))
}

fn map_invoice_store_error(error: InvoiceStoreError) -> ApiError {
    match error {
        InvoiceStoreError::InvoiceNumberExists => ApiError(ApplicationError::ConflictMessage(
            "Invoice number already exists.".to_owned(),
        )),
        InvoiceStoreError::InvoiceNotFound => invoice_not_found(),
        InvoiceStoreError::TemplateNotFound => ApiError(ApplicationError::NotFoundMessage(
            "Invoice template not found.".to_owned(),
        )),
        InvoiceStoreError::IncomeSourceNotFound => ApiError(ApplicationError::NotFoundMessage(
            "Income source not found.".to_owned(),
        )),
        InvoiceStoreError::TemplateNameRequired => ApiError(ApplicationError::BadRequest(
            "Template name is required.".to_owned(),
        )),
        InvoiceStoreError::Calculation(error) => {
            tracing::error!(%error, "invoice calculation failed");
            storage_message()
        }
        InvoiceStoreError::Database(error) => storage(error),
    }
}

fn invoice_not_found() -> ApiError {
    ApiError(ApplicationError::NotFoundMessage(
        "Invoice not found.".to_owned(),
    ))
}

fn validation(detail: &str) -> ApiError {
    ApiError(ApplicationError::Validation(detail.to_owned()))
}

fn storage(_error: sqlx::Error) -> ApiError {
    storage_message()
}

fn storage_message() -> ApiError {
    ApiError(ApplicationError::Storage)
}
