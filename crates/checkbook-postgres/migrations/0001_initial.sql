-- Checkbook production schema.
-- PostgreSQL is the only supported database. All monetary values use NUMERIC.

CREATE SCHEMA IF NOT EXISTS app;

CREATE FUNCTION app.current_household_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(current_setting('app.household_id', true), '')::uuid
$$;

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    full_name text NOT NULL,
    picture_url text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_normalized CHECK (email = lower(trim(email)))
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE external_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('cloudflare', 'google', 'local', 'development')),
    subject text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    household_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (octet_length(token_hash) = 32)
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_household_id_idx ON sessions(household_id);
CREATE INDEX sessions_active_expiry_idx ON sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE auth_rate_limits (
    scope text NOT NULL,
    subject_hash bytea NOT NULL,
    window_started timestamptz NOT NULL DEFAULT now(),
    request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, subject_hash),
    CHECK (octet_length(subject_hash) = 32)
);
CREATE INDEX auth_rate_limits_updated_idx ON auth_rate_limits(updated_at);

CREATE TABLE households (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    base_currency text NOT NULL DEFAULT 'PLN',
    timezone text NOT NULL DEFAULT 'Europe/Warsaw',
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (base_currency ~ '^[A-Z]{3}$')
);
ALTER TABLE sessions
    ADD CONSTRAINT sessions_household_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE;

CREATE TABLE household_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'contributor')),
    relationship_kind text NOT NULL CHECK (relationship_kind IN ('owner', 'spouse', 'member')),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, user_id),
    UNIQUE (household_id, id)
);
CREATE UNIQUE INDEX household_primary_member_unique
    ON household_memberships(household_id)
    WHERE is_active AND relationship_kind = 'owner';
CREATE UNIQUE INDEX household_spouse_member_unique
    ON household_memberships(household_id)
    WHERE is_active AND relationship_kind = 'spouse';

CREATE TABLE household_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'contributor')),
    relationship_kind text NOT NULL CHECK (relationship_kind IN ('owner', 'spouse', 'member')),
    token_hash bytea NOT NULL UNIQUE,
    accepted_at timestamptz,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    CHECK (email = lower(trim(email))),
    CHECK (octet_length(token_hash) = 32)
);

CREATE TABLE household_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL UNIQUE REFERENCES households(id) ON DELETE CASCADE,
    privacy_mode text NOT NULL DEFAULT 'private_joint',
    allow_cross_member_visibility boolean NOT NULL DEFAULT false,
    projection_baseline_window_months integer NOT NULL DEFAULT 6
        CHECK (projection_baseline_window_months BETWEEN 1 AND 24),
    projection_horizon_months integer NOT NULL DEFAULT 18
        CHECK (projection_horizon_months BETWEEN 3 AND 60),
    savings_allocation_strategy text NOT NULL DEFAULT 'keep_cash_positive',
    backup_path text NOT NULL DEFAULT '',
    backup_retention integer NOT NULL DEFAULT 0 CHECK (backup_retention BETWEEN 0 AND 365),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id)
);

CREATE TABLE role_permissions (
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    module text NOT NULL CHECK (module IN ('planning', 'settings', 'imports', 'records')),
    role text NOT NULL CHECK (role IN ('owner', 'contributor')),
    can_read boolean NOT NULL,
    can_write boolean NOT NULL,
    can_delete boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (household_id, module, role)
);

CREATE TABLE categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('expense', 'income', 'asset', 'liability', 'utility', 'planning')),
    name text NOT NULL,
    normalized_name text NOT NULL,
    parent_id uuid,
    is_system boolean NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, parent_id)
        REFERENCES categories(household_id, id) ON DELETE CASCADE,
    CHECK (normalized_name = lower(trim(normalized_name)))
);
CREATE UNIQUE INDEX categories_root_unique
    ON categories(household_id, kind, normalized_name)
    WHERE parent_id IS NULL;
CREATE UNIQUE INDEX categories_child_unique
    ON categories(household_id, kind, parent_id, normalized_name)
    WHERE parent_id IS NOT NULL;

-- Compatibility concept used for utility contracts. Legacy location and
-- income_source values remain valid at the API boundary during the port.
CREATE TABLE entry_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('location', 'contract', 'income_source')),
    name text NOT NULL,
    group_type text NOT NULL DEFAULT '',
    started_on date,
    ended_on date,
    notes text NOT NULL DEFAULT '',
    metadata_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    tracked_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, kind, name),
    CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
);

