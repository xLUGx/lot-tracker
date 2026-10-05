-- Lot Tracker / Car Count — Supabase schema (no secrets).
-- Set the PIN hash separately, e.g.:
--   UPDATE lot_private.config SET pin_hash = extensions.crypt('YOUR_PIN', extensions.gen_salt('bf')) WHERE id = 1;
-- Never commit the plaintext PIN.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS lot_private;

CREATE TABLE IF NOT EXISTS lot_private.config (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pin_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lot_private.docs (
  key text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lot_private.backups (
  id bigserial PRIMARY KEY,
  key text NOT NULL,
  data jsonb NOT NULL,
  version int NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backups_key_id_desc ON lot_private.backups (key, id DESC);

CREATE TABLE IF NOT EXISTS lot_private.pin_attempts (
  id bigserial PRIMARY KEY,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pin_attempts_recent ON lot_private.pin_attempts (attempted_at DESC);

INSERT INTO lot_private.docs (key, data, version) VALUES
  ('tracker', '{"overrides":{},"added":[]}'::jsonb, 0),
  ('carcount', '{"v":1,"entries":[],"active":{},"removed":[]}'::jsonb, 0)
ON CONFLICT (key) DO NOTHING;

INSERT INTO lot_private.config (id, pin_hash)
VALUES (1, extensions.crypt('CHANGE_ME', extensions.gen_salt('bf')))
ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON SCHEMA lot_private FROM PUBLIC, anon, authenticated;
ALTER TABLE lot_private.config ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_private.docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_private.backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_private.pin_attempts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION lot_private.check_pin(p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'lot_private', 'extensions', 'public'
AS $function$
DECLARE
  fails int;
  stored text;
  pin_ok boolean;
BEGIN
  SELECT count(*) INTO fails
  FROM lot_private.pin_attempts
  WHERE pin_attempts.ok = false AND attempted_at > now() - interval '10 minutes';

  IF fails >= 10 THEN
    RAISE EXCEPTION 'TOO_MANY_ATTEMPTS' USING ERRCODE = 'P0001';
  END IF;

  SELECT pin_hash INTO stored FROM lot_private.config WHERE id = 1;
  IF stored IS NULL THEN
    RAISE EXCEPTION 'PIN_NOT_SET' USING ERRCODE = 'P0001';
  END IF;

  pin_ok := (extensions.crypt(coalesce(p_pin, ''), stored) = stored);

  INSERT INTO lot_private.pin_attempts (ok) VALUES (pin_ok);

  DELETE FROM lot_private.pin_attempts
  WHERE id < (SELECT coalesce(max(id),0) - 500 FROM lot_private.pin_attempts);

  IF NOT pin_ok THEN
    RAISE EXCEPTION 'BAD_PIN' USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_get(pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'lot_private'
AS $function$
DECLARE
  result jsonb;
BEGIN
  PERFORM lot_private.check_pin(pin);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key', d.key,
    'data', d.data,
    'version', d.version,
    'updated_at', d.updated_at
  ) ORDER BY d.key), '[]'::jsonb)
  INTO result
  FROM lot_private.docs d;
  RETURN result;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.sync_put(pin text, key text, data jsonb, base_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'lot_private'
AS $function$
DECLARE
  doc_key text := key;
  cur_ver int;
  cur_data jsonb;
  new_ver int;
  server_empty boolean;
  client_empty boolean;
BEGIN
  PERFORM lot_private.check_pin(pin);

  IF doc_key IS NULL OR doc_key NOT IN ('tracker', 'carcount') THEN
    RAISE EXCEPTION 'BAD_KEY' USING ERRCODE = 'P0001';
  END IF;
  IF data IS NULL OR jsonb_typeof(data) <> 'object' THEN
    RAISE EXCEPTION 'BAD_DATA' USING ERRCODE = 'P0001';
  END IF;

  SELECT d.version, d.data INTO cur_ver, cur_data
  FROM lot_private.docs d WHERE d.key = doc_key FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO lot_private.docs (key, data, version)
    VALUES (doc_key, '{}'::jsonb, 0)
    RETURNING version, data INTO cur_ver, cur_data;
  END IF;

  IF doc_key = 'tracker' THEN
    client_empty := (
      coalesce(data->'overrides', '{}'::jsonb) = '{}'::jsonb
      AND coalesce(jsonb_array_length(coalesce(data->'added', '[]'::jsonb)), 0) = 0
    );
    server_empty := (
      coalesce(cur_data->'overrides', '{}'::jsonb) = '{}'::jsonb
      AND coalesce(jsonb_array_length(coalesce(cur_data->'added', '[]'::jsonb)), 0) = 0
    );
  ELSE
    client_empty := (
      coalesce(jsonb_array_length(coalesce(data->'entries', '[]'::jsonb)), 0) = 0
      AND coalesce(data->'active', '{}'::jsonb) = '{}'::jsonb
      AND coalesce(jsonb_array_length(coalesce(data->'removed', '[]'::jsonb)), 0) = 0
    );
    server_empty := (
      coalesce(jsonb_array_length(coalesce(cur_data->'entries', '[]'::jsonb)), 0) = 0
      AND coalesce(cur_data->'active', '{}'::jsonb) = '{}'::jsonb
      AND coalesce(jsonb_array_length(coalesce(cur_data->'removed', '[]'::jsonb)), 0) = 0
    );
  END IF;

  IF client_empty AND NOT server_empty THEN
    RETURN jsonb_build_object(
      'ok', true,
      'version', cur_ver,
      'data', cur_data,
      'guarded', true
    );
  END IF;

  IF cur_ver <> coalesce(base_version, -1) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'conflict', true,
      'version', cur_ver,
      'data', cur_data
    );
  END IF;

  IF cur_ver > 0 OR NOT server_empty THEN
    INSERT INTO lot_private.backups (key, data, version)
    VALUES (doc_key, cur_data, cur_ver);

    DELETE FROM lot_private.backups b
    WHERE b.key = doc_key
      AND b.id NOT IN (
        SELECT b2.id FROM lot_private.backups b2
        WHERE b2.key = doc_key
        ORDER BY b2.id DESC
        LIMIT 200
      );
  END IF;

  new_ver := cur_ver + 1;
  UPDATE lot_private.docs d
  SET data = sync_put.data, version = new_ver, updated_at = now()
  WHERE d.key = doc_key;

  RETURN jsonb_build_object(
    'ok', true,
    'version', new_ver,
    'data', sync_put.data,
    'guarded', false
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.sync_verify(pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'lot_private'
AS $function$
BEGIN
  PERFORM lot_private.check_pin(pin);
  RETURN jsonb_build_object('ok', true);
END;
$function$
;

REVOKE ALL ON FUNCTION lot_private.check_pin(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_get(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_put(text, text, jsonb, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_verify(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_get(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_put(text, text, jsonb, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_verify(text) TO anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA lot_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA lot_private FROM PUBLIC, anon, authenticated;

-- Restore from backup (admin / psql):
--   BEGIN;
--   INSERT INTO lot_private.backups (key, data, version)
--     SELECT key, data, version FROM lot_private.docs WHERE key = 'tracker';
--   UPDATE lot_private.docs d SET
--     data = b.data,
--     version = d.version + 1,
--     updated_at = now()
--   FROM lot_private.backups b
--   WHERE d.key = 'tracker' AND b.id = <backup_id>;
--   COMMIT;
