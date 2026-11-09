use std::collections::BTreeMap;

use rust_decimal::{Decimal, RoundingStrategy};
use serde::Serialize;
use thiserror::Error;
use typst::foundations::{Dict, IntoValue};
use typst_as_lib::TypstEngine;
use typst_layout::PagedDocument;

static TEMPLATE: &str = include_str!("../templates/invoice.typ");
static NOTO_SANS_REGULAR: &[u8] = include_bytes!("../fonts/NotoSans-Regular.ttf");
static NOTO_SANS_BOLD: &[u8] = include_bytes!("../fonts/NotoSans-Bold.ttf");

#[derive(Debug, Error)]
pub enum DocumentError {
    #[error("invoice rendering failed: {0}")]
    Render(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct InvoiceLineDocument {
    pub description: String,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    pub vat_rate: String,
    pub unit: String,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvoiceDocument {
    pub invoice_number: String,
    pub title: String,
    pub seller_name: String,
    pub seller_details: String,
    pub buyer_name: String,
    pub buyer_details: String,
    pub buyer_nip: String,
    pub buyer_address: String,
    pub issue_date: String,
    pub sale_date: Option<String>,
    pub due_date: Option<String>,
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
    pub lines: Vec<InvoiceLineDocument>,
}

pub fn render_invoice_pdf(document: &InvoiceDocument) -> Result<Vec<u8>, DocumentError> {
    let engine = TypstEngine::builder()
        .main_file(TEMPLATE)
        .fonts([NOTO_SANS_REGULAR, NOTO_SANS_BOLD])
        .build();
    let result = engine.compile_with_input(inputs(document));
    let compiled: PagedDocument = result.output.map_err(|error| {
        DocumentError::Render(format!("{error:?}; warnings: {:?}", result.warnings))
    })?;
    typst_pdf::pdf(&compiled, &Default::default())
        .map_err(|error| DocumentError::Render(format!("{error:?}")))
}

fn inputs(document: &InvoiceDocument) -> Dict {
    let mut values = Dict::new();
    insert(
        &mut values,
        "invoice_number",
        document.invoice_number.clone(),
    );
    insert(&mut values, "title", document.title.clone());
    insert(&mut values, "seller_name", document.seller_name.clone());
    insert(
        &mut values,
        "seller_details",
        document.seller_details.clone(),
    );
    insert(&mut values, "buyer_name", document.buyer_name.clone());
    insert(&mut values, "buyer_details", document.buyer_details.clone());
    insert(&mut values, "buyer_nip", document.buyer_nip.clone());
    insert(&mut values, "buyer_address", document.buyer_address.clone());
    insert(
        &mut values,
        "issue_date",
        display_date(&document.issue_date),
    );
    insert(
        &mut values,
        "sale_date",
        document
            .sale_date
            .as_deref()
            .map(display_date)
            .unwrap_or_else(|| "—".to_owned()),
    );
    insert(
        &mut values,
        "due_date",
        document
            .due_date
            .as_deref()
            .map(display_date)
            .unwrap_or_else(|| "—".to_owned()),
    );
    insert(&mut values, "status", status_label(&document.status));
    insert(
        &mut values,
        "subtotal",
        format_money(document.subtotal, &document.currency),
    );
    insert(
        &mut values,
        "tax_amount",
        format_money(document.tax_amount, &document.currency),
    );
    insert(
        &mut values,
        "total_amount",
        format_money(document.total_amount, &document.currency),
    );
    insert(&mut values, "payment_terms", document.payment_terms.clone());
    insert(&mut values, "notes", document.notes.clone());
    insert(&mut values, "conversion_note", conversion_note(document));
    values.insert(
        "lines".into(),
        document
            .lines
            .iter()
            .map(|line| line_dict(document, line))
            .collect::<Vec<_>>()
            .into_value(),
    );
    values.insert("vat_summary".into(), vat_summary(document).into_value());
    values
}

fn line_dict(document: &InvoiceDocument, line: &InvoiceLineDocument) -> Dict {
    let rate = vat_fraction(&line.vat_rate);
    let conversion = line_conversion(document, line);
    let net = money(line.quantity * line.unit_price * conversion);
    let mut values = Dict::new();
    insert(&mut values, "description", line.description.clone());
    insert(&mut values, "quantity", format_quantity(line.quantity));
    insert(&mut values, "unit", line.unit.clone());
    insert(
        &mut values,
        "unit_price",
        format_money(
            line.unit_price,
            if line.currency.is_empty() {
                &document.currency
            } else {
                &line.currency
            },
        ),
    );
    insert(&mut values, "vat_label", vat_label(&line.vat_rate));
    insert(
        &mut values,
        "net_amount",
        format_money(net, &document.currency),
    );
    insert(
        &mut values,
        "tax_amount",
        format_money(money(net * rate), &document.currency),
    );
    values
}

fn vat_summary(document: &InvoiceDocument) -> Vec<Dict> {
    let mut grouped = BTreeMap::<String, (Decimal, Decimal)>::new();
    for line in &document.lines {
        let net = money(line.quantity * line.unit_price * line_conversion(document, line));
        let tax = money(net * vat_fraction(&line.vat_rate));
        let entry = grouped
            .entry(line.vat_rate.trim().to_ascii_lowercase())
            .or_default();
        entry.0 += net;
        entry.1 += tax;
    }
    grouped
        .into_iter()
        .rev()
        .map(|(rate, (net, tax))| {
            let mut values = Dict::new();
            insert(&mut values, "vat_label", vat_label(&rate));
            insert(
                &mut values,
                "net_amount",
                format_money(net, &document.currency),
            );
            insert(
                &mut values,
                "tax_amount",
                format_money(tax, &document.currency),
            );
            values
        })
        .collect()
}

fn line_conversion(document: &InvoiceDocument, line: &InvoiceLineDocument) -> Decimal {
    if document.conversion_enabled
        && !document.conversion_currency.is_empty()
        && line.currency == document.conversion_currency
    {
        document.conversion_rate
    } else {
        Decimal::ONE
    }
}

fn conversion_note(document: &InvoiceDocument) -> String {
    if document.conversion_enabled && !document.conversion_currency.is_empty() {
        format!(
            "Kwoty w {} przeliczono po kursie 1 {} = {} {}.",
            document.conversion_currency,
            document.conversion_currency,
            format_decimal(document.conversion_rate, 4),
            document.currency
        )
    } else {
        String::new()
    }
}

fn vat_fraction(value: &str) -> Decimal {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized == "zw" {
        Decimal::ZERO
    } else {
        normalized.parse::<Decimal>().unwrap_or_default() / Decimal::ONE_HUNDRED
    }
}

fn vat_label(value: &str) -> String {
    if value.trim().eq_ignore_ascii_case("zw") {
        "zw.".to_owned()
    } else {
        format!("{}%", value.trim())
    }
}

fn money(value: Decimal) -> Decimal {
    value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

fn format_money(value: Decimal, currency: &str) -> String {
    format!("{} {}", format_decimal(money(value), 2), currency)
        .trim()
        .to_owned()
}

fn format_quantity(value: Decimal) -> String {
    value.normalize().to_string()
}

fn format_decimal(value: Decimal, scale: u32) -> String {
    let rounded = value.round_dp(scale);
    let negative = rounded.is_sign_negative();
    let absolute = rounded.abs();
    let raw = format!(
        "{absolute:.scale$}",
        scale = usize::try_from(scale).unwrap_or_default()
    );
    let (integer, fraction) = raw.split_once('.').unwrap_or((&raw, ""));
    let mut grouped = String::with_capacity(raw.len() + integer.len() / 3);
    for (index, character) in integer.chars().enumerate() {
        if index > 0 && (integer.len() - index).is_multiple_of(3) {
            grouped.push(' ');
        }
        grouped.push(character);
    }
    if !fraction.is_empty() {
        grouped.push(',');
        grouped.push_str(fraction);
    }
    if negative {
        grouped.insert(0, '-');
    }
    grouped
}

fn display_date(value: &str) -> String {
    let mut parts = value.split('-');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(year), Some(month), Some(day), None) => format!("{day}.{month}.{year}"),
        _ => value.to_owned(),
    }
}

fn status_label(value: &str) -> String {
    match value {
        "draft" => "Szkic",
        "issued" => "Wystawiona",
        "paid" => "Opłacona",
        "cancelled" => "Anulowana",
        other => other,
    }
    .to_owned()
}

fn insert<T: IntoValue>(dict: &mut Dict, key: &str, value: T) {
    dict.insert(key.into(), value.into_value());
}

#[cfg(test)]
mod tests {
    use rust_decimal_macros::dec;

    use super::{InvoiceDocument, InvoiceLineDocument, format_money, render_invoice_pdf};

    fn fixture() -> InvoiceDocument {
        InvoiceDocument {
            invoice_number: "FV/ŻÓŁĆ/2026".to_owned(),
            title: "Usługi konsultingowe".to_owned(),
            seller_name: "Example Seller".to_owned(),
            seller_details: "ul. Testowa 1\n00-001 Warszawa".to_owned(),
            buyer_name: "Zażółć Gęślą Jaźń Sp. z o.o.".to_owned(),
            buyer_details: "Długi opis nabywcy".to_owned(),
            buyer_nip: "1234567890".to_owned(),
            buyer_address: "Łódź".to_owned(),
            issue_date: "2026-06-22".to_owned(),
            sale_date: Some("2026-06-21".to_owned()),
            due_date: Some("2026-07-06".to_owned()),
            currency: "PLN".to_owned(),
            status: "issued".to_owned(),
            conversion_enabled: true,
            conversion_currency: "EUR".to_owned(),
            conversion_rate: dec!(4.25),
            subtotal: dec!(850),
            tax_amount: dec!(195.50),
            total_amount: dec!(1045.50),
            payment_terms: "14 dni".to_owned(),
            notes: "Płatność przelewem".to_owned(),
            lines: vec![
                InvoiceLineDocument {
                    description: "Konsulting".to_owned(),
                    quantity: dec!(2),
                    unit_price: dec!(100),
                    vat_rate: "23".to_owned(),
                    unit: "h".to_owned(),
                    currency: "EUR".to_owned(),
                },
                InvoiceLineDocument {
                    description: "Analiza".to_owned(),
                    quantity: dec!(1),
                    unit_price: dec!(0),
                    vat_rate: "zw".to_owned(),
                    unit: String::new(),
                    currency: "PLN".to_owned(),
                },
            ],
        }
    }

    #[test]
    fn formats_polish_money_without_binary_float() {
        assert_eq!(format_money(dec!(1234567.895), "PLN"), "1 234 567,90 PLN");
    }

    #[test]
    fn renders_structural_polish_safe_pdf() -> Result<(), super::DocumentError> {
        let pdf = render_invoice_pdf(&fixture())?;
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(pdf.len() > 10_000);
        assert!(pdf.windows(5).any(|window| window == b"/Font"));
        assert!(pdf.windows(5).any(|window| window == b"/Page"));
        Ok(())
    }
}
