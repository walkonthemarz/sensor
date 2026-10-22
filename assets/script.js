/* M701 dashboard — reads the latest 100 rows from /api/readings. */
(() => {
  'use strict';

  const API_URL = '/api/readings';
  const REFRESH_MS = 5000;
  const STORE_LIMIT = 100;
  const SPARK_POINTS = 24;
  const STALE_AFTER_MS = 90 * 1000;

  const LEVELS = {
    eco2: [800, 1200],
    ech2o: [80, 150],
    tvoc: [300, 600],
    pm2_5: [15, 35],
    pm10: [50, 100],
  };

  const AIR_KEYS = [
    ['eco2', 'CO₂', 'ppm'],
    ['pm2_5', 'PM2.5', 'µg/m³'],
    ['tvoc', 'TVOC', 'µg/m³'],
    ['ech2o', 'HCHO', 'µg/m³'],
  ];

  const ADVICE = {
    eco2: ' Open a window or check ventilation.',
    pm2_5: ' Ventilate or filter the air.',
    tvoc: ' Ventilate and check for sources.',
    ech2o: ' Ventilate and check for new materials or finishes.',
  };

  const COLOR = {
    ink: '#1b1f1a',
    ink2: '#414a3f',
    muted: '#5f6959',
    rule: '#d9d3c4',
    grid: '#e6e1d5',
    card: '#faf8f2',
    good: '#2f6b46',
    warn: '#a8641b',
    bad: '#a63a2b',
    temp: '#b25a3c',
    hum: '#3c6f8c',
    hcho: '#8a5a44',
    tvoc: '#b4761f',
    pm10: '#6f6650',
  };

  const MONO = '"SFMono-Regular", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const el = {
    connPill: $('#connPill'),
    connLabel: $('#connLabel'),
    updatedAt: $('#updatedAt'),
    refreshBtn: $('#refreshBtn'),
    verdict: $('#verdict'),
    verdictTitle: $('#verdictTitle'),
    verdictDetail: $('#verdictDetail'),
    errorBanner: $('#errorBanner'),
    readout: $('#readoutSection'),
    readoutMeta: $('#readoutMeta'),
    history: $('#historySection'),
    historyMeta: $('#historyMeta'),
    tableSection: $('#tableSection'),
    tableMeta: $('#tableMeta'),
    tbody: $('#readingsBody'),
    empty: $('#emptyState'),
    emptyTitle: $('#emptyTitle'),
    emptyText: $('#emptyText'),
    tzLabel: $('#tzLabel'),
    rangeButtons: $$('.seg button'),
  };

  const state = {
    readings: [],
    range: loadRange(),
    status: 'connecting',
    lastSync: null,
    error: null,
    inFlight: false,
    lastRenderKey: '',
    lastTableKey: '',
    chartFallback: false,
  };

  const charts = {};
  const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const pad = (n) => String(n).padStart(2, '0');

  /* ---------- formatting ---------- */

  function loadRange() {
    try {
      const fromUrl = Number(new URLSearchParams(location.search).get('points'));
      if ([20, 50, 100].includes(fromUrl)) return fromUrl;
    } catch (_) { /* no URL state */ }
    try {
      const saved = Number(localStorage.getItem('m701:range'));
      return [20, 50, 100].includes(saved) ? saved : 50;
    } catch (_) {
      return 50;
    }
  }

  function decimalsFor(key) {
    return key === 'temperature' || key === 'humidity' ? 1 : 0;
  }

  function formatValue(key, value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return decimalsFor(key) ? value.toFixed(1) : intFmt.format(Math.round(value));
  }

  function timeHMS(date) {
    return [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(':');
  }

  function timeHM(date) {
    return [pad(date.getHours()), pad(date.getMinutes())].join(':');
  }

  function dateHMS(date) {
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + timeHMS(date);
  }

  function tickFormat(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    if (Math.abs(number) >= 1000) return intFmt.format(Math.round(number));
    return Number.isInteger(number) ? String(number) : number.toFixed(1);
  }

  function hexToRgba(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((value >> 16) & 255) + ', ' + ((value >> 8) & 255) + ', ' + (value & 255) + ', ' + alpha + ')';
  }

  /* ---------- data ---------- */

  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function parseTimestamp(value) {
    if (!value) return null;
    let text = String(value).trim().replace(' ', 'T');
    text = text.replace(/(\.\d{3})\d+/, '$1');
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function normalize(row) {
    if (!row || typeof row !== 'object') return null;
    const reading = {
      id: toNumber(row.id),
      time: parseTimestamp(row.timestamp),
      eco2: toNumber(row.eco2),
      ech2o: toNumber(row.ech2o),
      tvoc: toNumber(row.tvoc),
      pm2_5: toNumber(row.pm2_5),
      pm10: toNumber(row.pm10),
      temperature: toNumber(row.temperature),
      humidity: toNumber(row.humidity),
    };
    const hasValue = ['eco2', 'ech2o', 'tvoc', 'pm2_5', 'pm10', 'temperature', 'humidity']
      .some((key) => reading[key] !== null);
    return hasValue ? reading : null;
  }

  function describeError(error) {
    if (!error) return 'unknown error';
    if (error.name === 'AbortError') return 'request timed out';
    if (error instanceof TypeError) return 'network unreachable';
    return error.message || 'request failed';
  }

  function levelFor(key, value) {
    if (value === null || !Number.isFinite(value)) return null;
    if (key === 'temperature') {
      return value >= 20 && value <= 26 ? 0 : value >= 18 && value <= 28 ? 1 : 2;
    }
    if (key === 'humidity') {
      return value >= 40 && value <= 60 ? 0 : value >= 30 && value <= 70 ? 1 : 2;
    }
    const band = LEVELS[key];
    if (!band) return null;
    return value < band[0] ? 0 : value < band[1] ? 1 : 2;
  }

  function levelTitle(key, level) {
    if (level === null) return 'No reading';
    if (key === 'temperature') {
      return ['Comfortable (20–26 °C)', 'Slightly outside 20–26 °C', 'Outside 18–28 °C'][level];
    }
    if (key === 'humidity') {
      return ['Comfortable (40–60 %RH)', 'Slightly outside 40–60 %RH', 'Outside 30–70 %RH'][level];
    }
    return ['Within the comfort band', 'Above the comfort band', 'Well above the comfort band'][level];
  }

  function isStale() {
    const latest = state.readings[0];
    if (!latest || !latest.time) return false;
    return Date.now() - latest.time.getTime() > STALE_AFTER_MS;
  }

  /* ---------- rendering ---------- */

  function render() {
    renderConnection();

    const hasData = state.readings.length > 0;
    el.readout.hidden = !hasData;
    el.history.hidden = !hasData;
    el.tableSection.hidden = !hasData;
    el.verdict.hidden = !hasData;
    el.empty.hidden = hasData;
    renderBanner();

    if (!hasData) {
      renderVerdict(null);
      renderEmpty();
      return;
    }

    const latest = state.readings[0];
    const rows = state.readings.slice(0, state.range);
    renderVerdict(latest);
    ensureCharts();

    const renderKey = state.range + ':' + rows.map((row) => row.id ?? (row.time ? row.time.getTime() : 'x')).join(',');
    if (renderKey !== state.lastRenderKey) {
      state.lastRenderKey = renderKey;
      renderMetrics(latest, rows);
      renderHistoryMeta(rows);
      updateCharts(rows);
      renderTable(rows);
      el.readoutMeta.textContent = latest.time
        ? 'Latest ' + timeHMS(latest.time) + ' · ' + state.readings.length + ' stored'
        : state.readings.length + ' stored';
    }
  }

  function renderConnection() {
    const stale = state.status === 'live' && isStale();
    const name = stale ? 'stale' : state.status;
    el.connPill.dataset.state = name;
    el.connLabel.textContent = {
      connecting: 'Connecting',
      live: 'Live',
      stale: 'Stale',
      waiting: 'Waiting',
      offline: 'Offline',
    }[name] || 'Connecting';
    el.updatedAt.textContent = state.lastSync ? 'Updated ' + timeHMS(state.lastSync) : 'Updated —';
  }

  function renderVerdict(latest) {
    if (!latest) {
      delete el.verdict.dataset.level;
      if (state.status === 'offline') {
        el.verdictTitle.textContent = 'Server unreachable';
        el.verdictDetail.textContent = 'The page keeps retrying every 5 seconds.';
      } else if (state.status === 'waiting') {
        el.verdictTitle.textContent = 'No readings yet';
        el.verdictDetail.textContent = 'The sensor will appear here as soon as it posts a reading.';
      } else {
        el.verdictTitle.textContent = 'Connecting to the sensor';
        el.verdictDetail.textContent = 'Waiting for the first reading.';
      }
      return;
    }

    const channels = AIR_KEYS
      .map(([key, label, unit]) => ({ key, label, unit, value: latest[key], level: levelFor(key, latest[key]) }))
      .filter((channel) => channel.value !== null && channel.level !== null);

    if (!channels.length) {
      delete el.verdict.dataset.level;
      el.verdictTitle.textContent = 'Reading available';
      el.verdictDetail.textContent = 'This entry has no air quality values.';
      return;
    }

    const level = channels.reduce((worst, channel) => Math.max(worst, channel.level), 0);
    el.verdict.dataset.level = String(level);
    el.verdictTitle.textContent = ['Air is fresh', 'Air is getting stale', 'Time to ventilate'][level];

    if (level === 0) {
      const parts = [];
      if (latest.eco2 !== null) parts.push('CO₂ at ' + formatValue('eco2', latest.eco2) + ' ppm');
      if (latest.pm2_5 !== null) parts.push('PM2.5 at ' + formatValue('pm2_5', latest.pm2_5) + ' µg/m³');
      el.verdictDetail.textContent = parts.length
        ? parts.join(' and ') + (parts.length === 2 ? ' are' : ' is') + ' inside the comfort band.'
        : 'All air channels are inside their comfort bands.';
      return;
    }

    const culprit = channels.find((channel) => channel.level === level);
    const limit = LEVELS[culprit.key][level === 1 ? 0 : 1];
    const advice = level === 2 ? (ADVICE[culprit.key] || ' Ventilate the room.') : '';
    el.verdictDetail.textContent = culprit.label + ' is at ' + formatValue(culprit.key, culprit.value) + ' ' + culprit.unit +
      ' — above ' + intFmt.format(limit) + ' ' + culprit.unit + '.' + advice;
  }

  function renderMetrics(latest, rows) {
    const points = rows.slice().reverse();
    for (const metric of $$('.metric')) {
      const key = metric.dataset.metric;
      const value = latest[key];
      const level = levelFor(key, value);

      $('[data-value]', metric).textContent = formatValue(key, value);
      if (level === null) {
        delete metric.dataset.level;
      } else {
        metric.dataset.level = String(level);
      }
      const flag = $('[data-flag]', metric);
      flag.title = levelTitle(key, level);

      const series = points.map((point) => point[key]).filter((item) => item !== null);
      drawSpark($('[data-spark]', metric), series.slice(-SPARK_POINTS));

      const foot = $('[data-foot]', metric);
      if (!series.length) {
        foot.textContent = 'No readings in range';
      } else if (series.length === 1) {
        foot.textContent = 'Only one reading · ' + formatValue(key, series[0]);
      } else {
        foot.textContent = 'Low ' + formatValue(key, Math.min.apply(null, series)) + ' · High ' + formatValue(key, Math.max.apply(null, series));
      }
    }
  }

  function drawSpark(svg, values) {
    const line = svg.querySelector('.spark__line');
    const area = svg.querySelector('.spark__area');
    if (!values || values.length < 2) {
      line.setAttribute('d', '');
      area.setAttribute('d', '');
      return;
    }

    const width = 100;
    const height = 28;
    const inset = 2;
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const flat = max === min;
    const span = flat ? 1 : max - min;
    const step = (width - inset * 2) / (values.length - 1);

    const points = values.map((value, index) => {
      const x = inset + index * step;
      const y = flat ? height / 2 : height - inset - ((value - min) / span) * (height - inset * 2);
      return [x, y];
    });

    let path = '';
    points.forEach((point, index) => {
      path += (index ? 'L' : 'M') + point[0].toFixed(2) + ' ' + point[1].toFixed(2) + ' ';
    });

    line.setAttribute('d', path.trim());
    area.setAttribute('d', path.trim() + ' L' + points[points.length - 1][0].toFixed(2) + ' ' + height + ' L' + points[0][0].toFixed(2) + ' ' + height + ' Z');
  }

  function renderHistoryMeta(rows) {
    if (!rows.length) {
      el.historyMeta.textContent = '—';
      return;
    }
    const newest = rows[0].time;
    const oldest = rows[rows.length - 1].time;
    const span = newest && oldest ? dateHMS(oldest) + ' – ' + timeHMS(newest) : rows.length + ' readings';
    el.historyMeta.textContent = rows.length + (rows.length === 1 ? ' point · ' : ' points · ') + span;
  }

  function renderTable(rows) {
    const key = state.range + ':' + rows.map((row) => row.id ?? (row.time ? row.time.getTime() : 'x')).join(',');
    if (key === state.lastTableKey) return;
    state.lastTableKey = key;

    const fragment = document.createDocumentFragment();
    rows.forEach((row, index) => {
      const tr = document.createElement('tr');
      if (index === 0) tr.className = 'is-latest';
      const cells = [
        row.time ? dateHMS(row.time) : '—',
        formatValue('eco2', row.eco2),
        formatValue('ech2o', row.ech2o),
        formatValue('tvoc', row.tvoc),
        formatValue('pm2_5', row.pm2_5),
        formatValue('pm10', row.pm10),
        formatValue('temperature', row.temperature),
        formatValue('humidity', row.humidity),
      ];
      cells.forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      fragment.appendChild(tr);
    });

    el.tbody.replaceChildren(fragment);
    el.tableMeta.textContent = 'Showing ' + rows.length + ' of ' + state.readings.length + ' · newest first';
  }

  function renderBanner() {
    if (!state.readings.length || state.status !== 'offline') {
      el.errorBanner.hidden = true;
      return;
    }
    const reason = state.error && state.error.message ? ' (' + state.error.message + ')' : '';
    const sync = state.lastSync ? ' Last successful sync ' + timeHMS(state.lastSync) + '.' : '';
    el.errorBanner.textContent = 'Can’t reach the sensor server' + reason + '. Showing the last known readings.' + sync + ' Retrying every 5 seconds.';
    el.errorBanner.hidden = false;
  }

  function renderEmpty() {
    if (state.status === 'offline') {
      el.emptyTitle.textContent = 'Server unreachable';
      el.emptyText.textContent = 'Couldn’t load /api/readings' + (state.error && state.error.message ? ' (' + state.error.message + ')' : '') + '. The page retries every 5 seconds.';
    } else if (state.status === 'waiting') {
      el.emptyTitle.textContent = 'No readings yet';
      el.emptyText.textContent = 'The sensor will appear here as soon as it posts its first reading.';
    } else {
      el.emptyTitle.textContent = 'Connecting to the sensor';
      el.emptyText.textContent = 'Reading the latest entries from the sensor server.';
    }
  }

  /* ---------- charts ---------- */

  function makeScales() {
    return {
      x: {
        grid: { display: false },
        border: { color: COLOR.rule },
        ticks: {
          color: COLOR.muted,
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 6,
          font: { family: MONO, size: 9 },
        },
      },
      y: {
        position: 'left',
        beginAtZero: false,
        grid: { color: COLOR.grid, drawTicks: false },
        border: { display: false },
        ticks: {
          color: COLOR.muted,
          maxTicksLimit: 4,
          padding: 6,
          font: { family: MONO, size: 9 },
          callback: tickFormat,
        },
      },
    };
  }

  function scalesWithRight() {
    const scales = makeScales();
    scales.y1 = {
      position: 'right',
      beginAtZero: false,
      grid: { display: false },
      border: { display: false },
      ticks: {
        color: COLOR.muted,
        maxTicksLimit: 4,
        padding: 6,
        font: { family: MONO, size: 9 },
        callback: tickFormat,
      },
    };
    return scales;
  }

  function tooltipOptions() {
    return {
      backgroundColor: COLOR.ink,
      titleColor: '#f4f1e9',
      bodyColor: '#f4f1e9',
      titleFont: { family: MONO, size: 9.5, weight: '500' },
      bodyFont: { family: MONO, size: 10 },
      footerFont: { family: MONO, size: 9 },
      padding: 10,
      boxPadding: 4,
      cornerRadius: 3,
      boxWidth: 6,
      boxHeight: 6,
      usePointStyle: true,
      displayColors: true,
      callbacks: {
        label: (context) => {
          const dataset = context.dataset;
          return ' ' + dataset.label + '  ' + formatValue(dataset.key, context.parsed.y) + ' ' + dataset.unit;
        },
      },
    };
  }

  function baseOptions(scales) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 2, right: 2, bottom: 0, left: 0 } },
      plugins: { legend: { display: false }, tooltip: tooltipOptions() },
      scales,
    };
  }

  function makeLineDataset(config) {
    return {
      key: config.key,
      label: config.label,
      unit: config.unit,
      yAxisID: config.axis || 'y',
      data: [],
      borderColor: config.color,
      backgroundColor: config.fill ? hexToRgba(config.color, 0.08) : 'transparent',
      fill: config.fill ? 'start' : false,
      borderWidth: 1.6,
      borderDash: config.dash || [],
      tension: 0.28,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHoverBorderWidth: 2,
      pointHoverBackgroundColor: config.color,
      pointHoverBorderColor: COLOR.card,
      spanGaps: true,
    };
  }

  function ensureCharts() {
    if (charts.air) return;

    if (typeof Chart === 'undefined') {
      if (!state.chartFallback) {
        state.chartFallback = true;
        $$('.chart__canvas').forEach((wrap) => {
          wrap.innerHTML = '<p class="chart__fail">The chart library could not be loaded. Every reading is still listed below.</p>';
        });
      }
      return;
    }

    Chart.defaults.font.family = MONO;
    Chart.defaults.font.size = 9;
    Chart.defaults.color = COLOR.muted;

    charts.air = new Chart($('#chartAir'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          makeLineDataset({ key: 'eco2', label: 'CO₂', unit: 'ppm', color: COLOR.good, fill: true }),
          makeLineDataset({ key: 'tvoc', label: 'TVOC', unit: 'µg/m³', color: COLOR.tvoc, axis: 'y1', dash: [5, 4] }),
          makeLineDataset({ key: 'ech2o', label: 'HCHO', unit: 'µg/m³', color: COLOR.hcho, axis: 'y1', dash: [1, 3] }),
        ],
      },
      options: baseOptions(scalesWithRight()),
    });

    charts.climate = new Chart($('#chartClimate'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          makeLineDataset({ key: 'temperature', label: 'Temp', unit: '°C', color: COLOR.temp }),
          makeLineDataset({ key: 'humidity', label: 'RH', unit: '%', color: COLOR.hum, axis: 'y1', dash: [5, 4] }),
        ],
      },
      options: baseOptions(scalesWithRight()),
    });

    charts.pm = new Chart($('#chartPm'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          makeLineDataset({ key: 'pm2_5', label: 'PM2.5', unit: 'µg/m³', color: COLOR.good, fill: true }),
          makeLineDataset({ key: 'pm10', label: 'PM10', unit: 'µg/m³', color: COLOR.pm10, dash: [5, 4] }),
        ],
      },
      options: baseOptions(makeScales()),
    });
  }

  function updateCharts(rows) {
    if (!charts.air) return;

    const ordered = rows.slice().reverse();
    const first = ordered[0] && ordered[0].time;
    const last = ordered[ordered.length - 1] && ordered[ordered.length - 1].time;
    const spanMs = first && last ? Math.abs(last.getTime() - first.getTime()) : 0;
    const labels = ordered.map((row) => {
      if (!row.time) return '—';
      return spanMs > 10 * 60 * 1000 ? timeHM(row.time) : timeHMS(row.time);
    });

    const payload = {};
    ['eco2', 'ech2o', 'tvoc', 'pm2_5', 'pm10', 'temperature', 'humidity'].forEach((key) => {
      payload[key] = ordered.map((row) => row[key]);
    });

    Object.values(charts).forEach((chart) => {
      chart.data.labels = labels;
      chart.data.datasets.forEach((dataset) => {
        dataset.data = payload[dataset.key] || [];
      });
      chart.update('none');
    });

    const latest = rows[0];
    if (!latest) return;

    const legend = {
      legendCo2: ['eco2', 'ppm'],
      legendTvoc: ['tvoc', 'µg/m³'],
      legendHcho: ['ech2o', 'µg/m³'],
      legendTemp: ['temperature', '°C'],
      legendHum: ['humidity', '%'],
      legendPm25: ['pm2_5', 'µg/m³'],
      legendPm10: ['pm10', 'µg/m³'],
    };
    Object.entries(legend).forEach(([id, [key, unit]]) => {
      const node = document.getElementById(id);
      if (node) node.textContent = latest[key] === null ? '—' : formatValue(key, latest[key]) + ' ' + unit;
    });

    const micro = ' micrograms per cubic metre';
    $('#chartAir').setAttribute('aria-label',
      'Air quality history. Latest carbon dioxide ' + formatValue('eco2', latest.eco2) + ' ppm, TVOC ' +
      formatValue('tvoc', latest.tvoc) + micro + ', formaldehyde ' + formatValue('ech2o', latest.ech2o) + micro + '.');
    $('#chartClimate').setAttribute('aria-label',
      'Climate history. Latest temperature ' + formatValue('temperature', latest.temperature) + ' degrees Celsius, humidity ' +
      formatValue('humidity', latest.humidity) + ' percent.');
    $('#chartPm').setAttribute('aria-label',
      'Particulate history. Latest PM2.5 ' + formatValue('pm2_5', latest.pm2_5) + micro + ', PM10 ' +
      formatValue('pm10', latest.pm10) + micro + '.');
  }

  /* ---------- network ---------- */

  function setBusy(busy) {
    el.refreshBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  async function refresh() {
    if (state.inFlight) return;
    state.inFlight = true;
    setBusy(true);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(API_URL, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error('unexpected response shape');

      const rows = payload.map(normalize).filter(Boolean);
      rows.sort((a, b) => {
        if (a.id !== null && b.id !== null && a.id !== b.id) return b.id - a.id;
        const aTime = a.time ? a.time.getTime() : 0;
        const bTime = b.time ? b.time.getTime() : 0;
        return bTime - aTime;
      });

      state.readings = rows.slice(0, STORE_LIMIT);
      state.error = null;
      state.lastSync = new Date();
      state.status = state.readings.length ? 'live' : 'waiting';
    } catch (error) {
      state.status = 'offline';
      state.error = new Error(describeError(error));
    } finally {
      clearTimeout(timer);
      state.inFlight = false;
      setBusy(false);
      render();
    }
  }

  /* ---------- events / init ---------- */

  function syncRangeButtons() {
    el.rangeButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.points) === state.range));
    });
  }

  function bindEvents() {
    el.refreshBtn.addEventListener('click', () => refresh());

    el.rangeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const value = Number(button.dataset.points);
        if (![20, 50, 100].includes(value) || value === state.range) return;
        state.range = value;
        try {
          localStorage.setItem('m701:range', String(value));
          const url = new URL(location.href);
          url.searchParams.set('points', String(value));
          history.replaceState(null, '', url);
        } catch (_) { /* storage or history unavailable */ }
        syncRangeButtons();
        state.lastRenderKey = '';
        state.lastTableKey = '';
        render();
      });
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
    window.addEventListener('online', () => refresh());
    window.addEventListener('popstate', () => {
      const value = Number(new URLSearchParams(location.search).get('points'));
      if (![20, 50, 100].includes(value) || value === state.range) return;
      state.range = value;
      syncRangeButtons();
      state.lastRenderKey = '';
      state.lastTableKey = '';
      render();
    });
  }

  function init() {
    try {
      el.tzLabel.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
    } catch (_) {
      el.tzLabel.textContent = 'local time';
    }
    syncRangeButtons();
    bindEvents();
    render();
    refresh();
    setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_MS);
  }

  init();
})();
