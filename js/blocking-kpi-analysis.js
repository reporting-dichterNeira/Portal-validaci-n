// Las notas pertenecen al export original de Bloqueantes (olas anterior y actual).
export function parseBlockingScore(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim().replace(/\s|%/g, '').replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function buildBlockingKpiRows(audits, describeAudit) {
  return audits.flatMap(audit => (audit.kpis || []).filter(kpi => (
    kpi.needsReview || kpi.alertaStatus === 'SE ALERTA'
  )).map(kpi => {
    // La decisión se guarda con el nombre único del KPI, incluido su modelo.
    const result = audit.validationResults?.[kpi.name] || {};
    const previous = parseBlockingScore(kpi.prevVal);
    const current = parseBlockingScore(kpi.actualVal);
    return {
      ...describeAudit(audit),
      auditId: String(audit.id), pdvId: String(audit.idPDV || ''),
      kpi: kpi.kpiName || kpi.name, model: kpi.modelo || audit.modelo || '',
      decision: ['aplica', 'no_aplica'].includes(result.status) ? result.status : 'pendiente',
      previous, current,
      difference: previous !== null && current !== null ? Number((current - previous).toFixed(8)) : null,
      variation: parseBlockingScore(kpi.variation),
      criterion: kpi.criterio || '', reason: result.tipificacion || '',
      observations: result.observaciones || ''
    };
  }));
}

export function filterBlockingKpiRows(rows, filters = {}) {
  const search = String(filters.search || '').trim().toLowerCase();
  const min = parseBlockingScore(filters.minDifference);
  const max = parseBlockingScore(filters.maxDifference);
  return rows.filter(row => (
    (!filters.kpi || filters.kpi === 'all' || row.kpi === filters.kpi)
    && (!filters.decision || filters.decision === 'all' || row.decision === filters.decision)
    && (!search || [row.auditId, row.pdvId].some(value => value.toLowerCase().includes(search)))
    && (min === null || (row.difference !== null && row.difference >= min))
    && (max === null || (row.difference !== null && row.difference <= max))
  ));
}

export function summarizeBlockingKpiRows(rows) {
  return ['aplica', 'no_aplica', 'pendiente'].map(decision => {
    const selected = rows.filter(row => row.decision === decision);
    const scored = selected.filter(row => row.difference !== null);
    return {
      decision, count: selected.length, scoredCount: scored.length,
      averageDifference: scored.length ? scored.reduce((sum, row) => sum + row.difference, 0) / scored.length : null
    };
  });
}

export function blockingKpiRowsToCsv(rows) {
  const columns = [
    ['ID Auditoría', 'auditId'], ['ID PDV', 'pdvId'], ['Estudio', 'study'], ['País', 'country'],
    ['Jornada', 'date'], ['KPI', 'kpi'], ['Modelo', 'model'], ['Decisión', 'decision'],
    ['Nota anterior (export)', 'previous'], ['Nota actual (export)', 'current'],
    ['Diferencia (puntos)', 'difference'], ['Variación del export (%)', 'variation'],
    ['Criterio del export', 'criterion'], ['Tipificación', 'reason'], ['Observaciones', 'observations']
  ];
  const escape = value => {
    let text = String(value ?? '');
    if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const labels = { aplica: 'Aplica', no_aplica: 'No aplica', pendiente: 'Pendiente' };
  return '\uFEFF' + [columns.map(([label]) => escape(label)).join(';'), ...rows.map(row => (
    columns.map(([, key]) => escape(key === 'decision' ? labels[row.decision] : row[key])).join(';')
  ))].join('\r\n');
}
