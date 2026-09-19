/**
 * SchedulePicker — inline Calendly-style start/end picker for StreamFlow.
 * Renders two cards (Start Time / End Time), each with its own calendar
 * and vertical time-slot list directly in the form. Past dates and past
 * time slots are disabled, and the end must come after the start. End
 * time is optional — leaving it empty means the stream runs nonstop —
 * and End Time offers 1–12 hour duration presets that auto-fill the end
 * date & time. State syncs to hidden datetime-local inputs so all
 * existing submit/prefill logic keeps working untouched.
 */
class SchedulePicker {
  static MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  static DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  static PRESET_HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  constructor({ mountId, startInputId, endInputId, toggleId, summaryId }) {
    this.mount = document.getElementById(mountId);
    this.startInput = document.getElementById(startInputId);
    this.endInput = document.getElementById(endInputId);
    this.toggleEl = toggleId ? document.getElementById(toggleId) : null;
    this.summary = summaryId ? document.getElementById(summaryId) : null;
    if (!this.mount || !this.startInput || !this.endInput) return;

    this.start = null;
    this.end = null;

    const now = new Date();
    this.view = {
      start: { y: now.getFullYear(), m: now.getMonth() },
      end: { y: now.getFullYear(), m: now.getMonth() }
    };
    this.slot = { start: null, end: null };   // dates whose slots are shown

    this.build();
    if (this.toggleEl) {
      this.toggleEl.addEventListener('change', () => this.renderSummary());
    }
    this.syncFromInputs();
  }

  /* ---------- state <-> inputs ---------- */

  syncFromInputs() {
    this.start = this.startInput.value ? this.parseLocal(this.startInput.value) : null;
    this.end = this.endInput.value ? this.parseLocal(this.endInput.value) : null;

    const anchor = this.start || new Date();
    this.view.start = this.start
      ? { y: this.start.getFullYear(), m: this.start.getMonth() }
      : { y: anchor.getFullYear(), m: anchor.getMonth() };
    this.view.end = this.end
      ? { y: this.end.getFullYear(), m: this.end.getMonth() }
      : { y: anchor.getFullYear(), m: anchor.getMonth() };
    this.slot.start = this.start ? this.dayOf(this.start) : null;
    this.slot.end = this.end ? this.dayOf(this.end) : null;

    this.renderAll();
    // prefill (edit modal): show the chosen slot instead of the list top
    if (this.start) this.scrollSlotsIntoView('start');
    if (this.end) this.scrollSlotsIntoView('end');
  }

  parseLocal(v) {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  }

  toLocalInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  commit() {
    this.startInput.value = this.start ? this.toLocalInput(this.start) : '';
    this.endInput.value = this.end ? this.toLocalInput(this.end) : '';
    for (const input of [this.startInput, this.endInput]) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.renderAll();
  }

  /* ---------- markup ---------- */

  cardHTML(which) {
    return `
      <div data-card="${which}" class="bg-dark-700 border border-gray-600 rounded-xl overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-gray-700">
          <i class="ti ti-calendar-event text-gray-400"></i>
          <span data-label class="text-sm text-gray-500 truncate">Pick a date &amp; time below</span>
          <span class="flex-1"></span>
          <button type="button" data-clear title="Clear"
            class="hidden p-1 rounded-full text-gray-500 hover:text-red-400 hover:bg-dark-600 transition-colors">
            <i class="ti ti-x"></i>
          </button>
        </div>
        <div data-calendar class="p-4"></div>
        <div data-slots class="px-4 pb-4 pt-3 border-t border-gray-700"></div>
      </div>
    `;
  }

