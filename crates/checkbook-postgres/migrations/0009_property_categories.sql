-- Lets a property/vehicle link expense categories (top-level or
-- subcategories) so spend tagged with those categories rolls up against it,
-- without requiring every ledger entry to carry a property_id.
CREATE TABLE property_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    property_id uuid NOT NULL,
    category_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, property_id, category_id),
    FOREIGN KEY (household_id, property_id)
        REFERENCES properties(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, category_id)
        REFERENCES categories(household_id, id) ON DELETE CASCADE
);
CREATE INDEX property_categories_property_idx
    ON property_categories(household_id, property_id);
CREATE INDEX property_categories_category_idx
    ON property_categories(household_id, category_id);

ALTER TABLE property_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON property_categories
    USING (household_id = app.current_household_id())
    WITH CHECK (household_id = app.current_household_id());
ALTER TABLE property_categories FORCE ROW LEVEL SECURITY;
