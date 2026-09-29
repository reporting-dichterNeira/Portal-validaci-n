# Databricks notebook source
"""Start Reporting Cluster and wait until Spark is ready for the daily load."""

if spark.range(1).count() != 1:
    raise RuntimeError("Reporting Cluster no respondió a la prueba de arranque")

print("Reporting Cluster listo; continúa la sincronización del mes vigente")
