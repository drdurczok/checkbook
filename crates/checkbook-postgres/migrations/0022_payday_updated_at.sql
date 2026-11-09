CREATE FUNCTION app.touch_payday_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER payday_templates_updated_at BEFORE UPDATE ON payday_templates
    FOR EACH ROW EXECUTE FUNCTION app.touch_payday_updated_at();
CREATE TRIGGER payday_months_updated_at BEFORE UPDATE ON payday_months
    FOR EACH ROW EXECUTE FUNCTION app.touch_payday_updated_at();
CREATE TRIGGER payday_allocations_updated_at BEFORE UPDATE ON payday_allocations
    FOR EACH ROW EXECUTE FUNCTION app.touch_payday_updated_at();
