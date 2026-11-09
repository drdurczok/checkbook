ALTER TABLE utility_services
    ADD COLUMN entry_mode text NOT NULL DEFAULT 'meter' CHECK (entry_mode IN ('meter', 'usage')),
    ADD COLUMN unit_rate numeric(20,6) CHECK (unit_rate >= 0);
ALTER TABLE utility_bills
    ADD COLUMN unit_rate numeric(20,6) CHECK (unit_rate >= 0),
    ADD COLUMN usage_amount numeric(20,4) CHECK (usage_amount >= 0),
    ADD COLUMN entry_mode text CHECK (entry_mode IN ('meter', 'usage'));
