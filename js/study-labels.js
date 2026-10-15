// Presentation names only. Stored study keys and filter values stay stable.
export function getStudyDisplayName(study) {
  const value = String(study ?? '');
  const labels = {
    chile: 'KO Tradicional CHILE',
    tradicional: 'KO Tradicional CAM',
    moderno: 'KO Moderno CAM'
  };
  return labels[value.trim().toLowerCase()] || value;
}

// Shared with the classic-script charts and PDF renderer.
globalThis.PortalStudyLabels = { getStudyDisplayName };