  build() {
    this.root = document.createElement('div');
    this.root.className = 'sf-schedule-picker';
    this.root.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <div class="mb-2">
            <label class="text-sm font-medium text-white">Start Time</label>
          </div>
          ${this.cardHTML('start')}
        </div>
        <div>
          <div class="mb-2">
            <label class="text-sm font-medium text-white">End Time</label>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 mb-2">
            ${SchedulePicker.PRESET_HOURS.map(h =>
              `<button type="button" data-preset="${h}"
                class="sp-preset px-3 py-1 rounded-full border border-gray-600 text-xs text-gray-300 hover:border-gray-400 hover:text-white transition-colors">${h}h</button>`
            ).join('')}
          </div>
          ${this.cardHTML('end')}
        </div>
      </div>
    `;
    this.mount.appendChild(this.root);

    this.cards = {};
    for (const which of ['start', 'end']) {
      const card = this.root.querySelector(`[data-card="${which}"]`);
      this.cards[which] = {
        el: card,
        label: card.querySelector('[data-label]'),
        clear: card.querySelector('[data-clear]'),
        calendar: card.querySelector('[data-calendar]'),
        slots: card.querySelector('[data-slots]')
      };
      this.cards[which].clear.addEventListener('click', () => this.clear(which));
    }

    this.root.querySelectorAll('[data-preset]').forEach(btn =>
      btn.addEventListener('click', () => this.applyPreset(+btn.dataset.preset)));
  }

  /* ---------- constraints ---------- */

  dayOf(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // earliest day selectable on a card: today for start; start day for end
  minDay(which) {
    const today = this.dayOf(new Date());
    if (which === 'end' && this.start) {
      const startDay = this.dayOf(this.start);
      return startDay > today ? startDay : today;
    }
    return today;
  }

  slotDisabled(which, mins) {
    const day = this.slot[which];
    if (!day) return false;
    const dt = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
      Math.floor(mins / 60), mins % 60, 0, 0);
    if (which === 'start') return dt <= new Date();
    if (this.start) return dt <= this.start;
    return dt <= new Date();
  }

  /* ---------- calendar ---------- */

  renderCalendar(which) {
    const { calendar } = this.cards[which];
    const y = this.view[which].y, m = this.view[which].m;
    const monthDays = new Date(y, m + 1, 0).getDate();
    const firstDow = new Date(y, m, 1).getDay();
    const minDay = this.minDay(which);

    let dayCells = '';
    for (let i = 0; i < firstDow; i++) dayCells += '<div></div>';
    for (let d = 1; d <= monthDays; d++) {
      const cellDate = new Date(y, m, d);
      const disabled = cellDate < minDay;
      const isSelected = this.slot[which] && cellDate.getTime() === this.slot[which].getTime();
      const isChosen = (which === 'start' ? this.start : this.end) &&
        cellDate.getTime() === this.dayOf(which === 'start' ? this.start : this.end).getTime();
      const cls = [
        'sp-day h-9 w-9 rounded-lg text-sm flex items-center justify-center transition-colors',
        isSelected ? 'bg-white text-gray-900 font-semibold' : '',
        !isSelected && isChosen ? 'ring-1 ring-primary text-primary' : '',
        !isSelected && !isChosen ? (disabled ? 'text-gray-600' : 'text-gray-300 hover:bg-dark-600') : '',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer'
      ].filter(Boolean).join(' ');
      dayCells += `<button type="button" data-day="${d}" ${disabled ? 'disabled' : ''} class="${cls}">${d}</button>`;
    }

    const today = new Date();
    calendar.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <button type="button" data-nav="-1" class="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-dark-600"><i class="ti ti-chevron-left"></i></button>
        <div class="flex items-center gap-1">
          <select data-month class="bg-dark-800 border border-gray-600 rounded-lg text-sm text-white px-2 py-1 focus:border-primary outline-none">
            ${SchedulePicker.MONTHS.map((name, i) => `<option value="${i}" ${i === m ? 'selected' : ''}>${name}</option>`).join('')}
          </select>
          <select data-year class="bg-dark-800 border border-gray-600 rounded-lg text-sm text-white px-2 py-1 focus:border-primary outline-none">
            ${Array.from({ length: 4 }, (_, i) => today.getFullYear() + i).map(yy =>
              `<option value="${yy}" ${yy === y ? 'selected' : ''}>${yy}</option>`).join('')}
          </select>
        </div>
        <button type="button" data-nav="1" class="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-dark-600"><i class="ti ti-chevron-right"></i></button>
      </div>
      <div class="grid grid-cols-7 mb-1">
        ${SchedulePicker.DOW.map(d => `<div class="text-center text-[11px] text-gray-500 py-1">${d[0]}</div>`).join('')}
      </div>
      <div class="grid grid-cols-7 gap-y-0.5 place-items-center">
        ${dayCells}
      </div>
    `;

    calendar.querySelectorAll('[data-nav]').forEach(btn =>
      btn.addEventListener('click', () => {
        this.view[which].m += +btn.dataset.nav;
        if (this.view[which].m < 0) { this.view[which].m = 11; this.view[which].y--; }
        if (this.view[which].m > 11) { this.view[which].m = 0; this.view[which].y++; }
        this.renderCalendar(which);
      }));
    calendar.querySelector('[data-month]').addEventListener('change', (e) => {
      this.view[which].m = +e.target.value;
      this.renderCalendar(which);
    });
    calendar.querySelector('[data-year]').addEventListener('change', (e) => {
      this.view[which].y = +e.target.value;
      this.renderCalendar(which);
    });
    calendar.querySelectorAll('[data-day]:not([disabled])').forEach(btn =>
      btn.addEventListener('click', () => {
        this.slot[which] = new Date(this.view[which].y, this.view[which].m, +btn.dataset.day);
        this.renderCalendar(which);
        this.renderSlots(which);
        this.renderLabel(which);
        this.renderSummary();
        this.scrollSlotsIntoView(which);
      }));
  }