CREATE TABLE income_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL,
    source_type text NOT NULL DEFAULT 'employment',
    owner_scope text NOT NULL CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    started_on date,
    ended_on date,
    notes text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0,
    source_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, source_key),
    CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX income_sources_household_name_idx ON income_sources(household_id, name);

CREATE TABLE income_source_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    income_source_id uuid NOT NULL,
    label text NOT NULL DEFAULT '',
    amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    frequency text NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'one_off')),
    owner_scope text CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    category text NOT NULL DEFAULT '',
    started_on date,
    ended_on date,
    notes text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, income_source_id)
        REFERENCES income_sources(household_id, id) ON DELETE CASCADE
);

CREATE TABLE income_source_custom_fields (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    income_source_id uuid,
    income_source_line_id uuid,
    label text NOT NULL,
    value text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, income_source_id)
        REFERENCES income_sources(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, income_source_line_id)
        REFERENCES income_source_lines(household_id, id) ON DELETE CASCADE,
    CHECK ((income_source_id IS NOT NULL)::integer + (income_source_line_id IS NOT NULL)::integer = 1)
);

CREATE TABLE income_source_milestones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    income_source_id uuid NOT NULL,
    label text NOT NULL,
    milestone_date date NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, income_source_id)
        REFERENCES income_sources(household_id, id) ON DELETE CASCADE
);

CREATE TABLE financial_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL,
    account_kind text NOT NULL CHECK (account_kind IN ('asset', 'liability')),
    account_type text NOT NULL,
    currency text NOT NULL DEFAULT 'PLN',
    owner_scope text NOT NULL CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    opened_on date,
    closed_on date,
    notes text NOT NULL DEFAULT '',
    source_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, source_key),
    CHECK (currency ~ '^[A-Z]{3}$'),
    CHECK (closed_on IS NULL OR opened_on IS NULL OR closed_on >= opened_on)
);
CREATE INDEX financial_accounts_household_kind_idx
    ON financial_accounts(household_id, account_kind, account_type);

CREATE TABLE account_balance_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    account_id uuid NOT NULL,
    balance numeric(20,2) NOT NULL CHECK (balance >= 0),
    effective_date date NOT NULL,
    data_source text NOT NULL CHECK (data_source IN ('bulk_load', 'app_manual', 'planning_only')),
    source_key text,
    source_fingerprint text,
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, account_id, effective_date, source_key),
    FOREIGN KEY (household_id, account_id)
        REFERENCES financial_accounts(household_id, id) ON DELETE CASCADE
);
CREATE INDEX account_balance_snapshots_timeline_idx
    ON account_balance_snapshots(household_id, account_id, effective_date DESC);

CREATE TABLE properties (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL,
    valuation numeric(20,2) NOT NULL DEFAULT 0 CHECK (valuation >= 0),
    valuation_date date NOT NULL,
    status text NOT NULL CHECK (status IN ('planned', 'active', 'completed')),
    started_on date,
    ended_on date,
    notes text NOT NULL DEFAULT '',
    utility_group_type text NOT NULL DEFAULT '',
    data_source text NOT NULL CHECK (data_source IN ('bulk_load', 'app_manual', 'planning_only')),
    source_key text,
    source_fingerprint text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, source_key),
    CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
);

CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    linked_property_id uuid,
    name text NOT NULL,
    budget numeric(20,2) NOT NULL DEFAULT 0 CHECK (budget >= 0),
    valuation_date date NOT NULL,
    stored_status text NOT NULL CHECK (stored_status IN ('planned', 'active', 'completed')),
    started_on date,
    ended_on date,
    notes text NOT NULL DEFAULT '',
    data_source text NOT NULL CHECK (data_source IN ('bulk_load', 'app_manual', 'planning_only')),
    source_key text,
    source_fingerprint text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, source_key),
    FOREIGN KEY (household_id, linked_property_id)
        REFERENCES properties(household_id, id) ON DELETE SET NULL,
    CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
);

CREATE TABLE project_rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    project_id uuid,
    property_id uuid,
    name text NOT NULL,
    declared_total numeric(20,2) CHECK (declared_total >= 0),
    notes text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, project_id)
        REFERENCES projects(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, property_id)
        REFERENCES properties(household_id, id) ON DELETE CASCADE,
    CHECK ((project_id IS NOT NULL)::integer + (property_id IS NOT NULL)::integer = 1)
);

