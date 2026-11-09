CREATE TABLE payday_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    section text NOT NULL DEFAULT 'mandatory' CHECK (section = 'mandatory'),
    kind text NOT NULL CHECK (kind IN ('expense', 'savings', 'transfer', 'other')),
    category_id uuid,
    subcategory_id uuid,
    category_name text,
    subcategory_name text,
    amount numeric(20,2) NOT NULL CHECK (amount >= 0),
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, category_id) REFERENCES categories(household_id, id) ON DELETE SET NULL (category_id),
    FOREIGN KEY (household_id, subcategory_id) REFERENCES categories(household_id, id) ON DELETE SET NULL (subcategory_id)
);
CREATE TABLE payday_months (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    month date NOT NULL CHECK (extract(day FROM month) = 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, month),
    UNIQUE (household_id, id)
);
CREATE TABLE payday_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    month_id uuid NOT NULL,
    template_id uuid,
    title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    section text NOT NULL CHECK (section IN ('mandatory', 'monthly', 'flexible')),
    kind text NOT NULL CHECK (kind IN ('expense', 'savings', 'transfer', 'other')),
    category_id uuid,
    subcategory_id uuid,
    category_name text,
    subcategory_name text,
    amount numeric(20,2) NOT NULL CHECK (amount >= 0),
    notes text NOT NULL DEFAULT '',
    source text NOT NULL CHECK (source IN ('manual', 'template', 'suggestion')),
    source_key text,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, month_id, source_key),
    FOREIGN KEY (household_id, month_id) REFERENCES payday_months(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, template_id) REFERENCES payday_templates(household_id, id) ON DELETE SET NULL (template_id),
    FOREIGN KEY (household_id, category_id) REFERENCES categories(household_id, id) ON DELETE SET NULL (category_id),
    FOREIGN KEY (household_id, subcategory_id) REFERENCES categories(household_id, id) ON DELETE SET NULL (subcategory_id)
);
CREATE INDEX payday_allocations_month_idx ON payday_allocations(household_id, month_id);
ALTER TABLE payday_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE payday_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON payday_templates USING (household_id = app.current_household_id()) WITH CHECK (household_id = app.current_household_id());
ALTER TABLE payday_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE payday_months FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON payday_months USING (household_id = app.current_household_id()) WITH CHECK (household_id = app.current_household_id());
ALTER TABLE payday_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payday_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON payday_allocations USING (household_id = app.current_household_id()) WITH CHECK (household_id = app.current_household_id());
