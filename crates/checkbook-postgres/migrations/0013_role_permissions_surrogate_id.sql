-- Household backups/restore operate generically over BACKUP_TABLES, keying
-- every table on a uuid `id` column. role_permissions had no such column
-- (its primary key was the (household_id, module, role) triple), which kept
-- it -- along with household_settings -- out of the backup/restore
-- allowlist. Give it a surrogate id so both tables can be captured and
-- restored like every other household table.
ALTER TABLE role_permissions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_pkey;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_household_module_role_key
    UNIQUE (household_id, module, role);
