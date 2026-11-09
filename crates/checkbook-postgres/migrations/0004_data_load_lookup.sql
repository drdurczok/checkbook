-- The private data-load listener receives a load UUID without an authenticated
-- household session. Expose only the tenant identifier needed to establish an
-- RLS-scoped transaction; all data-load details remain protected by RLS.
CREATE FUNCTION app.data_load_household_id(load_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT household_id
    FROM public.data_load_runs
    WHERE id = load_id
$$;

REVOKE ALL ON FUNCTION app.data_load_household_id(uuid) FROM PUBLIC;
