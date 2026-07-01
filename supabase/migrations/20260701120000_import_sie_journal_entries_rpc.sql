-- Atomic SIE journal-entry import.
--
-- The TypeScript importer still parses, maps, and validates the SIE file.
-- This RPC owns the actual journal_entries + journal_entry_lines commit so a
-- failed line insert cannot leave posted header rows behind.
CREATE OR REPLACE FUNCTION public.import_sie_journal_entries(
  p_company_id uuid,
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_entries jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry jsonb;
  v_line jsonb;
  v_series text;
  v_count integer;
  v_new_last integer;
  v_start integer;
  v_assigned_number integer;
  v_entry_id uuid;
  v_inserted jsonb := '[]'::jsonb;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'p_entries must be a JSON array';
  END IF;

  -- Tenant guard: anon/authenticated may only import into their own companies;
  -- service_role / direct access (no JWT role) bypasses for migrations and
  -- server-side maintenance paths that scope company access before calling.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF v_jwt_role IN ('anon', 'authenticated')
     AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must match auth.uid()'
      USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.sie_import_series_numbers (
    series text PRIMARY KEY,
    next_number integer NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.sie_import_series_numbers;

  FOR v_series, v_count IN
    SELECT COALESCE(NULLIF(e.value->>'series', ''), 'A') AS series, count(*)::integer AS count
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord)
    GROUP BY COALESCE(NULLIF(e.value->>'series', ''), 'A')
    ORDER BY min(e.ord)
  LOOP
    INSERT INTO public.voucher_sequences
      (company_id, user_id, fiscal_period_id, voucher_series, last_number)
    VALUES
      (p_company_id, p_user_id, p_fiscal_period_id, v_series, v_count)
    ON CONFLICT (company_id, fiscal_period_id, voucher_series)
    DO UPDATE SET
      last_number = public.voucher_sequences.last_number + EXCLUDED.last_number,
      updated_at = now()
    RETURNING last_number INTO v_new_last;

    v_start := v_new_last - v_count + 1;

    INSERT INTO pg_temp.sie_import_series_numbers(series, next_number)
    VALUES (v_series, v_start);
  END LOOP;

  FOR v_entry IN
    SELECT e.value
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord)
    ORDER BY e.ord
  LOOP
    v_series := COALESCE(NULLIF(v_entry->>'series', ''), 'A');

    SELECT next_number
    INTO v_assigned_number
    FROM pg_temp.sie_import_series_numbers
    WHERE series = v_series
    FOR UPDATE;

    UPDATE pg_temp.sie_import_series_numbers
    SET next_number = next_number + 1
    WHERE series = v_series;

    INSERT INTO public.journal_entries (
      user_id,
      company_id,
      fiscal_period_id,
      voucher_number,
      voucher_series,
      entry_date,
      description,
      source_type,
      source_voucher_series,
      source_voucher_number,
      status
    )
    VALUES (
      p_user_id,
      p_company_id,
      p_fiscal_period_id,
      v_assigned_number,
      v_series,
      (v_entry->>'date')::date,
      v_entry->>'description',
      COALESCE(NULLIF(v_entry->>'sourceType', ''), 'import'),
      NULLIF(v_entry->>'sourceSeries', ''),
      CASE
        WHEN v_entry ? 'sourceNumber' AND v_entry->>'sourceNumber' IS NOT NULL
        THEN (v_entry->>'sourceNumber')::integer
        ELSE NULL
      END,
      'draft'
    )
    RETURNING id INTO v_entry_id;

    IF jsonb_typeof(v_entry->'lines') <> 'array' OR jsonb_array_length(v_entry->'lines') = 0 THEN
      RAISE EXCEPTION 'SIE journal entry % has no lines', COALESCE(v_entry->>'sourceId', '<unknown>');
    END IF;

    FOR v_line IN
      SELECT l.value
      FROM jsonb_array_elements(v_entry->'lines') WITH ORDINALITY AS l(value, ord)
      ORDER BY l.ord
    LOOP
      INSERT INTO public.journal_entry_lines (
        journal_entry_id,
        account_number,
        account_id,
        debit_amount,
        credit_amount,
        currency,
        line_description,
        sort_order
      )
      VALUES (
        v_entry_id,
        v_line->>'account_number',
        CASE
          WHEN v_line ? 'account_id' AND v_line->>'account_id' IS NOT NULL
          THEN (v_line->>'account_id')::uuid
          ELSE NULL
        END,
        COALESCE((v_line->>'debit_amount')::numeric, 0),
        COALESCE((v_line->>'credit_amount')::numeric, 0),
        COALESCE(NULLIF(v_line->>'currency', ''), 'SEK'),
        NULLIF(v_line->>'line_description', ''),
        COALESCE((v_line->>'sort_order')::integer, 0)
      );
    END LOOP;

    UPDATE public.journal_entries
    SET status = 'posted',
        committed_at = now()
    WHERE id = v_entry_id
      AND company_id = p_company_id;

    v_inserted := v_inserted || jsonb_build_array(jsonb_build_object(
      'id', v_entry_id,
      'sourceId', v_entry->>'sourceId',
      'series', v_series,
      'voucherNumber', v_assigned_number,
      'sourceType', COALESCE(NULLIF(v_entry->>'sourceType', ''), 'import')
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'inserted_entries', v_inserted,
    'skipped_duplicates', '[]'::jsonb,
    'validation_errors', '[]'::jsonb
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
