-- Depreciation/appreciation was the only per-property feature toggle without
-- its own persisted flag — "enabled" was inferred from depreciation_rate != 0,
-- so disabling the card on save silently zeroed (and lost) a previously
-- configured rate. Mirrors utilities_enabled/projects_enabled/expenses_enabled
-- from 0010: a real boolean that hides the card without deleting its data.
ALTER TABLE properties
    ADD COLUMN depreciation_enabled boolean NOT NULL DEFAULT true;

UPDATE properties SET depreciation_enabled = (depreciation_rate <> 0);