CREATE TABLE project_sections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    room_id uuid NOT NULL,
    name text NOT NULL,
    declared_total numeric(20,2) CHECK (declared_total >= 0),
    notes text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, room_id)
        REFERENCES project_rooms(household_id, id) ON DELETE CASCADE
);

CREATE TABLE project_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    section_id uuid NOT NULL,
    name text NOT NULL,
    unit_price numeric(20,4) CHECK (unit_price >= 0),
    quantity numeric(20,4) CHECK (quantity >= 0),
    total_cost numeric(20,2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
    completed boolean NOT NULL DEFAULT false,
    notes text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, section_id)
        REFERENCES project_sections(household_id, id) ON DELETE CASCADE
);

CREATE TABLE planning_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    rule_kind text NOT NULL CHECK (rule_kind IN ('income', 'housing', 'loan', 'recurring')),
    stable_key text NOT NULL,
    title text NOT NULL,
    amount numeric(20,2) NOT NULL CHECK (amount >= 0),
    direction text NOT NULL CHECK (direction IN ('income', 'expense')),
    owner_scope text NOT NULL CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    category_id uuid,
    income_source_id uuid,
    linked_loan_id uuid,
    active_from date,
    active_until date,
    enabled boolean NOT NULL DEFAULT true,
    rule_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, stable_key),
    FOREIGN KEY (household_id, category_id)
        REFERENCES categories(household_id, id) ON DELETE SET NULL,
    FOREIGN KEY (household_id, income_source_id)
        REFERENCES income_sources(household_id, id) ON DELETE CASCADE
);

CREATE TABLE planning_occurrences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    planning_rule_id uuid NOT NULL,
    period date NOT NULL CHECK (date_trunc('month', period)::date = period),
    calculated_amount numeric(20,2) NOT NULL CHECK (calculated_amount >= 0),
    override_amount numeric(20,2) CHECK (override_amount >= 0),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, planning_rule_id, period),
    FOREIGN KEY (household_id, planning_rule_id)
        REFERENCES planning_rules(household_id, id) ON DELETE CASCADE
);

CREATE TABLE ledger_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('income', 'expense')),
    status text NOT NULL CHECK (status IN ('actual', 'planned')),
    amount numeric(20,2) NOT NULL CHECK (amount >= 0),
    currency text NOT NULL DEFAULT 'PLN' CHECK (currency ~ '^[A-Z]{3}$'),
    entry_date date,
    description text NOT NULL,
    notes text NOT NULL DEFAULT '',
    owner_scope text NOT NULL CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    data_source text NOT NULL CHECK (data_source IN ('bulk_load', 'app_manual', 'planning_only')),
    category_id uuid,
    subcategory_id uuid,
    income_source_id uuid,
    planning_occurrence_id uuid,
    linked_project_id uuid,
    priority text CHECK (priority IN ('idea', 'considering', 'nice_to_have', 'must_have', 'non_negotiable')),
    track_progress boolean NOT NULL DEFAULT false,
    progress_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (progress_amount >= 0),
    sort_order integer NOT NULL DEFAULT 0,
    source_key text,
    source_fingerprint text,
    extra_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, source_key),
    FOREIGN KEY (household_id, category_id)
        REFERENCES categories(household_id, id) ON DELETE SET NULL,
    FOREIGN KEY (household_id, subcategory_id)
        REFERENCES categories(household_id, id) ON DELETE SET NULL,
    FOREIGN KEY (household_id, income_source_id)
        REFERENCES income_sources(household_id, id) ON DELETE SET NULL,
    FOREIGN KEY (household_id, planning_occurrence_id)
        REFERENCES planning_occurrences(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, linked_project_id)
        REFERENCES projects(household_id, id) ON DELETE SET NULL,
    CHECK (status = 'planned' OR entry_date IS NOT NULL)
);
CREATE INDEX ledger_entries_timeline_idx
    ON ledger_entries(household_id, status, entry_date, direction);
CREATE INDEX ledger_entries_category_idx
    ON ledger_entries(household_id, category_id, entry_date);
CREATE INDEX ledger_entries_planning_board_idx
    ON ledger_entries(household_id, status, entry_date, sort_order, created_at);

CREATE TABLE utility_services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    service_key text NOT NULL,
    label text NOT NULL,
    service_kind text NOT NULL CHECK (service_kind IN ('cost', 'metered')),
    unit text NOT NULL DEFAULT '',
    is_system boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, service_key)
);

