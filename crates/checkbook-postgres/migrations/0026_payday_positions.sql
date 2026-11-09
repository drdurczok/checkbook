ALTER TABLE payday_allocations
    ADD COLUMN position integer NOT NULL DEFAULT 0
    CHECK (position >= 0);

ALTER TABLE payday_templates
    ADD COLUMN position integer NOT NULL DEFAULT 0
    CHECK (position >= 0);
