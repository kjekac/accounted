-- Supabase API roles need table privileges in addition to RLS policies.
-- A full local/self-hosted replay runs migrations as postgres, so tables can
-- otherwise end up visible only to the owner even though policies exist.

GRANT USAGE ON SCHEMA public TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO authenticated, service_role;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO authenticated, service_role;

GRANT EXECUTE
  ON ALL FUNCTIONS IN SCHEMA public
  TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT
  ON SEQUENCES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE
  ON FUNCTIONS TO authenticated, service_role;
