-- =====================================================================
--  Planning Dayan 3D : schéma de la base Supabase
--  À coller en entier dans Supabase > SQL Editor > New query > Run
--  Le script peut être relancé sans danger.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Profils des collaborateurs ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name',''), initcap(split_part(new.email,'@',1))))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- comptes déjà créés avant ce script
insert into public.profiles (id, name)
select id, coalesce(nullif(raw_user_meta_data->>'name',''), initcap(split_part(email,'@',1)))
from auth.users
on conflict (id) do nothing;

-- ---------- Machines ----------
create table if not exists public.machines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort int not null default 0
);
insert into public.machines (name, sort)
select v.name, v.sort from (values
  ('Bambu Lab HD2', 1), ('Creality K1', 2), ('Elegoo Neptune 4', 3)
) as v(name, sort)
where not exists (select 1 from public.machines);

-- ---------- Commandes clients ----------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  client text,
  title text not null,
  status text not null default 'todo' check (status in ('todo','doing','done')),
  due_date date,
  price_chf numeric(10,2),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Impressions (planning par machine) ----------
create table if not exists public.prints (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  machine_id uuid references public.machines(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'planned' check (status in ('planned','printing','done')),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Tâches et rendez-vous ----------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  kind text not null default 'task' check (kind in ('task','rdv')),
  start_at timestamptz,
  end_at timestamptz,
  assignee uuid references public.profiles(id) on delete set null,
  notes text,
  done boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Disponibilités ----------
create table if not exists public.availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  date_from date not null,
  date_to date not null,
  kind text not null default 'absent' check (kind in ('present','partial','absent')),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Pièces jointes (photos, STL) ----------
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  parent_type text not null check (parent_type in ('order','print')),
  parent_id uuid not null,
  name text not null,
  path text not null,
  size bigint,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- Historique des modifications ----------
create table if not exists public.history (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  table_name text not null,
  row_id uuid,
  action text not null,
  summary text,
  detail text
);

-- ---------- Stock de matières (1.3.0) ----------
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'filament' check (category in ('filament','wood','other')),
  unit text not null default 'g' check (unit in ('g','plaque','pièce')),
  quantity numeric not null default 0,
  min_quantity numeric not null default 0,
  cost_chf numeric(10,2),
  cost_qty numeric not null default 1 check (cost_qty > 0),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- matières utilisées par une impression ou par une commande
create table if not exists public.material_uses (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id) on delete cascade,
  print_id uuid references public.prints(id) on delete cascade,
  order_id uuid references public.orders(id) on delete cascade,
  qty numeric not null check (qty > 0),
  applied boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check ((print_id is not null)::int + (order_id is not null)::int = 1)
);

-- journal des mouvements de stock (la quantité de la matière en découle)
create table if not exists public.stock_moves (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  material_id uuid not null references public.materials(id) on delete cascade,
  delta numeric not null,
  reason text not null check (reason in ('use','return','purchase','adjust','inventory')),
  note text,
  user_id uuid default auth.uid()
);

-- ---------- Commentaires sur les commandes (1.4.0) ----------
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  body text not null check (length(btrim(body)) > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists comments_order_idx on public.comments (order_id, created_at);

-- dernière lecture des commentaires d'une commande, par personne
create table if not exists public.comment_reads (
  user_id uuid not null default auth.uid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (user_id, order_id)
);

-- ---------- Lot 1.5.0 : à racheter, blocage des machines ----------
alter table public.materials add column if not exists reorder_qty numeric;

-- période pendant laquelle une machine est indisponible (entretien, panne…)
create table if not exists public.machine_blocks (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.machines(id) on delete cascade,
  reason text not null default 'Entretien',
  start_at timestamptz not null,
  end_at timestamptz not null check (end_at > start_at),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- Lot 1.6.0 : clients, priorités et étiquettes, modèles d'impression ----------
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.orders add column if not exists priority text not null default 'normal'
  check (priority in ('normal','urgent'));
alter table public.orders add column if not exists tags text[] not null default '{}';

-- modèles d'impression : pièces refaites souvent (machine, durée, matières)
create table if not exists public.print_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  machine_id uuid references public.machines(id) on delete set null,
  duration_h numeric(6,2) not null default 1 check (duration_h > 0),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- les matières d'un modèle utilisent la même table que les impressions et les commandes
alter table public.material_uses add column if not exists template_id uuid references public.print_templates(id) on delete cascade;
alter table public.material_uses drop constraint if exists material_uses_check;
alter table public.material_uses drop constraint if exists material_uses_one_parent;
alter table public.material_uses add constraint material_uses_one_parent
  check ((print_id is not null)::int + (order_id is not null)::int + (template_id is not null)::int = 1);

-- ---------- Lot 2.1.0 : échecs d'impression, entretien selon les heures, corbeille ----------
alter table public.prints drop constraint if exists prints_status_check;
alter table public.prints add constraint prints_status_check check (status in ('planned','printing','done','failed'));
alter table public.prints add column if not exists fail_reason text;

-- entretien d'une machine tous les N heures d'impression
create table if not exists public.maintenance_rules (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.machines(id) on delete cascade,
  name text not null,
  every_h numeric(8,1) not null check (every_h > 0),
  last_done_at timestamptz not null default now(),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- corbeille : copie des éléments supprimés, gardés 30 jours
create table if not exists public.trash (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_id uuid not null,
  label text,
  data jsonb not null,
  deleted_by uuid default auth.uid(),
  deleted_at timestamptz not null default now()
);

-- ---------- Lot 2.2.0 : bobines individuelles ----------
create table if not exists public.spools (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id) on delete cascade,
  label text,
  initial_g numeric not null default 1000 check (initial_g > 0),
  remaining_g numeric not null default 1000,
  machine_id uuid references public.machines(id) on delete set null,
  loaded_at timestamptz,
  status text not null default 'active' check (status in ('active','empty')),
  alert_g numeric not null default 100,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.stock_moves add column if not exists spool_id uuid references public.spools(id) on delete set null;
alter table public.material_uses add column if not exists spool_id uuid references public.spools(id) on delete set null;

-- ---------- Lot 2.4.0 : heures de bénévolat, état en direct des imprimantes ----------
create table if not exists public.volunteer_hours (
  id uuid primary key default gen_random_uuid(),
  member text not null,
  day date not null default current_date,
  hours numeric(5,2) not null check (hours > 0 and hours <= 24),
  activity text not null default 'Atelier',
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- dernier état connu de chaque imprimante (écrit par l'ordinateur qui relaie les imprimantes)
create table if not exists public.printer_status (
  machine_id uuid primary key references public.machines(id) on delete cascade,
  state text not null default 'offline' check (state in ('idle','printing','paused','finished','error','offline')),
  progress numeric(5,1),
  remaining_min int,
  file_name text,
  nozzle_c numeric(5,1),
  bed_c numeric(5,1),
  layer int,
  total_layers int,
  state_since timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Lot 2.8.0 : gestionnaire de filaments ----------
-- la matière (filament) décrit la référence : marque, matière, couleur, températures
alter table public.materials
  add column if not exists brand text,
  add column if not exists filament_type text,
  add column if not exists color_name text,
  add column if not exists color_hex text check (color_hex is null or color_hex ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists diameter numeric(3,2),
  add column if not exists nozzle_min int,
  add column if not exists nozzle_max int,
  add column if not exists bed_c int,
  add column if not exists dry_c int,
  add column if not exists dry_h int;

-- la bobine est l'objet physique : poids à vide, prix payé, achat, rangement, séchage
alter table public.spools
  add column if not exists tare_g numeric check (tare_g is null or tare_g >= 0),
  add column if not exists price_chf numeric(10,2),
  add column if not exists purchased_at date,
  add column if not exists supplier text,
  add column if not exists location text,
  add column if not exists opened_at date,
  add column if not exists dried_at date,
  add column if not exists dry_storage boolean not null default false;

-- mise à jour automatique de updated_at
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- journal : qui a changé quoi
create or replace function public.log_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  j jsonb;
  lbl text;
  det text := null;
begin
  j := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  lbl := coalesce(nullif(j->>'title',''), nullif(j->>'name',''), nullif(j->>'note',''), nullif(j->>'body',''), nullif(j->>'reason',''), nullif(j->>'label',''), nullif(j->>'activity',''), '');
  if nullif(j->>'client','') is not null then
    lbl := (j->>'client') || ' – ' || lbl;
  end if;

  if tg_op = 'UPDATE' then
    select string_agg(n.key || ' → ' || left(coalesce(n.value #>> '{}', '∅'), 40), '; ')
      into det
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.value is distinct from o.value
      and n.key not in ('updated_at', 'recur_spawned', 'done_at');
    if det is null then
      return null; -- rien de réellement modifié
    end if;
  end if;

  insert into public.history (user_id, table_name, row_id, action, summary, detail)
  values (auth.uid(), tg_table_name, (j->>'id')::uuid, lower(tg_op), left(lbl, 160), det);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['orders','prints','tasks','availability','materials','clients','print_templates','spools','volunteer_hours','printer_status'] loop
    execute format('drop trigger if exists trg_touch on public.%I', t);
    execute format('create trigger trg_touch before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
  foreach t in array array['orders','prints','tasks','availability','attachments','materials','comments','machine_blocks','clients','print_templates','maintenance_rules','spools','volunteer_hours'] loop
    execute format('drop trigger if exists trg_log on public.%I', t);
    execute format('create trigger trg_log after insert or update or delete on public.%I for each row execute function public.log_change()', t);
  end loop;
end $$;

-- ---------- Évolutions 1.2.0 : tâches récurrentes et machine liée ----------
alter table public.tasks add column if not exists recurrence text not null default 'none'
  check (recurrence in ('none','daily','weekly','monthly'));
alter table public.tasks add column if not exists recur_until date;
alter table public.tasks add column if not exists recur_spawned boolean not null default false;
alter table public.tasks add column if not exists machine_id uuid references public.machines(id) on delete set null;

-- Quand une tâche récurrente est cochée, la suivante est créée automatiquement
-- (jamais dans le passé : si la tâche est faite en retard, la prochaine date est dans le futur).
create or replace function public.spawn_recurring_task() returns trigger
language plpgsql as $$
declare
  step interval;
  nxt timestamptz;
  nend timestamptz;
  k int := 1;
begin
  if new.done and not old.done
     and new.recurrence <> 'none'
     and not new.recur_spawned
     and new.start_at is not null then
    step := case new.recurrence
              when 'daily' then interval '1 day'
              when 'weekly' then interval '7 days'
              else interval '1 month' end;
    nxt := new.start_at + step * k;
    while nxt < now() and k < 2000 loop
      k := k + 1;
      nxt := new.start_at + step * k;
    end loop;
    if new.recur_until is null or nxt::date <= new.recur_until then
      nend := case when new.end_at is null then null else nxt + (new.end_at - new.start_at) end;
      insert into public.tasks (title, kind, start_at, end_at, assignee, notes, done, recurrence, recur_until, machine_id)
      values (new.title, new.kind, nxt, nend, new.assignee, new.notes, false, new.recurrence, new.recur_until, new.machine_id);
    end if;
    new.recur_spawned := true;
  end if;
  return new;
end $$;

drop trigger if exists trg_spawn on public.tasks;
create trigger trg_spawn before update on public.tasks
  for each row execute function public.spawn_recurring_task();

-- ---------- Évolutions 1.3.0 : le stock suit les utilisations ----------
-- la quantité d'une matière = somme de ses mouvements
create or replace function public.apply_stock_move() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.materials set quantity = quantity + new.delta where id = new.material_id;
  if new.spool_id is not null then
    update public.spools set remaining_g = remaining_g + new.delta where id = new.spool_id;
  end if;
  return null;
end $$;

drop trigger if exists trg_stock_move on public.stock_moves;
create trigger trg_stock_move after insert on public.stock_moves
  for each row execute function public.apply_stock_move();

-- une utilisation ajoutée, modifiée ou supprimée : le stock suit si l'impression/commande est terminée
create or replace function public.uses_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  is_done boolean;
  mach uuid;
  sp uuid;
begin
  if tg_op in ('UPDATE','DELETE') and old.applied then
    insert into public.stock_moves (material_id, delta, reason, note, spool_id)
    values (old.material_id, old.qty, 'return', 'Utilisation annulée ou modifiée', old.spool_id);
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select coalesce(
           (select p.status in ('done','failed') from public.prints p where p.id = new.print_id),
           (select o.status = 'done' from public.orders o where o.id = new.order_id),
           false) into is_done;
  new.applied := is_done;
  new.spool_id := null;
  if is_done then
    -- la bobine chargée dans la machine de l'impression, si elle existe
    if new.print_id is not null then
      select p.machine_id into mach from public.prints p where p.id = new.print_id;
      if mach is not null then
        select s.id into sp from public.spools s
        where s.material_id = new.material_id and s.machine_id = mach and s.status = 'active'
        order by s.loaded_at desc nulls last limit 1;
        new.spool_id := sp;
      end if;
    end if;
    insert into public.stock_moves (material_id, delta, reason, note, spool_id)
    values (new.material_id, -new.qty, 'use', 'Utilisé sur une impression ou une commande terminée', new.spool_id);
  end if;
  return new;
end $$;

drop trigger if exists trg_uses_ins on public.material_uses;
create trigger trg_uses_ins before insert on public.material_uses
  for each row execute function public.uses_write();
drop trigger if exists trg_uses_upd on public.material_uses;
create trigger trg_uses_upd before update of qty, material_id on public.material_uses
  for each row when (old.qty is distinct from new.qty or old.material_id is distinct from new.material_id)
  execute function public.uses_write();
drop trigger if exists trg_uses_del on public.material_uses;
create trigger trg_uses_del before delete on public.material_uses
  for each row execute function public.uses_write();

-- une impression ou une commande passe à « terminée » (ou en sort) : le stock baisse (ou remonte)
create or replace function public.sync_uses_on_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  u record;
  want boolean := (new.status in ('done','failed'));
  mach uuid := null;
  sp uuid;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  if tg_table_name = 'prints' then
    mach := new.machine_id;
  end if;
  for u in
    select * from public.material_uses
    where (tg_table_name = 'prints' and print_id = new.id)
       or (tg_table_name = 'orders' and order_id = new.id)
  loop
    if want and not u.applied then
      sp := null;
      if mach is not null then
        select s.id into sp from public.spools s
        where s.material_id = u.material_id and s.machine_id = mach and s.status = 'active'
        order by s.loaded_at desc nulls last limit 1;
      end if;
      insert into public.stock_moves (material_id, delta, reason, note, spool_id)
      values (u.material_id, -u.qty, 'use', 'Utilisé : ' || coalesce(new.title, ''), sp);
      update public.material_uses set applied = true, spool_id = sp where id = u.id;
    elsif not want and u.applied then
      insert into public.stock_moves (material_id, delta, reason, note, spool_id)
      values (u.material_id, u.qty, 'return', 'Remis en stock : ' || coalesce(new.title, ''), u.spool_id);
      update public.material_uses set applied = false, spool_id = null where id = u.id;
    end if;
  end loop;
  return null;
end $$;

drop trigger if exists trg_stock_status on public.prints;
create trigger trg_stock_status after update of status on public.prints
  for each row execute function public.sync_uses_on_status();
drop trigger if exists trg_stock_status on public.orders;
create trigger trg_stock_status after update of status on public.orders
  for each row execute function public.sync_uses_on_status();

-- ---------- Lot 1.7.0 : date de fin des commandes (pour les statistiques) ----------
alter table public.orders add column if not exists done_at timestamptz;

create or replace function public.set_done_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'done' then
    if tg_op = 'INSERT' or old.status is distinct from 'done' then
      new.done_at := now();
    end if;
  else
    new.done_at := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_done_at on public.orders;
create trigger trg_done_at before insert or update of status on public.orders
  for each row execute function public.set_done_at();

-- commandes déjà terminées avant cette version : on garde leur dernière modification
update public.orders set done_at = updated_at where status = 'done' and done_at is null;

-- ---------- Lot 1.8.0 : commandes de la boutique du site ----------
alter table public.orders add column if not exists source text not null default 'manual'
  check (source in ('manual','boutique'));
alter table public.orders add column if not exists stripe_session_id text;
-- un paiement Stripe ne crée qu'une seule commande (les valeurs vides restent permises)
create unique index if not exists orders_stripe_session_key on public.orders (stripe_session_id);

-- ---------- Lot 1.9.0 : photos avant / après sur les commandes ----------
alter table public.attachments add column if not exists kind text not null default 'file'
  check (kind in ('file','before','after'));

-- copie l'élément dans la corbeille juste avant sa suppression (avec ses matières et commentaires)
create or replace function public.trash_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  j jsonb := to_jsonb(old);
  lbl text;
  extra jsonb := '{}'::jsonb;
begin
  lbl := coalesce(nullif(j->>'title',''), nullif(j->>'name',''), '');
  if nullif(j->>'client','') is not null then
    lbl := (j->>'client') || ' – ' || lbl;
  end if;
  if tg_table_name = 'orders' then
    extra := jsonb_build_object(
      '_uses', (select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from public.material_uses u where u.order_id = old.id),
      '_comments', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from public.comments c where c.order_id = old.id));
  elsif tg_table_name = 'prints' then
    extra := jsonb_build_object('_uses', (select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from public.material_uses u where u.print_id = old.id));
  elsif tg_table_name = 'print_templates' then
    extra := jsonb_build_object('_uses', (select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from public.material_uses u where u.template_id = old.id));
  end if;
  insert into public.trash (table_name, row_id, label, data) values (tg_table_name, old.id, left(lbl, 160), j || extra);
  return old;
end $$;

do $$
declare t text;
begin
  foreach t in array array['orders','tasks','prints','clients','print_templates'] loop
    execute format('drop trigger if exists trg_trash on public.%I', t);
    execute format('create trigger trg_trash before delete on public.%I for each row execute function public.trash_row()', t);
  end loop;
end $$;

-- remet un élément de la corbeille à sa place (si un lien n'existe plus, il est simplement retiré)
create or replace function public.restore_trash(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare
  t record;
  d jsonb;
  clean jsonb;
  fk text;
  ru public.material_uses;
  rc public.comments;
begin
  select * into t from public.trash where id = p_id;
  if not found then return 'introuvable'; end if;
  d := t.data;
  clean := d - '_uses' - '_comments';
  begin
    execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)', t.table_name, t.table_name) using clean;
  exception
    when foreign_key_violation then
      foreach fk in array array['client_id','machine_id','order_id','assignee'] loop
        clean := clean - fk;
      end loop;
      execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)', t.table_name, t.table_name) using clean;
    when unique_violation then
      return 'déjà présent';
  end;
  if d ? '_uses' then
    for ru in select * from jsonb_populate_recordset(null::public.material_uses, d->'_uses') loop
      begin
        insert into public.material_uses select ru.*;
      exception when others then null;
      end;
    end loop;
  end if;
  if d ? '_comments' then
    for rc in select * from jsonb_populate_recordset(null::public.comments, d->'_comments') loop
      begin
        insert into public.comments select rc.*;
      exception when others then null;
      end;
    end loop;
  end if;
  delete from public.trash where id = p_id;
  return 'ok';
end $$;

alter table public.trash enable row level security;
drop policy if exists "equipe lit" on public.trash;
create policy "equipe lit" on public.trash for select to authenticated using (true);
drop policy if exists "equipe vide" on public.trash;
create policy "equipe vide" on public.trash for delete to authenticated using (true);

-- bobine : date de chargement, vide = déchargée
create or replace function public.spool_write() returns trigger
language plpgsql as $$
begin
  if new.machine_id is not null and (tg_op = 'INSERT' or old.machine_id is distinct from new.machine_id) then
    new.loaded_at := now();
  end if;
  if tg_op = 'UPDATE' and new.status = 'active' and new.remaining_g <= 0 and old.remaining_g > 0 then
    new.status := 'empty';
  end if;
  if new.status = 'empty' then
    new.machine_id := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_spool on public.spools;
create trigger trg_spool before insert or update on public.spools
  for each row execute function public.spool_write();

-- ---------- Accès : seulement les comptes connectés de l''équipe ----------
do $$
declare t text;
begin
  foreach t in array array['profiles','machines','orders','prints','tasks','availability','attachments','materials','material_uses','comments','machine_blocks','clients','print_templates','maintenance_rules','spools','volunteer_hours','printer_status'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "equipe" on public.%I', t);
    execute format('create policy "equipe" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

alter table public.comment_reads enable row level security;
drop policy if exists "chacun ses lectures" on public.comment_reads;
create policy "chacun ses lectures" on public.comment_reads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.mark_order_read(p_order uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.comment_reads (user_id, order_id, last_read_at)
  values (auth.uid(), p_order, now())
  on conflict (user_id, order_id) do update set last_read_at = now();
$$;

alter table public.stock_moves enable row level security;
drop policy if exists "equipe lit" on public.stock_moves;
create policy "equipe lit" on public.stock_moves for select to authenticated using (true);
drop policy if exists "equipe ajoute" on public.stock_moves;
create policy "equipe ajoute" on public.stock_moves for insert to authenticated with check (true);

alter table public.history enable row level security;
drop policy if exists "equipe lit" on public.history;
create policy "equipe lit" on public.history for select to authenticated using (true);

-- ---------- Stockage des fichiers ----------
insert into storage.buckets (id, name, public)
values ('pieces-jointes', 'pieces-jointes', false)
on conflict (id) do nothing;

drop policy if exists "equipe fichiers" on storage.objects;
create policy "equipe fichiers" on storage.objects
  for all to authenticated
  using (bucket_id = 'pieces-jointes')
  with check (bucket_id = 'pieces-jointes');

-- ---------- Synchronisation en direct ----------
do $$
declare t text;
begin
  foreach t in array array['profiles','machines','orders','prints','tasks','availability','attachments','history','materials','material_uses','stock_moves','comments','comment_reads','machine_blocks','clients','print_templates','maintenance_rules','trash','spools','volunteer_hours','printer_status'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
