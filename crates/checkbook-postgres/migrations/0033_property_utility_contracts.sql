-- Contracts own one property's utility; legacy standalone groups remain untouched.
CREATE TABLE utility_contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    property_id uuid NOT NULL,
    service_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date,
    tracking_mode text NOT NULL CHECK (tracking_mode IN ('actual', 'fixed', 'usage', 'meter')),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, service_id),
    UNIQUE (household_id, id, property_id, service_id),
    UNIQUE (household_id, id, property_id),
    FOREIGN KEY (household_id, property_id) REFERENCES properties(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, service_id) REFERENCES utility_services(household_id, id) ON DELETE RESTRICT,
    CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE TABLE utility_contract_prices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    utility_contract_id uuid NOT NULL,
    effective_on date NOT NULL CHECK (date_trunc('month', effective_on)::date = effective_on),
    price numeric(20,6) NOT NULL CHECK (price >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, utility_contract_id, effective_on),
    FOREIGN KEY (household_id, utility_contract_id) REFERENCES utility_contracts(household_id, id) ON DELETE CASCADE
);
CREATE TABLE utility_contract_import_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    property_id uuid NOT NULL,
    source_service_key text NOT NULL,
    utility_contract_id uuid NOT NULL,
    UNIQUE (household_id, id),
    UNIQUE (household_id, property_id, source_service_key),
    FOREIGN KEY (household_id, property_id) REFERENCES properties(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, utility_contract_id, property_id) REFERENCES utility_contracts(household_id, id, property_id) ON DELETE CASCADE
);
ALTER TABLE utility_bills
    ADD COLUMN utility_contract_id uuid,
    ADD COLUMN amount_source text NOT NULL DEFAULT 'actual' CHECK (amount_source IN ('actual', 'auto'));
UPDATE utility_bills SET amount_source = 'auto' WHERE unit_rate IS NOT NULL;

-- Stable identifiers also let archive upgrades reproduce the same mapping.
CREATE TEMP TABLE utility_contract_migration ON COMMIT DROP AS
SELECT pairs.household_id, pairs.property_id, pairs.service_id AS old_service_id,
       substr(encode(sha256(convert_to(pairs.household_id::text || ':' || pairs.property_id::text || ':' || pairs.service_id::text, 'UTF8')), 'hex'), 1, 32)::uuid AS id,
       COALESCE((SELECT min(b.charge_date) FROM utility_bills b WHERE b.household_id=pairs.household_id AND b.property_id=pairs.property_id AND b.service_id=pairs.service_id),
                (SELECT (min(l.created_at) AT TIME ZONE COALESCE((SELECT timezone FROM households WHERE id=pairs.household_id), 'Europe/Warsaw'))::date FROM utility_subject_services l WHERE l.household_id=pairs.household_id AND l.property_id=pairs.property_id AND l.service_id=pairs.service_id)) AS start_date
FROM (
    SELECT household_id, property_id, service_id FROM utility_bills WHERE property_id IS NOT NULL
    UNION
    SELECT household_id, property_id, service_id FROM utility_subject_services WHERE property_id IS NOT NULL
) pairs;
INSERT INTO utility_services (id, household_id, service_key, label, service_kind, unit, is_system, created_at, updated_at, entry_mode, unit_rate, retired, hidden, sort_order)
SELECT m.id, s.household_id, 'contract_' || m.id::text, s.label, s.service_kind, s.unit, false, s.created_at, s.updated_at, s.entry_mode, s.unit_rate, s.retired, s.hidden, s.sort_order
FROM utility_contract_migration m JOIN utility_services s ON s.household_id=m.household_id AND s.id=m.old_service_id;
INSERT INTO utility_contracts (id, household_id, property_id, service_id, start_date, tracking_mode, sort_order, created_at, updated_at)
SELECT m.id, m.household_id, m.property_id, m.id, m.start_date,
       CASE WHEN s.unit_rate IS NOT NULL THEN s.entry_mode
            ELSE COALESCE((SELECT b.entry_mode FROM utility_bills b
                             WHERE b.household_id=m.household_id AND b.property_id=m.property_id
                               AND b.service_id=m.old_service_id AND b.unit_rate IS NOT NULL
                             ORDER BY b.charge_date DESC, b.updated_at DESC, b.id DESC LIMIT 1),
                          'actual') END,
       COALESCE(l.sort_order, s.sort_order), s.created_at, s.updated_at
