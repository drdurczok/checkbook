ALTER TABLE payday_templates
    ADD COLUMN expense_group_id uuid,
    ADD COLUMN expense_group_name text,
    ADD FOREIGN KEY (household_id, expense_group_id)
        REFERENCES expense_groups(household_id, id) ON DELETE SET NULL (expense_group_id);
ALTER TABLE payday_allocations
    ADD COLUMN expense_group_id uuid,
    ADD COLUMN expense_group_name text,
    ADD FOREIGN KEY (household_id, expense_group_id)
        REFERENCES expense_groups(household_id, id) ON DELETE SET NULL (expense_group_id);

UPDATE payday_templates p
SET expense_group_id = g.id, expense_group_name = g.name
FROM categories c JOIN expense_groups g
    ON g.household_id = c.household_id AND g.id = c.expense_group_id
WHERE p.household_id = c.household_id AND p.category_id = c.id;
UPDATE payday_allocations p
SET expense_group_id = g.id, expense_group_name = g.name
FROM categories c JOIN expense_groups g
    ON g.household_id = c.household_id AND g.id = c.expense_group_id
WHERE p.household_id = c.household_id AND p.category_id = c.id;
