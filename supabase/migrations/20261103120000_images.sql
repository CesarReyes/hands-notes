-- Images placed on pages. A placed image is a stroke row (tool 'image:<file id>'),
-- and its bytes live in a private bucket under '<user id>/<file id>.jpg|png'.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', false, 10485760, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- Files are immutable (a new insert is a new id), so owners only need to upload and read.
create policy "own images select" on storage.objects for select to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own images insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text);