CREATE TABLE utility_subject_services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    property_id uuid,
    contract_id uuid,
    service_id uuid NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, property_id, contract_id, service_id),
    FOREIGN KEY (household_id, property_id)
        REFERENCES properties(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, contract_id)
        REFERENCES entry_groups(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, service_id)
        REFERENCES utility_services(household_id, id) ON DELETE CASCADE,
    CHECK ((property_id IS NOT NULL)::integer + (contract_id IS NOT NULL)::integer = 1)
);

CREATE TABLE utility_bills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    property_id uuid,
    contract_id uuid,
    service_id uuid NOT NULL,
    provider text NOT NULL,
    description text NOT NULL,
    amount numeric(20,2) NOT NULL CHECK (amount >= 0),
    currency text NOT NULL DEFAULT 'PLN' CHECK (currency ~ '^[A-Z]{3}$'),
    charge_date date NOT NULL,
    owner_scope text NOT NULL CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    data_source text NOT NULL CHECK (data_source IN ('bulk_load', 'app_manual', 'planning_only')),
    is_recurring boolean NOT NULL DEFAULT true,
    notes text NOT NULL DEFAULT '',
    source_key text,
    source_fingerprint text,
    extra_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, source_key),
    FOREIGN KEY (household_id, property_id)
        REFERENCES properties(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, contract_id)
        REFERENCES entry_groups(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, service_id)
        REFERENCES utility_services(household_id, id) ON DELETE RESTRICT,
    CHECK ((property_id IS NOT NULL)::integer + (contract_id IS NOT NULL)::integer = 1)
);
CREATE INDEX utility_bills_board_idx
    ON utility_bills(household_id, property_id, contract_id, charge_date, service_id);

CREATE TABLE utility_meter_readings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    utility_bill_id uuid NOT NULL,
    previous_reading_id uuid,
    reading numeric(20,4) NOT NULL CHECK (reading >= 0),
    usage_amount numeric(20,4) CHECK (usage_amount >= 0),
    unit text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, utility_bill_id),
    FOREIGN KEY (household_id, utility_bill_id)
        REFERENCES utility_bills(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, previous_reading_id)
        REFERENCES utility_meter_readings(household_id, id) ON DELETE SET NULL
);

CREATE TABLE loans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    account_id uuid NOT NULL,
    name text NOT NULL,
    liability_type text NOT NULL CHECK (liability_type IN ('debt', 'loan', 'mortgage')),
    owner_scope text NOT NULL CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    original_balance numeric(20,2) NOT NULL CHECK (original_balance >= 0),
    current_balance numeric(20,2) NOT NULL CHECK (current_balance >= 0),
    interest_rate numeric(12,8) NOT NULL DEFAULT 0 CHECK (interest_rate BETWEEN 0 AND 1),
    monthly_payment numeric(20,2) NOT NULL DEFAULT 0 CHECK (monthly_payment >= 0),
    start_date date,
    end_date date,
    notes text NOT NULL DEFAULT '',
    terms_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    data_source text NOT NULL DEFAULT 'app_manual'
        CHECK (data_source IN ('bulk_load', 'app_manual', 'planning_only')),
    source_key text,
    source_fingerprint text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, account_id),
    UNIQUE NULLS NOT DISTINCT (household_id, source_key),
    FOREIGN KEY (household_id, account_id)
        REFERENCES financial_accounts(household_id, id) ON DELETE CASCADE,
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
ALTER TABLE planning_rules
    ADD CONSTRAINT planning_rules_loan_fk
    FOREIGN KEY (household_id, linked_loan_id)
    REFERENCES loans(household_id, id) ON DELETE CASCADE;

CREATE TABLE loan_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    loan_id uuid NOT NULL,
    payment_date date NOT NULL,
    total_payment numeric(20,2) NOT NULL CHECK (total_payment >= 0),
    principal_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (principal_amount >= 0),
    interest_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (interest_amount >= 0),
    extra_payment numeric(20,2) NOT NULL DEFAULT 0 CHECK (extra_payment >= 0),
    remaining_balance numeric(20,2) CHECK (remaining_balance >= 0),
    source_key text,
    source_fingerprint text,
    extra_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, source_key),
    FOREIGN KEY (household_id, loan_id)
        REFERENCES loans(household_id, id) ON DELETE CASCADE
);
CREATE INDEX loan_payments_timeline_idx
    ON loan_payments(household_id, loan_id, payment_date);

