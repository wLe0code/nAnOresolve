// Componentes de interfaz reutilizables: avisos, menús contextuales, diálogos y controles.

import { h, clamp } from '../core/util.js';
import { icon } from './icons.js';

// ------------------------------------------------------------------ avisos ----

export function toast(message, type = 'info', opts = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h(
    'div',
    { class: `toast ${type}` },
    h('span', { class: 'toast-ico', html: icon(type === 'error' ? 'warning' : type === 'ok' ? 'check' : 'info', 15) }),
    h('span', { class: 'toast-msg' }, message),
    opts.action
      ? h(
          'button',
          {
            class: 'toast-action',
            onclick: () => {
              opts.action.run();
              el.remove();
            },
          },
          opts.action.label
        )
      : null
  );
  host.append(el);
  const ms = opts.duration || (type === 'error' ? 6500 : 3600);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 350);
  while (host.children.length > 4) host.firstChild.remove();
}

// ------------------------------------------------------- menú contextual ----

let openMenu = null;

export function closeContextMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

/** items: [{ label, icon, shortcut, danger, disabled, checked, run } | '-'] */
export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = h('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menu.append(h('div', { class: 'ctx-sep' }));
      continue;
    }
    menu.append(
      h(
        'button',
        {
          class: `ctx-item${it.danger ? ' danger' : ''}`,
          disabled: !!it.disabled,
          onclick: () => {
            closeContextMenu();
            it.run();
          },
        },
        h('span', { class: 'ctx-ico', html: it.checked ? icon('check', 14) : it.icon ? icon(it.icon, 14) : '' }),
        h('span', { class: 'ctx-label' }, it.label),
        it.shortcut ? h('span', { class: 'ctx-key' }, it.shortcut) : null
      )
    );
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
  openMenu = menu;
}

window.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeContextMenu();
}, true);
window.addEventListener('blur', closeContextMenu);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu();
});

// ---------------------------------------------------------------- diálogos ----

/** Abre un diálogo modal. Devuelve { el, close }. */
export function modal({ title, body, buttons = [], width = 460, onClose, dismissable = true }) {
  const root = document.getElementById('modal-root');
  const footer = h('div', { class: 'modal-footer' });
  const box = h(
    'div',
    { class: 'modal', style: { width: `${width}px` }, role: 'dialog' },
    h('div', { class: 'modal-header' }, h('h2', {}, title), dismissable ? h('button', { class: 'icon-btn', title: 'Cerrar', html: icon('x', 16), onclick: () => !api.locked && api.close() }) : null),
    h('div', { class: 'modal-body' }, body),
    footer
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, box);
  const api = {
    el: box,
    footer,
    closed: false,
    locked: false, // true = no se puede cerrar con Esc ni haciendo clic fuera
    close(result) {
      if (api.closed) return;
      api.closed = true;
      backdrop.remove();
      window.removeEventListener('keydown', onKey, true);
      if (onClose) onClose(result);
    },
    setButtons(list) {
      footer.replaceChildren(
        ...list.map((b) =>
          h('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, disabled: !!b.disabled, onclick: () => b.run(api) }, b.icon ? h('span', { html: icon(b.icon, 14) }) : null, b.label)
        )
      );
    },
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) {
      e.stopPropagation();
      if (!api.locked) api.close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop && dismissable && !api.locked) api.close();
  });
  api.setButtons(buttons);
  root.append(backdrop);
  return api;
}

export function confirmDialog(title, message, okLabel = 'Aceptar', opts = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: h('p', { class: 'modal-text' }, message),
      width: 420,
      onClose: (r) => resolve(!!r),
      buttons: [
        { label: opts.cancelLabel || 'Cancelar', run: (m) => m.close(false) },
        { label: okLabel, primary: !opts.danger, danger: !!opts.danger, run: (m) => m.close(true) },
      ],
    });
  });
}

// --------------------------------------------------------------- controles ----

export function iconButton(name, title, onclick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, title, html: icon(name, 16), onclick });
}

