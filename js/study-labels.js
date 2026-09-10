// Presentation names only. Stored study keys and filter values stay stable.
export function getStudyDisplayName(study) {
  const value = String(study ?? '');
  const labels = {
    tradicional: 'KO Tradicional CAM',
    moderno: 'KO Moderno CAM'
  };
  return labels[value.trim().toLowerCase()] || value;
}