CREATE TABLE loan_overpayment_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    loan_id uuid NOT NULL,
    period date NOT NULL CHECK (date_trunc('month', period)::date = period),
    amount numeric(20,2) NOT NULL CHECK (amount >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, loan_id, period),
    FOREIGN KEY (household_id, loan_id)
        REFERENCES loans(household_id, id) ON DELETE CASCADE
);

CREATE TABLE recurring_commitments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL,
    amount numeric(20,2) NOT NULL CHECK (amount > 0),
    cadence text NOT NULL CHECK (cadence IN ('monthly', 'quarterly', 'yearly')),
    next_due_date date NOT NULL,
    owner_scope text NOT NULL CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    category_id uuid,
    subcategory_id uuid,
    description text NOT NULL DEFAULT '',
    is_active boolean NOT NULL DEFAULT true,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, category_id)
        REFERENCES categories(household_id, id) ON DELETE SET NULL,
    FOREIGN KEY (household_id, subcategory_id)
        REFERENCES categories(household_id, id) ON DELETE SET NULL
);

CREATE TABLE goals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL,
    goal_type text NOT NULL CHECK (goal_type IN ('savings_target', 'debt_paydown')),
    target_amount numeric(20,2) NOT NULL CHECK (target_amount > 0),
    target_date date,
    owner_scope text NOT NULL CHECK (owner_scope IN ('self', 'spouse', 'joint')),
    linked_loan_id uuid,
    description text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('active', 'achieved', 'paused')),
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, linked_loan_id)
        REFERENCES loans(household_id, id) ON DELETE SET NULL
);

CREATE TABLE scenarios (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    is_baseline boolean NOT NULL DEFAULT false,
    monthly_income_delta numeric(20,2) NOT NULL DEFAULT 0,
    monthly_expense_delta numeric(20,2) NOT NULL DEFAULT 0,
    monthly_savings_delta numeric(20,2) NOT NULL DEFAULT 0,
    loan_id uuid,
    loan_overpayment_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (loan_overpayment_amount >= 0),
    loan_overpayment_start_month date,
    baseline_months integer CHECK (baseline_months BETWEEN 1 AND 36),
    monthly_income_override numeric(20,2),
    monthly_expense_override numeric(20,2),
    include_income boolean NOT NULL DEFAULT true,
    include_expenses boolean NOT NULL DEFAULT true,
    include_utilities boolean NOT NULL DEFAULT true,
    include_recurring boolean NOT NULL DEFAULT true,
    include_planned boolean NOT NULL DEFAULT true,
    include_loan_payments boolean NOT NULL DEFAULT true,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, loan_id)
        REFERENCES loans(household_id, id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX scenarios_baseline_unique
    ON scenarios(household_id)
    WHERE is_baseline;

CREATE TABLE scenario_category_overrides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    scenario_id uuid NOT NULL,
    budget_key text NOT NULL,
    amount numeric(20,2) NOT NULL CHECK (amount >= 0),
    start_month date,
    end_month date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE NULLS NOT DISTINCT (household_id, scenario_id, budget_key, start_month, end_month),
    FOREIGN KEY (household_id, scenario_id)
        REFERENCES scenarios(household_id, id) ON DELETE CASCADE,
    CHECK (end_month IS NULL OR start_month IS NULL OR end_month >= start_month)
);

CREATE TABLE buyers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL,
    nip text NOT NULL DEFAULT '',
    address text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id)
);
CREATE INDEX buyers_household_name_idx ON buyers(household_id, name);

CREATE TABLE invoice_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL,
    title text NOT NULL DEFAULT '',
    seller_name text NOT NULL DEFAULT '',
    seller_details text NOT NULL DEFAULT '',
    buyer_name text NOT NULL DEFAULT '',
    buyer_details text NOT NULL DEFAULT '',
    currency text NOT NULL DEFAULT 'PLN' CHECK (currency ~ '^[A-Z]{3}$'),
    payment_terms text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id)
);

CREATE TABLE invoice_template_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    template_id uuid NOT NULL,
    description text NOT NULL,
    quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
    unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
    vat_rate text NOT NULL,
    unit text NOT NULL DEFAULT '',
    currency text NOT NULL CHECK (currency = '' OR currency ~ '^[A-Z]{3}$'),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, template_id)
        REFERENCES invoice_templates(household_id, id) ON DELETE CASCADE
);

CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    invoice_number text NOT NULL,
    current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, invoice_number)
);

CREATE TABLE invoice_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    invoice_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    title text NOT NULL DEFAULT '',
    template_id uuid,
    template_name text NOT NULL DEFAULT '',
    income_source_id uuid,
    seller_name text NOT NULL DEFAULT '',
    seller_details text NOT NULL DEFAULT '',
    buyer_name text NOT NULL,
    buyer_details text NOT NULL DEFAULT '',
    buyer_nip text NOT NULL DEFAULT '',
    buyer_address text NOT NULL DEFAULT '',
    issue_date date NOT NULL,
    sale_date date,
    due_date date,
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status text NOT NULL CHECK (status IN ('draft', 'issued', 'paid', 'cancelled')),
    conversion_enabled boolean NOT NULL DEFAULT false,
    conversion_currency text NOT NULL DEFAULT '',
    conversion_rate numeric(20,8) NOT NULL DEFAULT 1 CHECK (conversion_rate >= 0),
    subtotal numeric(20,2) NOT NULL CHECK (subtotal >= 0),
    tax_amount numeric(20,2) NOT NULL CHECK (tax_amount >= 0),
    total_amount numeric(20,2) NOT NULL CHECK (total_amount >= 0),
    payment_terms text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, invoice_id, revision),
    FOREIGN KEY (household_id, invoice_id)
        REFERENCES invoices(household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, template_id)
        REFERENCES invoice_templates(household_id, id) ON DELETE SET NULL,
    FOREIGN KEY (household_id, income_source_id)
        REFERENCES income_sources(household_id, id) ON DELETE SET NULL,
    CHECK (NOT conversion_enabled OR conversion_currency ~ '^[A-Z]{3}$')
);

CREATE TABLE invoice_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    invoice_revision_id uuid NOT NULL,
    description text NOT NULL,
    quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
    unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
    vat_rate text NOT NULL,
    unit text NOT NULL DEFAULT '',
    currency text NOT NULL CHECK (currency = '' OR currency ~ '^[A-Z]{3}$'),
    net_amount numeric(20,2) NOT NULL CHECK (net_amount >= 0),
    tax_amount numeric(20,2) NOT NULL CHECK (tax_amount >= 0),
    gross_amount numeric(20,2) NOT NULL CHECK (gross_amount >= 0),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    FOREIGN KEY (household_id, invoice_revision_id)
        REFERENCES invoice_revisions(household_id, id) ON DELETE CASCADE
);

CREATE TABLE data_load_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('staged', 'validated', 'committed', 'failed', 'deleted')),
    archive_version integer NOT NULL,
    counts jsonb NOT NULL DEFAULT '{}'::jsonb,
    warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
    errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    archive_path text NOT NULL,
    archive_sha256 text NOT NULL,
    committed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id),
    UNIQUE (household_id, idempotency_key)
);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    event_type text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid,
    request_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (household_id, id)
);
CREATE INDEX audit_events_timeline_idx ON audit_events(household_id, created_at DESC);

-- Tenant tables are protected at the database boundary. API requests must set:
-- SET LOCAL app.household_id = '<uuid>';
ALTER TABLE households ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON households
    USING (id = app.current_household_id())
    WITH CHECK (id = app.current_household_id());

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'household_memberships',
        'household_invitations',
        'household_settings',
        'role_permissions',
        'categories',
        'entry_groups',
        'income_sources',
        'income_source_lines',
        'income_source_custom_fields',
        'income_source_milestones',
        'financial_accounts',
        'account_balance_snapshots',
        'properties',
        'projects',
        'project_rooms',
        'project_sections',
        'project_items',
        'planning_rules',
        'planning_occurrences',
        'ledger_entries',
        'utility_services',
        'utility_subject_services',
        'utility_bills',
        'utility_meter_readings',
        'loans',
        'loan_payments',
        'loan_overpayment_plans',
        'recurring_commitments',
        'goals',
        'scenarios',
        'scenario_category_overrides',
        'buyers',
        'invoice_templates',
        'invoice_template_lines',
        'invoices',
        'invoice_revisions',
        'invoice_lines',
        'data_load_runs',
        'audit_events'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY household_isolation ON %I
             USING (household_id = app.current_household_id())
             WITH CHECK (household_id = app.current_household_id())',
            table_name
        );
    END LOOP;
END
$$;
