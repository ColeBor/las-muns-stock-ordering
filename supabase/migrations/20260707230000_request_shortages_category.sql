-- Add a "Shortages" request category: staff flag items the store is running low
-- on, to request stock outside the delivery cycle. Surfaced in its own tab on
-- the admin Employee Requests page.

alter table public.employee_requests
  drop constraint if exists employee_requests_category_check;
alter table public.employee_requests
  add constraint employee_requests_category_check
  check (category in ('Store Issue', 'Request', 'Complaint', 'Question', 'Other', 'Shortages'));
