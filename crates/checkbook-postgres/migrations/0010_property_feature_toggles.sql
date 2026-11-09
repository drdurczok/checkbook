-- Per-property feature toggles: hide a property from other pages/areas
-- (utilities board, projects filter, expense-category rollups) without
-- deleting the underlying data. All default to enabled so existing
-- properties are unaffected.
ALTER TABLE properties
    ADD COLUMN utilities_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN projects_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN expenses_enabled boolean NOT NULL DEFAULT true;
