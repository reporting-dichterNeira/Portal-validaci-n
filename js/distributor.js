/**
 * Módulo de gestión de validadores y algoritmos de repartición equitativa
 * Soporta distribución por Número de Auditorías y por Carga de KPIs a Revisar
 */

export class Distributor {
  /**
   * Genera un código único alfanumérico legible para un validador (ej. VAL-7B42K9MX)
   */
  static generateValidatorCode(existingCodes = []) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    let isUnique = false;

    while (!isUnique) {
      let randPart = '';
      for (let i = 0; i < 8; i++) {
        randPart += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      code = `VAL-${randPart}`;
      if (!existingCodes.includes(code)) {
        isUnique = true;
      }
    }
    return code;
  }

  /**
   * Realiza la repartición equitativa simultánea de auditorías entre los validadores activos
   * balanceando al mismo tiempo el número de auditorías y la carga de KPIs con alerta.
   * 
   * @param {Array} audits - Lista de auditorías a repartir
   * @param {Array} validators - Lista de validadores disponibles
   * @returns {Array} audits con su assignedValidatorId actualizado
   */
  static distribute(audits, validators, options = {}) {
    if (!validators || validators.length === 0) {
      throw new Error('Debes agregar al menos un validador disponible para repartir.');
    }

    if (!audits || audits.length === 0) {
      throw new Error('No hay auditorías cargadas para repartir.');
    }

    return this.distributeSimultaneous(audits, validators, options);
  }

