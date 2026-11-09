CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Keep the expression identical to the historical suggestion search predicate.
CREATE INDEX ledger_entries_expense_name_search_idx
    ON ledger_entries USING gin
    (lower(btrim(regexp_replace(description, '\s+', ' ', 'g'))) gin_trgm_ops)
    WHERE direction = 'expense' AND status = 'actual';
