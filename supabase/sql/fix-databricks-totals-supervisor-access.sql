begin;
do $$ declare definition text; begin
 definition:=pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
 if position('''admin'',''supervisor'',''visualizer'',''commercial''' in definition)=0 then
  if position('''admin'',''visualizer'',''commercial''' in definition)=0 then
   raise exception 'Unexpected authorization definition; nothing changed';
  end if;
  execute replace(definition,'''admin'',''visualizer'',''commercial''','''admin'',''supervisor'',''visualizer'',''commercial''');
 end if;
end $$;
notify pgrst,'reload schema';
commit;
