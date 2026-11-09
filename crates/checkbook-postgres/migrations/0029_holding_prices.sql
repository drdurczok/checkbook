ALTER TABLE account_holdings ADD COLUMN ticker text
    CHECK (ticker IS NULL OR (length(ticker) <= 15 AND ticker ~ '^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$'));
CREATE INDEX account_holdings_open_ticker_idx ON account_holdings(household_id, property_id, ticker)
    WHERE ticker IS NOT NULL AND sold_on IS NULL AND sell_value IS NULL;

CREATE TABLE holding_price_cache (
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    ticker text NOT NULL CHECK (length(ticker) <= 15 AND ticker ~ '^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$'),
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    close numeric(24,6) CHECK (close > 0),
    price_date date,
    last_attempt_at timestamptz NOT NULL,
    last_success_at timestamptz,
    error text CHECK (length(error) <= 200),
    PRIMARY KEY (household_id, ticker),
    CHECK ((close IS NULL AND price_date IS NULL AND last_success_at IS NULL)
        OR (close IS NOT NULL AND price_date IS NOT NULL AND last_success_at IS NOT NULL))
);
ALTER TABLE holding_price_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON holding_price_cache
    USING (household_id = app.current_household_id())
    WITH CHECK (household_id = app.current_household_id());
ALTER TABLE holding_price_cache FORCE ROW LEVEL SECURITY;
