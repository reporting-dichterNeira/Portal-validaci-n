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
  static distribute(audits, validators) {
    if (!validators || validators.length === 0) {
      throw new Error('Debes agregar al menos un validador disponible para repartir.');
    }

    if (!audits || audits.length === 0) {
      throw new Error('No hay auditorías cargadas para repartir.');
    }

    return this.distributeSimultaneous(audits, validators);
  }

  /**
   * Repartición Simultánea Equitativa (Balanceo dual de Auditorías y Carga de KPIs)
   * Garantiza que todos los validadores reciban la misma cantidad de auditorías (±1)
   * y una carga de trabajo en KPIs con alerta perfectamente balanceada.
   */
  static distributeSimultaneous(audits, validators) {
    if (!validators || validators.length === 0 || !audits || audits.length === 0) return audits;

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
  static distributeEqually(audits, validators) {
    return this.distributeSimultaneous(audits, validators);
  }

  /**
   * Calcula estadísticas de carga de auditorías, KPIs y progreso por validador
   */
  static getValidatorStats(audits, validators) {
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
