-- ENABLE ROW LEVEL SECURITY alone does not constrain the table owner.
-- The application role commonly owns migrated tables, so force tenant policy
-- evaluation for every household-scoped data table. `households` remains
-- owner-readable so the maintenance scheduler can enumerate IDs; every
-- request-facing lookup still selects it by the authenticated household ID.
DO $$
DECLARE
    table_name text;
BEGIN
    FOR table_name IN
        SELECT DISTINCT tablename
        FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname = 'household_isolation'
          AND tablename <> 'households'
    LOOP
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    END LOOP;
END
$$;