FROM utility_contract_migration m JOIN utility_services s ON s.household_id=m.household_id AND s.id=m.old_service_id
LEFT JOIN utility_subject_services l ON l.household_id=m.household_id AND l.property_id=m.property_id AND l.service_id=m.old_service_id;
INSERT INTO utility_contract_import_sources (household_id, property_id, source_service_key, utility_contract_id)
SELECT m.household_id, m.property_id, s.service_key, m.id
FROM utility_contract_migration m JOIN utility_services s ON s.household_id=m.household_id AND s.id=m.old_service_id;
UPDATE utility_bills b SET service_id=m.id, utility_contract_id=m.id
FROM utility_contract_migration m WHERE b.household_id=m.household_id AND b.property_id=m.property_id AND b.service_id=m.old_service_id;
UPDATE utility_subject_services l SET service_id=m.id
FROM utility_contract_migration m WHERE l.household_id=m.household_id AND l.property_id=m.property_id AND l.service_id=m.old_service_id;

-- Snapshot observations are not a reconstructed tariff history. Never recalculate bills.
INSERT INTO utility_contract_prices (household_id, utility_contract_id, effective_on, price)
SELECT DISTINCT ON (household_id, utility_contract_id, date_trunc('month', charge_date)::date)
       household_id, utility_contract_id, date_trunc('month', charge_date)::date, unit_rate
FROM utility_bills WHERE utility_contract_id IS NOT NULL AND unit_rate IS NOT NULL
ORDER BY household_id, utility_contract_id, date_trunc('month', charge_date)::date, charge_date DESC, updated_at DESC, id DESC;
-- Automatic contracts need a price covering their start month. Prefer the
-- configured service rate; a rate cleared after priced history falls back to
-- the earliest observed snapshot. Amounts are never recalculated here.
INSERT INTO utility_contract_prices (household_id, utility_contract_id, effective_on, price)
SELECT c.household_id, c.id, date_trunc('month', c.start_date)::date,
       COALESCE(s.unit_rate, (SELECT p.price FROM utility_contract_prices p
                               WHERE p.household_id=c.household_id AND p.utility_contract_id=c.id
                               ORDER BY p.effective_on LIMIT 1))
FROM utility_contracts c JOIN utility_services s ON s.household_id=c.household_id AND s.id=c.service_id
WHERE c.tracking_mode <> 'actual'
  AND (s.unit_rate IS NOT NULL
       OR EXISTS (SELECT 1 FROM utility_contract_prices p
                   WHERE p.household_id=c.household_id AND p.utility_contract_id=c.id))
  AND NOT EXISTS (SELECT 1 FROM utility_contract_prices p
                   WHERE p.household_id=c.household_id AND p.utility_contract_id=c.id
                     AND p.effective_on <= date_trunc('month', c.start_date)::date);
ALTER TABLE utility_bills ADD CONSTRAINT utility_bills_contract_consistency
    FOREIGN KEY (household_id, utility_contract_id, property_id, service_id)
    REFERENCES utility_contracts(household_id, id, property_id, service_id) ON DELETE RESTRICT;
ALTER TABLE utility_bills ADD CONSTRAINT utility_bills_contract_property_required
    CHECK (utility_contract_id IS NULL OR property_id IS NOT NULL);
CREATE INDEX utility_contracts_property_idx ON utility_contracts(household_id, property_id, sort_order, id);
CREATE INDEX utility_bills_contract_idx ON utility_bills(household_id, utility_contract_id, charge_date);
ALTER TABLE utility_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON utility_contracts USING (household_id = app.current_household_id()) WITH CHECK (household_id = app.current_household_id());
ALTER TABLE utility_contract_import_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_contract_import_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON utility_contract_import_sources USING (household_id = app.current_household_id()) WITH CHECK (household_id = app.current_household_id());
ALTER TABLE utility_contract_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_contract_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON utility_contract_prices USING (household_id = app.current_household_id()) WITH CHECK (household_id = app.current_household_id());

-- No historical end date is inferred from a boolean retirement flag. Original
-- services remain available as provenance, including for unmapped legacy groups.
CREATE FUNCTION app.prevent_utility_contract_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.property_id IS DISTINCT FROM OLD.property_id OR NEW.household_id IS DISTINCT FROM OLD.household_id THEN
        RAISE EXCEPTION 'Utility contracts cannot move between properties or households' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER utility_contract_property_immutable BEFORE UPDATE ON utility_contracts
    FOR EACH ROW EXECUTE FUNCTION app.prevent_utility_contract_move();
