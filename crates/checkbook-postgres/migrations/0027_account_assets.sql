-- Financial accounts (bank savings, brokerage, options) as a new
-- `properties` category. `account_type`/`account_registration` are the
-- account discriminator columns; every other category must leave them NULL.
ALTER TABLE properties
    DROP CONSTRAINT properties_category_check,
    ADD CONSTRAINT properties_category_check
        CHECK (category IN ('property', 'vehicle', 'other', 'account'));

ALTER TABLE properties
    ADD COLUMN account_type text
        CONSTRAINT properties_account_type_check
        CHECK (account_type IN ('savings', 'stocks', 'options')),
    ADD COLUMN account_registration text
        CONSTRAINT properties_account_registration_check
        CHECK (account_registration IN ('regular', 'retirement')),
    ADD CONSTRAINT properties_account_columns_match_category_check
        CHECK (
            (category = 'account' AND account_type IS NOT NULL)
            OR (category <> 'account' AND account_type IS NULL AND account_registration IS NULL)
        );

-- Ordered positions (lots) held on an account-category property. Replaced
-- wholesale by the application on every write, like project rooms.
CREATE TABLE account_holdings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    property_id uuid NOT NULL,
    name text NOT NULL,
    quantity numeric(24,6),
    unit_price numeric(20,4),
    value numeric(20,2) NOT NULL CHECK (value >= 0),
    purchased_on date,
    sold_on date,
    sell_value numeric(20,2),
    notes text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, property_id)
        REFERENCES properties(household_id, id) ON DELETE CASCADE,
    CHECK (sold_on IS NULL OR purchased_on IS NULL OR sold_on >= purchased_on),
    CHECK (quantity IS NULL OR quantity > 0),
    CHECK (unit_price IS NULL OR unit_price >= 0),
    CHECK (sell_value IS NULL OR sell_value >= 0)
);

CREATE INDEX account_holdings_property_idx
    ON account_holdings(household_id, property_id, sort_order);

ALTER TABLE account_holdings ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON account_holdings
    USING (household_id = app.current_household_id())
    WITH CHECK (household_id = app.current_household_id());
ALTER TABLE account_holdings FORCE ROW LEVEL SECURITY;
