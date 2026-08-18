/**
 * Módulo de procesamiento y exportación de archivos Excel / CSV
 */

export class ExcelParser {
  /**
   * Parsea un texto CSV considerando delimitadores comunes (;, ,, \t)
   * y maneja correctamente comillas y saltos de línea.
   */
  static parseCSV(text) {
    if (!text || !text.trim()) return [];

    // Limpieza de caracteres BOM si existen
    const cleanText = text.replace(/^\uFEFF/, '').trim();
    
    // Detectar delimitador (punto y coma suele ser estándar en exports en español)
    const firstLine = cleanText.split(/\r?\n/)[0] || '';
    const semicolons = (firstLine.match(/;/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    const tabs = (firstLine.match(/\t/g) || []).length;

    let delimiter = ';';
    if (tabs > semicolons && tabs > commas) delimiter = '\t';
    else if (commas > semicolons) delimiter = ',';

    // Parseo robusto respetando comillas
    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let insideQuotes = false;

    for (let i = 0; i < cleanText.length; i++) {
      const char = cleanText[i];
      const nextChar = cleanText[i + 1];

      if (char === '"') {
        if (insideQuotes && nextChar === '"') {
          currentCell += '"';
          i++; // Salta la comilla escapada
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === delimiter && !insideQuotes) {
        currentRow.push(currentCell.trim());
        currentCell = '';
      } else if ((char === '\r' || char === '\n') && !insideQuotes) {
        if (char === '\r' && nextChar === '\n') {
          i++; // Salta \n en CRLF
        }
        currentRow.push(currentCell.trim());
        if (currentRow.some(cell => cell.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
      } else {
        currentCell += char;
      }
    }

    if (currentCell.length > 0 || currentRow.length > 0) {
      currentRow.push(currentCell.trim());
      if (currentRow.some(cell => cell.length > 0)) {
        rows.push(currentRow);
      }
    }

    return this.transformRowsToObjects(rows);
  }

  /**
   * Extrae estrictamente la fecha (YYYY-MM-DD o DD/MM/YYYY) sin hora, minutos ni milisegundos
   */
  static cleanDateOnly(rawDate) {
    if (!rawDate) return '';
    let str = rawDate.toString().trim();
    if (!str) return '';

    // Si viene formato ISO "2026-08-12T18:41:06..."
    if (str.includes('T')) {
      str = str.split('T')[0];
    }

    // Si viene formato con espacio "2026-08-12 18:41:06,000" o "2026-08-12 18:41:06"
    if (str.includes(' ')) {
      str = str.split(' ')[0].trim();
    }

    // Si viene con coma de milisegundos residual
    if (str.includes(',')) {
      str = str.split(',')[0].trim();
    }

    return str;
  }

  /**
   * Lee un archivo binario de Excel (.xlsx, .xls) usando SheetJS
   */
  static async parseExcelFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          if (typeof XLSX === 'undefined') {
            throw new Error('La librería SheetJS no está cargada.');
          }

          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];

          // Convertir a matriz 2D
          const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
          const parsed = this.transformRowsToObjects(rawRows);
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      };

      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Transforma filas brutas en objetos estructurados con metadata y lista de KPIs a revisar.
   * Soporta automáticamente:
   * 1. Formato Columnar (cada columna es un KPI ej. "Alerta pop", "Alerta precio")
   * 2. Formato por Filas / Alertas Bloqueantes (múltiples filas por auditoría con KPI_SUBKPI, VARIACION_POST, etc.)
   */
  static transformRowsToObjects(rows) {
    if (!rows || rows.length < 2) {
      return { audits: [], columns: [], kpiColumns: [] };
    }

    const headers = rows[0].map(h => (h || '').toString().trim());
    const headersLower = headers.map(h => h.toLowerCase());

    // Detectar si es formato por filas (Alertas Bloqueantes)
    const isRowBasedFormat = headersLower.some(h => 
      h.includes('kpi_subkpi') || h.includes('subkpi') || h.includes('alerta_variacion') || h.includes('id_modelo')
    );

    if (isRowBasedFormat) {
      return this.transformRowBasedAlerts(rows, headers);
    }

    // ----------------------------------------------------
    // FORMATO A: COLUMNAR (Validación Smart regular)
    // ----------------------------------------------------
    const kpiColumns = [];
    const metaColumns = [];

    headers.forEach((header, index) => {
      if (!header) return;
      const lower = header.toLowerCase();
      if (lower.startsWith('alerta ') || lower.startsWith('kpi ') || lower.includes('alerta')) {
        kpiColumns.push({ name: header, index });
      } else {
        metaColumns.push({ name: header, index });
      }
    });

    const audits = [];

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length === 0) continue;

      const firstCell = (row[0] || '').toString().trim();
      const firstCellLower = firstCell.toLowerCase();

      // Filtrar filas de totales o filtros agregados al pie del export
      if (
        !firstCell ||
        firstCellLower.startsWith('total') ||
        firstCellLower.startsWith('filtros') ||
        firstCellLower.startsWith('filtro') ||
        firstCellLower.startsWith('nota')
      ) {
        continue;
      }

      // Si toda la fila está vacía, ignorar
      if (row.every(c => !c || c.toString().trim() === '')) {
        continue;
      }

      // Extraer datos
      const auditObj = {
        _rawIndex: r,
        id: (row[0] || '').toString().trim(),
        idPDV: '',
        estado: '',
        fecha: '',
        fechaValidacion: '',
        canal: '',
        modelo: 'Tradicional',
        pais: '',
        usuario: '',
        validadorPrevio: '',
        ciudad: '',
        meta: {},
        kpis: [], // Lista de KPIs para esta auditoría
        assignedValidatorId: null,
        validationStatus: 'pendiente', // 'pendiente' | 'en_progreso' | 'completada'
        validationResults: {},
        completedAt: null
      };

      // Mapear columnas dinámicamente según headers
      headers.forEach((h, colIndex) => {
        const val = (row[colIndex] || '').toString().trim();
        const hLower = h.toLowerCase();

        if (hLower === 'id_de_audito' || hLower === 'id_audito' || hLower === 'id' || colIndex === 0) {
          auditObj.id = val;
        } else if (hLower === 'id_de_pdv' || hLower === 'id_pdv' || hLower === 'pdv') {
          auditObj.idPDV = val;
        } else if (hLower === 'fecha_del_audito' || hLower === 'fecha_audito' || hLower === 'fecha' || hLower.includes('fecha')) {
          auditObj.fecha = ExcelParser.cleanDateOnly(val);
        } else if (hLower === 'canal') {
          auditObj.canal = val;
        } else if (hLower === 'modelo_name' || hLower === 'modelo') {
          auditObj.modelo = val;
        } else if (hLower === 'pais' || hLower === 'país') {
          auditObj.pais = val;
        } else if (hLower === 'nombre_usuario' || hLower === 'usuario' || hLower === 'auditor') {
          auditObj.usuario = val;
        } else if (hLower === 'validador' || hLower === 'supervisor') {
          auditObj.validadorPrevio = val;
        } else if (hLower === 'ciudad') {
          auditObj.ciudad = val;
        } else if (hLower === 'estado' && !auditObj.estado) {
          auditObj.estado = val;
        }

        auditObj.meta[h] = val;

        const isKpiCol = kpiColumns.some(k => k.index === colIndex);
        if (isKpiCol) {
          const valLower = val.toLowerCase();
          const needsReview = valLower === 'revisar' || valLower === 'pendiente' || valLower === 'alerta';
          auditObj.kpis.push({
            name: h,
            originalValue: val,
            needsReview: needsReview
          });
        }
      });

      if (auditObj.kpis.length === 0) {
        headers.forEach((h, colIndex) => {
          const val = (row[colIndex] || '').toString().trim();
          if (val.toLowerCase() === 'revisar' || val.toLowerCase() === 'ok') {
            auditObj.kpis.push({
              name: h,
              originalValue: val,
              needsReview: val.toLowerCase() === 'revisar'
            });
            if (!kpiColumns.some(k => k.name === h)) {
              kpiColumns.push({ name: h, index: colIndex });
            }
          }
        });
      }

      if (auditObj.id) {
        audits.push(auditObj);
      }
    }

    // Deduplicación estricta por ID de Auditoría dentro del mismo archivo
    const deduplicatedAudits = this.deduplicateById(audits);

    return {
      audits: deduplicatedAudits,
      headers,
      kpiColumns: kpiColumns.map(k => k.name)
    };
  }

  /**
   * Garantiza que en cualquier lista o exportación no existan auditorías duplicadas con el mismo ID
   */
  static deduplicateById(audits) {
    if (!Array.isArray(audits)) return [];
    const map = new Map();
    audits.forEach(a => {
      if (!a || !a.id) return;
      const key = String(a.id).trim();
      if (!map.has(key)) {
        map.set(key, { ...a });
      } else {
        const existing = map.get(key);
        // Si el registro entrante o existente tiene validación completada, preservar el resultado
        const hasExistingProgress = existing.validationStatus === 'completada' || Object.keys(existing.validationResults || {}).length > 0;
        const hasIncomingProgress = a.validationStatus === 'completada' || Object.keys(a.validationResults || {}).length > 0;

        if (hasIncomingProgress && !hasExistingProgress) {
          map.set(key, { ...existing, ...a });
        } else {
          // Fusionar metadatos manteniendo validaciones
          map.set(key, {
            ...a,
            ...existing,
            validationResults: { ...(existing.validationResults || {}), ...(a.validationResults || {}) }
          });
        }
      }
    });
    return Array.from(map.values());
  }

  /**
   * Procesa archivos en formato por filas (Alertas Bloqueantes)
   * Agrupa automáticamente múltiples filas con el mismo ID_AUDITO en una única auditoría
   */
  static transformRowBasedAlerts(rows, headers) {
    const headersLower = headers.map(h => h.toLowerCase());

    const findCol = (...candidates) => {
      for (const cand of candidates) {
        const idx = headersLower.findIndex(h => h === cand || h.includes(cand));
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const idAuditoIdx = findCol('id_audito', 'id_de_audito', 'idaudito', 'id');
    const idPDVIdx = findCol('id_pdv', 'id_de_pdv', 'idpdv', 'pdv');
    const fechaIdx = findCol('fecha_audito', 'fecha_del_audito', 'fecha_ingreso', 'fecha');
    const paisIdx = findCol('pais', 'país', 'id_pais');
    const canalIdx = findCol('canal', 'id_canal');
    const modeloIdx = findCol('modelo_name', 'modelo', 'estudio');
    const kpiIdx = findCol('kpi_subkpi', 'subkpi', 'kpi', 'variable');
    const variableIdx = findCol('variable');
    const valActualIdx = findCol('valor_ola_actual', 'actual');
    const valAnteriorIdx = findCol('valor_ola_anterior', 'anterior');
    const variacionIdx = findCol('variacion_post', 'variacion', 'variación');
    const criterioIdx = findCol('cumple_citerios_validacion_post', 'criterio');
    const alertaIdx = findCol('alerta_variacion_pdv', 'alerta');

    const auditMap = new Map();
    const allKpisSet = new Set();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length === 0) continue;

      const rawId = idAuditoIdx !== -1 ? (row[idAuditoIdx] || '').toString().trim() : (row[0] || '').toString().trim();
      if (!rawId || rawId.toLowerCase().startsWith('total') || rawId.toLowerCase().startsWith('filtro')) {
        continue;
      }

      const idPDV = idPDVIdx !== -1 ? (row[idPDVIdx] || '').toString().trim() : '';
      const rawFecha = fechaIdx !== -1 ? (row[fechaIdx] || '').toString().trim() : '';
      const fecha = ExcelParser.cleanDateOnly(rawFecha);
      const pais = paisIdx !== -1 ? (row[paisIdx] || '').toString().trim() : 'Perú';
      const canal = canalIdx !== -1 ? (row[canalIdx] || '').toString().trim() : 'GROCERY SHOPPING';
      const modelo = modeloIdx !== -1 ? (row[modeloIdx] || '').toString().trim() : 'TRADICIONAL';
      const kpiName = (kpiIdx !== -1 ? (row[kpiIdx] || '').toString().trim() : '') || (variableIdx !== -1 ? (row[variableIdx] || '').toString().trim() : 'Alerta Bloqueante');
      const valActual = valActualIdx !== -1 ? (row[valActualIdx] || '').toString().trim() : '';
      const valAnterior = valAnteriorIdx !== -1 ? (row[valAnteriorIdx] || '').toString().trim() : '';
      const variacion = variacionIdx !== -1 ? (row[variacionIdx] || '').toString().trim() : '';
      const criterio = criterioIdx !== -1 ? (row[criterioIdx] || '').toString().trim() : '';
      const alerta = alertaIdx !== -1 ? (row[alertaIdx] || '').toString().trim() : 'SE ALERTA';

      if (!auditMap.has(rawId)) {
        auditMap.set(rawId, {
          _rawIndex: r,
          id: rawId,
          idPDV: idPDV,
          estado: 'Aprobada',
          fecha: fecha,
          fechaValidacion: '',
          canal: canal,
          modelo: modelo,
          pais: pais,
          usuario: `Auditor (${pais})`,
          validadorPrevio: '',
          ciudad: canal,
          meta: {},
          kpis: [],
          assignedValidatorId: null,
          validationStatus: 'pendiente',
          validationResults: {},
          completedAt: null
        });
      }

      const auditObj = auditMap.get(rawId);

      // Clave descriptiva única para el KPI
      const kpiKey = auditObj.kpis.some(k => k.name === kpiName) 
        ? `${kpiName} (${modelo})` 
        : kpiName;

      allKpisSet.add(kpiKey);

      auditObj.kpis.push({
        name: kpiKey,
        kpiName: kpiName,
        modelo: modelo,
        canal: canal,
        variable: variableIdx !== -1 ? (row[variableIdx] || '').toString().trim() : kpiName,
        actualVal: valActual,
        prevVal: valAnterior,
        variation: variacion,
        criterio: criterio,
        alertaStatus: alerta,
        originalValue: variacion ? `Var: ${variacion}% (${criterio})` : 'Revisar',
        needsReview: true
      });
    }

    const audits = Array.from(auditMap.values());

    return {
      audits,
      headers,
      kpiColumns: Array.from(allKpisSet)
    };
  }

  /**
   * Genera y descarga un archivo Excel (.xlsx) con los resultados consolidados
   */
  static exportResultsToExcel(audits, validators, filename = 'Auditorias_Validadas_Consolidado.xlsx') {
    if (typeof XLSX === 'undefined') {
      alert('La librería SheetJS no está disponible para exportar.');
      return;
    }

    const uniqueAudits = this.deduplicateById(audits);
    const valMap = new Map((validators || []).map(v => [v.id, v]));

    // Hoja 1: Detalle Completo de Auditorías
    const rows = uniqueAudits.map(audit => {
      const validador = valMap.get(audit.assignedValidatorId);
      const kpisParaRevisar = (audit.kpis || []).filter(k => k.needsReview);

      const baseRow = {
        'ID Auditoría': audit.id,
        'ID PDV': audit.idPDV,
        'País': audit.pais,
        'Ciudad': audit.ciudad,
        'Canal': audit.canal,
        'Fecha Auditoría': audit.fecha,
        'Auditor': audit.usuario,
        'Validador Asignado': validador ? validador.name : 'Sin asignar',
        'Código Validador': validador ? validador.code : '',
        'Estado Validación': audit.validationStatus.toUpperCase(),
        'Fecha Finalización': audit.completedAt ? new Date(audit.completedAt).toLocaleString('es-CO') : '',
        'KPIs a Revisar (Total)': kpisParaRevisar.length
      };

      // Agregar columnas de resultados por cada KPI revisable
      kpisParaRevisar.forEach(kpi => {
        const result = audit.validationResults[kpi.name] || {};
        const statusText = result.status === 'aplica' ? 'APLICA' : result.status === 'no_aplica' ? 'NO APLICA' : 'PENDIENTE';
        baseRow[`[${kpi.name}] Resultado`] = statusText;
        baseRow[`[${kpi.name}] Tipificación No Aplica`] = result.tipificacion || '';
        baseRow[`[${kpi.name}] Observaciones`] = result.observaciones || '';
      });

      return baseRow;
    });

    // Hoja 2: Resumen por Validador
    const validatorSummary = (validators || []).map(val => {
      const assigned = audits.filter(a => a.assignedValidatorId === val.id);
      const completed = assigned.filter(a => a.validationStatus === 'completada');
      const pending = assigned.filter(a => a.validationStatus === 'pendiente');
      const inProgress = assigned.filter(a => a.validationStatus === 'en_progreso');

      let kpisTotal = 0;
      let kpisAplica = 0;
      let kpisNoAplica = 0;

      completed.forEach(a => {
        Object.values(a.validationResults || {}).forEach(r => {
          kpisTotal++;
          if (r.status === 'aplica') kpisAplica++;
          if (r.status === 'no_aplica') kpisNoAplica++;
        });
      });

      return {
        'Código': val.code,
        'Nombre': val.name,
        'Email': val.email || '',
        'Total Asignadas': assigned.length,
        'Completadas': completed.length,
        'En Progreso': inProgress.length,
        'Pendientes': pending.length,
        '% Avance': assigned.length > 0 ? `${Math.round((completed.length / assigned.length) * 100)}%` : '0%',
        'KPIs Validados Aplica': kpisAplica,
        'KPIs Validados No Aplica': kpisNoAplica
      };
    });

    const wb = XLSX.utils.book_new();

    const wsAudits = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, wsAudits, 'Auditorias_Validadas');

    const wsSummary = XLSX.utils.json_to_sheet(validatorSummary);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumen_Validadores');

    XLSX.writeFile(wb, filename);
  }

