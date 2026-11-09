-- Properties currently only model "a home to run projects/utilities
-- against." Generalize them to any physical asset (property, vehicle, ...)
-- and let each one link to the financial_accounts row that already tracks
-- its net-worth valuation, instead of duplicating a valuation figure in two
-- disconnected places. Loans/mortgages get a matching structural link so
-- "this loan belongs to this property or vehicle" no longer relies on
-- name-matching in the UI.
ALTER TABLE properties
    ADD COLUMN category text NOT NULL DEFAULT 'property'
        CHECK (category IN ('property', 'vehicle', 'other')),
    ADD COLUMN account_id uuid;

ALTER TABLE properties
    ADD CONSTRAINT properties_household_id_account_id_fkey
        FOREIGN KEY (household_id, account_id)
        REFERENCES financial_accounts(household_id, id)
        ON DELETE SET NULL (account_id),
    ADD CONSTRAINT properties_household_id_account_id_key
        UNIQUE (household_id, account_id);

ALTER TABLE loans
    ADD COLUMN linked_property_id uuid;

ALTER TABLE loans
    ADD CONSTRAINT loans_household_id_linked_property_id_fkey
        FOREIGN KEY (household_id, linked_property_id)
        REFERENCES properties(household_id, id)
        ON DELETE SET NULL (linked_property_id);
