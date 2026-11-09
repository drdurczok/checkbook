-- Existing rows lack durable provenance. Do not guess manual ownership from names
-- or missing source links (sources may already have been removed).
ALTER TABLE expense_groups
    ADD COLUMN is_retired boolean NOT NULL DEFAULT false,
    ADD COLUMN creation_origin text NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE categories
    ADD COLUMN is_retired boolean NOT NULL DEFAULT false,
    ADD COLUMN creation_origin text NOT NULL DEFAULT 'legacy_unknown';

-- Unannotated creation paths, including source triggers, imports, planning,
-- system bootstrap and asset helpers, are automatic. Only manual writes opt in.
ALTER TABLE expense_groups ALTER COLUMN creation_origin SET DEFAULT 'automatic';
ALTER TABLE categories ALTER COLUMN creation_origin SET DEFAULT 'automatic';
ALTER TABLE expense_groups ADD CONSTRAINT expense_groups_creation_origin_check
    CHECK (creation_origin IN ('manual', 'automatic', 'legacy_unknown'));
ALTER TABLE categories ADD CONSTRAINT categories_creation_origin_check
    CHECK (creation_origin IN ('manual', 'automatic', 'legacy_unknown'));

CREATE FUNCTION app.expense_group_can_delete(target_household uuid, target_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM expense_groups g
        WHERE g.household_id = target_household AND g.id = target_id
          AND g.creation_origin = 'manual' AND g.linked_property_id IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM categories c
              WHERE c.household_id = g.household_id AND c.expense_group_id = g.id
                AND (c.linked_loan_id IS NOT NULL OR c.linked_project_id IS NOT NULL))
    );
$$;

CREATE FUNCTION app.expense_category_can_delete(target_household uuid, target_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    WITH RECURSIVE subtree AS (
        SELECT id, household_id, creation_origin, is_system, linked_loan_id, linked_project_id
        FROM categories WHERE household_id = target_household AND id = target_id AND kind = 'expense'
        UNION ALL
        SELECT c.id, c.household_id, c.creation_origin, c.is_system, c.linked_loan_id, c.linked_project_id
        FROM categories c JOIN subtree parent ON c.household_id = parent.household_id AND c.parent_id = parent.id
    )
    SELECT EXISTS (SELECT 1 FROM subtree) AND NOT EXISTS (
        SELECT 1 FROM subtree c
        WHERE c.creation_origin <> 'manual' OR c.is_system
          OR c.linked_loan_id IS NOT NULL OR c.linked_project_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM property_categories p
                     WHERE p.household_id = c.household_id AND p.category_id = c.id)
          OR EXISTS (SELECT 1 FROM planning_rules p
                     WHERE p.household_id = c.household_id AND p.category_id = c.id)
          OR EXISTS (SELECT 1 FROM recurring_commitments r
                     WHERE r.household_id = c.household_id
                       AND (r.category_id = c.id OR r.subcategory_id = c.id))
    );
$$;

CREATE FUNCTION app.guard_expense_creation_origin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.creation_origin IS DISTINCT FROM OLD.creation_origin THEN
        RAISE EXCEPTION 'Expense creation origin is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER expense_group_origin_guard BEFORE UPDATE ON expense_groups
    FOR EACH ROW EXECUTE FUNCTION app.guard_expense_creation_origin();
CREATE TRIGGER expense_category_origin_guard BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION app.guard_expense_creation_origin();

-- Preserve the existing controlled restore and household-cascade exceptions.
CREATE OR REPLACE FUNCTION app.guard_linked_expense_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.expense_source_restore', true) = 'on'
       OR NOT EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) THEN
        RETURN OLD;
    END IF;
    IF TG_TABLE_NAME = 'expense_groups' THEN
        IF NOT app.expense_group_can_delete(OLD.household_id, OLD.id) THEN
            RAISE EXCEPTION 'Automatically created or source-referenced expense groups cannot be deleted; retire them instead'
                USING ERRCODE = '23514';
        END IF;
    ELSIF OLD.kind = 'expense' AND NOT app.expense_category_can_delete(OLD.household_id, OLD.id) THEN
        RAISE EXCEPTION 'Automatically created or source-referenced expenses cannot be deleted; retire them instead'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;
