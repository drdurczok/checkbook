-- Keep the opening anchor even when the final completed payment is undone.
-- Partial imported histories must not resurrect debt absent from their opening balance.
ALTER TABLE loans ADD COLUMN schedule_opening_balance numeric CHECK (schedule_opening_balance >= 0);
UPDATE loans l SET schedule_opening_balance = CASE WHEN EXISTS (
    SELECT 1 FROM loan_payments p WHERE p.household_id = l.household_id AND p.loan_id = l.id
        AND p.completed AND (p.remaining_balance IS NOT NULL
            OR p.principal_amount IS NOT NULL OR p.extra_payment IS NOT NULL)
) THEN l.original_balance ELSE l.current_balance END;