  /* ---------- slots ---------- */

  renderSlots(which) {
    const { slots } = this.cards[which];
    const day = this.slot[which];
    if (!day) {
      slots.innerHTML = `
        <div class="flex flex-col items-center justify-center text-gray-500 text-sm py-6 gap-2">
          <i class="ti ti-calendar text-2xl"></i>
          <span>Select a date to pick a time</span>
        </div>
      `;
      return;
    }

    // two vertical columns, each flowing downward: morning left, evening right
    const morning = [];
    const evening = [];
    for (let mins = 0; mins < 24 * 60; mins += 30) {
      (mins < 720 ? morning : evening).push(mins);
    }
    const value = which === 'start' ? this.start : this.end;
    const slotBtn = (mins) => {
      const selected = this.matchesSlot(which, mins);
      const disabled = this.slotDisabled(which, mins);
      const cls = selected
        ? 'bg-white text-gray-900 font-semibold'
        : disabled
          ? 'text-gray-600 cursor-not-allowed'
          : 'text-gray-300 hover:bg-dark-600';
      return `<button type="button" data-slot="${mins}" ${disabled ? 'disabled' : ''}
        class="w-full px-2 py-1.5 rounded-lg text-xs transition-colors ${cls}">
        ${this.fmtSlot(mins)}
      </button>`;
    };

    slots.innerHTML = `
      <div class="text-sm font-medium text-white mb-2">
        ${SchedulePicker.DOW[day.getDay()]}, ${day.getDate()} ${SchedulePicker.MONTHS[day.getMonth()].slice(0, 3)}
      </div>
      <div data-slot-scroll class="flex gap-1 max-h-72 overflow-y-auto pr-1">
        <div class="flex-1 flex flex-col gap-1">${morning.map(slotBtn).join('')}</div>
        <div class="flex-1 flex flex-col gap-1">${evening.map(slotBtn).join('')}</div>
      </div>
    `;

    slots.querySelectorAll('[data-slot]:not([disabled])').forEach(btn =>
      btn.addEventListener('click', () => this.applySlot(which, +btn.dataset.slot)));
  }

  // bring the chosen slot (or the first pickable one) into view — e.g. on
  // today, where everything before now is disabled and the list starts at 00:00
  scrollSlotsIntoView(which) {
    const container = this.cards[which].slots.querySelector('[data-slot-scroll]');
    if (!container) return;
    const value = which === 'start' ? this.start : this.end;
    const day = this.slot[which];
    let target = null;
    if (value && day && value.toDateString() === day.toDateString()) {
      target = container.querySelector(`[data-slot="${value.getHours() * 60 + value.getMinutes()}"]`);
    }
    if (!target || target.disabled) {
      target = container.querySelector('[data-slot]:not([disabled])');
    }
    if (!target) return;
    const cr = container.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    container.scrollTop += tr.top - cr.top - 4;
  }

  /* ---------- selection ---------- */

  setEnd(d) {
    this.end = d;
    this.view.end = { y: d.getFullYear(), m: d.getMonth() };
    this.slot.end = this.dayOf(d);
  }

  applySlot(which, mins) {
    const day = this.slot[which];
    if (!day) return;
    const dt = new Date(day);
    dt.setHours(Math.floor(mins / 60), mins % 60, 0, 0);

    if (which === 'start') {
      this.start = dt;
      // end stays untouched unless the new start invalidates it
      if (this.end && this.end <= this.start) {
        this.end = null;
      }
      if (!this.end) {
        // keep the end calendar on the start's month for easy navigation,
        // but do not pre-select the date — the user picks it themselves
        this.view.end = { y: dt.getFullYear(), m: dt.getMonth() };
      }
    } else {
      this.end = dt;
      if (this.start && this.end <= this.start) {
        this.end.setDate(this.end.getDate() + 1);
      }
    }
    this.commit();
  }

  applyPreset(hours) {
    if (!this.start) return;
    this.setEnd(new Date(this.start.getTime() + hours * 3600000));
    this.commit();
    this.scrollSlotsIntoView('end');
  }

  clear(which) {
    if (which === 'start') {
      this.start = null;
      this.end = null;
      this.slot.start = null;
      this.slot.end = null;
    } else {
      this.end = null;
      this.slot.end = this.start ? this.dayOf(this.start) : null;
    }
    this.commit();
  }

