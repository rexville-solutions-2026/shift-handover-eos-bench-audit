/* Shift Handover · EOS Bench Audit — standalone Supabase-backed app
 * Same architecture as the Picking & Packing Audits Board: a single static
 * page, no build step, no server. Supabase (Postgres + Storage + Realtime)
 * is the shared backend; Netlify just serves these static files.
 */
(function () {
  'use strict';

  // ======================================================================
  // Constants / content model
  // ======================================================================
  var HANDOVER_AREA_KEYS = ['inbound', 'pick', 'pack', 'despatch'];
  var DEPT_LABELS = { inbound: 'Inbound', pick: 'Pick', pack: 'Pack', despatch: 'Despatch' };
  var SHIFTS = ['AM', 'PM', 'NS'];
  var PASSCODE = '1254'; // guards viewing past dates, editing checklist topics, and clearing all data
  var PHOTOS_BUCKET = 'photos';
  var MAX_CONDITION_PHOTOS = 4;

  var DEFAULT_TOPICS = {
    inbound: ['Number of the loads remaining?', 'Put away remaining?', 'Booking in remaining?', 'Whiteboard updated?'],
    pick: ['Outstanding pick tasks?', 'Condition of aisles 11-19?', 'Whiteboard updated?', 'Ops scanned out/WTT?'],
    pack: ['EOS pack benches audited?', 'Unfinished orders in/on trolleys?', 'Whiteboard updated?', 'Ops scanned out/WTT?'],
    despatch: ['List missing collections?', 'Yorks count completed?', 'No of yorks inside?', 'Whiteboard updated?']
  };

  // Every handover topic normally requires a comment when it's answered
  // "No" (that's the failing/needs-explanation state — e.g. "Whiteboard
  // updated?" -> "No" means something's wrong). A handful of topics are
  // phrased the other way round, where "Yes" is the state that needs
  // explaining — "Any loads remaining?" -> "Yes" means there ARE loads
  // remaining, which is what needs a note. Handover topics are plain
  // editable strings with no stable id, and the live checklist text has
  // already drifted from the wording below (e.g. "Any loads remaining?"
  // vs. the original "Number of the loads remaining?"), so matching by
  // label text isn't reliable — this matches by the topic's position in
  // the list instead, which stays stable across a reword.
  var MANDATORY_ON_YES_INDEX = {
    inbound: [0, 1, 2],  // top 3: loads remaining / put away remaining / booking in remaining
    pick: [0],           // Outstanding pick tasks?
    pack: [1],           // Unfinished orders in/on trolleys?
    despatch: [0]        // (Any) missing collections?
  };
  function mandatoryOnForTopic(areaKey, idx) {
    var idxs = MANDATORY_ON_YES_INDEX[areaKey];
    return (idxs && idxs.indexOf(idx) !== -1) ? 'Yes' : 'No';
  }

  var BENCH_AUDIT_FIELDS = [
    { key: 'auditor', type: 'text', label: 'Auditor' },
    { key: 'bench', type: 'select-number', label: 'Bench Number', min: 1, max: 60 },
    { key: 'opId', type: 'text', label: 'Op ID' }
  ];
  var BENCH_AUDIT_QUESTIONS = [
    { label: 'Are consumables stored in the correct designated locations at the bench and labelled correctly?', options: ['Yes', 'No'], mandatoryOn: 'No' },
    { label: 'Are the hygiene items in the designated location at the bench?', options: ['Yes', 'No'], mandatoryOn: 'No' },
    { label: 'Void fill boxes filled?', options: ['Yes', 'No'], mandatoryOn: 'No' },
    // photosOnFail: the "Add photo" camera button only appears once the
    // answer is the mandatory-comment one ("No") — a photo is only useful
    // to show what's wrong. Photos already attached stay visible even if
    // the answer is changed back to "Yes" afterwards.
    { label: 'Is the pack bench clean?', options: ['Yes', 'No'], mandatoryOn: 'No', photos: true, photosOnFail: true }
  ];

  function getAreas() {
    var areas = HANDOVER_AREA_KEYS.map(function (k) {
      return { key: k, label: DEPT_LABELS[k], topics: topicsFor(k) };
    });
    areas.push({ key: 'benchaudit', label: 'EOS Bench Audit' });
    return areas;
  }
  function topicsFor(areaKey) {
    var custom = TOPICS_STATE[areaKey];
    return (custom && custom.length) ? custom.slice() : DEFAULT_TOPICS[areaKey].slice();
  }

  // ======================================================================
  // Supabase client + connection state
  // ======================================================================
  var supabase = null;
  var readOnly = false;
  var configOk = (typeof SUPABASE_URL === 'string' && SUPABASE_URL.indexOf('YOUR_') !== 0 &&
                  typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY.indexOf('YOUR_') !== 0);

  function setReadOnly(val, msg) {
    readOnly = val;
    document.body.setAttribute('data-readonly', val ? 'true' : 'false');
    var banner = document.getElementById('configBanner');
    if (val && msg) {
      banner.textContent = msg;
      banner.setAttribute('data-visible', 'true');
    } else if (!val) {
      banner.setAttribute('data-visible', 'false');
    }
  }

  // ======================================================================
  // In-memory state, grouped from flat Supabase rows the same way the
  // artifact version grouped its embedded JSON: by "date|shift" combo key,
  // then by area. Each area holds its *history* (rows already saved) plus
  // (client-side only) the *draft* currently being filled in.
  // ======================================================================
  var TOPICS_STATE = {};      // { inbound: [strings], ... } — overrides of DEFAULT_TOPICS
  var HISTORY = {};           // { "date|shift": { inbound: [entryRow,...], ..., benchaudit: [auditRow,...] } }
  var DRAFTS = {};            // { "date|shift": { inbound: {topics:[{label,note}], given, received, condition?}, ..., benchaudit: {...} } }

  function comboKeyOf(dateStr, shift) { return dateStr + '|' + shift; }

  function ensureHistory(comboKey) {
    if (!HISTORY[comboKey]) HISTORY[comboKey] = { inbound: [], pick: [], pack: [], despatch: [], benchaudit: [] };
    return HISTORY[comboKey];
  }

  function freshHandoverDraft(areaKey) {
    return {
      topics: topicsFor(areaKey).map(function (label) { return { label: label, result: '', note: '' }; }),
      given: '', received: ''
    };
  }
  function freshBenchDraft() {
    return {
      auditor: '', bench: '', opId: '',
      answers: BENCH_AUDIT_QUESTIONS.map(function () { return { result: '', note: '', photos: [] }; })
    };
  }
  function ensureDraft(comboKey, areaKey) {
    if (!DRAFTS[comboKey]) DRAFTS[comboKey] = {};
    if (!DRAFTS[comboKey][areaKey]) {
      DRAFTS[comboKey][areaKey] = areaKey === 'benchaudit' ? freshBenchDraft() : freshHandoverDraft(areaKey);
    } else if (areaKey !== 'benchaudit') {
      // Re-sync topic labels to the current master checklist, keeping any note
      // already typed for the matching position (mirrors the artifact's
      // reconcileTopics behaviour: topic wording is never frozen in a draft).
      var master = topicsFor(areaKey);
      var d = DRAFTS[comboKey][areaKey];
      d.topics = master.map(function (label, idx) {
        var prev = d.topics[idx];
        var note = (prev && typeof prev.note === 'string') ? prev.note : '';
        var result = (prev && typeof prev.result === 'string') ? prev.result : '';
        return { label: label, result: result, note: note };
      });
    }
    return DRAFTS[comboKey][areaKey];
  }

  // ======================================================================
  // Remote data: fetch + group
  // ======================================================================
  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Wipes and re-derives HISTORY for every "date|shift" combo key whose date
  // falls in [startStr, endStr] (inclusive), leaving every other cached date
  // untouched. Called right before re-populating that exact range from a
  // fresh query, so it reflects deletes/edits, not just new rows.
  function clearHistoryForDateRange(startStr, endStr) {
    Object.keys(HISTORY).forEach(function (ck) {
      var d = ck.split('|')[0];
      if (d >= startStr && d <= endStr) delete HISTORY[ck];
    });
  }
  function applyRowsToHistory(handoverRows, benchRows) {
    (handoverRows || []).forEach(function (row) {
      var h = ensureHistory(comboKeyOf(row.date, row.shift));
      h[row.area].push({
        id: row.id, topics: row.topics || [], condition: row.condition || null,
        given: row.given_by || '', received: row.received_by || '', savedAt: row.created_at
      });
    });
    (benchRows || []).forEach(function (row) {
      var h = ensureHistory(comboKeyOf(row.date, row.shift));
      h.benchaudit.push({
        id: row.id, auditor: row.auditor || '', bench: row.bench || '', opId: row.op_id || '',
        answers: row.answers || [], savedAt: row.created_at
      });
    });
  }

  // Keeps the rolling window (see ROLLING_WINDOW_DAYS above) in sync — this
  // is the only query that runs unprompted (on load, and after any realtime
  // change), so it's the one that has to stay cheap no matter how much
  // history has piled up. checklist_topics is tiny (one row per area) and is
  // always fetched in full.
  async function fetchWindow() {
    if (!supabase) return;
    var start = windowStartStr(), end = windowEndStr();
    try {
      var hRes = await supabase.from('handover_entries').select('*').gte('date', start).lte('date', end).order('created_at', { ascending: true });
      if (hRes.error) throw hRes.error;
      var bRes = await supabase.from('bench_audits').select('*').gte('date', start).lte('date', end).order('created_at', { ascending: true });
      if (bRes.error) throw bRes.error;
      var tRes = await supabase.from('checklist_topics').select('*');
      if (tRes.error) throw tRes.error;

      clearHistoryForDateRange(start, end);
      applyRowsToHistory(hRes.data, bRes.data);

      var newTopics = {};
      (tRes.data || []).forEach(function (row) { newTopics[row.area] = row.topics; });
      TOPICS_STATE = newTopics;
    } catch (e) {
      // leave existing HISTORY/TOPICS_STATE in place; the next realtime tick or
      // manual reload will retry
    }
  }

  // On-demand lookup for a single date outside the rolling window — e.g.
  // someone picking an older date from the calendar. No-ops (and costs
  // nothing) if that date is already covered by the window.
  async function fetchDateIfNeeded(dateStr) {
    if (!supabase) return;
    if (dateStr >= windowStartStr() && dateStr <= windowEndStr()) return;
    try {
      var hRes = await supabase.from('handover_entries').select('*').eq('date', dateStr).order('created_at', { ascending: true });
      if (hRes.error) throw hRes.error;
      var bRes = await supabase.from('bench_audits').select('*').eq('date', dateStr).order('created_at', { ascending: true });
      if (bRes.error) throw bRes.error;
      clearHistoryForDateRange(dateStr, dateStr);
      applyRowsToHistory(hRes.data, bRes.data);
      safeRenderMain();
    } catch (e) {
      // leave existing (possibly empty) HISTORY for this date; picking the
      // date again will retry
    }
  }

  // ======================================================================
  // Photo compression + upload (mirrors the Picking & Packing board: resize
  // client-side via canvas, upload to the public "photos" bucket, keep the
  // public URL).
  // ======================================================================
  function resizeImageFile(file) {
    return new Promise(function (resolve) {
      try {
        if (typeof Image === 'undefined' || typeof document.createElement('canvas').getContext !== 'function') { resolve(file); return; }
        var img = new Image();
        var url = URL.createObjectURL(file);
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return; settled = true;
          try { URL.revokeObjectURL(url); } catch (e) {}
          resolve(file);
        }, 1500);
        img.onload = function () {
          if (settled) return; settled = true; clearTimeout(timer);
          try {
            var maxDim = 1600;
            var w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) { URL.revokeObjectURL(url); resolve(file); return; }
            var scale = Math.min(1, maxDim / Math.max(w, h));
            var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
            var canvas = document.createElement('canvas');
            canvas.width = cw; canvas.height = ch;
            var ctx = canvas.getContext('2d');
            if (!ctx || typeof canvas.toBlob !== 'function') { URL.revokeObjectURL(url); resolve(file); return; }
            ctx.drawImage(img, 0, 0, cw, ch);
            URL.revokeObjectURL(url);
            canvas.toBlob(function (blob) { resolve(blob || file); }, 'image/jpeg', 0.82);
          } catch (e) { try { URL.revokeObjectURL(url); } catch (e2) {} resolve(file); }
        };
        img.onerror = function () {
          if (settled) return; settled = true; clearTimeout(timer);
          try { URL.revokeObjectURL(url); } catch (e) {}
          resolve(file);
        };
        img.src = url;
      } catch (e) { resolve(file); }
    });
  }

  async function uploadPhoto(photo, file) {
    if (!supabase || readOnly) {
      photo.uploading = false;
      photo.error = "Can't upload here — kept for this session only.";
      safeRenderMain();
      return;
    }
    try {
      var blob = await resizeImageFile(file);
      var ext = (blob && blob.type === 'image/png') ? 'png' : 'jpg';
      var path = photo.id + '.' + ext;
      var upRes = await supabase.storage.from(PHOTOS_BUCKET).upload(path, blob, { contentType: (blob && blob.type) || 'image/jpeg', upsert: false });
      if (upRes.error) throw upRes.error;
      var pub = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(path);
      photo.path = pub && pub.data ? pub.data.publicUrl : path;
      photo.uploading = false;
      safeRenderMain();
    } catch (err) {
      photo.uploading = false;
      photo.error = 'Upload failed — remove and try again.';
      safeRenderMain();
    }
  }

  function handlePhotoFiles(photosArr, fileList) {
    var files = Array.from(fileList || []);
    files.forEach(function (file) {
      if (!file || file.type.indexOf('image/') !== 0) return;
      if (photosArr.length >= MAX_CONDITION_PHOTOS) return;
      var photo = { id: makeId(), localUrl: null, path: null, uploading: true, error: null };
      try { photo.localUrl = URL.createObjectURL(file); } catch (e) {}
      photosArr.push(photo);
      renderMain();
      uploadPhoto(photo, file);
    });
  }
  function photoDisplaySrc(ph) { return (ph && (ph.localUrl || ph.path)) || ''; }

  // ======================================================================
  // Date helpers
  // ======================================================================
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  // The app's "day" runs 6:00am to 5:59am, not midnight to midnight — so
  // between midnight and 6am it's still logically "yesterday". Shift the
  // clock back 6 hours before reading off the calendar date.
  var DAY_ROLLOVER_HOUR = 6;
  function todayStr() {
    var d = new Date(Date.now() - DAY_ROLLOVER_HOUR * 60 * 60 * 1000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dateFromStr(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function tomorrowStr() {
    var b = dateFromStr(todayStr());
    var d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function isCreatableDate(dateStr) { return dateStr === todayStr() || dateStr === tomorrowStr(); }
  function isPastDate(dateStr) { return dateStr < todayStr(); }
  function shiftDateStr(dateStr, deltaDays) {
    var b = dateFromStr(dateStr);
    var d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + deltaDays);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  // How much history the app keeps "warm" (fetched up front and kept in sync
  // over realtime) without being asked. Board mode and everyday Summary
  // browsing only ever need one date at a time, so this can stay small —
  // it just has to cover "today", "tomorrow", and a reasonable amount of
  // recent look-back without a fresh fetch. Anything older is fetched on
  // demand the moment someone picks that date from the calendar (see
  // fetchDateIfNeeded), so the app stays just as fast after a year of daily
  // logs as it is on day one — it never downloads the whole history table.
  var ROLLING_WINDOW_DAYS = 14;
  function windowStartStr() { return shiftDateStr(todayStr(), -ROLLING_WINDOW_DAYS); }
  function windowEndStr() { return tomorrowStr(); }
  function formatDateLabel(dateStr) { return dateFromStr(dateStr).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  function shortDateLabel(dateStr) { return dateFromStr(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function formatSavedWhen(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' +
        d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  // ======================================================================
  // DOM builder helpers
  // ======================================================================
  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function textEl(tag, className, str) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    e.textContent = str;
    return e;
  }

  function buildSignoff(givenVal, receivedVal, onChange) {
    var wrap = el('div', { class: 'signoff' });
    var given = el('label', { class: 'signoff-field' });
    given.appendChild(textEl('span', 'signoff-label', 'Handover given by'));
    var givenInput = el('input', { type: 'text', class: 'signoff-input', autocomplete: 'off' });
    givenInput.value = givenVal || '';
    givenInput.addEventListener('input', function () { onChange('given', givenInput.value); });
    given.appendChild(givenInput);

    var received = el('label', { class: 'signoff-field' });
    received.appendChild(textEl('span', 'signoff-label', 'Handover received by'));
    var receivedInput = el('input', { type: 'text', class: 'signoff-input', autocomplete: 'off' });
    receivedInput.value = receivedVal || '';
    receivedInput.addEventListener('input', function () { onChange('received', receivedInput.value); });
    received.appendChild(receivedInput);

    wrap.appendChild(given);
    wrap.appendChild(received);
    return wrap;
  }

  function buildTextTopicRow(topic, idx, onNote) {
    var row = el('div', { class: 'topic-row' });
    var body = el('div', { class: 'topic-body' });
    body.appendChild(textEl('span', 'topic-label', topic.label));
    var note = el('div', { class: 'topic-note', contenteditable: 'true', 'data-placeholder': 'Add a note…' });
    if (topic.note) note.textContent = topic.note;
    note.addEventListener('input', function () { onNote(idx, note.textContent); });
    body.appendChild(note);
    row.appendChild(body);
    return row;
  }

  function updateMandatoryState(row, mandatoryOn, currentAnswer) {
    var required = !!currentAnswer && currentAnswer === mandatoryOn;
    var note = row.querySelector('.topic-note');
    if (note) note.setAttribute('data-required', required ? 'true' : 'false');
  }

  function buildYesNoRow(opts) {
    // opts: { label, options, mandatoryOn, prefill:{result,note,photos}, allowPhotos, photosOnFail, onAnswer(val), onNote(val), onAddPhotos(files), onRemovePhoto(id) }
    var row = el('div', { class: 'topic-row' });
    var body = el('div', { class: 'topic-body' });
    body.appendChild(textEl('span', 'topic-label', opts.label));

    var btnWrap = el('div', { class: 'yesno-buttons', role: 'group', 'aria-label': opts.label });
    var prefill = opts.prefill || { result: '', note: '', photos: [] };

    // The photo-add control is built once (so its event listeners aren't
    // re-wired on every answer change) and then shown/hidden in place —
    // when photosOnFail is set, it only appears once the answer is the
    // mandatory-comment one, matching the same "only offer a photo on a
    // failing answer" rule used for comments.
    var addBtn = null, fileInput = null;
    if (opts.allowPhotos) {
      addBtn = el('button', { type: 'button', class: 'add-photo-btn question-photo-btn', 'aria-label': 'Add photo' });
      addBtn.textContent = '📷';
      fileInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: 'true', class: 'condition-photo-input' });
      fileInput.addEventListener('change', function () { opts.onAddPhotos(fileInput.files); fileInput.value = ''; });
      addBtn.addEventListener('click', function () { fileInput.click(); });
    }
    function updatePhotoButtonVisibility() {
      if (!opts.allowPhotos) return;
      var shouldShow = !opts.photosOnFail || prefill.result === opts.mandatoryOn;
      if (shouldShow) {
        var atCap = (prefill.photos || []).length >= MAX_CONDITION_PHOTOS;
        addBtn.setAttribute('aria-label', atCap ? 'Photo limit reached' : 'Add photo');
        if (atCap) addBtn.setAttribute('disabled', 'true'); else addBtn.removeAttribute('disabled');
        if (!addBtn.parentNode) { btnWrap.appendChild(addBtn); btnWrap.appendChild(fileInput); }
      } else if (addBtn.parentNode) {
        btnWrap.removeChild(addBtn);
        btnWrap.removeChild(fileInput);
      }
    }

    opts.options.forEach(function (optVal) {
      var b = el('button', { type: 'button', class: 'yesno-btn', 'aria-pressed': (prefill.result === optVal) ? 'true' : 'false' });
      b.textContent = optVal;
      b.addEventListener('click', function () {
        var next = prefill.result === optVal ? '' : optVal;
        Array.from(btnWrap.querySelectorAll('.yesno-btn')).forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        if (next) b.setAttribute('aria-pressed', 'true');
        prefill.result = next;
        updateMandatoryState(row, opts.mandatoryOn, next);
        updatePhotoButtonVisibility();
        opts.onAnswer(next);
      });
      btnWrap.appendChild(b);
    });

    updatePhotoButtonVisibility();
    body.appendChild(btnWrap);

    var note = el('div', { class: 'topic-note', contenteditable: 'true', 'data-placeholder': 'Add a note…' });
    if (prefill.note) note.textContent = prefill.note;
    note.addEventListener('input', function () { opts.onNote(note.textContent); });
    body.appendChild(note);

    if (opts.allowPhotos && (prefill.photos || []).length) {
      body.appendChild(buildPhotoThumbs(prefill.photos, opts.onRemovePhoto));
    }

    row.appendChild(body);
    row.setAttribute('data-mandatory-on', opts.mandatoryOn || '');
    updateMandatoryState(row, opts.mandatoryOn, prefill.result);
    return row;
  }

  function buildPhotoThumbs(photos, onRemove) {
    var wrap = el('div', { class: 'condition-thumbs' });
    (photos || []).forEach(function (ph) {
      var thumb = el('div', { class: 'condition-thumb' + (ph.uploading ? ' uploading' : '') });
      thumb.appendChild(el('img', { src: photoDisplaySrc(ph), alt: 'Photo evidence' }));
      var rm = el('button', { type: 'button', class: 'condition-thumb-remove', 'aria-label': 'Remove photo' });
      rm.textContent = '×';
      rm.addEventListener('click', function () { onRemove(ph.id); });
      thumb.appendChild(rm);
      wrap.appendChild(thumb);
    });
    return wrap;
  }

  function buildBenchPicker(value, onSelect) {
    var wrap = el('div', { class: 'bench-picker' });
    var trigger = el('button', { type: 'button', class: 'bench-picker-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
    var valueSpan = el('span', { class: 'bench-picker-value', 'data-placeholder': 'Select…' });
    if (value) valueSpan.textContent = value;
    var icon = el('span', { class: 'bench-picker-icon', 'aria-hidden': 'true' }); icon.textContent = '▾';
    trigger.appendChild(valueSpan); trigger.appendChild(icon);

    var popover = el('div', { class: 'bench-picker-popover', 'data-visible': 'false', role: 'listbox' });
    for (var n = 1; n <= 60; n++) {
      var optBtn = el('button', { type: 'button', class: 'bench-picker-option', 'aria-pressed': (value === String(n)) ? 'true' : 'false' });
      optBtn.textContent = String(n);
      (function (num, btn) {
        btn.addEventListener('click', function () {
          Array.from(popover.querySelectorAll('.bench-picker-option')).forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
          btn.setAttribute('aria-pressed', 'true');
          valueSpan.textContent = String(num);
          popover.setAttribute('data-visible', 'false');
          trigger.setAttribute('aria-expanded', 'false');
          onSelect(String(num));
        });
      })(n, optBtn);
      popover.appendChild(optBtn);
    }
    trigger.addEventListener('click', function () {
      var open = popover.getAttribute('data-visible') === 'true';
      closeAllPopovers();
      popover.setAttribute('data-visible', open ? 'false' : 'true');
      trigger.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    wrap.appendChild(trigger); wrap.appendChild(popover);
    return wrap;
  }

  function closeAllPopovers() {
    document.querySelectorAll('.bench-picker-popover[data-visible="true"]').forEach(function (p) { p.setAttribute('data-visible', 'false'); });
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.bench-picker')) closeAllPopovers();
  });

  function buildSavedHandoverEntry(snapshot) {
    var card = el('div', { class: 'saved-entry' });
    card.appendChild(textEl('div', 'saved-entry-when', formatSavedWhen(snapshot.savedAt)));
    (snapshot.topics || []).forEach(function (t) {
      if (!t.result && !t.note) return;
      var row = el('div', { class: 'saved-topic' });
      row.appendChild(textEl('span', 'saved-topic-label', t.label + ': '));
      row.appendChild(textEl('span', 'saved-topic-note', (t.result || '—') + (t.note ? ' — ' + t.note : '')));
      card.appendChild(row);
    });
    var cond = snapshot.condition;
    if (cond && (cond.answer || cond.note || (cond.photos && cond.photos.length))) {
      var condRow = el('div', { class: 'saved-topic' });
      condRow.appendChild(textEl('span', 'saved-topic-label', 'Overall pick condition: '));
      condRow.appendChild(textEl('span', 'saved-topic-note', (cond.answer || '—') + (cond.note ? ' — ' + cond.note : '')));
      card.appendChild(condRow);
      if (cond.photos && cond.photos.length) {
        var thumbs = el('div', { class: 'condition-thumbs saved-thumbs' });
        cond.photos.forEach(function (p, i) {
          thumbs.appendChild(el('img', { class: 'saved-thumb-img', src: p.path || '', alt: 'Pick condition photo ' + (i + 1) }));
        });
        card.appendChild(thumbs);
      }
    }
    if (snapshot.given || snapshot.received) {
      card.appendChild(textEl('div', 'saved-signoff', 'Given by ' + (snapshot.given || '—') + ' · Received by ' + (snapshot.received || '—')));
    }
    return card;
  }

  function buildSavedAuditEntry(snapshot) {
    var card = el('div', { class: 'saved-entry' });
    card.appendChild(textEl('div', 'saved-entry-when', formatSavedWhen(snapshot.savedAt)));
    card.appendChild(textEl('div', 'saved-topic', 'Auditor ' + (snapshot.auditor || '—') + ' · Bench ' + (snapshot.bench || '—') + ' · Op ID ' + (snapshot.opId || '—')));
    BENCH_AUDIT_QUESTIONS.forEach(function (q, i) {
      var a = (snapshot.answers && snapshot.answers[i]) || {};
      if (!a.result && !a.note && !(a.photos && a.photos.length)) return;
      var row = el('div', { class: 'saved-topic' });
      row.appendChild(textEl('span', 'saved-topic-label', q.label + ': '));
      row.appendChild(textEl('span', 'saved-topic-note', (a.result || '—') + (a.note ? ' — ' + a.note : '')));
      card.appendChild(row);
      if (a.photos && a.photos.length) {
        var thumbs = el('div', { class: 'condition-thumbs saved-thumbs' });
        a.photos.forEach(function (p, pi) {
          thumbs.appendChild(el('img', { class: 'saved-thumb-img', src: p.path || '', alt: q.label + ' photo ' + (pi + 1) }));
        });
        card.appendChild(thumbs);
      }
    });
    return card;
  }

  function buildSavedList(title, snapshots, entryBuilder) {
    if (!snapshots || !snapshots.length) return null;
    var wrap = el('div', { class: 'saved-list' });
    wrap.appendChild(textEl('div', 'saved-list-title', title + ' (' + snapshots.length + ')'));
    snapshots.slice().reverse().forEach(function (s) { wrap.appendChild(entryBuilder(s)); });
    return wrap;
  }

  // ======================================================================
  // Save actions (row insert into Supabase, mirroring tryPersist in the
  // Picking & Packing board: optimistic local update, then insert with a
  // couple of retries on transient failure).
  // ======================================================================
  function setSaveStatus(btnRow, kind, msg) {
    var status = btnRow.querySelector('.save-status');
    if (!status) return;
    status.setAttribute('data-kind', kind);
    status.textContent = msg;
    status.setAttribute('data-visible', 'true');
    if (kind === 'saved') setTimeout(function () { status.setAttribute('data-visible', 'false'); }, 4000);
  }

  async function saveHandoverArea(comboKey, areaKey, draft, btnRow, errEl) {
    var missing = draft.topics.some(function (t, idx) {
      if (!t.result) return true;
      var mandatoryOn = mandatoryOnForTopic(areaKey, idx);
      if (t.result === mandatoryOn && !(t.note && t.note.trim())) return true;
      return false;
    });
    var signoffMissing = !(draft.given && draft.given.trim()) || !(draft.received && draft.received.trim());
    if (missing || signoffMissing) { errEl.setAttribute('data-visible', 'true'); return; }
    errEl.setAttribute('data-visible', 'false');

    var parts = comboKey.split('|'); var date = parts[0], shift = parts[1];
    var row = {
      id: makeId(), date: date, shift: shift, area: areaKey,
      topics: draft.topics.map(function (t) { return { label: t.label, result: t.result, note: t.note }; }),
      condition: null, // no longer collected — kept so old rows with data still read fine
      given_by: draft.given || '', received_by: draft.received || ''
    };

    // optimistic local update, then clear the draft
    var h = ensureHistory(comboKey);
    h[areaKey].push({ id: row.id, topics: row.topics, condition: row.condition, given: row.given_by, received: row.received_by, savedAt: new Date().toISOString() });
    delete DRAFTS[comboKey][areaKey];
    renderMain();

    // renderMain() just tore down and rebuilt the whole page, so btnRow/errEl
    // (captured from the DOM *before* this save started) are now detached —
    // writing "Saving…"/"Saved" onto them was invisible to the user. Re-find
    // this area's freshly-rebuilt save row so the confirmation actually shows.
    // (This was the real cause behind "still needs comments, won't save"
    // reports: a successful save silently cleared the form with zero visible
    // confirmation, so the now-blank draft immediately tripped the same
    // "answer every question… sign off both names" banner again, and people
    // — having no sign anything had worked — filled it in and resubmitted,
    // creating duplicate entries.)
    var freshBlock = document.querySelector('.area-block[data-area="' + areaKey + '"]');
    var freshRow = freshBlock ? freshBlock.querySelector('.area-save-row') : btnRow;

    if (readOnly || !supabase) { setSaveStatus(freshRow, 'saved', 'Saved (this session only)'); return; }
    setSaveStatus(freshRow, 'saving', 'Saving…');
    var ok = await tryInsert('handover_entries', row, 0);
    setSaveStatus(freshRow, ok ? 'saved' : 'error', ok ? '✓ Saved — cleared for the next entry' : "Couldn't save — try again in a moment");
  }

  async function saveBenchAudit(comboKey, draft, btnRow, errEl) {
    var qMissing = draft.answers.some(function (a) { return !a.result; });
    var commentMissing = draft.answers.some(function (a, i) {
      var q = BENCH_AUDIT_QUESTIONS[i];
      return a.result === q.mandatoryOn && !(a.note && a.note.trim());
    });
    if (!draft.auditor.trim() || !draft.bench || !draft.opId.trim() || qMissing || commentMissing) {
      errEl.setAttribute('data-visible', 'true'); return;
    }
    errEl.setAttribute('data-visible', 'false');

    var parts = comboKey.split('|'); var date = parts[0], shift = parts[1];
    var row = {
      id: makeId(), date: date, shift: shift,
      bench: draft.bench, auditor: draft.auditor.trim(), op_id: draft.opId.trim(),
      answers: draft.answers.map(function (a, i) {
        return {
          label: BENCH_AUDIT_QUESTIONS[i].label, result: a.result, note: a.note,
          photos: (a.photos || []).filter(function (p) { return p.path && !p.uploading && !p.error; }).map(function (p) { return { path: p.path }; })
        };
      })
      // no given_by/received_by — bench audits no longer collect a handover signoff
    };

    var h = ensureHistory(comboKey);
    h.benchaudit.push({ id: row.id, auditor: row.auditor, bench: row.bench, opId: row.op_id, answers: row.answers, savedAt: new Date().toISOString() });
    delete DRAFTS[comboKey].benchaudit;
    renderMain();

    // Same fix as saveHandoverArea: btnRow is detached after renderMain()
    // rebuilds the page, so re-find the fresh save row before showing status.
    var freshBlock = document.querySelector('.area-block[data-area="benchaudit"]');
    var freshRow = freshBlock ? freshBlock.querySelector('.area-save-row') : btnRow;

    if (readOnly || !supabase) { setSaveStatus(freshRow, 'saved', 'Saved (this session only)'); return; }
    setSaveStatus(freshRow, 'saving', 'Saving…');
    var ok = await tryInsert('bench_audits', row, 0);
    setSaveStatus(freshRow, ok ? 'saved' : 'error', ok ? '✓ Saved — form cleared for the next audit' : "Couldn't save — try again in a moment");
  }

  async function tryInsert(table, row, attempt) {
    try {
      var res = await supabase.from(table).insert([row]);
      if (res.error) throw res.error;
      return true;
    } catch (err) {
      if (attempt < 2) { await sleep(400 + Math.random() * 400); return tryInsert(table, row, attempt + 1); }
      return false;
    }
  }

  async function saveTopics(areaKey, newTopics) {
    TOPICS_STATE[areaKey] = newTopics;
    // reconcile any open draft for this area (today/tomorrow) to the new wording
    Object.keys(DRAFTS).forEach(function (ck) { if (DRAFTS[ck][areaKey]) ensureDraft(ck, areaKey); });
    renderMain();
    if (readOnly || !supabase) return true;
    try {
      var res = await supabase.from('checklist_topics').upsert([{ area: areaKey, topics: newTopics, updated_at: new Date().toISOString() }], { onConflict: 'area' });
      if (res.error) throw res.error;
      return true;
    } catch (e) { return false; }
  }

  async function clearAllData() {
    HISTORY = {};
    renderMain();
    if (readOnly || !supabase) return true;
    try {
      var r1 = await supabase.from('handover_entries').delete().not('id', 'is', null);
      if (r1.error) throw r1.error;
      var r2 = await supabase.from('bench_audits').delete().not('id', 'is', null);
      if (r2.error) throw r2.error;
      return true;
    } catch (e) { return false; }
  }

  // Scoped alternative to "Clear all data" — wipes just one date, optionally
  // narrowed further to one area and/or one shift, instead of every date at
  // once. areaKey is 'all' or one of HANDOVER_AREA_KEYS/'benchaudit';
  // shiftKey is 'all' or one of SHIFTS.
  async function clearDateData(dateStr, areaKey, shiftKey) {
    var shifts = (shiftKey === 'all') ? SHIFTS : [shiftKey];
    var areaKeys = (areaKey === 'all') ? HANDOVER_AREA_KEYS.concat(['benchaudit']) : [areaKey];
    shifts.forEach(function (s) {
      var ck = comboKeyOf(dateStr, s);
      if (!HISTORY[ck]) return;
      areaKeys.forEach(function (a) { HISTORY[ck][a] = []; });
    });
    safeRenderMain();
    if (readOnly || !supabase) return true;
    // handover_entries covers the four handover areas; bench_audits is its
    // own table with no area column — only touch whichever of the two the
    // selected area actually applies to.
    var doHandover = areaKey !== 'benchaudit';
    var doBench = (areaKey === 'all' || areaKey === 'benchaudit');
    try {
      if (doHandover) {
        var hq = supabase.from('handover_entries').delete().eq('date', dateStr);
        if (shiftKey !== 'all') hq = hq.eq('shift', shiftKey);
        if (areaKey !== 'all') hq = hq.eq('area', areaKey);
        var r1 = await hq;
        if (r1.error) throw r1.error;
      }
      if (doBench) {
        var bq = supabase.from('bench_audits').delete().eq('date', dateStr);
        if (shiftKey !== 'all') bq = bq.eq('shift', shiftKey);
        var r2 = await bq;
        if (r2.error) throw r2.error;
      }
      return true;
    } catch (e) { return false; }
  }

  // ======================================================================
  // Main render
  // ======================================================================
  var view = { date: todayStr(), shift: 'AM', area: 'handover', dept: 'all', mode: 'board' };
  var summaryExportMsg = '';
  // Which audit type the Export CSV button covers — its own pill row inside
  // the export bar, independent of the page's Area/Department filter above
  // (same idea as the Picking & Packing board, where the export type pills
  // are separate from the Log page's own type tabs). No "All" option here.
  var EXPORT_TYPES = [{ key: 'handover', label: 'Handover' }, { key: 'benchaudit', label: 'EOS Bench Audit' }];
  var exportType = 'handover';
  function exportAreasForType() {
    return getAreas().filter(function (a) {
      return exportType === 'benchaudit' ? a.key === 'benchaudit' : a.key !== 'benchaudit';
    });
  }

  // The Area/Department filtering renderMain() uses to decide which area
  // cards to show in the list below.
  function computeShowAreas() {
    return getAreas().filter(function (a) {
      if (view.area === 'handover') return a.key !== 'benchaudit';
      if (view.area === 'benchaudit') return a.key === 'benchaudit';
      return true;
    }).filter(function (a) {
      if (a.key === 'benchaudit') return true;
      if (view.dept === 'all') return true;
      return a.key === view.dept;
    });
  }

  // ======================================================================
  // CSV export (Summary) — same idea as the Picking & Packing board's
  // export: one row per saved entry, columns padded out to however many
  // questions the widest entry being exported has. Handover topics and
  // bench-audit questions are flattened into the same {text,result,note,
  // photos} shape so both areas can share one CSV.
  // ======================================================================
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csvRow(cells) { return cells.map(csvCell).join(','); }

  function summaryRowsForAreas(comboKey, areas) {
    var rows = [];
    areas.forEach(function (a) {
      var hist = a.key === 'benchaudit'
        ? ((HISTORY[comboKey] && HISTORY[comboKey].benchaudit) || [])
        : ((HISTORY[comboKey] && HISTORY[comboKey][a.key]) || []);
      hist.forEach(function (entry) {
        if (a.key === 'benchaudit') {
          var qs = BENCH_AUDIT_QUESTIONS.map(function (q, i) {
            var ans = entry.answers[i] || {};
            return { text: q.label, result: ans.result || '', note: ans.note || '', photos: ans.photos || [] };
          });
          rows.push({ area: a.label, auditor: entry.auditor || '', bench: entry.bench || '', opId: entry.opId || '', given: '', received: '', questions: qs });
        } else {
          var qs2 = (entry.topics || []).map(function (t) { return { text: t.label, result: t.result || '', note: t.note || '', photos: [] }; });
          var cond = entry.condition;
          if (cond && (cond.answer || cond.note || (cond.photos && cond.photos.length))) {
            qs2.push({ text: 'Overall pick condition', result: cond.answer || '', note: cond.note || '', photos: cond.photos || [] });
          }
          rows.push({ area: a.label, auditor: '', bench: '', opId: '', given: entry.given || '', received: entry.received || '', questions: qs2 });
        }
      });
    });
    return rows;
  }

  function buildSummaryCsv(rows) {
    var maxQ = 0;
    rows.forEach(function (r) { if (r.questions.length > maxQ) maxQ = r.questions.length; });
    var header = ['Date', 'Shift', 'Area', 'Auditor', 'Bench', 'Op ID', 'Given By', 'Received By'];
    for (var i = 1; i <= maxQ; i++) { header.push('Question ' + i, 'Answer ' + i, 'Comment ' + i, 'Photos ' + i); }
    var lines = [csvRow(header)];
    rows.forEach(function (r) {
      var row = [view.date, view.shift, r.area, r.auditor, r.bench, r.opId, r.given, r.received];
      for (var i = 0; i < maxQ; i++) {
        var q = r.questions[i];
        if (q) {
          var photoPaths = (q.photos || []).map(function (p) { return p.path; }).filter(Boolean).join('; ');
          row.push(q.text || '', q.result || '', q.note || '', photoPaths);
        } else {
          row.push('', '', '', '');
        }
      }
      lines.push(csvRow(row));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // A plain, ordinary browser download — no special capability needed,
  // works for every visitor. Scoped to the selected date + shift and to
  // whichever export type pill (Handover / EOS Bench Audit) is active.
  function exportSummaryCsv() {
    var comboKey = comboKeyOf(view.date, view.shift);
    var rows = summaryRowsForAreas(comboKey, exportAreasForType());
    if (!rows.length) return;
    var csv = buildSummaryCsv(rows);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var typeLabel = EXPORT_TYPES.filter(function (t) { return t.key === exportType; })[0].label;
    a.href = url;
    a.download = 'shift-handover-' + view.date + '-' + view.shift + '-' + typeLabel.replace(/\s+/g, '-') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    summaryExportMsg = 'Exported ' + rows.length + ' ' + typeLabel + ' ' + (rows.length === 1 ? 'entry' : 'entries') + ' for ' + formatDateLabel(view.date) + ' (' + view.shift + ') to CSV.';
    renderMain();
  }

  // In Summary mode the checklist/question form is never shown — just the
  // area title and whatever's already been saved for the selected date and
  // shift. Returns null when there's nothing saved, so the caller can skip
  // the area entirely rather than showing an empty card.
  function buildAreaSummaryBlock(area, comboKey) {
    var hist = area.key === 'benchaudit'
      ? ((HISTORY[comboKey] && HISTORY[comboKey].benchaudit) || [])
      : ((HISTORY[comboKey] && HISTORY[comboKey][area.key]) || []);
    if (!hist.length) return null;

    var block = el('section', { class: 'area-block', 'data-area': area.key });
    var head = el('div', { class: 'area-head' });
    head.appendChild(textEl('h3', 'area-title', area.label));
    block.appendChild(head);

    var histEl = area.key === 'benchaudit'
      ? buildSavedList('Completed audits', hist, buildSavedAuditEntry)
      : buildSavedList('Saved handovers', hist, buildSavedHandoverEntry);
    block.appendChild(histEl);
    return block;
  }

  function buildAreaBlock(area, comboKey) {
    if (view.mode === 'summary') return buildAreaSummaryBlock(area, comboKey);

    var block = el('section', { class: 'area-block', 'data-area': area.key });
    var head = el('div', { class: 'area-head' });
    head.appendChild(textEl('h3', 'area-title', area.label));
    if (area.key !== 'benchaudit') {
      var editBtn = el('button', { type: 'button', class: 'edit-topics-link', style: 'display:inline;padding:0;margin:6px 0 0;' });
      editBtn.textContent = 'Edit checklist';
      editBtn.addEventListener('click', function () { requestPasscode('editTopics', function () { openTopicsEditor(area.key); }); });
      head.appendChild(editBtn);
    }
    block.appendChild(head);

    var list = el('div', { class: 'topic-list' });

    if (area.key === 'benchaudit') {
      var draft = ensureDraft(comboKey, 'benchaudit');

      // Every box on this form must be filled before Save is clickable:
      // auditor, bench, Op ID, every question answered, and a comment on any
      // failing answer.
      // Returns a human-readable list of exactly what's still missing, so the
      // banner below the Save button can say precisely what to fix instead of
      // a generic reminder — the generic version left people staring at a
      // fully-filled-looking form with no way to tell which single answer or
      // comment was actually still blank.
      function benchIncompleteItems() {
        var items = [];
        if (!(draft.auditor && draft.auditor.trim())) items.push('Auditor name');
        if (!draft.bench) items.push('Bench number');
        if (!(draft.opId && draft.opId.trim())) items.push('Op ID');
        draft.answers.forEach(function (a, i) {
          var q = BENCH_AUDIT_QUESTIONS[i];
          if (!a.result) { items.push('"' + q.label + '" — needs an answer'); return; }
          if (a.result === q.mandatoryOn && !(a.note && a.note.trim())) items.push('"' + q.label + '" — needs a comment');
        });
        return items;
      }
      function isBenchValid() { return benchIncompleteItems().length === 0; }
      function updateBenchValidity() {
        var items = benchIncompleteItems();
        var valid = items.length === 0;
        saveBtn.disabled = !valid;
        // Only show the "still needed" banner once the auditor has actually
        // touched this form — right after a save, the form resets to blank
        // (ready for the next audit) and would otherwise immediately show
        // the exact same banner, which reads like the previous save failed.
        if (valid || !draft._touched) {
          errEl.setAttribute('data-visible', 'false');
        } else {
          errEl.textContent = 'Still needed: ' + items.join('; ') + '.';
          errEl.setAttribute('data-visible', 'true');
        }
      }
      function onBenchFieldChanged() { draft._touched = true; updateBenchValidity(); }

      // Auditor
      var auditorRow = el('div', { class: 'topic-row' });
      var auditorBody = el('div', { class: 'topic-body' });
      auditorBody.appendChild(textEl('span', 'topic-label', 'Auditor'));
      var auditorNote = el('div', { class: 'topic-note', contenteditable: 'true', 'data-placeholder': 'Add auditor name…' });
      if (draft.auditor) auditorNote.textContent = draft.auditor;
      auditorNote.addEventListener('input', function () { draft.auditor = auditorNote.textContent; onBenchFieldChanged(); });
      auditorBody.appendChild(auditorNote);
      auditorRow.appendChild(auditorBody);
      list.appendChild(auditorRow);

      // Bench number
      var benchRow = el('div', { class: 'topic-row' });
      var benchBody = el('div', { class: 'topic-body' });
      benchBody.appendChild(textEl('span', 'topic-label', 'Bench Number'));
      benchBody.appendChild(buildBenchPicker(draft.bench, function (v) { draft.bench = v; onBenchFieldChanged(); }));
      benchRow.appendChild(benchBody);
      list.appendChild(benchRow);

      // Op ID
      var opRow = el('div', { class: 'topic-row' });
      var opBody = el('div', { class: 'topic-body' });
      opBody.appendChild(textEl('span', 'topic-label', 'Op ID'));
      var opNote = el('div', { class: 'topic-note', contenteditable: 'true', 'data-placeholder': 'Add Op ID…' });
      if (draft.opId) opNote.textContent = draft.opId;
      opNote.addEventListener('input', function () { draft.opId = opNote.textContent; onBenchFieldChanged(); });
      opBody.appendChild(opNote);
      opRow.appendChild(opBody);
      list.appendChild(opRow);

      BENCH_AUDIT_QUESTIONS.forEach(function (q, idx) {
        var a = draft.answers[idx];
        list.appendChild(buildYesNoRow({
          label: q.label, options: q.options, mandatoryOn: q.mandatoryOn, allowPhotos: !!q.photos, photosOnFail: !!q.photosOnFail,
          prefill: a,
          onAnswer: function (v) { a.result = v; onBenchFieldChanged(); },
          onNote: function (v) { a.note = v; onBenchFieldChanged(); },
          onAddPhotos: function (files) { handlePhotoFiles(a.photos, files); },
          onRemovePhoto: function (id) {
            var pos = a.photos.findIndex(function (p) { return p.id === id; });
            if (pos > -1) { var p = a.photos[pos]; if (p.localUrl) { try { URL.revokeObjectURL(p.localUrl); } catch (e) {} } a.photos.splice(pos, 1); renderMain(); }
          }
        }));
      });
      block.appendChild(list);

      var saveRow = el('div', { class: 'area-save-row' });
      var saveBtn = el('button', { type: 'button', class: 'save-audit-btn' }); saveBtn.textContent = 'Save audit & start new';
      var status = el('span', { class: 'save-status', 'data-visible': 'false' });
      saveRow.appendChild(saveBtn); saveRow.appendChild(status);
      var errEl = el('p', { class: 'save-error', 'data-visible': 'false' }); errEl.textContent = 'Fill in every field, answer every question, and add a comment for any failing answer before saving.';
      saveBtn.addEventListener('click', function () { saveBenchAudit(comboKey, draft, saveRow, errEl); });
      block.appendChild(saveRow);
      block.appendChild(errEl);
      updateBenchValidity();
      // Completed audits are shown in Summary, not here — Board is just the
      // active entry form.
    } else {
      var d = ensureDraft(comboKey, area.key);

      // Every box must be filled before Save is clickable: every topic
      // answered Yes/No, a comment on any "No" answer, and both signoff names.
      // handoverIncompleteItems() names exactly what's still missing (rather
      // than a generic "answer every question" banner) — a checklist can grow
      // a new question at any time via "Edit checklist", and a new question
      // tucked lower on the page is easy to miss; naming it here is the
      // difference between a confusing dead-end and something a team lead can
      // act on immediately.
      function handoverIncompleteItems() {
        var items = [];
        d.topics.forEach(function (t, idx) {
          var mandatoryOn = mandatoryOnForTopic(area.key, idx);
          if (!t.result) { items.push('"' + t.label + '" — needs an answer'); return; }
          if (t.result === mandatoryOn && !(t.note && t.note.trim())) items.push('"' + t.label + '" — needs a comment');
        });
        if (!(d.given && d.given.trim())) items.push('"Handover given by" — needs a name');
        if (!(d.received && d.received.trim())) items.push('"Handover received by" — needs a name');
        return items;
      }
      function isHandoverValid() { return handoverIncompleteItems().length === 0; }
      function updateHandoverValidity() {
        var items = handoverIncompleteItems();
        var valid = items.length === 0;
        saveBtn2.disabled = !valid;
        // Only show the "still needed" banner once this entry has actually
        // been touched — right after a save, the form resets to blank (ready
        // for the next entry) and would otherwise immediately show the exact
        // same banner, which reads like the save that just succeeded failed.
        if (valid || !d._touched) {
          errEl2.setAttribute('data-visible', 'false');
        } else {
          errEl2.textContent = 'Still needed: ' + items.join('; ') + '.';
          errEl2.setAttribute('data-visible', 'true');
        }
      }
      function onHandoverFieldChanged() { d._touched = true; updateHandoverValidity(); }

      d.topics.forEach(function (t, idx) {
        list.appendChild(buildYesNoRow({
          label: t.label, options: ['Yes', 'No'], mandatoryOn: mandatoryOnForTopic(area.key, idx),
          prefill: t,
          onAnswer: function (v) { t.result = v; onHandoverFieldChanged(); },
          onNote: function (v) { t.note = v; onHandoverFieldChanged(); }
        }));
      });
      block.appendChild(list);
      block.appendChild(buildSignoff(d.given, d.received, function (which, v) { d[which] = v; onHandoverFieldChanged(); }));

      var saveRow2 = el('div', { class: 'area-save-row' });
      var saveBtn2 = el('button', { type: 'button', class: 'save-area-btn' }); saveBtn2.textContent = 'Save handover';
      var status2 = el('span', { class: 'save-status', 'data-visible': 'false' });
      saveRow2.appendChild(saveBtn2); saveRow2.appendChild(status2);
      var errEl2 = el('p', { class: 'save-error', 'data-visible': 'false' }); errEl2.textContent = 'Answer every question, add a comment for any failing answer, and sign off both names before saving.';
      saveBtn2.addEventListener('click', function () { saveHandoverArea(comboKey, area.key, d, saveRow2, errEl2); });
      block.appendChild(saveRow2);
      block.appendChild(errEl2);
      updateHandoverValidity();
      // Saved handovers are shown in Summary, not here — Board is just the
      // active entry form.
    }
    return block;
  }

  function renderMain() {
    var app = document.getElementById('app');
    var comboKey = comboKeyOf(view.date, view.shift);
    var showAreas = computeShowAreas();

    app.innerHTML = '';
    var head = el('div', { class: 'date-head' });
    head.appendChild(textEl('h2', 'date-title', formatDateLabel(view.date) + ' — ' + view.shift));
    app.appendChild(head);

    if (view.mode === 'summary') {
      var exportRows = summaryRowsForAreas(comboKey, exportAreasForType());
      var exportBar = el('div', { class: 'exportbar' });
      exportBar.appendChild(textEl('span', 'exportbar-count', exportRows.length + ' ' + (exportRows.length === 1 ? 'entry' : 'entries') + ' logged for this date and shift'));

      var exportActions = el('span', { class: 'exportbar-actions' });
      var exportTypePills = el('div', { class: 'exporttype-pills' });
      EXPORT_TYPES.forEach(function (t) {
        var pillBtn = el('button', { type: 'button', class: 'exporttype-btn', 'aria-pressed': (exportType === t.key) ? 'true' : 'false' });
        pillBtn.textContent = t.label;
        pillBtn.addEventListener('click', function () { exportType = t.key; renderMain(); });
        exportTypePills.appendChild(pillBtn);
      });
      exportActions.appendChild(exportTypePills);

      var exportBtn = el('button', { type: 'button', class: 'export-csv-btn' });
      exportBtn.textContent = 'Export CSV';
      if (!exportRows.length) exportBtn.setAttribute('disabled', 'true');
      exportBtn.addEventListener('click', exportSummaryCsv);
      exportActions.appendChild(exportBtn);

      exportBar.appendChild(exportActions);
      app.appendChild(exportBar);
      if (summaryExportMsg) app.appendChild(textEl('p', 'exportmsg', summaryExportMsg));
    }

    var builtBlocks = showAreas.map(function (a) { return buildAreaBlock(a, comboKey); }).filter(Boolean);

    var noMsg = el('p', { class: 'no-handover', 'data-visible': builtBlocks.length ? 'false' : 'true' });
    noMsg.textContent = view.mode === 'summary'
      ? 'Nothing saved for this date, shift and filter yet.'
      : 'Nothing to show for this date, shift and filter yet.';
    app.appendChild(noMsg);

    builtBlocks.forEach(function (block) { app.appendChild(block); });

    document.getElementById('deptControl').setAttribute('data-visible', view.area === 'handover' ? 'true' : 'false');
    document.body.setAttribute('data-mode', view.mode);
  }

  // ======================================================================
  // Passcode gate (past dates / edit topics / clear data)
  // ======================================================================
  var UNLOCK_KEY = 'handoverPastUnlocked';
  function isUnlocked() { try { return localStorage.getItem(UNLOCK_KEY) === '1'; } catch (e) { return false; } }
  function setUnlocked() { try { localStorage.setItem(UNLOCK_KEY, '1'); } catch (e) {} }

  var pendingPasscodeAction = null;
  var passcodeOverlay = document.getElementById('passcodeOverlay');
  var passcodeInput = document.getElementById('passcodeInput');
  var passcodeError = document.getElementById('passcodeError');
  var passcodeSub = document.getElementById('passcodeSub');

  function requestPasscode(kind, onSuccess) {
    if (kind === 'pastDate' && isUnlocked()) { onSuccess(); return; }
    pendingPasscodeAction = onSuccess;
    passcodeSub.textContent = kind === 'pastDate'
      ? 'Previous handovers are locked. Enter the shared passcode to view them.'
      : (kind === 'editTopics' ? 'Enter the passcode to edit the checklist topics.'
      : (kind === 'clearDate' ? 'Enter the passcode to clear this data.' : 'Enter the passcode to continue.'));
    passcodeInput.value = '';
    passcodeError.setAttribute('data-visible', 'false');
    passcodeOverlay.setAttribute('data-visible', 'true');
    setTimeout(function () { passcodeInput.focus(); }, 0);
  }
  function hidePasscodeGate() { passcodeOverlay.setAttribute('data-visible', 'false'); pendingPasscodeAction = null; }
  function trySubmitPasscode() {
    if (passcodeInput.value === PASSCODE) {
      setUnlocked();
      var action = pendingPasscodeAction;
      hidePasscodeGate();
      if (action) action();
    } else {
      passcodeError.setAttribute('data-visible', 'true');
      passcodeInput.value = '';
      passcodeInput.focus();
    }
  }
  document.getElementById('passcodeSubmit').addEventListener('click', trySubmitPasscode);
  document.getElementById('passcodeInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') trySubmitPasscode(); });
  document.getElementById('passcodeCancel').addEventListener('click', hidePasscodeGate);

  // ======================================================================
  // Topics editor (passcode-gated)
  // ======================================================================
  var topicsEditorOverlay = document.getElementById('topicsEditorOverlay');
  var topicsEditorBody = document.getElementById('topicsEditorBody');
  var topicsEditorError = document.getElementById('topicsEditorError');
  var topicsEditorDept = document.getElementById('topicsEditorDept');
  var topicsDraft = null;
  var topicsDraftArea = null;

  function openTopicsEditor(areaKey) {
    topicsDraftArea = areaKey;
    topicsDraft = topicsFor(areaKey);
    topicsEditorDept.textContent = 'Editing the ' + DEPT_LABELS[areaKey] + ' checklist.';
    renderTopicsEditorBody();
    topicsEditorOverlay.setAttribute('data-visible', 'true');
  }
  function renderTopicsEditorBody() {
    topicsEditorBody.innerHTML = '';
    topicsDraft.forEach(function (text, idx) {
      var row = el('div', { class: 'topics-editor-row' });
      var input = el('input', { type: 'text', class: 'topics-editor-input' });
      input.value = text;
      input.addEventListener('input', function () { topicsDraft[idx] = input.value; });
      var rm = el('button', { type: 'button', class: 'topics-editor-btn', title: 'Remove', 'aria-label': 'Remove topic' });
      rm.textContent = '×';
      rm.addEventListener('click', function () { topicsDraft.splice(idx, 1); renderTopicsEditorBody(); });
      row.appendChild(input); row.appendChild(rm);
      topicsEditorBody.appendChild(row);
    });
  }
  document.getElementById('topicsEditorAdd').addEventListener('click', function () {
    topicsDraft.push(''); renderTopicsEditorBody();
    var inputs = topicsEditorBody.querySelectorAll('.topics-editor-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  document.getElementById('topicsEditorCancel').addEventListener('click', function () {
    topicsEditorOverlay.setAttribute('data-visible', 'false'); topicsDraft = null; topicsDraftArea = null;
  });
  document.getElementById('topicsEditorSave').addEventListener('click', async function () {
    var cleaned = topicsDraft.map(function (t) { return t.trim(); }).filter(function (t) { return t.length; });
    if (!cleaned.length) { topicsEditorError.setAttribute('data-visible', 'true'); return; }
    topicsEditorError.setAttribute('data-visible', 'false');
    topicsEditorOverlay.setAttribute('data-visible', 'false');
    await saveTopics(topicsDraftArea, cleaned);
    topicsDraft = null; topicsDraftArea = null;
  });
  document.getElementById('editTopicsBtn').addEventListener('click', function () {
    // top control-bar link edits whichever single department is currently filtered to;
    // if "All"/multiple departments are showing, default to the first handover area shown.
    var areaKey = (view.dept !== 'all') ? view.dept : 'inbound';
    requestPasscode('editTopics', function () { openTopicsEditor(areaKey); });
  });

  // ======================================================================
  // Clear all data (passcode-gated)
  // ======================================================================
  var confirmClearOverlay = document.getElementById('confirmClearOverlay');
  document.getElementById('clearDataBtn').addEventListener('click', function () {
    requestPasscode('clearData', function () { confirmClearOverlay.setAttribute('data-visible', 'true'); });
  });
  document.getElementById('confirmClearCancel').addEventListener('click', function () { confirmClearOverlay.setAttribute('data-visible', 'false'); });
  document.getElementById('confirmClearGo').addEventListener('click', async function () {
    confirmClearOverlay.setAttribute('data-visible', 'false');
    await clearAllData();
  });

  // ======================================================================
  // Clear a specific date's data (passcode-gated) — a scoped alternative to
  // "Clear all data" above, so a mistake on one day (or one area/shift on
  // that day) doesn't mean wiping every date to fix it.
  // ======================================================================
  var clearDateOverlay = document.getElementById('clearDateOverlay');
  var clearDateCalMonthLabel = document.getElementById('clearDateCalMonthLabel');
  var clearDateCalGrid = document.getElementById('clearDateCalGrid');
  var clearDateAreaSelect = document.getElementById('clearDateArea');
  var clearDateShiftSelect = document.getElementById('clearDateShift');
  var clearDateSummaryEl = document.getElementById('clearDateSummary');
  var clearDateGoBtn = document.getElementById('clearDateGo');
  var clearDateSelected = null;
  var clearDateCalViewYear, clearDateCalViewMonth;

  function updateClearDateSummary() {
    var areaLabel = clearDateAreaSelect.value === 'all' ? 'every area' :
      (clearDateAreaSelect.value === 'benchaudit' ? 'EOS Bench Audit' : DEPT_LABELS[clearDateAreaSelect.value]);
    var shiftLabel = clearDateShiftSelect.value === 'all' ? 'every shift' : (clearDateShiftSelect.value + ' shift');
    clearDateGoBtn.disabled = !clearDateSelected;
    clearDateSummaryEl.textContent = clearDateSelected
      ? ('This permanently deletes ' + areaLabel + ', ' + shiftLabel + ', logged on ' + shortDateLabel(clearDateSelected) + '.')
      : 'Pick a date above.';
  }
  function renderClearDateCalendar() {
    clearDateCalMonthLabel.textContent = new Date(clearDateCalViewYear, clearDateCalViewMonth, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    clearDateCalGrid.innerHTML = '';
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { clearDateCalGrid.appendChild(textEl('span', 'date-picker-weekday', d)); });
    var first = new Date(clearDateCalViewYear, clearDateCalViewMonth, 1);
    var startWeekday = first.getDay();
    var daysInMonth = new Date(clearDateCalViewYear, clearDateCalViewMonth + 1, 0).getDate();
    for (var i = 0; i < startWeekday; i++) clearDateCalGrid.appendChild(el('span', { class: 'date-picker-day', 'data-empty': 'true' }));
    for (var day = 1; day <= daysInMonth; day++) {
      var dStr = clearDateCalViewYear + '-' + pad(clearDateCalViewMonth + 1) + '-' + pad(day);
      var btn = el('button', { type: 'button', class: 'date-picker-day', 'data-selected': (dStr === clearDateSelected) ? 'true' : 'false' });
      btn.textContent = String(day);
      btn.addEventListener('click', function (dStrCaptured) {
        return function () { clearDateSelected = dStrCaptured; renderClearDateCalendar(); updateClearDateSummary(); };
      }(dStr));
      clearDateCalGrid.appendChild(btn);
    }
  }
  document.getElementById('clearDateBtn').addEventListener('click', function () {
    clearDateSelected = view.date;
    var d = dateFromStr(clearDateSelected);
    clearDateCalViewYear = d.getFullYear(); clearDateCalViewMonth = d.getMonth();
    clearDateAreaSelect.value = 'all'; clearDateShiftSelect.value = 'all';
    renderClearDateCalendar();
    updateClearDateSummary();
    clearDateOverlay.setAttribute('data-visible', 'true');
  });
  document.getElementById('clearDateCalPrev').addEventListener('click', function () {
    clearDateCalViewMonth--; if (clearDateCalViewMonth < 0) { clearDateCalViewMonth = 11; clearDateCalViewYear--; }
    renderClearDateCalendar();
  });
  document.getElementById('clearDateCalNext').addEventListener('click', function () {
    clearDateCalViewMonth++; if (clearDateCalViewMonth > 11) { clearDateCalViewMonth = 0; clearDateCalViewYear++; }
    renderClearDateCalendar();
  });
  clearDateAreaSelect.addEventListener('change', updateClearDateSummary);
  clearDateShiftSelect.addEventListener('change', updateClearDateSummary);
  document.getElementById('clearDateCancel').addEventListener('click', function () { clearDateOverlay.setAttribute('data-visible', 'false'); });
  clearDateGoBtn.addEventListener('click', function () {
    if (!clearDateSelected) return;
    var dateStr = clearDateSelected, areaKey = clearDateAreaSelect.value, shiftKey = clearDateShiftSelect.value;
    clearDateOverlay.setAttribute('data-visible', 'false'); // out of the way before the passcode dialog stacks on top
    requestPasscode('clearDate', async function () {
      await clearDateData(dateStr, areaKey, shiftKey);
    });
  });

  // ======================================================================
  // Date picker / shift / area / dept / mode controls
  // ======================================================================
  var dateTrigger = document.getElementById('dateTrigger');
  var dateTriggerLabel = document.getElementById('dateTriggerLabel');
  var datePopover = document.getElementById('datePopover');
  var calPrevMonth = document.getElementById('calPrevMonth');
  var calNextMonth = document.getElementById('calNextMonth');
  var calMonthLabel = document.getElementById('calMonthLabel');
  var calGrid = document.getElementById('calGrid');
  var calViewYear, calViewMonth;

  function updateDateTriggerLabel() {
    dateTriggerLabel.textContent = view.date === todayStr() ? 'Today' : (view.date === tomorrowStr() ? 'Tomorrow' : shortDateLabel(view.date));
  }
  function renderCalendar() {
    calMonthLabel.textContent = new Date(calViewYear, calViewMonth, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    calGrid.innerHTML = '';
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { calGrid.appendChild(textEl('span', 'date-picker-weekday', d)); });
    var first = new Date(calViewYear, calViewMonth, 1);
    var startWeekday = first.getDay();
    var daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    for (var i = 0; i < startWeekday; i++) calGrid.appendChild(el('span', { class: 'date-picker-day', 'data-empty': 'true' }));
    for (var day = 1; day <= daysInMonth; day++) {
      var dStr = calViewYear + '-' + pad(calViewMonth + 1) + '-' + pad(day);
      var btn = el('button', { type: 'button', class: 'date-picker-day', 'data-selected': (dStr === view.date) ? 'true' : 'false' });
      btn.textContent = String(day);
      btn.addEventListener('click', function (dStrCaptured) { return function () { trySwitchDate(dStrCaptured); }; }(dStr));
      calGrid.appendChild(btn);
    }
  }
  function trySwitchDate(dStr) {
    function go() {
      view.date = dStr; updateDateTriggerLabel(); datePopover.setAttribute('data-visible', 'false'); renderMain();
      fetchDateIfNeeded(dStr); // loads older history on demand; re-renders once it lands
    }
    if (isPastDate(dStr)) {
      requestPasscode('pastDate', go);
    } else {
      go();
    }
  }
  dateTrigger.addEventListener('click', function () {
    var open = datePopover.getAttribute('data-visible') === 'true';
    if (!open) {
      var d = dateFromStr(view.date);
      calViewYear = d.getFullYear(); calViewMonth = d.getMonth();
      renderCalendar();
    }
    datePopover.setAttribute('data-visible', open ? 'false' : 'true');
  });
  calPrevMonth.addEventListener('click', function () { calViewMonth--; if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; } renderCalendar(); });
  calNextMonth.addEventListener('click', function () { calViewMonth++; if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; } renderCalendar(); });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#datePicker')) datePopover.setAttribute('data-visible', 'false');
  });

  document.getElementById('shiftSelect').addEventListener('change', function (e) { view.shift = e.target.value; renderMain(); });

  document.getElementById('areaFilter').addEventListener('click', function (e) {
    var btn = e.target.closest('.area-btn'); if (!btn) return;
    var next = btn.getAttribute('data-area');
    Array.from(this.querySelectorAll('.area-btn')).forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-area') === next ? 'true' : 'false');
    });
    view.area = next;
    renderMain();
  });

  document.getElementById('deptSelect').addEventListener('change', function (e) { view.dept = e.target.value; renderMain(); });

  document.getElementById('modeToggle').addEventListener('click', function (e) {
    var btn = e.target.closest('.mode-btn'); if (!btn) return;
    Array.from(this.querySelectorAll('.mode-btn')).forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    btn.setAttribute('aria-pressed', 'true');
    view.mode = btn.getAttribute('data-mode');
    document.body.setAttribute('data-mode', view.mode);
    renderMain();
  });

  // ======================================================================
  // Realtime + init
  // ======================================================================
  function subscribeRealtime() {
    if (!supabase || !supabase.channel) return;
    try {
      supabase.channel('handover-sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'handover_entries' }, function () { refreshFromRemote(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bench_audits' }, function () { refreshFromRemote(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'checklist_topics' }, function () { refreshFromRemote(); })
        .subscribe();
    } catch (e) {}
  }

  // renderMain() rebuilds the whole page from scratch, which replaces every
  // input/contenteditable node in it. When that happens while someone has
  // one of those fields focused — mid-typing a comment, an Op ID, a
  // signoff name — the field they're typing into is destroyed out from
  // under them: focus silently drops, and anything they type afterwards
  // lands nowhere (not in the new field, not saved anywhere) until they
  // notice and click back in. The Realtime refresh below is the main way
  // this happens in practice, since it's driven entirely by OTHER people's
  // saves — e.g. Despatch finishing their handover while Pick is still
  // mid-comment — so it can land at any moment with zero warning. That
  // silently-lost typing is exactly what shows up as "I added a comment
  // but it still won't save": the comment the person sees on screen never
  // actually made it into the saved draft. safeRenderMain() defers the
  // rebuild until the focused field is blurred, instead of tearing it down
  // mid-edit; isHandoverValid()/isBenchAuditValid() and the Save button's
  // enabled state still update live on every keystroke regardless (they're
  // wired directly to each field's own input handler, not to a render).
  var renderDeferredForFocus = false;
  function isEditingFocus() {
    var ae = document.activeElement;
    if (!ae || ae === document.body) return false;
    if (ae.isContentEditable) return true;
    var tag = ae.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }
  function safeRenderMain() {
    if (isEditingFocus()) { renderDeferredForFocus = true; return; }
    renderMain();
  }
  document.addEventListener('focusout', function () {
    if (!renderDeferredForFocus) return;
    renderDeferredForFocus = false;
    // Let the field's own blur/input handling finish updating the draft
    // (result/note/etc.) before the deferred rebuild reads it back out.
    setTimeout(function () { renderMain(); }, 0);
  }, true);

  var refreshPending = false;
  function refreshFromRemote() {
    if (refreshPending) return;
    refreshPending = true;
    setTimeout(async function () {
      refreshPending = false;
      await fetchWindow();
      await fetchDateIfNeeded(view.date); // keep an out-of-window open date live too
      safeRenderMain();
    }, 300);
  }

  async function init() {
    updateDateTriggerLabel();
    try {
      if (configOk && window.supabase && window.supabase.createClient) {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      }
    } catch (e) { supabase = null; }
    if (!supabase) {
      setReadOnly(true, configOk
        ? "Couldn't connect to the database — check the Supabase URL/key at the top of index.html."
        : "This board isn't connected to a database yet — add your Supabase URL and anon key at the top of index.html, then reload.");
    } else {
      await fetchWindow();
      subscribeRealtime();
    }
    renderMain();
  }

  // Photo thumbnails are kept small so the checklist stays compact, but
  // they should still be viewable at full size on demand. One delegated
  // listener on the app container (attached once, not re-attached on every
  // renderMain()) covers both in-progress draft photos (.condition-thumb
  // img) and saved/summary ones (.saved-thumb-img) across every re-render.
  document.getElementById('app').addEventListener('click', function (e) {
    var img = e.target.closest('.condition-thumb img, .saved-thumb-img');
    if (!img) return;
    var src = img.getAttribute('src');
    if (src) window.open(src, '_blank');
  });

  init();
})();
