-- =============================================================================
-- dashboard_metrics v2 — fixes from the milestone F review:
--   * daily "auto" uses exactly the same filter as auto_resolved (chart and KPI agree)
--   * assisted counts only drafts a human actually approved/edited (rejected drafts aren't help)
--   * escalated = an escalation carrying any reason other than draft_review
--   * needs_attention / injection_flagged exclude spam (spam never reaches the agent)
--   * assisted tickets cost half a human ticket ($3.90): a person still reviews, but doesn't write
-- =============================================================================

create or replace function public.dashboard_metrics(p_tenant_id uuid, p_days integer default 30)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with t as (
    select tk.*,
      exists (select 1 from public.escalations e, unnest(e.reason_codes) rc where e.tenant_id = tk.tenant_id and e.ticket_id = tk.id and rc <> 'draft_review') as was_escalated,
      exists (select 1 from public.escalations e where e.tenant_id = tk.tenant_id and e.ticket_id = tk.id and 'draft_review' = any (e.reason_codes)) as was_draft,
      exists (select 1 from public.escalations e where e.tenant_id = tk.tenant_id and e.ticket_id = tk.id and 'draft_review' = any (e.reason_codes) and e.status in ('approved', 'edited')) as draft_approved,
      exists (select 1 from public.messages m where m.tenant_id = tk.tenant_id and m.ticket_id = tk.id and m.author = 'ai' and m.status = 'sent') as ai_sent
    from public.tickets tk
    where tk.tenant_id = p_tenant_id and tk.created_at > now() - make_interval(days => p_days)
  ),
  s as (
    select
      count(*) as total,
      count(*) filter (where not is_spam) as handled,
      count(*) filter (where is_spam) as spam,
      count(*) filter (where not is_spam and ai_sent and not was_escalated and not was_draft and status in ('resolved', 'awaiting_customer', 'closed')) as auto_resolved,
      count(*) filter (where not is_spam and draft_approved and not was_escalated) as assisted,
      count(*) filter (where not is_spam and was_escalated) as escalated,
      count(*) filter (where not is_spam and status = 'needs_attention') as needs_attention,
      count(*) filter (where not is_spam and injection_suspected) as injection_flagged,
      percentile_cont(0.5) within group (order by extract(epoch from (first_response_at - created_at))) filter (where first_response_at is not null) as median_frt_seconds,
      avg(csat_score) filter (where csat_score is not null) as csat_avg,
      count(*) filter (where csat_score is not null) as csat_count
    from t
  ),
  c as (
    select coalesce(sum(r.est_cost_usd), 0) as ai_cost, count(*) as runs, coalesce(sum(r.tokens_in + r.tokens_out), 0) as tokens,
           percentile_cont(0.5) within group (order by r.latency_ms) as median_latency_ms
    from public.agent_runs r
    where r.tenant_id = p_tenant_id and r.started_at > now() - make_interval(days => p_days)
  ),
  daily as (
    select coalesce(jsonb_agg(jsonb_build_object('day', d, 'tickets', n, 'auto', a, 'escalated', e) order by d), '[]'::jsonb) as series
    from (
      select date_trunc('day', created_at)::date as d, count(*) filter (where not is_spam) as n,
             count(*) filter (where not is_spam and ai_sent and not was_escalated and not was_draft and status in ('resolved', 'awaiting_customer', 'closed')) as a,
             count(*) filter (where not is_spam and was_escalated) as e
      from t group by 1
    ) x
  )
  select jsonb_build_object(
    'window_days', p_days,
    'tickets_total', s.total,
    'handled', s.handled,
    'spam_closed', s.spam,
    'auto_resolved', s.auto_resolved,
    'assisted', s.assisted,
    'escalated', s.escalated,
    'needs_attention', s.needs_attention,
    'injection_flagged', s.injection_flagged,
    'auto_resolution_rate', case when s.handled > 0 then round(s.auto_resolved::numeric / s.handled, 4) else null end,
    'escalation_rate', case when s.handled > 0 then round(s.escalated::numeric / s.handled, 4) else null end,
    'median_first_response_seconds', s.median_frt_seconds,
    'csat_avg', s.csat_avg,
    'csat_count', s.csat_count,
    'hours_saved', round((s.auto_resolved * 8 + s.assisted * 4)::numeric / 60, 2),
    'ai_cost_usd', c.ai_cost,
    'cost_per_ticket_usd', case when s.handled > 0 then round((c.ai_cost + s.escalated * 7.80 + s.assisted * 3.90) / s.handled, 4) else null end,
    'baseline_cost_per_ticket_usd', 7.80,
    'agent_runs', c.runs,
    'tokens', c.tokens,
    'median_agent_latency_ms', c.median_latency_ms,
    'daily', daily.series
  )
  from s, c, daily;
$$;

revoke all on function public.dashboard_metrics(uuid, integer) from public, anon;
grant execute on function public.dashboard_metrics(uuid, integer) to authenticated, service_role;
