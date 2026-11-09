-- UI Categories are expense_groups; UI Groups are root expense categories.
-- Source identity is structural. No payment rows are created by this migration.
ALTER TABLE expense_groups
    ADD COLUMN linked_property_id uuid,
    ADD CONSTRAINT expense_groups_property_fk
        FOREIGN KEY (household_id, linked_property_id)
        REFERENCES properties(household_id, id)
        ON DELETE SET NULL (linked_property_id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX expense_groups_property_unique
    ON expense_groups(household_id, linked_property_id)
    WHERE linked_property_id IS NOT NULL;

ALTER TABLE categories
    ADD COLUMN linked_loan_id uuid,
    ADD COLUMN linked_project_id uuid,
    ADD CONSTRAINT categories_loan_fk
        FOREIGN KEY (household_id, linked_loan_id)
        REFERENCES loans(household_id, id)
        ON DELETE SET NULL (linked_loan_id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT categories_project_fk
        FOREIGN KEY (household_id, linked_project_id)
        REFERENCES projects(household_id, id)
        ON DELETE SET NULL (linked_project_id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT categories_source_scope CHECK (
        (linked_loan_id IS NULL AND linked_project_id IS NULL)
        OR (kind = 'expense' AND parent_id IS NULL
            AND num_nonnulls(linked_loan_id, linked_project_id) = 1)
    );
CREATE UNIQUE INDEX categories_loan_unique
    ON categories(household_id, linked_loan_id) WHERE linked_loan_id IS NOT NULL;
CREATE UNIQUE INDEX categories_project_unique
    ON categories(household_id, linked_project_id) WHERE linked_project_id IS NOT NULL;

-- The previous unqualified action would also clear the non-null tenant key.
ALTER TABLE categories
    DROP CONSTRAINT categories_household_id_expense_group_id_fkey,
    ADD CONSTRAINT categories_household_id_expense_group_id_fkey
        FOREIGN KEY (household_id, expense_group_id)
        REFERENCES expense_groups(household_id, id)
        ON DELETE SET NULL (expense_group_id);

-- Invoker functions preserve forced RLS. Callers already hold the household
-- mutation lock via tenant::begin; DISTINCT guards terminate reverse updates.
CREATE FUNCTION app.sync_property_expense_group() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_id uuid;
    existing_property uuid;
BEGIN
    IF current_setting('app.expense_source_restore', true) = 'on' THEN
        RETURN NEW;
    END IF;
    SELECT id INTO target_id FROM expense_groups
    WHERE household_id = NEW.household_id AND linked_property_id = NEW.id;
    IF target_id IS NULL THEN
        IF (SELECT count(*) FROM properties
            WHERE household_id = NEW.household_id
              AND lower(trim(name)) = lower(trim(NEW.name))) > 1 THEN
            RAISE EXCEPTION 'Properties with identical names cannot share an expense category'
                USING ERRCODE = '23505';
        END IF;
        SELECT id, linked_property_id INTO target_id, existing_property
        FROM expense_groups WHERE household_id = NEW.household_id
            AND normalized_name = lower(trim(NEW.name));
        IF target_id IS NOT NULL
           AND current_setting('app.expense_source_backfill', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'Expense category name already exists; choose a distinct property name'
                USING ERRCODE = '23505';
        END IF;
        IF existing_property IS NOT NULL AND existing_property <> NEW.id THEN
            RAISE EXCEPTION 'Expense category name is already linked to another property'
                USING ERRCODE = '23505';
        END IF;
        IF target_id IS NULL THEN
            INSERT INTO expense_groups(household_id, name, normalized_name, linked_property_id)
            VALUES (NEW.household_id, trim(NEW.name), lower(trim(NEW.name)), NEW.id);
        ELSE
            UPDATE expense_groups SET linked_property_id = NEW.id, updated_at = now()
            WHERE household_id = NEW.household_id AND id = target_id;
        END IF;
    ELSE
        UPDATE expense_groups SET name = trim(NEW.name), normalized_name = lower(trim(NEW.name)),
            updated_at = now()
        WHERE household_id = NEW.household_id AND id = target_id
          AND (name, normalized_name) IS DISTINCT FROM (trim(NEW.name), lower(trim(NEW.name)));
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION app.sync_source_expense_category() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_id uuid;
    group_id uuid;
    existing_loan uuid;
    existing_project uuid;
    is_loan boolean := TG_TABLE_NAME = 'loans';
BEGIN
    IF current_setting('app.expense_source_restore', true) = 'on' THEN
        RETURN NEW;
    END IF;
    IF NEW.linked_property_id IS NOT NULL THEN
        SELECT id INTO group_id FROM expense_groups
        WHERE household_id = NEW.household_id AND linked_property_id = NEW.linked_property_id;
        IF group_id IS NULL THEN
            RAISE EXCEPTION 'Linked property has no expense category' USING ERRCODE = '23514';
        END IF;
    END IF;
    SELECT id INTO target_id FROM categories
    WHERE household_id = NEW.household_id
      AND ((is_loan AND linked_loan_id = NEW.id)
        OR (NOT is_loan AND linked_project_id = NEW.id));
    IF target_id IS NULL THEN
        IF ((SELECT count(*) FROM loans WHERE household_id = NEW.household_id
               AND lower(trim(name)) = lower(trim(NEW.name)))
            + (SELECT count(*) FROM projects WHERE household_id = NEW.household_id
               AND lower(trim(name)) = lower(trim(NEW.name)))) > 1 THEN
            RAISE EXCEPTION 'Loans and projects with identical names cannot share an expense group'
                USING ERRCODE = '23505';
        END IF;
        SELECT id, linked_loan_id, linked_project_id
            INTO target_id, existing_loan, existing_project
        FROM categories WHERE household_id = NEW.household_id AND kind = 'expense'
            AND parent_id IS NULL AND normalized_name = lower(trim(NEW.name));
        IF target_id IS NOT NULL
           AND current_setting('app.expense_source_backfill', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'Expense group name already exists; choose a distinct source name'
                USING ERRCODE = '23505';
        END IF;
        IF existing_loan IS NOT NULL OR existing_project IS NOT NULL THEN
            RAISE EXCEPTION 'Expense group name is already linked to another source'
                USING ERRCODE = '23505';
        END IF;
        IF target_id IS NULL THEN
            INSERT INTO categories(household_id, kind, name, normalized_name, expense_group_id,
                linked_loan_id, linked_project_id)
            VALUES (NEW.household_id, 'expense', trim(NEW.name), lower(trim(NEW.name)), group_id,
                CASE WHEN is_loan THEN NEW.id END, CASE WHEN NOT is_loan THEN NEW.id END);
        ELSE
            UPDATE categories SET linked_loan_id = CASE WHEN is_loan THEN NEW.id END,
                linked_project_id = CASE WHEN NOT is_loan THEN NEW.id END,
                expense_group_id = group_id, updated_at = now()
            WHERE household_id = NEW.household_id AND id = target_id;
        END IF;
    ELSE
        UPDATE categories SET name = trim(NEW.name), normalized_name = lower(trim(NEW.name)),
            expense_group_id = group_id, updated_at = now()
        WHERE household_id = NEW.household_id AND id = target_id
          AND (name, normalized_name, expense_group_id)
              IS DISTINCT FROM (trim(NEW.name), lower(trim(NEW.name)), group_id);
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION app.sync_expense_source_reverse() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    property_id uuid;
BEGIN
    IF current_setting('app.expense_source_restore', true) = 'on' THEN
        RETURN NEW;
    END IF;
    IF TG_TABLE_NAME = 'expense_groups' THEN
        IF NEW.linked_property_id IS NOT NULL
           AND (TG_OP = 'INSERT' OR OLD.name IS DISTINCT FROM NEW.name) THEN
            UPDATE properties SET name = NEW.name, updated_at = now()
            WHERE household_id = NEW.household_id AND id = NEW.linked_property_id
                AND name IS DISTINCT FROM NEW.name;
            UPDATE financial_accounts account SET name = NEW.name, updated_at = now()
            FROM properties property
            WHERE property.household_id = NEW.household_id AND property.id = NEW.linked_property_id
              AND account.household_id = property.household_id AND account.id = property.account_id
              AND account.name IS DISTINCT FROM NEW.name;
        END IF;
    ELSE
        IF NEW.linked_loan_id IS NULL AND NEW.linked_project_id IS NULL THEN
            RETURN NEW;
        END IF;
        IF NEW.expense_group_id IS NOT NULL THEN
            SELECT linked_property_id INTO property_id FROM expense_groups
            WHERE household_id = NEW.household_id AND id = NEW.expense_group_id;
            IF property_id IS NULL THEN
                RAISE EXCEPTION 'A source-linked group must belong to a property category or Uncategorized'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF NEW.linked_loan_id IS NOT NULL THEN
            UPDATE loans SET name = NEW.name, linked_property_id = property_id, updated_at = now()
            WHERE household_id = NEW.household_id AND id = NEW.linked_loan_id
              AND (name, linked_property_id) IS DISTINCT FROM (NEW.name, property_id);
            UPDATE financial_accounts account SET name = NEW.name, updated_at = now()
            FROM loans loan
            WHERE loan.household_id = NEW.household_id AND loan.id = NEW.linked_loan_id
              AND account.household_id = loan.household_id AND account.id = loan.account_id
              AND account.name IS DISTINCT FROM NEW.name;
        ELSE
            UPDATE projects SET name = NEW.name, linked_property_id = property_id, updated_at = now()
            WHERE household_id = NEW.household_id AND id = NEW.linked_project_id
              AND (name, linked_property_id) IS DISTINCT FROM (NEW.name, property_id);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION app.guard_linked_expense_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.expense_source_restore', true) = 'on' THEN
        RETURN OLD;
    END IF;
    -- Parent household deletion legitimately cascades all source rows.
    IF NOT EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) THEN
        RETURN OLD;
    END IF;
    IF TG_TABLE_NAME = 'expense_groups' THEN
        IF OLD.linked_property_id IS NOT NULL THEN
            RAISE EXCEPTION 'Delete the linked property instead of its expense category'
                USING ERRCODE = '23514';
        END IF;
    ELSIF OLD.linked_loan_id IS NOT NULL OR OLD.linked_project_id IS NOT NULL THEN
        RAISE EXCEPTION 'Delete the linked loan or project instead of its expense group'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER property_expense_sync AFTER INSERT OR UPDATE OF name ON properties
    FOR EACH ROW EXECUTE FUNCTION app.sync_property_expense_group();
CREATE TRIGGER loan_expense_sync AFTER INSERT OR UPDATE OF name, linked_property_id ON loans
    FOR EACH ROW EXECUTE FUNCTION app.sync_source_expense_category();
CREATE TRIGGER project_expense_sync AFTER INSERT OR UPDATE OF name, linked_property_id ON projects
    FOR EACH ROW EXECUTE FUNCTION app.sync_source_expense_category();
CREATE TRIGGER expense_group_source_sync AFTER INSERT OR UPDATE ON expense_groups
    FOR EACH ROW EXECUTE FUNCTION app.sync_expense_source_reverse();
CREATE TRIGGER expense_category_source_sync AFTER INSERT OR UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION app.sync_expense_source_reverse();
CREATE TRIGGER expense_group_source_delete BEFORE DELETE ON expense_groups
    FOR EACH ROW EXECUTE FUNCTION app.guard_linked_expense_delete();
CREATE TRIGGER expense_category_source_delete BEFORE DELETE ON categories
    FOR EACH ROW EXECUTE FUNCTION app.guard_linked_expense_delete();

-- Backfill one tenant at a time because affected tables have forced RLS.
DO $$
DECLARE
    tenant_id uuid;
    previous_tenant text := current_setting('app.household_id', true);
    previous_backfill text := current_setting('app.expense_source_backfill', true);
BEGIN
    PERFORM set_config('app.expense_source_backfill', 'on', true);
    FOR tenant_id IN SELECT id FROM households ORDER BY id LOOP
        PERFORM set_config('app.household_id', tenant_id::text, true);

        UPDATE properties SET name = name WHERE household_id = tenant_id;
        UPDATE loans SET name = name WHERE household_id = tenant_id;
        UPDATE projects SET name = name WHERE household_id = tenant_id;

        -- Explicit whole-root mappings can safely follow their property's
        -- expense category. Child-only and multi-property mappings stay intact.
        UPDATE categories category SET expense_group_id = linked.expense_group_id
        FROM (
            SELECT mapping.category_id, bucket.id AS expense_group_id
            FROM property_categories mapping
            JOIN expense_groups bucket ON bucket.household_id = mapping.household_id
                AND bucket.linked_property_id = mapping.property_id
            WHERE mapping.household_id = tenant_id
              AND NOT EXISTS (
                  SELECT 1 FROM property_categories other
                  WHERE other.household_id = mapping.household_id
                    AND other.category_id = mapping.category_id
                    AND other.property_id <> mapping.property_id)
        ) linked
        WHERE category.household_id = tenant_id AND category.id = linked.category_id
            AND category.kind = 'expense' AND category.parent_id IS NULL
            AND category.linked_loan_id IS NULL AND category.linked_project_id IS NULL
            AND category.expense_group_id IS NULL;
    END LOOP;
    PERFORM set_config('app.household_id', coalesce(previous_tenant, ''), true);
    PERFORM set_config('app.expense_source_backfill', coalesce(previous_backfill, ''), true);
END;
$$;
