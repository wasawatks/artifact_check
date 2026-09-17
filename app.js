/* Otter diet metabarcoding viewer
 * Static, client-side only. Dataset list comes from datasets.json,
 * label colors from data/color_code.tsv. Nothing is hard-coded per dataset.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Settings (paths are relative so the site works under /REPOSITORY/)
  // ------------------------------------------------------------------
  var CONFIG = {
    datasetsFile: 'datasets.json',
    colorFile: 'data/color_code.tsv',
    pxPerSample: 30,        // plot width grows by this much per sample
    plotHeight: 560,
    tableChunk: 500,        // rows rendered per "Show more" click
    maxDetails: 25          // detail lines shown per notice
  };

  var COL = { taxon: 'Final_taxon', label: 'Label', asv: 'Total_ASVs', total: 'Total_read' };

  var FALLBACK_PALETTE = [
    '#4E79A7', '#F28E2B', '#59A14F', '#B07AA1', '#76B7B2', '#EDC948',
    '#9C755F', '#FF9DA7', '#BAB0AC', '#6B8E23', '#8C564B', '#17BECF',
    '#BCBD22', '#7F7F7F', '#1F77B4', '#AEC7E8'
  ];

  var NA_TOKENS = { '': 1, 'na': 1, 'n/a': 1, 'nan': 1, 'null': 1, 'none': 1, '-': 1 };
  var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  var MISSING_LABEL = '(missing label)';

  // ------------------------------------------------------------------
  // Pure data functions (no DOM) — also exported for testing in Node
  // ------------------------------------------------------------------

  function DataError(message) {
    this.name = 'DataError';
    this.message = message;
  }
  DataError.prototype = Object.create(Error.prototype);

  /** Collects notices, grouping repeated problems under one heading. */
  function NoticeLog() { this.groups = new Map(); }
  NoticeLog.prototype.add = function (level, key, title, detail) {
    var g = this.groups.get(key);
    if (!g) { g = { level: level, title: title, details: [] }; this.groups.set(key, g); }
    if (detail !== undefined) g.details.push(detail);
  };
  NoticeLog.prototype.list = function () { return Array.from(this.groups.values()); };

  /** Split TSV text into trimmed cells. Handles BOM and CRLF.
   *  Only leading/trailing whitespace is trimmed, so "Artifact  (Primates)"
   *  keeps its double space and still matches color_code.tsv. */
  function splitTSV(text) {
    var lines = String(text).replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      var cells = lines[i].split('\t');
      for (var c = 0; c < cells.length; c++) cells[c] = cells[c].trim();
      rows.push({ line: i + 1, cells: cells });
    }
    return rows;
  }

  /** Parse a read/ASV count. Empty and NA become 0; anything else malformed is flagged. */
  function parseCount(raw) {
    if (raw === undefined || raw === null) return { value: 0, kind: 'empty' };
    var s = String(raw);
    if (s === '') return { value: 0, kind: 'empty' };
    if (NA_TOKENS[s.toLowerCase()]) return { value: 0, kind: 'na' };
    if (!NUM_RE.test(s)) return { value: 0, kind: 'invalid' };
    var v = Number(s);
    if (!isFinite(v)) return { value: 0, kind: 'invalid' };
    if (v < 0) return { value: 0, kind: 'negative' };
    return { value: v, kind: 'ok' };
  }

  function normalizeColor(raw) {
    var s = String(raw || '').trim();
    if (/^[0-9a-f]{6}$/i.test(s) || /^[0-9a-f]{3}$/i.test(s)) s = '#' + s;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s.toUpperCase();
    return null;
  }

  function findCol(header, name) {
    var lower = name.toLowerCase();
    for (var i = 0; i < header.length; i++) if (header[i].toLowerCase() === lower) return i;
    return -1;
  }

  /** color_code.tsv -> { map: Map(label -> color), notices } */
  function parseColorTable(text) {
    var log = new NoticeLog();
    var map = new Map();
    var rows = splitTSV(text);
    if (!rows.length) {
      log.add('error', 'color-empty', 'color_code.tsv is empty. All labels use fallback colors.');
      return { map: map, notices: log.list() };
    }
    var header = rows[0].cells;
    var iL = findCol(header, 'Label');
    var iC = findCol(header, 'Color_code');
    if (iL < 0 || iC < 0) {
      log.add('error', 'color-header',
        'color_code.tsv must have the columns "Label" and "Color_code". Found: ' + header.join(', ') + '. All labels use fallback colors.');
      return { map: map, notices: log.list() };
    }
    var firstLine = new Map();
    var dupes = new Map();
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var label = row.cells[iL] || '';
      var colorRaw = row.cells[iC] || '';
      if (!label) {
        log.add('warning', 'color-nolabel', 'color_code.tsv has rows without a Label. They were ignored.', 'line ' + row.line);
        continue;
      }
      if (firstLine.has(label)) {
        if (!dupes.has(label)) dupes.set(label, [firstLine.get(label)]);
        dupes.get(label).push(row.line);
        continue;
      }
      firstLine.set(label, row.line);
      var color = normalizeColor(colorRaw);
      if (!color) {
        log.add('warning', 'color-invalid',
          'color_code.tsv has invalid colors. Those labels use fallback colors. Use hex codes such as #B45253.',
          '"' + label + '" → "' + colorRaw + '" (line ' + row.line + ')');
        continue;
      }
      map.set(label, color);
    }
    dupes.forEach(function (lines, label) {
      log.add('error', 'color-dupe',
        'Duplicate labels in color_code.tsv. Each label must appear once; the first occurrence is used.',
        '"' + label + '" on lines ' + lines.join(', '));
    });
    return { map: map, notices: log.list() };
  }

  /** Dataset TSV -> structured rows. Throws DataError when the file cannot be used. */
  function parseDataset(text) {
    var log = new NoticeLog();
    var rows = splitTSV(text);
    if (!rows.length) throw new DataError('The file is empty.');

    var header = rows[0].cells;
    if (header.length < 2) {
      throw new DataError('The header has only one column. Check that the file is tab-separated (not comma- or space-separated).');
    }
    var idx = {
      taxon: findCol(header, COL.taxon),
      label: findCol(header, COL.label),
      asv: findCol(header, COL.asv),
      total: findCol(header, COL.total)
    };
    var missing = Object.keys(idx).filter(function (k) { return idx[k] < 0; })
      .map(function (k) { return COL[k]; });
    if (missing.length) {
      throw new DataError('Required column(s) missing: ' + missing.join(', ') +
        '. Expected header: Final_taxon, Label, Total_ASVs, <samples…>, Total_read. Found: ' + header.join(', '));
    }
    if (idx.total < idx.asv) {
      throw new DataError('Total_read must come after Total_ASVs. Sample columns are the columns between them.');
    }
    if (idx.taxon !== 0 || idx.label !== 1 || idx.asv !== 2 || idx.total !== header.length - 1) {
      log.add('warning', 'col-order',
        'Columns are not in the expected order (Final_taxon, Label, Total_ASVs, samples, Total_read). Columns were matched by name; samples are the columns between Total_ASVs and Total_read.');
    }

    // Samples: every column strictly between Total_ASVs and Total_read, in header order.
    var samples = [];
    var seen = new Map();
    for (var c = idx.asv + 1; c < idx.total; c++) {
      if (c === idx.taxon || c === idx.label) continue;
      var name = header[c];
      if (!name) {
        name = '(unnamed column ' + (c + 1) + ')';
        log.add('warning', 'sample-blank', 'Some sample columns have no name.', 'column ' + (c + 1));
      }
      if (seen.has(name)) {
        var n = seen.get(name) + 1;
        seen.set(name, n);
        log.add('warning', 'sample-dupe', 'Duplicate sample names were made unique by adding a number.', name + ' → ' + name + ' (' + n + ')');
        name = name + ' (' + n + ')';
      } else {
        seen.set(name, 1);
      }
      samples.push({ name: name, col: c });
    }
    if (!samples.length) {
      throw new DataError('No sample columns found. Sample columns must sit between Total_ASVs and Total_read.');
    }
    if (rows.length < 2) throw new DataError('The file has a header but no data rows.');

    var nS = samples.length;
    var out = [];
    var naCells = 0;
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var cells = row.cells;
      if (cells.length !== header.length) {
        log.add('warning', 'row-width',
          'Some rows have a different number of columns than the header. Missing cells were read as empty; extra cells were ignored.',
          'line ' + row.line + ': ' + cells.length + ' columns, header has ' + header.length);
      }
      var label = cells[idx.label] || '';
      if (!label) {
        label = MISSING_LABEL;
        log.add('warning', 'row-nolabel', 'Some rows have no Label. They are grouped as "' + MISSING_LABEL + '".',
          'line ' + row.line + (cells[idx.taxon] ? ' (' + cells[idx.taxon] + ')' : ''));
      }

      var asv = parseCount(cells[idx.asv]);
      if (asv.kind === 'invalid' || asv.kind === 'negative') {
        log.add('warning', 'bad-asv', 'Non-numeric or negative Total_ASVs values were counted as 0.',
          'line ' + row.line + ': "' + cells[idx.asv] + '"');
      }

      var counts = new Float64Array(nS);
      var kinds = new Array(nS);
      var sum = 0;
      for (var j = 0; j < nS; j++) {
        var raw = cells[samples[j].col];
        var p = parseCount(raw);
        counts[j] = p.value;
        kinds[j] = p.kind;
        sum += p.value;
        if (p.kind === 'invalid' || p.kind === 'negative') {
          log.add('warning', 'bad-read',
            'Malformed read counts were found and counted as 0. These plot values may be too low until the file is fixed.',
            'line ' + row.line + ', ' + samples[j].name + ': "' + raw + '"');
        } else if (p.kind === 'na' || p.kind === 'empty') {
          naCells++;
        }
      }

      var total = parseCount(cells[idx.total]);
      if (total.kind === 'invalid' || total.kind === 'negative') {
        log.add('warning', 'bad-total', 'Some Total_read values are not valid numbers.',
          'line ' + row.line + ': "' + cells[idx.total] + '"');
      } else if (total.kind === 'ok' && Math.abs(total.value - sum) > 0.5) {
        log.add('warning', 'total-mismatch',
          'Total_read does not match the sum of the sample columns on some rows. The plot uses the sample columns.',
          'line ' + row.line + ': Total_read ' + fmt(total.value) + ', samples sum to ' + fmt(sum));
      }

      out.push({
        line: row.line,
        cells: cells,
        taxon: cells[idx.taxon] || '',
        label: label,
        asv: asv.value,
        asvKind: asv.kind,
        counts: counts,
        kinds: kinds,
        total: total.value,
        totalKind: total.kind
      });
    }
    if (naCells) {
      log.add('info', 'na-cells', naCells.toLocaleString('en-US') + ' empty or NA read cells were counted as 0.');
    }

    return { header: header, idx: idx, samples: samples, rows: out, notices: log.list() };
  }

  /** Merge rows by Label (first-appearance order). Sum reads per sample and Total_ASVs. */
  function aggregateByLabel(ds) {
    var nS = ds.samples.length;
    var byLabel = new Map();
    for (var i = 0; i < ds.rows.length; i++) {
      var row = ds.rows[i];
      var g = byLabel.get(row.label);
      if (!g) {
        g = { name: row.label, asvs: 0, reads: new Float64Array(nS), pooled: 0, rowCount: 0 };
        byLabel.set(row.label, g);
      }
      g.asvs += row.asv;
      g.rowCount++;
      for (var j = 0; j < nS; j++) g.reads[j] += row.counts[j];
    }
    var labels = Array.from(byLabel.values());
    var sampleTotals = new Float64Array(nS);
    var grand = 0;
    labels.forEach(function (g) {
      for (var j = 0; j < nS; j++) { sampleTotals[j] += g.reads[j]; g.pooled += g.reads[j]; }
      grand += g.pooled;
    });
    labels.forEach(function (g) {
      g.pct = new Float64Array(nS);
      for (var j = 0; j < nS; j++) {
        // Zero-read samples get 0% for every label (no division by zero).
        g.pct[j] = sampleTotals[j] > 0 ? (g.reads[j] / sampleTotals[j]) * 100 : 0;
      }
      g.pooledPct = grand > 0 ? (g.pooled / grand) * 100 : 0;
    });
    var zeroSamples = [];
    for (var j = 0; j < nS; j++) if (sampleTotals[j] === 0) zeroSamples.push(ds.samples[j].name);
    return { labels: labels, sampleTotals: sampleTotals, grandTotal: grand, zeroSamples: zeroSamples };
  }

  // Missing labels get the same fallback color in every dataset during a session.
  var fallbackAssigned = new Map();
  function colorFor(label, colorMap) {
    if (colorMap && colorMap.has(label)) return { color: colorMap.get(label), fallback: false };
    if (!fallbackAssigned.has(label)) {
      fallbackAssigned.set(label, FALLBACK_PALETTE[fallbackAssigned.size % FALLBACK_PALETTE.length]);
    }
    return { color: fallbackAssigned.get(label), fallback: true };
  }

  function fmt(n) {
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      splitTSV: splitTSV, parseCount: parseCount, parseColorTable: parseColorTable,
      parseDataset: parseDataset, aggregateByLabel: aggregateByLabel, colorFor: colorFor
    };
  }
  if (typeof document === 'undefined') return;

  // ------------------------------------------------------------------
  // Browser UI
  // ------------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    datasets: [],
    listNotices: [],
    activeIndex: -1,
    view: 'plot',
    colors: { map: new Map(), notices: [] },
    cache: new Map(),       // file -> Promise<{ds, agg}>
    hidden: new Set(),      // hidden labels in the plot (reset per dataset)
    plotKey: null,          // which dataset the plot currently shows
    current: null,          // {entry, ds, agg, colors}
    table: null             // table view state
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // cache: 'no-cache' makes the browser revalidate with GitHub Pages every time,
  // so an updated TSV shows up as soon as the new deployment is live.
  function fetchText(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('Could not load "' + url + '" (HTTP ' + res.status + '). Check that the file exists and the path in datasets.json is correct (paths are case-sensitive).');
      return res.text();
    }, function (err) {
      throw new Error('Could not load "' + url + '": ' + err.message +
        (location.protocol === 'file:' ? ' Browsers block file loading from file:// pages; run a local web server (see README).' : ''));
    });
  }

  function loadColors() {
    return fetchText(CONFIG.colorFile).then(parseColorTable, function (err) {
      return {
        map: new Map(),
        notices: [{ level: 'error', title: err.message + ' All labels use fallback colors.', details: [] }]
      };
    });
  }

  function loadDatasetList() {
    return fetchText(CONFIG.datasetsFile).then(function (text) {
      var list;
      try { list = JSON.parse(text); } catch (e) {
        throw new Error('datasets.json is not valid JSON: ' + e.message + '. Check for missing commas or a trailing comma after the last entry.');
      }
      if (!Array.isArray(list)) throw new Error('datasets.json must contain a list: [ {"name": …, "file": …}, … ]');
      var log = new NoticeLog();
      var names = new Set();
      var colorPath = CONFIG.colorFile.toLowerCase();
      var clean = [];
      list.forEach(function (e, i) {
        if (!e || typeof e.name !== 'string' || typeof e.file !== 'string' || !e.name.trim() || !e.file.trim()) {
          log.add('warning', 'list-bad', 'Some entries in datasets.json need both "name" and "file". They were skipped.', 'entry ' + (i + 1) + ': ' + JSON.stringify(e));
          return;
        }
        var file = e.file.trim().replace(/^\.\//, '');
        if (file.toLowerCase() === colorPath) {
          log.add('warning', 'list-color', 'color_code.tsv is the color settings file, not a dataset, so it is not listed.');
          return;
        }
        if (file.charAt(0) === '/') {
          log.add('warning', 'list-abs', 'Some dataset paths start with "/". On a GitHub Pages project site they should be relative, e.g. data/file.tsv. The leading "/" was removed.', e.file);
          file = file.replace(/^\/+/, '');
        }
        var name = e.name.trim();
        if (names.has(name)) {
          log.add('warning', 'list-dupe', 'Duplicate dataset names in datasets.json. Only the first is listed.', name);
          return;
        }
        names.add(name);
        clean.push({ name: name, file: file, meta: '' });
      });
      state.listNotices = log.list();
      return clean;
    });
  }

  function loadDataset(entry) {
    if (!state.cache.has(entry.file)) {
      var p = fetchText(entry.file).then(function (text) {
        var ds = parseDataset(text);
        return { ds: ds, agg: aggregateByLabel(ds) };
      });
      p.catch(function () { state.cache.delete(entry.file); }); // allow retry after failure
      state.cache.set(entry.file, p);
    }
    return state.cache.get(entry.file);
  }

  // ---------- Sidebar ----------
  function renderSidebar() {
    var nav = $('dataset-list');
    nav.innerHTML = '';
    if (!state.datasets.length) {
      nav.innerHTML = '<p class="sidebar-status">No datasets listed. Add entries to datasets.json.</p>';
      return;
    }
    state.datasets.forEach(function (d, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dataset-btn';
      b.dataset.index = i;
      b.innerHTML = '<span class="dataset-name"></span><span class="dataset-meta"></span>';
      b.firstChild.textContent = d.name;
      b.title = d.file;
      b.addEventListener('click', function () { selectDataset(i); });
      nav.appendChild(b);
    });
  }

  function updateSidebar() {
    var btns = document.querySelectorAll('.dataset-btn');
    btns.forEach(function (b) {
      var i = Number(b.dataset.index);
      b.setAttribute('aria-current', i === state.activeIndex ? 'true' : 'false');
      b.lastChild.textContent = state.datasets[i].meta || '';
    });
  }

  // ---------- Routing (#dataset=…&view=…) ----------
  function readHash() {
    var params = new URLSearchParams(location.hash.slice(1));
    return { dataset: params.get('dataset'), view: params.get('view') };
  }
  function writeHash() {
    var entry = state.datasets[state.activeIndex];
    if (!entry) return;
    var params = new URLSearchParams();
    params.set('dataset', entry.name);
    params.set('view', state.view);
    var h = '#' + params.toString();
    if (location.hash !== h) history.replaceState(null, '', h);
  }

  // ---------- Selection ----------
  function selectDataset(i) {
    if (i < 0 || i >= state.datasets.length) return;
    var entry = state.datasets[i];
    state.activeIndex = i;
    state.current = null;
    state.hidden = new Set();
    updateSidebar();
    writeHash();

    $('dataset-title').textContent = entry.name;
    $('dataset-stats').hidden = true;
    $('ribbon-wrap').hidden = true;
    setStatus('Loading ' + entry.file + '…');
    hidePanels();

    loadDataset(entry).then(function (res) {
      if (state.activeIndex !== i) return; // user moved on
      var colors = new Map();
      var fallbackLabels = [];
      res.agg.labels.forEach(function (g) {
        var c = colorFor(g.name, state.colors.map);
        colors.set(g.name, c);
        if (c.fallback) fallbackLabels.push(g.name);
      });
      entry.meta = res.ds.samples.length + ' samples, ' + res.agg.labels.length + ' labels';
      state.current = { entry: entry, ds: res.ds, agg: res.agg, colors: colors, fallbackLabels: fallbackLabels };
      state.plotKey = null;
      state.table = null;
      updateSidebar();
      setStatus('');
      renderHeader();
      renderNotices();
      showView(state.view);
    }).catch(function (err) {
      if (state.activeIndex !== i) return;
      var prefix = err instanceof DataError ? 'Cannot display "' + entry.file + '": ' : '';
      setStatus(prefix + err.message, true, function () { selectDataset(i); });
      renderNotices();
    });
  }

  function setStatus(msg, isError, retry) {
    var el = $('status');
    el.className = 'status' + (isError ? ' is-error' : '');
    el.textContent = msg || '';
    if (retry) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'more-btn retry-btn';
      b.textContent = 'Try again';
      b.addEventListener('click', retry);
      el.appendChild(b);
    }
  }

  function hidePanels() {
    $('panel-plot').hidden = true;
    $('panel-table').hidden = true;
  }

  // ---------- Header ----------
  function renderHeader() {
    var cur = state.current;
    var stats = [
      ['Samples', cur.ds.samples.length],
      ['Taxon rows', cur.ds.rows.length],
      ['Labels', cur.agg.labels.length],
      ['Total reads', cur.agg.grandTotal]
    ];
    var dl = $('dataset-stats');
    dl.innerHTML = stats.map(function (s) {
      return '<div><dt>' + s[0] + '</dt><dd>' + fmt(s[1]) + '</dd></div>';
    }).join('');
    dl.hidden = false;

    var ribbon = $('ribbon');
    ribbon.innerHTML = '';
    cur.agg.labels.forEach(function (g) {
      if (g.pooledPct <= 0) return;
      var s = document.createElement('span');
      s.style.flex = '0 0 ' + g.pooledPct + '%';
      s.style.background = cur.colors.get(g.name).color;
      s.title = g.name + ': ' + g.pooledPct.toFixed(2) + '% of all reads';
      ribbon.appendChild(s);
    });
    $('ribbon-wrap').hidden = cur.agg.grandTotal <= 0;
  }

  // ---------- Notices ----------
  function renderNotices() {
    var items = [].concat(state.colors.notices, state.listNotices);
    var cur = state.current;
    if (cur) {
      if (cur.fallbackLabels.length) {
        items.push({
          level: 'warning',
          title: 'These labels have no color in data/color_code.tsv, so a fallback color was assigned (dashed outline in the legend). Add them to color_code.tsv to fix this.',
          details: cur.fallbackLabels.map(function (l) { return '"' + l + '"'; })
        });
      }
      if (cur.agg.zeroSamples.length) {
        items.push({
          level: 'warning',
          title: 'Some samples have 0 reads in total. Their bars are empty.',
          details: cur.agg.zeroSamples
        });
      }
      items = items.concat(cur.ds.notices);
    }
    var box = $('notices');
    if (!items.length) { box.hidden = true; return; }

    var counts = { error: 0, warning: 0, info: 0 };
    items.forEach(function (n) { counts[n.level]++; });
    var parts = [];
    if (counts.error) parts.push(counts.error + (counts.error === 1 ? ' error' : ' errors'));
    if (counts.warning) parts.push(counts.warning + (counts.warning === 1 ? ' warning' : ' warnings'));
    if (counts.info) parts.push(counts.info + ' note' + (counts.info === 1 ? '' : 's'));
    $('notices-summary').textContent = 'Data check: ' + parts.join(', ');
    box.classList.toggle('has-error', counts.error > 0);

    var order = { error: 0, warning: 1, info: 2 };
    items.sort(function (a, b) { return order[a.level] - order[b.level]; });
    $('notices-list').innerHTML = items.map(function (n) {
      var d = '';
      if (n.details && n.details.length) {
        var shown = n.details.slice(0, CONFIG.maxDetails).map(function (x) {
          return '<li><code>' + escapeHtml(x) + '</code></li>';
        }).join('');
        var extra = n.details.length - CONFIG.maxDetails;
        if (extra > 0) shown += '<li>…and ' + extra + ' more</li>';
        d = '<ul class="notice-details">' + shown + '</ul>';
      }
      return '<li><span class="notice-level ' + n.level + '">' + n.level + '</span>' + escapeHtml(n.title) + d + '</li>';
    }).join('');
    box.hidden = false;
    if (counts.error || counts.warning) box.open = true;
  }

  // ---------- Tabs ----------
  function showView(view) {
    state.view = view === 'table' ? 'table' : 'plot';
    ['plot', 'table'].forEach(function (v) {
      var tab = $('tab-' + v);
      var on = v === state.view;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });
    writeHash();
    if (!state.current) return;
    $('panel-plot').hidden = state.view !== 'plot';
    $('panel-table').hidden = state.view !== 'table';
    // Plotly needs a visible container to measure, so render only when shown.
    if (state.view === 'plot') renderPlot();
    else renderTable();
  }

  function bindTabs() {
    var tabs = [$('tab-plot'), $('tab-table')];
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { showView(t.dataset.view); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          var next = tabs[(i + 1) % 2];
          next.focus();
          showView(next.dataset.view);
          e.preventDefault();
        }
      });
    });
  }

  // ---------- Plot ----------
  function plotWidth(n) {
    var avail = $('plot-scroll').clientWidth || 800;
    return Math.max(avail, Math.round(n * CONFIG.pxPerSample + 120));
  }

  function renderPlot() {
    var cur = state.current;
    var plotEl = $('plot');
    if (typeof Plotly === 'undefined') {
      setStatus('The plotting library (Plotly) could not be loaded from the CDN. Check your internet connection; the Table tab still works.', true);
      return;
    }
    var key = cur.entry.file;
    var n = cur.ds.samples.length;
    if (state.plotKey === key) { // same dataset: only fix the width
      Plotly.relayout(plotEl, { width: plotWidth(n) });
      return;
    }
    var names = cur.ds.samples.map(function (s) { return s.name; });
    var traces = cur.agg.labels.map(function (g) {
      var custom = new Array(n);
      var safeLabel = escapeHtml(g.name);
      for (var j = 0; j < n; j++) custom[j] = [g.reads[j], g.asvs, g.pct[j], safeLabel];
      return {
        type: 'bar',
        name: g.name,
        x: names,
        y: Array.from(g.pct),
        customdata: custom,
        marker: { color: cur.colors.get(g.name).color, line: { width: 0 } },
        hovertemplate:
          'Sample: %{x}<br>' +
          'Label: %{customdata[3]}<br>' +
          'Total reads: %{customdata[0]:,}<br>' +
          'Percentage: %{customdata[2]:.2f}%<br>' +
          'Total ASVs: %{customdata[1]:,}<extra></extra>',
        visible: state.hidden.has(g.name) ? 'legendonly' : true
      };
    });

    var maxLen = names.reduce(function (m, s) { return Math.max(m, s.length); }, 0);
    var rotate = n > 8 || maxLen * n * 7 > plotWidth(n);
    var annotations = cur.agg.zeroSamples.map(function (s) {
      return { x: s, y: 2, text: 'no reads', textangle: -90, yanchor: 'bottom', showarrow: false,
        font: { size: 10, color: '#8a9895' } };
    });

    var layout = {
      barmode: 'stack',
      width: plotWidth(n),
      height: CONFIG.plotHeight,
      bargap: n > 40 ? 0.12 : (n < 6 ? 0.5 : 0.22),
      margin: { l: 70, r: 20, t: 14, b: 20 },
      font: { family: '"Public Sans", system-ui, sans-serif', size: 12, color: '#1d2b2a' },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: '#ffffff',
      showlegend: false,
      hovermode: 'closest',
      hoverlabel: { bgcolor: '#ffffff', bordercolor: '#17423f', font: { color: '#1d2b2a', size: 13 } },
      xaxis: {
        type: 'category',
        categoryorder: 'array',
        categoryarray: names,
        tickangle: rotate ? -60 : 0,
        automargin: true,
        tickfont: { size: 11 },
        title: { text: 'Sample', standoff: 12 }
      },
      yaxis: {
        range: [0, 100],
        dtick: 20,
        ticksuffix: '%',
        gridcolor: '#e3eae7',
        zeroline: false,
        fixedrange: true,
        title: { text: 'Reads (%)' }
      },
      annotations: annotations
    };
    var config = {
      displaylogo: false,
      responsive: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
      toImageButtonOptions: {
        format: 'png',
        filename: cur.entry.name.replace(/[^\w.-]+/g, '_') + '_composition',
        scale: 2
      }
    };
    Plotly.react(plotEl, traces, layout, config);
    state.plotKey = key;
    renderLegend();
  }

  function renderLegend() {
    var cur = state.current;
    var box = $('legend');
    box.innerHTML = '';
    cur.agg.labels.forEach(function (g, i) {
      var c = cur.colors.get(g.name);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'legend-item';
      b.setAttribute('aria-pressed', state.hidden.has(g.name) ? 'false' : 'true');
      b.title = (c.fallback ? 'Fallback color: add this label to color_code.tsv. ' : '') +
        fmt(g.pooled) + ' reads, ' + fmt(g.asvs) + ' ASVs, ' + g.rowCount + ' taxon row(s)';
      b.innerHTML = '<span class="swatch' + (c.fallback ? ' is-fallback' : '') + '" style="background:' + c.color + '"></span>' +
        '<span>' + escapeHtml(g.name) + '</span>' +
        '<span class="legend-pct">' + g.pooledPct.toFixed(1) + '%</span>';
      b.addEventListener('click', function () {
        if (state.hidden.has(g.name)) state.hidden.delete(g.name); else state.hidden.add(g.name);
        b.setAttribute('aria-pressed', state.hidden.has(g.name) ? 'false' : 'true');
        Plotly.restyle($('plot'), { visible: state.hidden.has(g.name) ? 'legendonly' : true }, [i]);
        updateLegendButtons();
      });
      box.appendChild(b);
    });
    box.appendChild(bulkButton('legend-show-all', 'Show all labels', false));
    box.appendChild(bulkButton('legend-hide-all', 'Hide all labels', true));
    updateLegendButtons();
  }

  /** "Show all labels" / "Hide all labels" */
  function bulkButton(id, text, hide) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'legend-reset';
    b.id = id;
    b.textContent = text;
    b.addEventListener('click', function () {
      state.hidden = new Set(hide ? state.current.agg.labels.map(function (g) { return g.name; }) : []);
      Plotly.restyle($('plot'), { visible: hide ? 'legendonly' : true });
      $('legend').querySelectorAll('.legend-item').forEach(function (item) {
        item.setAttribute('aria-pressed', hide ? 'false' : 'true');
      });
      updateLegendButtons();
    });
    return b;
  }

  function updateLegendButtons() {
    var total = state.current ? state.current.agg.labels.length : 0;
    var show = $('legend-show-all');
    var hide = $('legend-hide-all');
    if (show) show.hidden = state.hidden.size === 0;       // nothing hidden yet
    if (hide) hide.hidden = state.hidden.size >= total;     // everything already hidden
  }

  // ---------- Table (original rows) ----------
  function renderTable() {
    var cur = state.current;
    if (state.table && state.table.key === cur.entry.file) { renderTableBody(); return; }

    var ds = cur.ds;
    // Column plan in original header order
    var cols = ds.header.map(function (h, c) {
      var type = 'text';
      if (c === ds.idx.asv || c === ds.idx.total) type = 'num';
      if (ds.samples.some(function (s) { return s.col === c; })) type = 'num';
      return { col: c, name: h || '(unnamed)', type: type };
    });
    var sampleIndexByCol = new Map(ds.samples.map(function (s, j) { return [s.col, j]; }));

    state.table = {
      key: cur.entry.file,
      cols: cols,
      sampleIndexByCol: sampleIndexByCol,
      search: ds.rows.map(function (r) { return (r.taxon + '\u0001' + r.label).toLowerCase(); }),
      sortCol: null,
      sortDir: 0,
      query: '',
      label: '',
      limit: CONFIG.tableChunk
    };

    // Header
    var thead = $('data-table').tHead;
    thead.innerHTML = '<tr>' + cols.map(function (c, k) {
      var cls = [c.type === 'num' ? 'num' : '', c.col === ds.idx.taxon ? 'col-taxon' : ''].join(' ');
      return '<th class="' + cls + '" aria-sort="none"><button type="button" class="sort-btn" data-k="' + k + '">' +
        escapeHtml(c.name) + '<span class="sort-ind" aria-hidden="true"></span></button></th>';
    }).join('') + '</tr>';

    // Label filter options
    var sel = $('table-label');
    sel.innerHTML = '<option value="">All labels</option>' + cur.agg.labels.map(function (g) {
      return '<option>' + escapeHtml(g.name) + '</option>';
    }).join('');
    $('table-search').value = '';
    renderTableBody();
  }

  function numericValue(row, c, ds, t) {
    if (c === ds.idx.asv) return row.asvKind === 'ok' ? row.asv : -Infinity;
    if (c === ds.idx.total) return row.totalKind === 'ok' ? row.total : -Infinity;
    var j = t.sampleIndexByCol.get(c);
    return row.kinds[j] === 'ok' ? row.counts[j] : -Infinity;
  }

  function renderTableBody() {
    var cur = state.current;
    var ds = cur.ds;
    var t = state.table;
    var q = t.query.toLowerCase();

    var idxs = [];
    for (var i = 0; i < ds.rows.length; i++) {
      if (t.label && ds.rows[i].label !== t.label) continue;
      if (q && t.search[i].indexOf(q) === -1) continue;
      idxs.push(i);
    }
    if (t.sortCol !== null && t.sortDir !== 0) {
      var colDef = t.cols[t.sortCol];
      var dir = t.sortDir;
      if (colDef.type === 'num') {
        var vals = new Map();
        idxs.forEach(function (i) { vals.set(i, numericValue(ds.rows[i], colDef.col, ds, t)); });
        idxs.sort(function (a, b) { return (vals.get(a) - vals.get(b)) * dir || a - b; });
      } else {
        var coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
        idxs.sort(function (a, b) {
          return coll.compare(ds.rows[a].cells[colDef.col] || '', ds.rows[b].cells[colDef.col] || '') * dir || a - b;
        });
      }
    }

    var shown = Math.min(idxs.length, t.limit);
    var html = new Array(shown);
    for (var k = 0; k < shown; k++) html[k] = rowHtml(ds.rows[idxs[k]], ds, t, cur);
    $('data-table').tBodies[0].innerHTML = shown ? html.join('')
      : '<tr><td colspan="' + t.cols.length + '">No rows match. Clear the search or pick another label.</td></tr>';

    $('table-count').textContent = 'Showing ' + fmt(shown) + ' of ' + fmt(idxs.length) + ' matching rows (' + fmt(ds.rows.length) + ' total)';
    var more = $('table-more');
    more.hidden = shown >= idxs.length;
    more.textContent = 'Show ' + fmt(Math.min(CONFIG.tableChunk, idxs.length - shown)) + ' more rows';

    // Sort indicators
    $('data-table').tHead.querySelectorAll('th').forEach(function (th, k) {
      var active = t.sortCol === k && t.sortDir !== 0;
      th.setAttribute('aria-sort', active ? (t.sortDir > 0 ? 'ascending' : 'descending') : 'none');
      th.querySelector('.sort-ind').textContent = active ? (t.sortDir > 0 ? '▲' : '▼') : '';
    });
  }

  function rowHtml(row, ds, t, cur) {
    var out = '<tr>';
    for (var k = 0; k < t.cols.length; k++) {
      var c = t.cols[k].col;
      var raw = row.cells[c] === undefined ? '' : row.cells[c];
      if (c === ds.idx.taxon) {
        out += '<td class="col-taxon">' + escapeHtml(raw).replace(/;/g, ';<wbr>') + '</td>';
      } else if (c === ds.idx.label) {
        var col = cur.colors.get(row.label);
        out += '<td><span class="label-cell"><span class="swatch' + (col.fallback ? ' is-fallback' : '') +
          '" style="background:' + col.color + '"></span>' + escapeHtml(raw || MISSING_LABEL) + '</span></td>';
      } else if (t.cols[k].type === 'num') {
        var kind, value;
        if (c === ds.idx.asv) { kind = row.asvKind; value = row.asv; }
        else if (c === ds.idx.total) { kind = row.totalKind; value = row.total; }
        else { var j = t.sampleIndexByCol.get(c); kind = row.kinds[j]; value = row.counts[j]; }
        var extra = c === ds.idx.total ? ' col-total' : '';
        if (kind === 'ok') {
          out += '<td class="num' + (value === 0 ? ' zero' : '') + extra + '">' + fmt(value) + '</td>';
        } else if (kind === 'invalid' || kind === 'negative') {
          out += '<td class="num bad' + extra + '" title="Not a valid read count; counted as 0">' + escapeHtml(raw) + '</td>';
        } else {
          out += '<td class="num na' + extra + '" title="Counted as 0">' + (raw ? escapeHtml(raw) : '') + '</td>';
        }
      } else {
        out += '<td>' + escapeHtml(raw) + '</td>';
      }
    }
    return out + '</tr>';
  }

  function bindTable() {
    $('data-table').tHead.addEventListener('click', function (e) {
      var btn = e.target.closest('.sort-btn');
      if (!btn || !state.table) return;
      var k = Number(btn.dataset.k);
      var t = state.table;
      if (t.sortCol !== k) { t.sortCol = k; t.sortDir = t.cols[k].type === 'num' ? -1 : 1; }
      else if (t.sortDir !== 0) { t.sortDir = t.sortDir === (t.cols[k].type === 'num' ? -1 : 1) ? -t.sortDir : 0; }
      else { t.sortDir = t.cols[k].type === 'num' ? -1 : 1; }
      renderTableBody();
    });
    var timer = null;
    $('table-search').addEventListener('input', function (e) {
      clearTimeout(timer);
      var v = e.target.value.trim();
      timer = setTimeout(function () {
        if (!state.table) return;
        state.table.query = v;
        state.table.limit = CONFIG.tableChunk;
        renderTableBody();
      }, 150);
    });
    $('table-label').addEventListener('change', function (e) {
      if (!state.table) return;
      state.table.label = e.target.value;
      state.table.limit = CONFIG.tableChunk;
      renderTableBody();
    });
    $('table-more').addEventListener('click', function () {
      if (!state.table) return;
      state.table.limit += CONFIG.tableChunk;
      renderTableBody();
    });
  }

  // ---------- Resize ----------
  function bindResize() {
    var last = 0;
    var ro = new ResizeObserver(function (entries) {
      var w = Math.round(entries[0].contentRect.width);
      if (w === last) return;
      last = w;
      if (state.current && state.view === 'plot' && state.plotKey && typeof Plotly !== 'undefined') {
        Plotly.relayout($('plot'), { width: plotWidth(state.current.ds.samples.length) });
      }
    });
    ro.observe($('plot-scroll'));
  }

  // ---------- Boot ----------
  function pickFromHash() {
    var h = readHash();
    if (h.view) state.view = h.view === 'table' ? 'table' : 'plot';
    var i = -1;
    if (h.dataset) i = state.datasets.findIndex(function (d) { return d.name === h.dataset; });
    return i >= 0 ? i : 0;
  }

  function boot() {
    bindTabs();
    bindTable();
    bindResize();
    hidePanels();

    var colorsReady = loadColors().then(function (c) { state.colors = c; });

    Promise.all([loadDatasetList(), colorsReady]).then(function (res) {
      state.datasets = res[0];
      renderSidebar();
      renderNotices();
      if (!state.datasets.length) {
        setStatus('No datasets to show. Add entries to datasets.json, for example {"name": "12S OBS1", "file": "data/12S_OBS1.tsv"}.', true);
        return;
      }
      selectDataset(pickFromHash());
      window.addEventListener('hashchange', function () {
        var i = pickFromHash();
        if (i !== state.activeIndex) selectDataset(i); else showView(state.view);
      });
    }).catch(function (err) {
      $('dataset-list').innerHTML = '<p class="sidebar-status is-error"></p>';
      $('dataset-list').firstChild.textContent = 'Dataset list failed to load.';
      setStatus(err.message, true, function () { location.reload(); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
