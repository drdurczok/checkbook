-- Optional monthly appreciation/depreciation rate for a property or
-- vehicle's value. Signed: negative depreciates, positive appreciates.
-- The stored `valuation`/`valuation_date` remain the anchor the rate
-- compounds forward from; the displayed "current" value is computed at
-- read time and periodically snapshotted into the linked financial_accounts
-- history by the monthly maintenance job. Editing the valuation directly
-- re-anchors compounding from that new value/date without touching
-- history already recorded.
ALTER TABLE properties
    ADD COLUMN depreciation_rate numeric(9,6) NOT NULL DEFAULT 0
        CHECK (depreciation_rate BETWEEN -1 AND 1);
