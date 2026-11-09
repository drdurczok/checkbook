-- Composite tenant foreign keys must never clear household_id. PostgreSQL's
-- unqualified SET NULL applies to every referencing column, including the
-- non-null tenant key. Restrict each action to its nullable reference column.
ALTER TABLE projects
    DROP CONSTRAINT projects_household_id_linked_property_id_fkey,
    ADD CONSTRAINT projects_household_id_linked_property_id_fkey
        FOREIGN KEY (household_id, linked_property_id)
        REFERENCES properties(household_id, id)
        ON DELETE SET NULL (linked_property_id);

ALTER TABLE planning_rules
    DROP CONSTRAINT planning_rules_household_id_category_id_fkey,
    ADD CONSTRAINT planning_rules_household_id_category_id_fkey
        FOREIGN KEY (household_id, category_id)
        REFERENCES categories(household_id, id)
        ON DELETE SET NULL (category_id);

ALTER TABLE ledger_entries
    DROP CONSTRAINT ledger_entries_household_id_category_id_fkey,
    DROP CONSTRAINT ledger_entries_household_id_subcategory_id_fkey,
    DROP CONSTRAINT ledger_entries_household_id_income_source_id_fkey,
    DROP CONSTRAINT ledger_entries_household_id_linked_project_id_fkey,
    ADD CONSTRAINT ledger_entries_household_id_category_id_fkey
        FOREIGN KEY (household_id, category_id)
        REFERENCES categories(household_id, id)
        ON DELETE SET NULL (category_id),
    ADD CONSTRAINT ledger_entries_household_id_subcategory_id_fkey
        FOREIGN KEY (household_id, subcategory_id)
        REFERENCES categories(household_id, id)
        ON DELETE SET NULL (subcategory_id),
    ADD CONSTRAINT ledger_entries_household_id_income_source_id_fkey
        FOREIGN KEY (household_id, income_source_id)
        REFERENCES income_sources(household_id, id)
        ON DELETE SET NULL (income_source_id),
    ADD CONSTRAINT ledger_entries_household_id_linked_project_id_fkey
        FOREIGN KEY (household_id, linked_project_id)
        REFERENCES projects(household_id, id)
        ON DELETE SET NULL (linked_project_id);

ALTER TABLE utility_meter_readings
    DROP CONSTRAINT utility_meter_readings_household_id_previous_reading_id_fkey,
    ADD CONSTRAINT utility_meter_readings_household_id_previous_reading_id_fkey
        FOREIGN KEY (household_id, previous_reading_id)
        REFERENCES utility_meter_readings(household_id, id)
        ON DELETE SET NULL (previous_reading_id);

ALTER TABLE recurring_commitments
    DROP CONSTRAINT recurring_commitments_household_id_category_id_fkey,
    DROP CONSTRAINT recurring_commitments_household_id_subcategory_id_fkey,
    ADD CONSTRAINT recurring_commitments_household_id_category_id_fkey
        FOREIGN KEY (household_id, category_id)
        REFERENCES categories(household_id, id)
        ON DELETE SET NULL (category_id),
    ADD CONSTRAINT recurring_commitments_household_id_subcategory_id_fkey
        FOREIGN KEY (household_id, subcategory_id)
        REFERENCES categories(household_id, id)
        ON DELETE SET NULL (subcategory_id);

ALTER TABLE goals
    DROP CONSTRAINT goals_household_id_linked_loan_id_fkey,
    ADD CONSTRAINT goals_household_id_linked_loan_id_fkey
        FOREIGN KEY (household_id, linked_loan_id)
        REFERENCES loans(household_id, id)
        ON DELETE SET NULL (linked_loan_id);

ALTER TABLE scenarios
    DROP CONSTRAINT scenarios_household_id_loan_id_fkey,
    ADD CONSTRAINT scenarios_household_id_loan_id_fkey
        FOREIGN KEY (household_id, loan_id)
        REFERENCES loans(household_id, id)
        ON DELETE SET NULL (loan_id);

ALTER TABLE invoice_revisions
    DROP CONSTRAINT invoice_revisions_household_id_template_id_fkey,
    DROP CONSTRAINT invoice_revisions_household_id_income_source_id_fkey,
    ADD CONSTRAINT invoice_revisions_household_id_template_id_fkey
        FOREIGN KEY (household_id, template_id)
        REFERENCES invoice_templates(household_id, id)
        ON DELETE SET NULL (template_id),
    ADD CONSTRAINT invoice_revisions_household_id_income_source_id_fkey
        FOREIGN KEY (household_id, income_source_id)
        REFERENCES income_sources(household_id, id)
        ON DELETE SET NULL (income_source_id);
