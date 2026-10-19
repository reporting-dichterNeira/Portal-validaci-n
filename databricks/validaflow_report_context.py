"""Read-only reporting metadata by portal audit ID and study.

Unlike the frozen monthly volume snapshots, metadata must also include late
arrivals into a prior Ola. Do not restrict it to the portal upload month.
The caller supplies requested_identities: [{study, ids: [external_id, ...]}].
No source tables, monthly snapshots, decisions or assignments are modified.
"""
from pyspark.sql import functions as F


def report_context(requested_identities):
    requested = spark.createDataFrame(
        [(str(audit_id).lstrip("0") or "0", row["study"])
         for row in requested_identities for audit_id in row["ids"]],
        "audit_external_id string, study string",
    ).dropDuplicates()
    source = spark.sql("""
        SELECT regexp_replace(regexp_replace(CAST(ID_de_audito AS STRING), '[.,]0+$', ''), '^0+(?=[0-9])', '') AS audit_external_id,
               CASE WHEN lower(Survey) RLIKE 'ko[ _]trad[ _]ch([ _]|$)|chile|embonor' THEN 'Chile'
                    WHEN lower(Survey) LIKE '%lindley%' THEN 'Lindley'
                    WHEN lower(Survey) LIKE '%moderno%' THEN 'Moderno'
                    WHEN lower(Survey) LIKE '%trad%' THEN 'Tradicional' END AS study,
               Pais AS country, region, canal AS channel,
               subcanal_modelo AS subchannel, segmento,
               nombre_usuario AS auditor, CAST(Fecha_del_audito AS STRING) AS audit_date,
               CAST(ID_de_PDV AS STRING) AS pdv_id
        FROM storeview.slv_sv_ceres_ag_export
        WHERE CAST(ID_de_audito AS STRING) RLIKE '^[0-9]+([.,]0+)?$'
    """)
    columns = ["country", "region", "channel", "subchannel", "segmento", "auditor", "audit_date", "pdv_id"]
    matched = source.join(F.broadcast(requested), ["audit_external_id", "study"], "inner")
    grouped = matched.groupBy("audit_external_id", "study").agg(
        F.count(F.lit(1)).alias("source_rows"),
        *[F.collect_set(F.when(F.length(F.trim(F.col(c))) > 0, F.trim(F.col(c)))).alias(c + "_values") for c in columns],
    )
    return requested.join(grouped, ["audit_external_id", "study"], "left").select(
        "audit_external_id", "study", F.coalesce("source_rows", F.lit(0)).alias("source_rows"),
        *[F.when(F.size(F.col(c + "_values")) == 1, F.element_at(F.col(c + "_values"), 1)).alias(c) for c in columns],
        *[(F.size(F.col(c + "_values")) > 1).alias(c + "_ambiguous") for c in columns],
    ).orderBy("study", "audit_external_id")


def sync_report_context():
    import requests
    import time

    endpoint = "https://jujndhavotibflcredrx.supabase.co/functions/v1/sync-databricks-export"
    token = dbutils.secrets.get(scope="validaflow-export-general", key="staging-token")
    session = requests.Session()

    def send(action, **values):
        for attempt in range(4):
            try:
                response = session.post(endpoint, headers={"x-ingest-token": token},
                                        json={"action": action, **values}, timeout=90)
                if response.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                if not response.ok:
                    raise RuntimeError(f"{action}: HTTP {response.status_code}: {response.text[:500]}")
                response.raise_for_status()
                return response.json()
            except requests.RequestException:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)

    grouped = {}
    after = ""
    while True:
        page = send("context-identities", after=after)["identities"]
        if not page:
            break
        for row in page:
            grouped.setdefault(row["study"], []).append(row["id"])
        next_cursor = page[-1]["cursor"]
        if next_cursor <= after:
            raise ValueError("El cursor del contexto no avanzó")
        after = next_cursor
    if not grouped:
        print("Sin auditorías del portal para contrastar")
        return
    context = report_context([{"study": study, "ids": ids} for study, ids in grouped.items()]).cache()
    try:
        summary = context.groupBy("study").agg(
            F.count("*").alias("requested"),
            F.sum(F.when(F.col("source_rows") > 0, 1).otherwise(0)).alias("matched"),
            F.sum(F.when(F.col("region").isNotNull(), 1).otherwise(0)).alias("with_region"),
            F.sum(F.when(F.col("channel").isNotNull(), 1).otherwise(0)).alias("with_channel"),
        ).orderBy("study").collect()
        batch, written = [], 0
        for row in context.toLocalIterator():
            batch.append(row.asDict())
            if len(batch) == 250:
                written += send("context-batch", rows=batch)["written"]
                batch = []
        if batch:
            written += send("context-batch", rows=batch)["written"]
        for row in summary:
            print(row.asDict())
        print(f"Contextos verificados y publicados: {written}. Sin modificar cortes mensuales ni validaciones.")
    finally:
        context.unpersist()


if __name__ == "__main__":
    sync_report_context()
