-- Workers (role='employee') can mark their own store's cycle_stores row
-- finished. Previously the click silently failed RLS so finished_at stayed
-- null and /api/allocations/run blocked with "Waiting on N store(s)..."
-- even though the UI showed the green ✓.

drop policy if exists "Cycle stores: employees can mark own store finished" on public.cycle_stores;
create policy "Cycle stores: employees can mark own store finished"
  on public.cycle_stores
  for update
  using (public.is_employee() and store_id = public.current_store_id())
  with check (public.is_employee() and store_id = public.current_store_id());
