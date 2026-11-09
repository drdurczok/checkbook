-- Explicit completion is independent of the calendar: imported forecasts do not
-- become completed just because their dates pass.
ALTER TABLE loan_payments
    ADD COLUMN completed boolean NOT NULL DEFAULT true,
    ADD COLUMN interest_balance numeric CHECK (interest_balance >= 0),
    ADD COLUMN schedule_order integer NOT NULL DEFAULT 0,
    ALTER COLUMN total_payment TYPE numeric,
    ALTER COLUMN total_payment DROP NOT NULL,
    ALTER COLUMN principal_amount TYPE numeric,
    ALTER COLUMN principal_amount DROP NOT NULL,
    ALTER COLUMN interest_amount TYPE numeric,
    ALTER COLUMN interest_amount DROP NOT NULL,
    ALTER COLUMN extra_payment TYPE numeric,
    ALTER COLUMN extra_payment DROP NOT NULL,
    ALTER COLUMN remaining_balance TYPE numeric;

-- The last user-edited JSON schedule wins when legacy copies disagree. Match
-- duplicate dates by occurrence, preserving existing identities where possible.
-- Loans without an explicit JSON schedule retain their existing payment records.
CREATE TEMP TABLE canonical_loan_schedule ON COMMIT DROP AS
WITH legacy AS (
    SELECT l.household_id, l.id AS loan_id, s.value, s.ordinality::integer AS schedule_order,
           (s.value->>'date')::date AS payment_date,
           row_number() OVER (PARTITION BY l.household_id, l.id, s.value->>'date'
                              ORDER BY s.ordinality) AS date_ordinal
    FROM loans l
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(l.terms_payload->'payment_schedule') = 'array'
             THEN l.terms_payload->'payment_schedule' ELSE '[]'::jsonb END
    ) WITH ORDINALITY s(value, ordinality)
), existing AS (
    SELECT p.*, row_number() OVER (PARTITION BY household_id, loan_id, payment_date
                                  ORDER BY created_at, id) AS date_ordinal
    FROM loan_payments p
)
SELECT COALESCE(p.id, gen_random_uuid()) AS id, l.household_id, l.loan_id,
       l.payment_date, (l.value->>'payment')::numeric AS total_payment,
       (l.value->>'principal')::numeric AS principal_amount,
       (l.value->>'interest')::numeric AS interest_amount,
       (l.value->>'extra_principal')::numeric AS extra_payment,
       (l.value->>'outstanding_loan_balance')::numeric AS remaining_balance,
       (l.value->>'interest_balance')::numeric AS interest_balance,
       COALESCE((l.value->>'completed')::boolean,
                NOT COALESCE((l.value->>'projected')::boolean, false)) AS completed,
       l.schedule_order,
       COALESCE(p.source_key, 'canonical:loan-payment:' || gen_random_uuid()::text) AS source_key,
       p.source_fingerprint, COALESCE(p.extra_payload, '{}'::jsonb) AS extra_payload,
       COALESCE(p.created_at, now()) AS created_at
FROM legacy l LEFT JOIN existing p ON p.household_id = l.household_id
    AND p.loan_id = l.loan_id AND p.payment_date = l.payment_date
    AND p.date_ordinal = l.date_ordinal;

DELETE FROM loan_payments p USING loans l
WHERE p.household_id = l.household_id AND p.loan_id = l.id
    AND jsonb_typeof(l.terms_payload->'payment_schedule') = 'array';
INSERT INTO loan_payments
    (id, household_id, loan_id, payment_date, total_payment, principal_amount,
     interest_amount, extra_payment, remaining_balance, interest_balance,
     completed, schedule_order, source_key, source_fingerprint, extra_payload, created_at)
SELECT id, household_id, loan_id, payment_date, total_payment, principal_amount,
       interest_amount, extra_payment, remaining_balance, interest_balance,
       completed, schedule_order, source_key, source_fingerprint, extra_payload, created_at
FROM canonical_loan_schedule;

-- Align the scalar balance with the same immutable history used by normal edits.
-- A checkpoint anchors partial imported histories; only subsequent actual reductions count.
WITH ordered AS (
    SELECT p.*, row_number() OVER (PARTITION BY household_id, loan_id
        ORDER BY payment_date, schedule_order, id) AS position
    FROM loan_payments p WHERE completed
), checkpoints AS (
    SELECT DISTINCT ON (household_id, loan_id)
        household_id, loan_id, remaining_balance, position
    FROM ordered WHERE remaining_balance IS NOT NULL
    ORDER BY household_id, loan_id, position DESC
), balances AS (
    SELECT l.household_id, l.id,
        greatest(0, COALESCE(c.remaining_balance, l.original_balance)
            - COALESCE(sum(COALESCE(p.principal_amount, 0) + COALESCE(p.extra_payment, 0)), 0)) AS balance
    FROM loans l
    LEFT JOIN checkpoints c ON c.household_id = l.household_id AND c.loan_id = l.id
    LEFT JOIN ordered p ON p.household_id = l.household_id AND p.loan_id = l.id
        AND p.position > COALESCE(c.position, 0)
    WHERE c.position IS NOT NULL OR EXISTS (
        SELECT 1 FROM ordered evidence WHERE evidence.household_id = l.household_id
            AND evidence.loan_id = l.id
            AND (evidence.principal_amount IS NOT NULL OR evidence.extra_payment IS NOT NULL)
    )
    GROUP BY l.household_id, l.id, l.original_balance, c.remaining_balance
)
UPDATE loans l SET current_balance = b.balance FROM balances b
WHERE l.household_id = b.household_id AND l.id = b.id;

UPDATE loans SET terms_payload = terms_payload - 'payment_schedule';

-- Compatibility response shape, derived on read rather than independently stored.
-- SECURITY INVOKER retains forced household RLS and the explicit tenant predicate.
CREATE FUNCTION app.loan_terms_with_schedule(tenant_id uuid, target_loan_id uuid, terms jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
    SELECT (terms - 'payment_schedule') || jsonb_build_object('payment_schedule',
        COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'id', p.id, 'date', p.payment_date,
            'payment', p.total_payment::text, 'principal', p.principal_amount::text,
            'interest', p.interest_amount::text, 'extra_principal', p.extra_payment::text,
            'outstanding_loan_balance', p.remaining_balance::text,
            'interest_balance', p.interest_balance::text,
            'completed', p.completed, 'projected', NOT p.completed
        )) ORDER BY p.payment_date, p.schedule_order, p.id), '[]'::jsonb))
    FROM loan_payments p WHERE p.household_id = tenant_id AND p.loan_id = target_loan_id;
$$;
