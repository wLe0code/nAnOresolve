// Carga útil del arrastre en curso dentro de la app (medios, transiciones, efectos, textos, color).
// Durante `dragover` el navegador no deja leer los datos, así que se guardan aquí.

let payload = null;

/** payload: { kind: 'media' | 'text' | 'transition' | 'audio-transition' | 'effect' | 'audio-effect' | 'color', id } */
export function setDrag(e, data) {
  payload = data;
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('application/x-nano', JSON.stringify(data));
}

export const getDrag = () => payload;

export function clearDrag() {
  payload = null;
}

window.addEventListener('dragend', clearDrag);
