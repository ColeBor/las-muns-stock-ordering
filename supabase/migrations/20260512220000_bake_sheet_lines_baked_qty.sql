-- Baker progress tracking on the bake sheet.
--
-- Adds `baked_qty` to bake_sheet_lines so the morning baker can tick items
-- off the sheet as they finish them — fully (set to bake_qty), half
-- (floor(bake_qty/2)), or a custom amount. Defaults to 0 so a freshly-saved
-- sheet starts with nothing baked yet. When the closing employee saves a
-- new sheet (delete + reinsert lines), baked_qty naturally resets to 0.

alter table public.bake_sheet_lines
  add column if not exists baked_qty integer not null default 0;

alter table public.bake_sheet_lines
  drop constraint if exists bake_sheet_lines_baked_qty_chk;
alter table public.bake_sheet_lines
  add constraint bake_sheet_lines_baked_qty_chk
  check (baked_qty >= 0);
