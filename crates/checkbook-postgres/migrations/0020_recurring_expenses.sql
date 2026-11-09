ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_data_source_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_data_source_check
    CHECK (data_source IN ('bulk_load', 'app_manual', 'planning_only', 'app_recurring'));

CREATE TABLE recurring_expenses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    description text NOT NULL CHECK (length(trim(description)) > 0),
    amount numeric NOT NULL CHECK (amount > 0),
    start_date date NOT NULL,
    end_date date CHECK (end_date >= start_date),
    cadence text NOT NULL CHECK (cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
    owner_scope text NOT NULL CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    category_id uuid,
    notes text NOT NULL DEFAULT '',
    is_active boolean NOT NULL DEFAULT true,
    next_index integer NOT NULL DEFAULT 0 CHECK (next_index >= 0),
    revision uuid NOT NULL DEFAULT gen_random_uuid(),
    price_history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(price_history) = 'array'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, category_id) REFERENCES categories(household_id, id)
        ON DELETE SET NULL (category_id)
);
CREATE INDEX recurring_expenses_active_idx ON recurring_expenses(household_id) WHERE is_active;
ALTER TABLE recurring_expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON recurring_expenses
    USING (household_id = app.current_household_id())
    WITH CHECK (household_id = app.current_household_id());
ALTER TABLE recurring_expenses FORCE ROW LEVEL SECURITY;