/** Sección plegable del inspector. */
export function section(title, children, opts = {}) {
  const body = h('div', { class: 'sec-body' }, children);
  const el = h(
    'section',
    { class: `sec${opts.collapsed ? ' collapsed' : ''}` },
    h(
      'header',
      {
        class: 'sec-head',
        onclick: (e) => {
          if (e.target.closest('.sec-actions')) return;
          el.classList.toggle('collapsed');
          if (opts.onToggle) opts.onToggle(el.classList.contains('collapsed'));
        },
      },
      h('span', { class: 'sec-chevron', html: icon('chevronDown', 13) }),
      opts.icon ? h('span', { class: 'sec-ico', html: icon(opts.icon, 14) }) : null,
      h('span', { class: 'sec-title' }, title),
      opts.badge ? h('span', { class: 'sec-badge' }, opts.badge) : null,
      opts.actions ? h('span', { class: 'sec-actions' }, opts.actions) : null
    ),
    body
  );
  return el;
}

/**
 * Fila con deslizador y campo numérico.
 * opts: { label, min, max, step, get, set, def, format, parse, kf, hint }
 * kf: { state() -> 'none' | 'has' | 'on', toggle(), prev(), next() }
 */
export function sliderRow(opts) {
  const fmt = opts.format || ((v) => String(Math.round(v * 100) / 100));
  const parse = opts.parse || ((s) => parseFloat(String(s).replace(',', '.')));
  const range = h('input', { type: 'range', class: 'slider', min: opts.min, max: opts.max, step: opts.step ?? 0.01 });
  const num = h('input', { type: 'text', class: 'num', spellcheck: false });
  let dragging = false;

  const paint = (v) => {
    const pct = ((clamp(v, opts.min, opts.max) - opts.min) / (opts.max - opts.min)) * 100;
    range.style.setProperty('--fill', `${pct}%`);
  };
  const apply = (v, final) => {
    if (!Number.isFinite(v)) return;
    const hardMin = opts.hardMin ?? opts.min;
    const hardMax = opts.hardMax ?? opts.max;
    opts.set(clamp(v, hardMin, hardMax), final);
  };

  range.addEventListener('pointerdown', () => {
    dragging = true;
  });
  range.addEventListener('input', () => {
    const v = parseFloat(range.value);
    apply(v, false);
    num.value = fmt(v);
    paint(v);
  });
  range.addEventListener('change', () => {
    dragging = false;
    apply(parseFloat(range.value), true);
  });
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') num.blur();
    if (e.key === 'Escape') {
      num.value = fmt(opts.get());
      num.blur();
    }
    e.stopPropagation();
  });
  num.addEventListener('change', () => {
    apply(parse(num.value), true);
    api.sync(true);
  });
  num.addEventListener('focus', () => num.select());

  let kfBtn = null;
  let kfNav = null;
  if (opts.kf) {
    kfBtn = h('button', { class: 'kf-btn', title: 'Añadir o quitar keyframe en el cursor', onclick: () => opts.kf.toggle() });
    kfNav = h(
      'span',
      { class: 'kf-nav' },
      h('button', { class: 'kf-arrow', title: 'Keyframe anterior', html: icon('chevronLeft', 11), onclick: () => opts.kf.prev() }),
      kfBtn,
      h('button', { class: 'kf-arrow', title: 'Keyframe siguiente', html: icon('chevronRight', 11), onclick: () => opts.kf.next() })
    );
  }

  const label = h('span', { class: 'row-label', title: opts.hint || (opts.def !== undefined ? 'Doble clic para restablecer' : '') }, opts.label);
  if (opts.def !== undefined) label.addEventListener('dblclick', () => apply(opts.def, true));

  const el = h('div', { class: 'row slider-row' }, label, kfNav, range, num);
  const api = {
    el,
    sync(force) {
      const v = opts.get();
      if (!dragging || force) {
        range.value = clamp(v, opts.min, opts.max);
        paint(v);
      }
      if (document.activeElement !== num || force) num.value = fmt(v);
      if (kfBtn) {
        const st = opts.kf.state();
        kfBtn.innerHTML = icon(st === 'on' ? 'diamondFill' : 'diamond', 12);
        kfBtn.className = `kf-btn ${st}`;
        kfNav.classList.toggle('active', st !== 'none');
      }
    },
  };
  api.sync(true);
  return api;
}

