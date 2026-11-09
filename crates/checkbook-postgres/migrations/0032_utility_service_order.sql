ALTER TABLE utility_services ADD COLUMN sort_order bigint;

WITH ordered AS (
    SELECT id, row_number() OVER (PARTITION BY household_id ORDER BY label, service_key, id) - 1 AS position
    FROM utility_services
)
UPDATE utility_services s SET sort_order = ordered.position
FROM ordered WHERE ordered.id = s.id;

ALTER TABLE utility_services ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE utility_services ADD CONSTRAINT utility_services_sort_order_nonnegative CHECK (sort_order >= 0);

-- All service creation paths append to the household catalog. Household writes
-- already hold the tenant advisory lock, including imports and authentication seeds.
CREATE FUNCTION append_utility_service_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.sort_order IS NULL THEN
        SELECT COALESCE(MAX(sort_order) + 1, 0) INTO NEW.sort_order
        FROM utility_services WHERE household_id = NEW.household_id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER utility_services_append_order BEFORE INSERT ON utility_services
FOR EACH ROW EXECUTE FUNCTION append_utility_service_order();

CREATE INDEX utility_services_catalog_order_idx
ON utility_services (household_id, retired, sort_order, label);