  /**
   * Genera y descarga un archivo Excel Multi-Hoja que contiene:
   * 1. Consolidado General (todas las auditorías)
   * 2. Resumen Día por Día
   * 3. Una hoja individual por cada día trabajado
   */
  static exportDailyAndConsolidatedExcel(audits, validators, filename = 'ValidaFlow_Consolidado_y_Dia_por_Dia.xlsx') {
    if (typeof XLSX === 'undefined') {
      alert('La librería SheetJS no está disponible para exportar.');
      return;
    }

    const uniqueAudits = this.deduplicateById(audits);
    const valMap = new Map((validators || []).map(v => [v.id, v]));
    const wb = XLSX.utils.book_new();

    // Función auxiliar para transformar lista de auditorías a filas de Excel
    const formatAuditRows = (list) => {
      return list.map(audit => {
        const validador = valMap.get(audit.assignedValidatorId);
        const kpisParaRevisar = (audit.kpis || []).filter(k => k.needsReview);

        const row = {
          'ID Auditoría': audit.id,
          'ID PDV': audit.idPDV,
          'País': audit.pais,
          'Ciudad': audit.ciudad,
          'Canal': audit.canal,
          'Fecha Captura': audit.fecha,
          'Auditor': audit.usuario,
          'Validador Asignado': validador ? validador.name : 'Sin asignar',
          'Código Validador': validador ? validador.code : '',
          'Estado Validación': (audit.validationStatus || 'pendiente').toUpperCase(),
          'Tiempo (seg)': audit.durationSeconds || '—',
          'Fecha/Hora Validación': audit.completedAt ? new Date(audit.completedAt).toLocaleString('es-CO') : 'Pendiente',
          'Total KPIs a Revisar': kpisParaRevisar.length
        };

        kpisParaRevisar.forEach(kpi => {
          const result = (audit.validationResults || {})[kpi.name] || {};
          const statusText = result.status === 'aplica' ? 'APLICA' : result.status === 'no_aplica' ? 'NO APLICA' : 'PENDIENTE';
          row[`[${kpi.name}] Resultado`] = statusText;
          row[`[${kpi.name}] Tipificación No Aplica`] = result.tipificacion || '';
          row[`[${kpi.name}] Observaciones`] = result.observaciones || '';
        });

        return row;
      });
    };

    // 1. Hoja 1: Consolidado General
    const allRows = formatAuditRows(uniqueAudits);
    const wsAll = XLSX.utils.json_to_sheet(allRows);
    XLSX.utils.book_append_sheet(wb, wsAll, 'Consolidado_General');

    // 2. Agrupar auditorías validadas por día
    const dailyGroups = {};
    uniqueAudits.forEach(audit => {
      let dateKey = 'Sin_Fecha_Validacion';
      if (audit.completedAt) {
        const d = new Date(audit.completedAt);
        dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      } else if (audit.fecha) {
        dateKey = audit.fecha.replace(/\//g, '-');
      }

      if (!dailyGroups[dateKey]) dailyGroups[dateKey] = [];
      dailyGroups[dateKey].push(audit);
    });

    // 3. Hoja 2: Resumen Diario
    const dailySummary = Object.entries(dailyGroups).map(([dateKey, groupAudits]) => {
      const completed = groupAudits.filter(a => a.validationStatus === 'completada');
      let aplicaCount = 0;
      let noAplicaCount = 0;
      let totalDuration = 0;

      completed.forEach(a => {
        if (a.durationSeconds) totalDuration += a.durationSeconds;
        Object.values(a.validationResults || {}).forEach(r => {
          if (r.status === 'aplica') aplicaCount++;
          if (r.status === 'no_aplica') noAplicaCount++;
        });
      });

      const uniqueValidators = new Set(groupAudits.map(a => a.assignedValidatorId).filter(Boolean));

      return {
        'Fecha': dateKey,
        'Total Auditorías': groupAudits.length,
        'Completadas': completed.length,
        'Pendientes': groupAudits.length - completed.length,
        'Validadores Activos': uniqueValidators.size,
        'KPIs Aplica': aplicaCount,
        'KPIs No Aplica': noAplicaCount,
        'Tiempo Promedio (seg)': completed.length > 0 ? Math.round(totalDuration / completed.length) : '—'
      };
    });

    const wsDailySummary = XLSX.utils.json_to_sheet(dailySummary);
    XLSX.utils.book_append_sheet(wb, wsDailySummary, 'Resumen_Dia_x_Dia');

    // 4. Hojas individuales por cada día
    Object.entries(dailyGroups).forEach(([dateKey, groupAudits]) => {
      const cleanSheetName = `Dia_${dateKey}`.substring(0, 31); // Límite de 31 caracteres de Excel
      const dayRows = formatAuditRows(groupAudits);
      const wsDay = XLSX.utils.json_to_sheet(dayRows);
      XLSX.utils.book_append_sheet(wb, wsDay, cleanSheetName);
    });

    XLSX.writeFile(wb, filename);
  }

  /**
   * Descarga el reporte exclusivo de una fecha específica
   */
  static exportSingleDayExcel(audits, validators, targetDateKey, filename) {
    if (typeof XLSX === 'undefined') {
      alert('La librería SheetJS no está disponible para exportar.');
      return;
    }

    const valMap = new Map((validators || []).map(v => [v.id, v]));
    const dayAudits = audits.filter(audit => {
      // La fecha del reporte es la jornada/base cargada. La fecha en que el
      // validador terminó puede ser posterior y no debe moverla de jornada.
      const operationDate = audit._batchOperationDate || audit.fecha || audit.fechaValidacion;
      if (operationDate) return this.cleanDateOnly(operationDate) === targetDateKey;

      if (audit.completedAt) {
        const d = new Date(audit.completedAt);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return k === targetDateKey;
      }
      return false;
    });

    if (dayAudits.length === 0) {
      alert(`No hay auditorías registradas para el día ${targetDateKey}.`);
      return;
    }

    const wb = XLSX.utils.book_new();

    const rows = dayAudits.map(audit => {
      const validador = valMap.get(audit.assignedValidatorId);
      const kpisParaRevisar = (audit.kpis || []).filter(k => k.needsReview);

      const row = {
        'ID Auditoría': audit.id,
        'ID PDV': audit.idPDV,
        'País': audit.pais,
        'Ciudad': audit.ciudad,
        'Canal': audit.canal,
        'Fecha Captura': audit.fecha,
        'Auditor': audit.usuario,
        'Validador Responsable': validador ? validador.name : 'Sin asignar',
        'Código Validador': validador ? validador.code : '',
        'Estado': (audit.validationStatus || 'pendiente').toUpperCase(),
        'Tiempo (seg)': audit.durationSeconds || '—',
        'Fecha/Hora Validación': audit.completedAt ? new Date(audit.completedAt).toLocaleString('es-CO') : 'Pendiente'
      };

      kpisParaRevisar.forEach(kpi => {
        const result = (audit.validationResults || {})[kpi.name] || {};
        const statusText = result.status === 'aplica' ? 'APLICA' : result.status === 'no_aplica' ? 'NO APLICA' : 'PENDIENTE';
        row[`[${kpi.name}] Resultado`] = statusText;
        row[`[${kpi.name}] Tipificación`] = result.tipificacion || '';
        row[`[${kpi.name}] Observaciones`] = result.observaciones || '';
      });

      return row;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, `Auditorias_${targetDateKey}`.substring(0, 31));

    const finalName = filename || `Reporte_Validacion_${targetDateKey}.xlsx`;
    XLSX.writeFile(wb, finalName);
  }

  /**
   * Genera y descarga un Informe Ejecutivo para Comité y Presentaciones Directivas
   * Incluye:
   * 1. Resumen Ejecutivo de Métricas Globales
   * 2. Ranking / Pareto de KPIs con más Alertas (Aplica vs No Aplica)
   * 3. Incidencia de Alertas por Estudio / Canal / Modelo
   * 4. Causas Raíz de Descarte (Tipificaciones justificadas)
   */
  static exportExecutiveExcel(audits, studyLabel = 'Todos los Estudios', filename = 'Informe_Ejecutivo_Comite_dichter_neira.xlsx') {
    if (typeof XLSX === 'undefined') {
      alert('La librería SheetJS no está disponible para exportar.');
      return;
    }

    const uniqueAudits = this.deduplicateById(audits);
    let totalAudits = uniqueAudits.length;
    let completedAudits = uniqueAudits.filter(a => a.validationStatus === 'completada').length;
    let totalAlerts = 0;
    let totalAplica = 0;
    let totalNoAplica = 0;

    const kpiStats = {};
    const channelStats = {};
    const reasonsMap = {};

    uniqueAudits.forEach(audit => {
      const studyKey = audit.modelo || audit.canal || 'Tradicional';
      if (!channelStats[studyKey]) {
        channelStats[studyKey] = { study: studyKey, audits: 0, alerts: 0, aplica: 0, noAplica: 0 };
      }
      channelStats[studyKey].audits++;

      (audit.kpis || []).filter(k => k.needsReview).forEach(k => {
        totalAlerts++;
        channelStats[studyKey].alerts++;

        const kName = k.kpiName || k.name;
        if (!kpiStats[kName]) {
          kpiStats[kName] = { kpi: kName, totalAlertas: 0, aplica: 0, noAplica: 0, pendientes: 0 };
        }
        kpiStats[kName].totalAlertas++;

        const res = (audit.validationResults || {})[k.name];
        if (res && res.status === 'aplica') {
          totalAplica++;
          kpiStats[kName].aplica++;
          channelStats[studyKey].aplica++;
        } else if (res && res.status === 'no_aplica') {
          totalNoAplica++;
          kpiStats[kName].noAplica++;
          channelStats[studyKey].noAplica++;
          if (res.tipificacion) {
            reasonsMap[res.tipificacion] = (reasonsMap[res.tipificacion] || 0) + 1;
          }
        } else {
          kpiStats[kName].pendientes++;
        }
      });
    });

    const evaluated = totalAplica + totalNoAplica;
    const confirmRate = evaluated > 0 ? `${Math.round((totalAplica / evaluated) * 100)}%` : '0%';
    const discardRate = evaluated > 0 ? `${Math.round((totalNoAplica / evaluated) * 100)}%` : '0%';

    const wb = XLSX.utils.book_new();

    // 1. Hoja Resumen Ejecutivo
    const execSummaryRows = [
      { 'Indicador Ejecutivo': 'Empresa', 'Valor': 'dichter & neira' },
      { 'Indicador Ejecutivo': 'Fecha de Generación', 'Valor': new Date().toLocaleString('es-CO') },
      { 'Indicador Ejecutivo': 'Segmentación / Estudios', 'Valor': studyLabel },
      { 'Indicador Ejecutivo': 'Total Auditorías Auditadas', 'Valor': totalAudits },
      { 'Indicador Ejecutivo': 'Auditorías Completadas', 'Valor': completedAudits },
      { 'Indicador Ejecutivo': 'Total Alertas Generadas', 'Valor': totalAlerts },
      { 'Indicador Ejecutivo': 'Alertas Validadas "Aplica" (Confirmadas)', 'Valor': totalAplica },
      { 'Indicador Ejecutivo': 'Alertas Validadas "No Aplica" (Descartadas)', 'Valor': totalNoAplica },
      { 'Indicador Ejecutivo': 'Tasa de Confirmación (% Efectividad Alertas)', 'Valor': confirmRate },
      { 'Indicador Ejecutivo': 'Tasa de Descarte (% Falsos Positivos / Justificados)', 'Valor': discardRate }
    ];
    const wsSummary = XLSX.utils.json_to_sheet(execSummaryRows);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumen_Comite');

    // 2. Hoja Ranking Pareto de KPIs
    const kpiRankingRows = Object.values(kpiStats)
      .sort((a, b) => b.totalAlertas - a.totalAlertas)
      .map((k, idx) => {
        const evalK = k.aplica + k.noAplica;
        return {
          'Rank': idx + 1,
          'KPI / Variable': k.kpi,
          'Total Alertas': k.totalAlertas,
          '% del Total Alertas': totalAlerts > 0 ? `${((k.totalAlertas / totalAlerts) * 100).toFixed(1)}%` : '0%',
          'Aplica (Confirmado)': k.aplica,
          'No Aplica (Descartado)': k.noAplica,
          '% Confirmación Aplica': evalK > 0 ? `${Math.round((k.aplica / evalK) * 100)}%` : '0%',
          '% Descarte No Aplica': evalK > 0 ? `${Math.round((k.noAplica / evalK) * 100)}%` : '0%'
        };
      });
    const wsKpis = XLSX.utils.json_to_sheet(kpiRankingRows);
    XLSX.utils.book_append_sheet(wb, wsKpis, 'Ranking_Pareto_KPIs');

    // 3. Hoja Incidencia por Estudio / Canal
    const channelRows = Object.values(channelStats).map(c => {
      const evalC = c.aplica + c.noAplica;
      return {
        'Estudio / Canal / Modelo': c.study,
        'Total Auditorías': c.audits,
        'Total Alertas': c.alerts,
        'Aplica': c.aplica,
        'No Aplica': c.noAplica,
        '% Efectividad (Aplica)': evalC > 0 ? `${Math.round((c.aplica / evalC) * 100)}%` : '0%'
      };
    });
    const wsChannels = XLSX.utils.json_to_sheet(channelRows);
    XLSX.utils.book_append_sheet(wb, wsChannels, 'Incidencia_Por_Estudio');

    // 4. Hoja Causas de Descarte
    const reasonRows = Object.entries(reasonsMap)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count], idx) => {
        return {
          'Posición': idx + 1,
          'Causa Raíz / Tipificación': reason,
          'Casos': count,
          '% del Total Descartados': totalNoAplica > 0 ? `${((count / totalNoAplica) * 100).toFixed(1)}%` : '0%'
        };
      });
    const wsReasons = XLSX.utils.json_to_sheet(reasonRows);
    XLSX.utils.book_append_sheet(wb, wsReasons, 'Causas_No_Aplica');

    XLSX.writeFile(wb, filename);
  }
}
