-- Hands Notes: local-first handwriting notes. Rows are client-generated (uuid) and
-- merged last-writer-wins on updated_at (client epoch ms). server_ts is the pull cursor.

create table public.notebooks (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  cover text not null default '#3b5bdb',
  created_at bigint not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  server_ts timestamptz not null default clock_timestamp()
);

create table public.pages (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  notebook_id uuid not null,
  position double precision not null,
  template text not null default 'lined',
  paper text not null default 'white',
  width real not null,
  height real not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  server_ts timestamptz not null default clock_timestamp()
);

create table public.strokes (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  notebook_id uuid not null,
  page_id uuid not null,
  tool text not null,
  color text not null,
  size real not null,
  points text not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  server_ts timestamptz not null default clock_timestamp()
);

create index notebooks_user_ts on public.notebooks (user_id, server_ts);
create index pages_user_ts on public.pages (user_id, server_ts);
create index strokes_user_ts on public.strokes (user_id, server_ts);

create or replace function public.touch_server_ts() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.server_ts := clock_timestamp();
  return new;
end $$;

create trigger notebooks_ts before insert or update on public.notebooks for each row execute function public.touch_server_ts();
create trigger pages_ts before insert or update on public.pages for each row execute function public.touch_server_ts();
create trigger strokes_ts before insert or update on public.strokes for each row execute function public.touch_server_ts();

alter table public.notebooks enable row level security;
alter table public.pages enable row level security;
alter table public.strokes enable row level security;

create policy "own notebooks select" on public.notebooks for select to authenticated using ((select auth.uid()) = user_id);
create policy "own notebooks insert" on public.notebooks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own notebooks update" on public.notebooks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own pages select" on public.pages for select to authenticated using ((select auth.uid()) = user_id);
create policy "own pages insert" on public.pages for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own pages update" on public.pages for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own strokes select" on public.strokes for select to authenticated using ((select auth.uid()) = user_id);
create policy "own strokes insert" on public.strokes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own strokes update" on public.strokes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- LWW batch upserts. security invoker: RLS still applies; user_id always comes from the JWT.
create or replace function public.push_notebooks(rows jsonb) returns void
language sql security invoker set search_path = '' as $$
  insert into public.notebooks as t (id, user_id, title, cover, created_at, updated_at, deleted)
  select r.id, auth.uid(), r.title, r.cover, r.created_at, r.updated_at, r.deleted
  from jsonb_to_recordset(rows) as r(id uuid, title text, cover text, created_at bigint, updated_at bigint, deleted boolean)
  on conflict (id) do update set
    title = excluded.title, cover = excluded.cover, updated_at = excluded.updated_at, deleted = excluded.deleted
  where t.updated_at <= excluded.updated_at;
$$;

create or replace function public.push_pages(rows jsonb) returns void
language sql security invoker set search_path = '' as $$
  insert into public.pages as t (id, user_id, notebook_id, position, template, paper, width, height, updated_at, deleted)
  select r.id, auth.uid(), r.notebook_id, r.position, r.template, r.paper, r.width, r.height, r.updated_at, r.deleted
  from jsonb_to_recordset(rows) as r(id uuid, notebook_id uuid, position double precision, template text, paper text, width real, height real, updated_at bigint, deleted boolean)
  on conflict (id) do update set
    position = excluded.position, template = excluded.template, paper = excluded.paper,
    width = excluded.width, height = excluded.height, updated_at = excluded.updated_at, deleted = excluded.deleted
  where t.updated_at <= excluded.updated_at;
$$;

create or replace function public.push_strokes(rows jsonb) returns void
language sql security invoker set search_path = '' as $$
  insert into public.strokes as t (id, user_id, notebook_id, page_id, tool, color, size, points, updated_at, deleted)
  select r.id, auth.uid(), r.notebook_id, r.page_id, r.tool, r.color, r.size, r.points, r.updated_at, r.deleted
  from jsonb_to_recordset(rows) as r(id uuid, notebook_id uuid, page_id uuid, tool text, color text, size real, points text, updated_at bigint, deleted boolean)
  on conflict (id) do update set
    page_id = excluded.page_id, tool = excluded.tool, color = excluded.color, size = excluded.size,
    points = excluded.points, updated_at = excluded.updated_at, deleted = excluded.deleted
  where t.updated_at <= excluded.updated_at;
$$;

revoke execute on function public.push_notebooks(jsonb), public.push_pages(jsonb), public.push_strokes(jsonb) from public, anon;
grant execute on function public.push_notebooks(jsonb), public.push_pages(jsonb), public.push_strokes(jsonb) to authenticated;

alter publication supabase_realtime add table public.notebooks, public.pages, public.strokes;
