# Databricks notebook source
"""Stage the current and previous monthly exports from Reporting Cluster.

This job never publishes data. A supervisor reviews each completed staging
load in ValidaFlow before replacing the visible export for that month.
"""

from datetime import datetime
import re
from zoneinfo import ZoneInfo

import requests

month_names = ("ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC")
callback_url = "https://jujndhavotibflcredrx.supabase.co/functions/v1/sync-databricks-export"
ingest_token = dbutils.secrets.get(scope="validaflow-export-general", key="staging-token")
session = requests.Session()


def send(sync_job_id, callback_token, action, **values):
    response = session.post(
        callback_url,
        headers={"x-sync-token": callback_token},
        json={"action": action, "jobId": sync_job_id, **values},
        timeout=90,
    )
    response.raise_for_status()


def clean(value):
    return None if value is None else str(value).strip()[:1000]


def sync_month(period_month):
    if not re.fullmatch(r"20\d{2}-(0[1-9]|1[0-2])", period_month):
        raise ValueError("Mes de sincronización no válido")
    begin_response = session.post(
        callback_url,
        headers={"x-ingest-token": ingest_token},
        json={"action": "begin", "periodMonth": period_month},
        timeout=90,
    )
    begin_response.raise_for_status()
    begin_result = begin_response.json()
    sync_job_id = str(begin_result["jobId"])
    callback_token = str(begin_result["callbackToken"])
    if not re.fullmatch(r"[0-9a-f-]{36}", sync_job_id, flags=re.I) or len(callback_token) < 40:
        raise ValueError("La respuesta de inicio no fue válida")

    year, month = period_month.split("-")
    wave = f"{month_names[int(month) - 1]} {year}"
    # The fixed table and a validated year/month prevent arbitrary SQL.
    query = f"""
    SELECT Estado, ID_de_audito, ID_de_PDV, Pais, Fecha_del_audito,
           Survey, Ola, ciudad, canal, nombre_usuario AS auditor
    FROM storeview.slv_sv_ceres_ag_export
    WHERE (lower(Survey) LIKE '%ko_trad%'
           OR lower(Survey) LIKE '%ko_moderno%'
           OR lower(Survey) LIKE '%lindley%')
      AND upper(trim(Ola)) = '{wave}'
      AND CAST(ID_de_audito AS STRING) RLIKE '^[0-9]+$'
    """

    seen_ids = set()
    batch = []
    sent_count = 0
    try:
        for item in spark.sql(query).toLocalIterator():
            row = item.asDict()
            audit_id = clean(row.get("ID_de_audito"))
            if not audit_id or not re.fullmatch(r"[0-9]+", audit_id) or audit_id in seen_ids:
                continue
            seen_ids.add(audit_id)
            audit_date = clean(row.get("Fecha_del_audito"))
            batch.append({
                "audit_external_id": audit_id,
                "audit_status": clean(row.get("Estado")),
                "pdv_id": clean(row.get("ID_de_PDV")),
                "country": clean(row.get("Pais")),
                "audit_date": audit_date[:10] if audit_date else None,
                "study": clean(row.get("Survey")),
                "wave": clean(row.get("Ola")),
                "city": clean(row.get("ciudad")),
                "channel": clean(row.get("canal")),
                "auditor": clean(row.get("auditor")),
            })
            if len(batch) >= 250:
                sent_count += len(batch)
                send(sync_job_id, callback_token, "batch", rows=batch, processedCount=sent_count)
                batch = []
        if batch:
            sent_count += len(batch)
            send(sync_job_id, callback_token, "batch", rows=batch, processedCount=sent_count)
        send(sync_job_id, callback_token, "complete", expectedCount=sent_count)
        print(f"{period_month}: {sent_count} auditorías listas para revisión")
    except Exception as exc:
        try:
            send(sync_job_id, callback_token, "failed", message=str(exc)[:500])
        except Exception:
            pass
        raise


today = datetime.now(ZoneInfo("America/Bogota"))
current_month = f"{today.year:04d}-{today.month:02d}"
previous_year = today.year - 1 if today.month == 1 else today.year
previous_month = 12 if today.month == 1 else today.month - 1
previous_period = f"{previous_year:04d}-{previous_month:02d}"

errors = []
dbutils.widgets.text("period_override", "")
period_override = dbutils.widgets.get("period_override").strip()
if period_override and period_override not in (previous_period, current_month):
    raise ValueError("Solo se puede probar el mes actual o el anterior")
periods = (period_override,) if period_override else (previous_period, current_month)
for period in periods:
    try:
        sync_month(period)
    except Exception as exc:
        errors.append(f"{period}: {exc}")
if errors:
    raise RuntimeError("; ".join(errors))