  static getPrPhotoCount(audit) {
    const metaCount = Object.entries(audit.meta || {}).find(([header]) => (
      header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') === 'cantidad_de_fotos_pr'
    ))?.[1];
    const raw = String(audit.cantidadFotosPR ?? metaCount ?? '').replace(/\s/g, '');
    const value = Number(raw.replace(/^(\d+),0+$/, '$1'));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  /**
   * Smart Lindley: cuotas de auditorías (diferencia máxima de una) y balance
   * conjunto de las sumas de fotos PR y KPIs. Normaliza ambas cargas por su
   * promedio objetivo para que sus diferentes escalas no dominen el reparto.
   */
  static distributeByPrPhotos(audits, validators) {
    const items = audits.map((audit, originalIndex) => {
      const alertCount = (audit.kpis || []).filter(k => k.needsReview || k.alertaStatus === 'SE ALERTA').length;
      return { audit, originalIndex, weight: Math.max(1, alertCount), photos: this.getPrPhotoCount(audit) };
    });
    const photoTarget = items.reduce((sum, item) => sum + item.photos, 0) / validators.length || 1;
    const kpiTarget = items.reduce((sum, item) => sum + item.weight, 0) / validators.length;
    const loads = validators.map((val, index) => ({
      val, totalAudits: 0, totalKpis: 0, totalPhotos: 0, items: [],
      quota: Math.floor(audits.length / validators.length) + (index < audits.length % validators.length ? 1 : 0)
    }));
    const updated = new Array(audits.length);
    const work = item => item.photos / photoTarget + item.weight / kpiTarget;
    items.sort((a, b) => work(b) - work(a) || b.photos - a.photos || a.originalIndex - b.originalIndex);
    for (const item of items) {
      const cost = load => (
        (2 * load.totalPhotos * item.photos + item.photos ** 2) / photoTarget ** 2
        + (2 * load.totalKpis * item.weight + item.weight ** 2) / kpiTarget ** 2
      );
      const eligible = loads.filter(load => load.totalAudits < load.quota);
      eligible.sort((a, b) => cost(a) - cost(b) || a.totalAudits - b.totalAudits);
      const target = eligible[0];
      target.totalAudits++;
      target.totalKpis += item.weight;
      target.totalPhotos += item.photos;
      target.items.push(item);
    }
    // Intercambios acotados mejoran ambas cargas sin alterar las cuotas de
    // auditorías. Se consideran los extremos de fotos y KPIs por validador
    // para evitar comparar todas las parejas de una base grande.
    const candidates = load => {
      const photos = load.items.slice().sort((a, b) => a.photos - b.photos);
      const kpis = load.items.slice().sort((a, b) => a.weight - b.weight);
      return [...new Set([...photos.slice(0, 8), ...photos.slice(-8), ...kpis.slice(0, 8), ...kpis.slice(-8)])];
    };
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      for (let i = 0; i < loads.length; i++) {
        for (let j = i + 1; j < loads.length; j++) {
          const a = loads[i];
          const b = loads[j];
          let best = null;
          let bestDelta = -1e-9;
          const leftCandidates = candidates(a);
          const rightCandidates = candidates(b);
          for (const left of leftCandidates) {
            for (const right of rightCandidates) {
              const photos = right.photos - left.photos;
              const kpis = right.weight - left.weight;
              const delta = 2 * ((a.totalPhotos - b.totalPhotos) * photos + photos ** 2) / photoTarget ** 2
                + 2 * ((a.totalKpis - b.totalKpis) * kpis + kpis ** 2) / kpiTarget ** 2;
              if (delta < bestDelta) {
                bestDelta = delta;
                best = { left, right, photos, kpis };
              }
            }
          }
          if (best) {
            a.items[a.items.indexOf(best.left)] = best.right;
            b.items[b.items.indexOf(best.right)] = best.left;
            a.totalPhotos += best.photos;
            b.totalPhotos -= best.photos;
            a.totalKpis += best.kpis;
            b.totalKpis -= best.kpis;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    loads.forEach(load => load.items.forEach(item => {
      updated[item.originalIndex] = {
        ...item.audit,
        assignedValidatorId: load.val.id,
        distributionCriterion: 'simultaneous_pr_photos'
      };
    }));
    return updated;
  }

  /**
   * Repartición Simultánea Equitativa (Balanceo dual de Auditorías y Carga de KPIs)
   * Garantiza que todos los validadores reciban la misma cantidad de auditorías (±1)
   * y una carga de trabajo en KPIs con alerta perfectamente balanceada.
   */
  static distributeSimultaneous(audits, validators, options = {}) {
    if (!validators || validators.length === 0 || !audits || audits.length === 0) return audits;
    if (options?.balanceByPrPhotos) return this.distributeByPrPhotos(audits, validators);

    const numValidators = validators.length;
    const maxAuditsPerVal = Math.ceil(audits.length / numValidators);

    // 1. Calcular el peso de KPIs de cada auditoría
    const auditsWithWeights = audits.map((audit, originalIndex) => {
      const alertKpis = (audit.kpis || []).filter(k => k.needsReview || k.alertaStatus === 'SE ALERTA');
      const weight = alertKpis.length > 0 ? alertKpis.length : 1;
      return {
        audit,
        originalIndex,
        weight
      };
    });

    // 2. Ordenar auditorías de mayor a menor carga de KPIs (Longest Processing Time first)
    auditsWithWeights.sort((a, b) => b.weight - a.weight);

    // 3. Estructura de seguimiento de carga para cada validador
    const valLoads = validators.map(v => ({
      val: v,
      totalKpis: 0,
      totalAudits: 0
    }));

    // 4. Asignar vorazmente al validador disponible con menor carga acumulada de KPIs
    const updatedAudits = new Array(audits.length);

    auditsWithWeights.forEach(item => {
      // Filtrar validadores que aún no hayan alcanzado el tope máximo de auditorías
      let eligible = valLoads.filter(v => v.totalAudits < maxAuditsPerVal);
      if (eligible.length === 0) {
        eligible = valLoads;
      }

      // Ordenar por menor KPIs acumulados, y desempate por menor auditorías
      eligible.sort((a, b) => {
        if (a.totalKpis !== b.totalKpis) return a.totalKpis - b.totalKpis;
        return a.totalAudits - b.totalAudits;
      });

      const targetVal = eligible[0];
      targetVal.totalKpis += item.weight;
      targetVal.totalAudits += 1;

      updatedAudits[item.originalIndex] = {
        ...item.audit,
        assignedValidatorId: targetVal.val.id,
        distributionCriterion: 'simultaneous'
      };
    });

    return updatedAudits;
  }

  /**
   * Repartición por número de auditorías (Round-Robin equilibrado)
   */
  static distributeByAudits(audits, validators) {
    return this.distributeSimultaneous(audits, validators);
  }

  /**
   * Repartición balanceada por Carga de Trabajo de KPIs a Revisar
   */
  static distributeByKpis(audits, validators) {
    return this.distributeSimultaneous(audits, validators);
  }

  // Alias para mantener compatibilidad hacia atrás
  static distributeEqually(audits, validators, options = {}) {
    return this.distributeSimultaneous(audits, validators, options);
  }

  /**
   * Calcula estadísticas de carga de auditorías, KPIs y progreso por validador
   */
  static getValidatorStats(audits, validators, options = {}) {
    return (validators || []).map(val => {
      const assigned = (audits || []).filter(a => a.assignedValidatorId === val.id);
      const completed = assigned.filter(a => a.validationStatus === 'completada');
      const inProgress = assigned.filter(a => a.validationStatus === 'en_progreso');
      const pending = assigned.filter(a => !a.validationStatus || a.validationStatus === 'pendiente');

      let assignedKpisCount = 0;
      let completedKpisCount = 0;
      let pendingKpisCount = 0;

      assigned.forEach(a => {
        const alertKpis = (a.kpis || []).filter(k => k.needsReview);
        const count = alertKpis.length > 0 ? alertKpis.length : 1;
        assignedKpisCount += count;

        if (a.validationStatus === 'completada') {
          completedKpisCount += count;
        } else {
          pendingKpisCount += count;
        }
      });

      const percent = assigned.length > 0 ? Math.round((completed.length / assigned.length) * 100) : 0;

      return {
        ...val,
        totalAssigned: assigned.length,
        totalAssignedKpis: assignedKpisCount,
        totalAssignedPrPhotos: options.balanceByPrPhotos
          ? assigned.reduce((sum, audit) => sum + this.getPrPhotoCount(audit), 0)
          : 0,
        completedKpis: completedKpisCount,
        pendingKpis: pendingKpisCount,
        completed: completed.length,
        inProgress: inProgress.length,
        pending: pending.length,
        percentProgress: percent
      };
    });
  }
}