export function selectRow({ label, options, get, set }) {
  const sel = h(
    'select',
    { class: 'select', onchange: () => set(sel.value) },
    options.map((o) => h('option', { value: o.id ?? o.value, title: o.hint || '' }, o.name ?? o.label))
  );
  const el = h('div', { class: 'row' }, h('span', { class: 'row-label' }, label), sel);
  const api = {
    el,
    sync() {
      if (document.activeElement !== sel) sel.value = get();
    },
  };
  api.sync();
  return api;
}

export function colorRow({ label, get, set }) {
  const input = h('input', { type: 'color', class: 'color' });
  const hex = h('input', { type: 'text', class: 'num hex', spellcheck: false, maxLength: 7 });
  input.addEventListener('input', () => {
    set(input.value, false);
    hex.value = input.value.toUpperCase();
  });
  input.addEventListener('change', () => set(input.value, true));
  hex.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') hex.blur();
    e.stopPropagation();
  });
  hex.addEventListener('change', () => {
    const v = hex.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) set(v.startsWith('#') ? v : `#${v}`, true);
    api.sync();
  });
  const el = h('div', { class: 'row' }, h('span', { class: 'row-label' }, label), h('span', { class: 'color-wrap' }, input, hex));
  const api = {
    el,
    sync() {
      const v = get() || '#000000';
      input.value = v;
      if (document.activeElement !== hex) hex.value = v.toUpperCase();
    },
  };
  api.sync();
  return api;
}

export function toggleRow({ label, get, set, hint }) {
  const btn = h('button', { class: 'switch', role: 'switch', onclick: () => set(!get()) }, h('span', { class: 'knob' }));
  const el = h('div', { class: 'row', title: hint || '' }, h('span', { class: 'row-label' }, label), btn);
  const api = {
    el,
    sync() {
      btn.classList.toggle('on', !!get());
    },
  };
  api.sync();
  return api;
}

/** Botones excluyentes. options: [{ id, name, icon, hint }] */
export function segmented({ label, options, get, set }) {
  const buttons = options.map((o) =>
    h('button', { class: 'seg-btn', title: o.hint || o.name, onclick: () => set(o.id) }, o.icon ? h('span', { html: icon(o.icon, 14) }) : null, o.short ?? o.name)
  );
  const group = h('div', { class: 'segmented' }, buttons);
  const el = label ? h('div', { class: 'row' }, h('span', { class: 'row-label' }, label), group) : group;
  const api = {
    el,
    sync() {
      const v = get();
      buttons.forEach((b, i) => b.classList.toggle('on', options[i].id === v));
    },
  };
  api.sync();
  return api;
}

export function textAreaRow({ get, set, placeholder }) {
  const ta = h('textarea', { class: 'textarea', rows: 3, placeholder: placeholder || '', spellcheck: false });
  ta.addEventListener('input', () => set(ta.value));
  ta.addEventListener('keydown', (e) => e.stopPropagation());
  const api = {
    el: h('div', { class: 'row block' }, ta),
    input: ta,
    sync() {
      if (document.activeElement !== ta) ta.value = get();
    },
  };
  api.sync();
  return api;
}

export function button(label, onclick, opts = {}) {
  return h('button', { class: `btn${opts.primary ? ' primary' : ''}${opts.small ? ' small' : ''}${opts.danger ? ' danger' : ''}${opts.block ? ' block' : ''}`, title: opts.title || '', onclick }, opts.icon ? h('span', { html: icon(opts.icon, 14) }) : null, label);
}
