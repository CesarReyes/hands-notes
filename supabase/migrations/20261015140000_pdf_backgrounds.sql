-- Imported PDFs: pages can carry a background reference ('pdf:<file id>:<page>'),
-- and the PDF bytes live in a private Storage bucket under '<user id>/<file id>.pdf'.

alter table public.pages add column background text;

create or replace function public.push_pages(rows jsonb) returns void
language sql security invoker set search_path = '' as $$
  insert into public.pages as t (id, user_id, notebook_id, position, template, paper, width, height, background, updated_at, deleted)
  select r.id, auth.uid(), r.notebook_id, r.position, r.template, r.paper, r.width, r.height, r.background, r.updated_at, r.deleted
  from jsonb_to_recordset(rows) as r(id uuid, notebook_id uuid, position double precision, template text, paper text, width real, height real, background text, updated_at bigint, deleted boolean)
  on conflict (id) do update set
    position = excluded.position, template = excluded.template, paper = excluded.paper,
    width = excluded.width, height = excluded.height, background = excluded.background,
    updated_at = excluded.updated_at, deleted = excluded.deleted
  where t.updated_at <= excluded.updated_at;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

-- Files are immutable (a new import is a new id), so owners only need to upload and read.
create policy "own pdfs select" on storage.objects for select to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own pdfs insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
