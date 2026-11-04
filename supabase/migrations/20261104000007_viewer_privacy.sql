-- =============================================================================
-- Viewer privacy (milestone F security review): the public read-only demo account must never see
-- real people's messages. Real inbound email (anyone can write to the support inbox) lands in the
-- same tenants as the fictional demo data, so visibility is decided per ticket, in the database:
--   owner / agent  → every ticket of their tenant (unchanged)
--   viewer         → only tickets of fictional seeded customers (customer_id set = verified demo
--                    customer) and website-chat demo conversations (the widget tells visitors not
--                    to share real personal information). Unverified email from real senders is
--                    hidden, and the audit log is staff-only.
-- =============================================================================

create or replace function public.can_read_ticket(p_tenant_id uuid, p_ticket_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_members m
    join public.tickets t on t.tenant_id = m.tenant_id and t.id = p_ticket_id
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and (m.role in ('owner', 'agent') or t.customer_id is not null or t.channel = 'chat')
  );
$$;

revoke all on function public.can_read_ticket(uuid, uuid) from public, anon;
grant execute on function public.can_read_ticket(uuid, uuid) to authenticated, service_role;

drop policy member_read on public.tickets;
create policy member_read on public.tickets for select to authenticated
  using (public.can_read_ticket(tenant_id, id));

drop policy member_read on public.messages;
create policy member_read on public.messages for select to authenticated
  using (public.can_read_ticket(tenant_id, ticket_id));

drop policy member_read on public.escalations;
create policy member_read on public.escalations for select to authenticated
  using (public.can_read_ticket(tenant_id, ticket_id));

drop policy member_read on public.agent_runs;
create policy member_read on public.agent_runs for select to authenticated
  using (public.can_read_ticket(tenant_id, ticket_id));

drop policy member_read on public.trace_events;
create policy member_read on public.trace_events for select to authenticated
  using (exists (select 1 from public.agent_runs r where r.id = run_id and public.can_read_ticket(r.tenant_id, r.ticket_id)));

drop policy member_read on public.audit_log;
create policy staff_read on public.audit_log for select to authenticated
  using (public.has_tenant_role(tenant_id, array['owner', 'agent']::public.member_role[]));