  /* ---------- render ---------- */

  fmtDay(d) {
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return `${SchedulePicker.DOW[d.getDay()]}, ${d.getDate()} ${SchedulePicker.MONTHS[d.getMonth()].slice(0, 3)}${sameYear ? '' : ' ' + d.getFullYear()}`;
  }

  fmtSummary(d) {
    return `${this.fmtDay(d)} · ${this.fmtSlot(d.getHours() * 60 + d.getMinutes())}`;
  }

  fmtDuration(ms) {
    const mins = Math.round(ms / 60000);
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    const parts = [];
    if (d) parts.push(`${d} day${d > 1 ? 's' : ''}`);
    if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
    if (m) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
    return parts.join(' ') || '0 minutes';
  }

  // compact recap under the Enable Schedule toggle: start / end / duration
  renderSummary() {
    if (!this.summary) return;
    this.summary.classList.toggle('hidden', !(this.toggleEl && this.toggleEl.checked));

    const endPending = this.start && !this.end && this.slot.end;
    const startTxt = this.start ? this.fmtSummary(this.start) : '—';
    const endTxt = !this.start ? '—'
      : (this.end ? this.fmtSummary(this.end)
        : (endPending ? `${this.fmtDay(this.slot.end)} — pick a time` : 'Nonstop'));
    const durTxt = !this.start ? '—'
      : (this.end ? this.fmtDuration(this.end - this.start)
        : (endPending ? '—' : 'Nonstop'));
    const endSpan = this.summary.querySelector('[data-sum="end"]');
    endSpan.textContent = endTxt;
    endSpan.classList.toggle('text-amber-400', !!endPending);
    endSpan.classList.toggle('text-gray-300', !endPending);
    this.summary.querySelector('[data-sum="start"]').textContent = startTxt;
    this.summary.querySelector('[data-sum="duration"]').textContent = durTxt;
  }

  // header text of a card: chosen value, pending date-without-time (end),
  // or the placeholder
  renderLabel(which) {
    const { label, clear } = this.cards[which];
    const value = which === 'start' ? this.start : this.end;
    if (value) {
      label.textContent = this.fmtSummary(value);
      label.className = 'text-sm text-white truncate';
      label.title = label.textContent;
    } else if (which === 'end' && this.slot.end) {
      // a date was picked but no time yet — the end is still empty,
      // so make it obvious the choice is incomplete
      label.textContent = `${this.fmtDay(this.slot.end)} — pick a time`;
      label.className = 'text-sm text-amber-400 truncate';
      label.title = label.textContent;
    } else {
      label.textContent = which === 'start'
        ? 'Pick a date & time below'
        : 'Optional — leave empty for nonstop';
      label.className = 'text-sm text-gray-500';
      label.title = '';
    }
    clear.classList.toggle('hidden', !value);
  }

  renderAll() {
    if (!this.root) return;

    for (const which of ['start', 'end']) {
      this.renderLabel(which);

      if (which === 'end' && !this.start && !this.end) {
        // end needs a start to relate to; presets are disabled meanwhile
        this.cards.end.calendar.innerHTML = `
          <div class="flex flex-col items-center justify-center text-gray-500 text-sm py-10 gap-2">
            <i class="ti ti-clock text-2xl"></i>
            <span>Pick a start time first</span>
          </div>`;
        this.cards.end.slots.innerHTML = '';
        continue;
      }

      this.renderCalendar(which);
      this.renderSlots(which);
    }

    // duration presets: active only when end - start is exactly the preset
    const activeMinutes = this.start && this.end
      ? Math.round((this.end - this.start) / 60000)
      : null;
    this.root.querySelectorAll('[data-preset]').forEach(btn => {
      const h = +btn.dataset.preset;
      const on = activeMinutes === h * 60;
      btn.className = `sp-preset px-3 py-1 rounded-full border text-xs transition-colors ${on
        ? 'bg-white text-gray-900 border-white font-medium'
        : 'border-gray-600 text-gray-300 hover:border-gray-400 hover:text-white'}`;
      btn.disabled = !this.start;
      btn.title = this.start
        ? `Set end time ${h} hour${h > 1 ? 's' : ''} after start`
        : 'Pick a start time first';
    });

    this.renderSummary();
  }

  /* ---------- helpers ---------- */

  matchesSlot(which, mins) {
    const value = which === 'start' ? this.start : this.end;
    const day = this.slot[which];
    return !!(value && day &&
      value.toDateString() === day.toDateString() &&
      value.getHours() * 60 + value.getMinutes() === mins);
  }

  fmtSlot(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

window.SchedulePicker = SchedulePicker;
