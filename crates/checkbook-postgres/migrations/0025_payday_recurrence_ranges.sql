-- Existing templates retain their historical all-month eligibility. New recurring
-- allocations set an explicit start month; version ranges preserve earlier plans.
ALTER TABLE payday_templates
    ADD COLUMN recurrence_id uuid,
    ADD COLUMN starts_on date NOT NULL DEFAULT '-infinity',
    ADD COLUMN ends_before date;
UPDATE payday_templates SET recurrence_id = id;
ALTER TABLE payday_templates
    ALTER COLUMN recurrence_id SET NOT NULL,
    ALTER COLUMN recurrence_id SET DEFAULT gen_random_uuid(),
    ADD CONSTRAINT payday_template_month_range CHECK (
        (starts_on = '-infinity' OR extract(day FROM starts_on) = 1)
        AND (ends_before IS NULL OR (extract(day FROM ends_before) = 1 AND ends_before >= starts_on))
    );
CREATE INDEX payday_template_recurrence_idx ON payday_templates (household_id, recurrence_id);
-- Retain a deleted occurrence's unique source key so later series edits cannot
-- recreate that month's explicitly removed allocation.
ALTER TABLE payday_allocations ADD COLUMN deleted_at timestamptz;
