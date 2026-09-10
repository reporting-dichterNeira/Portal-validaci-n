// Browser export. Keep this separate from data loading and load the PPT engine
// only after a download request. All values come from the current report snapshot.
let enginePromise;
export function loadPowerPointEngine() {
  if (typeof window.PptxGenJS === 'function') return Promise.resolve(window.PptxGenJS);
  if (enginePromise) return enginePromise;
  enginePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js';
    script.async = true;
    const timer = setTimeout(() => fail(), 25000);
    const fail = () => {
      clearTimeout(timer); script.remove(); enginePromise = null;
      reject(new Error('No se pudo cargar PowerPoint. Revisa la conexión e intenta de nuevo.'));
    };
    script.onerror = fail;
    script.onload = () => {
      if (typeof window.PptxGenJS !== 'function') { fail(); return; }
      clearTimeout(timer); resolve(window.PptxGenJS);
    };
    document.head.appendChild(script);
  });
  return enginePromise;
}

export function buildExecutivePowerPoint(PptxGenJS, data) {
  const ppt = new PptxGenJS();
  ppt.layout = 'LAYOUT_WIDE';
  ppt.author = 'dichter & neira';
  ppt.subject = 'Indicadores comerciales de ValidaFlow';
  ppt.title = 'Calidad y resultado de las alertas';
  ppt.company = 'dichter & neira';
  ppt.lang = 'es-CO';
  ppt.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial', lang: 'es-CO' };
  const navy = '002B49', muted = '526078', green = '009E60', blue = '005691', pink = 'E6286B';
  const slides = [];
  const text = (slide, value, x, y, w, h, options = {}) => slide.addText(String(value ?? '—'), {
    x, y, w, h, fontFace: 'Arial', fontSize: 18, color: navy,
    margin: 0, breakLine: false, valign: 'middle', ...options
  });
  const makeSlide = (title, subtitle = '') => {
    const slide = ppt.addSlide(); slides.push(slide);
    slide.background = { color: 'FFFFFF' };
    text(slide, 'dichter & neira', .6, .25, 8, .35, { fontSize: 16, bold: true });
    text(slide, title, .6, .85, 12.1, .6, { fontSize: 30, bold: true });
    if (subtitle) text(slide, subtitle, .6, 1.52, 12.1, .55, { fontSize: 15, color: muted });
    slide.addNotes(`Fuente: informe comercial de ValidaFlow. Estudios: ${data.scope}. Módulo: ${data.module}. Fecha de emisión: ${data.date}. Los datos respetan la selección al iniciar la descarga.`);
    return slide;
  };
  const tableSlides = (title, headers, rows, widths, subtitle = '') => {
    const available = rows.length ? rows : [headers.map((_, i) => i ? '—' : 'Sin registros para los filtros seleccionados')];
    const rowHeight = row => Math.max(.78, ...headers.map((_, col) => {
      const charsPerLine = Math.max(1, Math.floor((widths[col] - .25) * 72 / (17 * .6)));
      return String(row[col] ?? '—').split('\n').reduce((lines, part) => lines + Math.max(1, Math.ceil(part.length / charsPerLine)), 0) * .28 + .25;
    }));
    for (let offset = 0; offset < available.length;) {
      const slide = makeSlide(title + (offset ? ' (continuación)' : ''), subtitle);
      const pageRows = [], heights = [rowHeight(headers)];
      let height = heights[0];
      while (offset < available.length && pageRows.length < 4) {
        const nextHeight = rowHeight(available[offset]);
        if (pageRows.length && height + nextHeight > 4.5) break;
        pageRows.push(available[offset++]); heights.push(nextHeight); height += nextHeight;
      }
      slide.addTable([
        headers.map(value => ({ text: String(value), options: { bold: true, fill: navy, color: 'FFFFFF' } })),
        ...pageRows.map(row => headers.map((_, col) => ({ text: String(row[col] ?? '—'),
          options: { fill: 'F4F7FA', color: col ? blue : navy, bold: col > 0 } })))
      ], { x: .6, y: 2.2, w: 12.1, colW: widths, rowH: heights, fontFace: 'Arial', fontSize: 17,
        margin: 9, border: { type: 'solid', pt: 1, color: 'D4DEE8' }, valign: 'middle',
        autoPage: false });
    }
  };

  const summary = makeSlide('Calidad y resultado de las alertas', `Estudios: ${data.scope}`);
  const metrics = [
    ['Auditorías evaluadas', data.audits, navy],
    ['Falsos positivos filtrados', data.discarded, pink],
    ['Precisión de alertas', data.precision, blue],
    ['Tiempo promedio por auditoría', data.averageTime, navy],
    ['Universo de KPIs medibles', data.universe, green]
  ];
  metrics.forEach(([label, value, color], i) => {
    const x = .6 + (i % 3) * 4.15, y = 2.25 + Math.floor(i / 3) * 1.55;
    text(summary, value, x, y, 3.75, .7, { fontSize: 40, bold: true, color });
    text(summary, label, x, y + .75, 3.75, .6, { fontSize: 18 });
  });
  text(summary, 'Los falsos positivos son alertas que no aplicaban y no requieren edición.\nPrecisión = Aplica ÷ (Aplica + No aplica) × 100.', .6, 5.8, 12.1, .75, { fontSize: 15, color: muted });

  tableSlides('Universo y decisiones de validación', ['Resultado', 'Cantidad', '% del universo'], data.universeRows, [6.2, 2.7, 3.2],
    `Universo total: ${data.universe} KPIs. Incluye los casos pendientes de decisión.`);
  tableSlides('Volumen por estudio', ['Estudio', 'Auditorías', 'Alertas', 'Aplica', 'No aplica'],
    data.benchmark.map(row => row.slice(0, 5)), [4.1, 2, 2, 2, 2]);
  tableSlides('Tasas por estudio', ['Estudio', 'Confirmación', 'Efectividad en PDV'],
    data.benchmark.map(row => [row[0], row[5], row[6]]), [5.1, 3.5, 3.5],
    'Tasas calculadas por la vista comercial para los estudios seleccionados.');
  tableSlides('KPIs con más alertas', ['Posición', 'KPI', 'Alertas', 'Confirmación'], data.topKpis,
    [1.25, 6.65, 1.7, 2.5], 'Ranking por volumen total de alertas.');
  tableSlides('Motivos de descarte', ['Tipología de No aplica', 'Casos', '% de descartes'], data.reasons,
    [7.1, 2, 3], 'Alertas que no aplicaban y no requieren edición.');
  // Every continuation keeps the heading, column labels and module/date footer.
  slides.forEach((slide, i) => {
    text(slide, `${data.module} · ${data.date}`, .6, 7.02, 10.8, .22, { fontSize: 11, color: muted });
    text(slide, `${i + 1} / ${slides.length}`, 11.6, 7.02, 1.1, .22, { fontSize: 11, color: muted, align: 'right' });
  });
  return ppt;
}
