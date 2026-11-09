ALTER TABLE payday_templates
    DROP CONSTRAINT payday_templates_section_check,
    ADD CONSTRAINT payday_templates_section_check
        CHECK (section IN ('mandatory', 'monthly', 'flexible'));
