-- Expense groups collect root expense categories into household-level
-- buckets (e.g. Groceries + Eating out -> Food). The dashboard expense mix
-- aggregates by group; ungrouped categories keep reporting under their own
-- name.
CREATE TABLE expense_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL,
    normalized_name text NOT NULL,
    color text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, normalized_name),
    CHECK (normalized_name = lower(trim(normalized_name)))
);

ALTER TABLE expense_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON expense_groups
    USING (household_id = app.current_household_id())
    WITH CHECK (household_id = app.current_household_id());
ALTER TABLE expense_groups FORCE ROW LEVEL SECURITY;

-- Only root expense categories can join a group; subcategories inherit the
-- group through their parent.
ALTER TABLE categories
    ADD COLUMN expense_group_id uuid,
    ADD FOREIGN KEY (household_id, expense_group_id)
        REFERENCES expense_groups(household_id, id) ON DELETE SET NULL,
    ADD CONSTRAINT categories_expense_group_scope CHECK (
        expense_group_id IS NULL OR (kind = 'expense' AND parent_id IS NULL)
    );

CREATE INDEX categories_expense_group_idx
    ON categories(household_id, expense_group_id)
    WHERE expense_group_id IS NOT NULL;
