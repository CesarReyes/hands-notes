-- Least privilege, independent of platform defaults: signed-in users read and
-- upsert their own rows (RLS); nothing is ever hard-deleted from the client.
revoke all on public.notebooks, public.pages, public.strokes from anon, authenticated;
grant select, insert, update on public.notebooks, public.pages, public.strokes to authenticated;
