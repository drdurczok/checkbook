-- Periodic maintenance must enumerate tenants without granting the application
-- role unrestricted SELECT access to the households table. The function owner
-- is the migration role, so the narrowly scoped SECURITY DEFINER function can
-- read household IDs while callers remain subject to RLS everywhere else.
CREATE FUNCTION app.maintenance_household_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT id
    FROM public.households
    ORDER BY id
$$;

REVOKE ALL ON FUNCTION app.maintenance_household_ids() FROM PUBLIC;
