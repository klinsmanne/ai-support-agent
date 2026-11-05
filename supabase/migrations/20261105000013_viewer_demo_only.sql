-- The viewer role exists for the public demo account. Restrict it to demo tenants *in the database*
-- (security review, final docs PR): before, the demo stayed off real clients only because
-- `npm run dashboard:users` never adds it there. Now, even if a membership were added by mistake,
-- a viewer on a non-demo tenant sees no tickets, messages, escalations, runs or traces.
-- Client teams use the owner or agent roles (ADR-025).

create or replace function public.can_read_ticket(p_tenant_id uuid, p_ticket_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_members m
    join public.tickets t on t.tenant_id = m.tenant_id and t.id = p_ticket_id
    join public.tenants tn on tn.id = m.tenant_id
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and (
        m.role in ('owner', 'agent')
        or (tn.is_demo and (t.customer_id is not null or t.channel = 'chat'))
      )
  );
$$;

revoke all on function public.can_read_ticket(uuid, uuid) from public, anon;
grant execute on function public.can_read_ticket(uuid, uuid) to authenticated, service_role;
