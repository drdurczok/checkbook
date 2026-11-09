-- Completion locks direct manual inputs, not derived meter-chain charges.
CREATE TABLE utility_months (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    property_id uuid,
    contract_id uuid,
    period date NOT NULL CHECK (date_trunc('month', period)::date = period),
    completed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(property_id, contract_id) = 1),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, property_id, contract_id, period),
    FOREIGN KEY (household_id, property_id)
        REFERENCES properties(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, contract_id)
        REFERENCES entry_groups(household_id, id) ON DELETE CASCADE
);

ALTER TABLE utility_months ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON utility_months
    USING (household_id = app.current_household_id())
    WITH CHECK (household_id = app.current_household_id());
ALTER TABLE utility_months FORCE ROW LEVEL SECURITY;
