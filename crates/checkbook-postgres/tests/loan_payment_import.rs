use checkbook_postgres::{
    auth::create_development_session,
    bulk_import::{BulkImportRequest, run_bulk_import},
    connect, tenant,
};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

fn payload() -> Value {
    json!({
        "source": "loan-payment-regression",
        "loans": [{
            "source_key": "test:loan",
            "account_source_key": "test:loan-account",
            "name": "Imported loan",
            "liability_type": "loan",
            "owner_scope": "joint",
            "original_balance": 1000,
            "current_balance": 999,
            "interest_rate": 0.12,
            "monthly_payment": 100,
            "start_date": "2026-01-01",
            "end_date": "2026-12-31",
            "payments": [
                {
                    "source_key": "test:checkpoint",
                    "payment_date": "2026-01-01",
                    "completed": true,
                    "total_payment": 200,
                    "principal_amount": 200,
                    "remaining_balance": 800,
                    "interest_balance": 123.45
                },
                {
                    "source_key": "test:principal-only",
                    "payment_date": "2026-02-01",
                    "completed": true,
                    "total_payment": 100,
                    "principal_amount": 100
                },
                {
                    "source_key": "test:pending-first",
                    "payment_date": "2026-03-01",
                    "completed": false,
                    "total_payment": 100,
                    "principal_amount": 777,
                    "interest_amount": 333,
                    "extra_payment": 10,
                    "remaining_balance": 999
                },
                {
                    "source_key": "test:pending-second",
                    "payment_date": "2026-04-01",
                    "projected": true,
                    "total_payment": 100,
                    "principal_amount": 777,
                    "interest_amount": 333,
                    "remaining_balance": 999
                }
            ]
        }]
    })
}

#[derive(Debug, PartialEq)]
struct Pending {
    source_key: String,
    total_payment: Decimal,
    principal_amount: Decimal,
    interest_amount: Decimal,
    extra_payment: Decimal,
    remaining_balance: Decimal,
    interest_balance: Decimal,
}

async fn state(
    pool: &PgPool,
    household: Uuid,
) -> anyhow::Result<(Decimal, Vec<String>, Vec<Pending>)> {
    let mut tx = tenant::begin(pool, household, true).await?;
    let loan = sqlx::query!(
        "SELECT id, current_balance FROM loans WHERE household_id = $1 AND source_key = 'test:loan'",
        household,
    )
    .fetch_one(&mut *tx)
    .await?;
    // Text preserves numeric lexemes as well as identities, status, metadata and
    // timestamps: touching an otherwise identical completed row must also fail.
    let completed = sqlx::query_scalar!(
        r#"SELECT row_to_json(payment)::text AS "snapshot!" FROM loan_payments payment
         WHERE household_id = $1 AND loan_id = $2 AND completed
         ORDER BY payment_date, id"#,
        household,
        loan.id,
    )
    .fetch_all(&mut *tx)
    .await?;
    let pending = sqlx::query_as!(
        Pending,
        r#"SELECT source_key AS "source_key!", total_payment AS "total_payment!",
                principal_amount AS "principal_amount!", interest_amount AS "interest_amount!",
                extra_payment AS "extra_payment!", remaining_balance AS "remaining_balance!",
                interest_balance AS "interest_balance!"
         FROM loan_payments WHERE household_id = $1 AND loan_id = $2 AND NOT completed
         ORDER BY payment_date, schedule_order, id"#,
        household,
        loan.id,
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((loan.current_balance, completed, pending))
}

fn expected_pending(
    first_interest: Decimal,
    first_principal: Decimal,
    first_extra: Decimal,
    first_balance: Decimal,
    second_interest: Decimal,
    second_principal: Decimal,
    second_balance: Decimal,
) -> Vec<Pending> {
    vec![
        Pending {
            source_key: "test:pending-first".to_owned(),
            total_payment: dec!(100),
            principal_amount: first_principal,
            interest_amount: first_interest,
            extra_payment: first_extra,
            remaining_balance: first_balance,
            interest_balance: second_interest,
        },
        Pending {
            source_key: "test:pending-second".to_owned(),
            total_payment: dec!(100),
            principal_amount: second_principal,
            interest_amount: second_interest,
            extra_payment: dec!(0),
            remaining_balance: second_balance,
            interest_balance: dec!(0),
        },
    ]
}

#[tokio::test]
async fn reimport_preserves_completed_bytes_and_reconciles_pending_history() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; loan payment import integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("loan-import-{}@example.com", Uuid::new_v4()),
        "Loan Import Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let mut input = payload();
    let request: BulkImportRequest = serde_json::from_value(input.clone())?;
    run_bulk_import(&pool, household, request).await?;
    let (balance, completed, pending) = state(&pool, household).await?;
    assert_eq!(balance, dec!(700));
    assert_eq!(completed.len(), 2);
    assert_eq!(
        pending,
        expected_pending(
            dec!(7),
            dec!(93),
            dec!(10),
            dec!(597),
            dec!(5.97),
            dec!(94.03),
            dec!(502.97)
        ),
    );

    // Reimport changes one completed row, omits the later principal-only row,
    // changes terms, and edits pending extra principal. Only pending rows move.
    input["loans"][0]["interest_rate"] = json!(0.24);
    input["loans"][0]["current_balance"] = json!(555);
    input["loans"][0]["payments"][0]["principal_amount"] = json!(900);
    input["loans"][0]["payments"][0]["remaining_balance"] = json!(100);
    input["loans"][0]["payments"][0]["completed"] = json!(false);
    input["loans"][0]["payments"][2]["extra_payment"] = json!(20);
    input["loans"][0]["payments"] = json!([
        input["loans"][0]["payments"][0].clone(),
        input["loans"][0]["payments"][2].clone(),
        input["loans"][0]["payments"][3].clone(),
    ]);
    run_bulk_import(&pool, household, serde_json::from_value(input.clone())?).await?;
    let (balance, after_completed, pending) = state(&pool, household).await?;
    assert_eq!(balance, dec!(700));
    assert_eq!(after_completed, completed);
    assert_eq!(
        pending,
        expected_pending(
            dec!(14),
            dec!(86),
            dec!(20),
            dec!(594),
            dec!(11.88),
            dec!(88.12),
            dec!(505.88)
        ),
    );

    // Omitting every completed row still retains both of them. Removing the
    // pending extra payment propagates into the next month's interest.
    input["loans"][0]["payments"] = json!([
        input["loans"][0]["payments"][1].clone(),
        input["loans"][0]["payments"][2].clone(),
    ]);
    input["loans"][0]["payments"][0]["extra_payment"] = json!(0);
    run_bulk_import(&pool, household, serde_json::from_value(input)?).await?;
    let (balance, after_completed, pending) = state(&pool, household).await?;
    assert_eq!(balance, dec!(700));
    assert_eq!(after_completed, completed);
    assert_eq!(
        pending,
        expected_pending(
            dec!(14),
            dec!(86),
            dec!(0),
            dec!(614),
            dec!(12.28),
            dec!(87.72),
            dec!(526.28)
        ),
    );
    Ok(())
}
