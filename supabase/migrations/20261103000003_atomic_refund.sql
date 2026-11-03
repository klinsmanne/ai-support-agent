-- =============================================================================
-- Atomic refunds (milestone D security review): the agent's policy check runs in application
-- code, but the balance / frequency limits are re-checked here under a row lock on the order,
-- so two tickets processed concurrently can't both refund the same money.
-- =============================================================================

create or replace function public.create_refund_checked(
  p_tenant_id uuid,
  p_order_id uuid,
  p_customer_id uuid,
  p_ticket_id uuid,
  p_amount_cents integer,
  p_reason text,
  p_status public.refund_status,
  p_idempotency_key text,
  p_max_refunds_30d integer
)
returns table (refund_id uuid, outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_captured bigint;
  v_refunded bigint;
  v_recent integer;
  v_existing uuid;
begin
  -- Serialize refunds per order: concurrent callers wait here.
  perform 1 from public.orders o
   where o.tenant_id = p_tenant_id and o.id = p_order_id and o.customer_id = p_customer_id
   for update;
  if not found then
    return query select null::uuid, 'order_not_found'::text;
    return;
  end if;

  select r.id into v_existing from public.refunds r
   where r.tenant_id = p_tenant_id and r.idempotency_key = p_idempotency_key;
  if v_existing is not null then
    return query select v_existing, 'duplicate'::text;
    return;
  end if;

  select coalesce(sum(p.amount_cents), 0) into v_captured from public.payments p
   where p.tenant_id = p_tenant_id and p.order_id = p_order_id;
  select coalesce(sum(r.amount_cents), 0) into v_refunded from public.refunds r
   where r.tenant_id = p_tenant_id and r.order_id = p_order_id and r.status in ('approved', 'pending_approval');
  if p_amount_cents <= 0 or v_refunded + p_amount_cents > v_captured then
    return query select null::uuid, 'exceeds_balance'::text;
    return;
  end if;

  select count(*) into v_recent from public.refunds r
   where r.tenant_id = p_tenant_id and r.customer_id = p_customer_id
     and r.status = 'approved' and r.created_at > now() - interval '30 days';
  if p_status = 'approved' and v_recent >= p_max_refunds_30d then
    return query select null::uuid, 'frequency_limit'::text;
    return;
  end if;

  return query
  insert into public.refunds (tenant_id, order_id, customer_id, ticket_id, amount_cents, reason, status, decided_by, idempotency_key)
  values (p_tenant_id, p_order_id, p_customer_id, p_ticket_id, p_amount_cents, p_reason, p_status, 'ai', p_idempotency_key)
  returning id, 'created'::text;
end;
$$;

revoke all on function public.create_refund_checked(uuid, uuid, uuid, uuid, integer, text, public.refund_status, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_refund_checked(uuid, uuid, uuid, uuid, integer, text, public.refund_status, text, integer)
  to service_role;
