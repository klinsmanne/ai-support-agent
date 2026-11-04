-- Only pg_cron (running as postgres) may run the data-lifecycle functions. Supabase's default
-- privileges grant new functions to every API role, so service_role is revoked explicitly: a
-- leaked secret key must not be able to purge or reset data through an RPC call.
revoke all on function public.purge_expired_data() from public, anon, authenticated, service_role;

do $$
begin
  if to_regproc('public.reset_demo_data') is not null then
    revoke all on function public.reset_demo_data() from public, anon, authenticated, service_role;
  end if;
end;
$$;
