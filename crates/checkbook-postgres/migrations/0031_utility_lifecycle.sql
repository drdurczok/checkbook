ALTER TABLE utility_services
    ADD COLUMN retired boolean NOT NULL DEFAULT false,
    ADD COLUMN hidden boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT utility_services_hidden_requires_retired CHECK (NOT hidden OR retired);
