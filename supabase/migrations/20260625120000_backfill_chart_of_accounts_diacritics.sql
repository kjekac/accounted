-- Backfill: restore Swedish diacritics (å/ä/ö) on seeded chart-of-accounts names.
--
-- The seed_chart_of_accounts() helper shipped between 2026-03-30
-- (20260330130000_multi_tenant_company_refactor.sql) and 2026-05-16 with its
-- account-name string literals stripped of å/ä/ö — e.g. 'Foretagskonto /
-- checkkonto', 'Leverantorsskulder', 'Arets resultat', 'Loner'. The function was
-- repaired for NEW companies by 20260516130000_seed_chart_of_accounts_restore_
-- swedish_chars.sql, but the ~830 companies seeded in that window were never
-- backfilled, so their books still render bank/expense/VAT accounts without
-- diacritics (the reported "Foretagskonto / checkkonto" / "Ovriga bankkonton").
--
-- This restores the diacritics on the AFFECTED rows only. It maps each corrupted
-- name back to the diacritic form OF THAT SAME ACCOUNT (same account_number and
-- same wording) — it deliberately does NOT adopt the later seed's restructured
-- VAT accounts (2610/2611/2612 stay as-is with their names fixed; they are not
-- renumbered to 2611/2621/2631 — that is a structural change, out of scope for a
-- charset repair).
--
-- Safe + idempotent: the join matches on account_number AND the exact corrupted
-- account_name, so a company that renamed an account, or a row already carrying
-- the correct name, is left untouched. Re-running is a no-op.

UPDATE public.chart_of_accounts AS coa
SET account_name = fix.correct_name
FROM (
  VALUES
    ('1930', 'Foretagskonto / checkkonto',      'Företagskonto / checkkonto'),
    ('1940', 'Ovriga bankkonton',               'Övriga bankkonton'),
    ('2013', 'Ovriga egna uttag',               'Övriga egna uttag'),
    ('2018', 'Ovriga egna insattningar',        'Övriga egna insättningar'),
    ('2099', 'Arets resultat',                  'Årets resultat'),
    ('2440', 'Leverantorsskulder',              'Leverantörsskulder'),
    ('2610', 'Utgaende moms 25%',               'Utgående moms 25%'),
    ('2611', 'Utgaende moms 12%',               'Utgående moms 12%'),
    ('2612', 'Utgaende moms 6%',                'Utgående moms 6%'),
    ('2641', 'Debiterad ingaende moms',         'Debiterad ingående moms'),
    ('2650', 'Redovisningskonto for moms',      'Redovisningskonto för moms'),
    ('2731', 'Avrakning socialavgifter',        'Avräkning socialavgifter'),
    ('2893', 'Skuld till aktieagare',           'Skuld till aktieägare'),
    ('3001', 'Forsaljning tjanster 25%',        'Försäljning tjänster 25%'),
    ('3002', 'Forsaljning varor 25%',           'Försäljning varor 25%'),
    ('3100', 'Momsfri forsaljning',             'Momsfri försäljning'),
    ('3900', 'Ovriga rorelseintakter',          'Övriga rörelseintäkter'),
    ('4000', 'Varuinkop',                       'Varuinköp'),
    ('5410', 'Forbrukningsinventarier',         'Förbrukningsinventarier'),
    ('5460', 'Forbrukningsmaterial',            'Förbrukningsmaterial'),
    ('6530', 'Redovisningstjanster',            'Redovisningstjänster'),
    ('6991', 'Ovriga avdragsgilla kostnader',   'Övriga avdragsgilla kostnader'),
    ('7010', 'Loner',                           'Löner'),
    ('7210', 'Semesterloner',                   'Semesterlöner'),
    ('7960', 'Valutakursforluster',             'Valutakursförluster'),
    ('8310', 'Ranteintakter',                   'Ränteintäkter'),
    ('8410', 'Rantekostnader',                  'Räntekostnader')
) AS fix(account_number, corrupted_name, correct_name)
WHERE coa.account_number = fix.account_number
  AND coa.account_name = fix.corrupted_name;
