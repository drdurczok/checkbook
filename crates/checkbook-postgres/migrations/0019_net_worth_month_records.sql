-- Canonical manually curated net worth months. A record fully replaces the
-- snapshot-derived aggregation for its period: imports keep writing account
-- balance snapshots, but the curated month reports its own components until
-- the record is deleted. Completed months are frozen against component edits
-- until they are explicitly reopened (completed = false).
CREATE TABLE net_worth_months (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    period date NOT NULL CHECK (date_trunc('month', period)::date = period),
    completed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, period)
);

CREATE TABLE net_worth_month_components (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    month_id uuid NOT NULL,
    group_key text NOT NULL CHECK (group_key IN ('investing', 'savings', 'non_liquid_assets', 'debt')),
    label text NOT NULL CHECK (label = trim(label) AND length(label) > 0),
    value numeric NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, month_id, group_key, label),
    FOREIGN KEY (household_id, month_id)
        REFERENCES net_worth_months(household_id, id) ON DELETE CASCADE,
    CHECK (group_key != 'debt' OR value >= 0)
);

CREATE INDEX net_worth_month_components_month_idx
    ON net_worth_month_components(household_id, month_id);

ALTER TABLE net_worth_months ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON net_worth_months
    USING (household_id = app.current_household_id())
    WITH CHECK (household_id = app.current_household_id());
ALTER TABLE net_worth_months FORCE ROW LEVEL SECURITY;

ALTER TABLE net_worth_month_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON net_worth_month_components
    USING (household_id = app.current_household_id())
    WITH CHECK (household_id = app.current_household_id());
ALTER TABLE net_worth_month_components FORCE ROW LEVEL SECURITY;
