ALTER TABLE utility_services
    ADD COLUMN color TEXT,
    ADD CONSTRAINT utility_services_color_hex
        CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
