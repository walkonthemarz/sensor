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
    ['pm10', 'PM10', 'µg/m³'],
    ['tvoc', 'TVOC', 'µg/m³'],
    ['ech2o', 'HCHO', 'µg/m³'],
  ];

  const ADVICE = {
    eco2: ' Open a window or check ventilation.',
    pm2_5: ' Ventilate or filter the air.',
    pm10: ' Ventilate or filter the air.',
    tvoc: ' Ventilate and check for sources.',
    ech2o: ' Ventilate and check for new materials or finishes.',
  };

  const COLOR = {
    ink: '#2c1d16',
    ink2: '#523c2f',
    muted: '#775846',
    rule: '#efd9c5',
    grid: '#f2decc',
    card: '#fffbf6',
    good: '#3d7a55',
    warn: '#9a5a06',
    bad: '#b03a2a',
    temp: '#de532d',
    hum: '#3e7fa8',
    hcho: '#8a5b84',
    tvoc: '#b8791e',
    pm10: '#7a6a54',
  };

  const FONT = '"Gabarito", "Avenir Next", "Segoe UI", system-ui, sans-serif';

  const RULERS = {
    eco2: { min: 0, max: 1500, bands: [[0, 800, 'good'], [800, 1200, 'warn'], [1200, 1500, 'bad']] },
    ech2o: { min: 0, max: 200, bands: [[0, 80, 'good'], [80, 150, 'warn'], [150, 200, 'bad']] },
    tvoc: { min: 0, max: 800, bands: [[0, 300, 'good'], [300, 600, 'warn'], [600, 800, 'bad']] },
    pm2_5: { min: 0, max: 55, bands: [[0, 15, 'good'], [15, 35, 'warn'], [35, 55, 'bad']] },
    pm10: { min: 0, max: 150, bands: [[0, 50, 'good'], [50, 100, 'warn'], [100, 150, 'bad']] },
    temperature: {
      min: 10, max: 34,
      bands: [[10, 18, 'bad'], [18, 20, 'warn'], [20, 26, 'good'], [26, 28, 'warn'], [28, 34, 'bad']],
    },
    humidity: {
      min: 0, max: 100,
      bands: [[0, 30, 'bad'], [30, 40, 'warn'], [40, 60, 'good'], [60, 70, 'warn'], [70, 100, 'bad']],
    },
  };

  const ZONE_COLOR = {
    good: 'rgba(61, 122, 85, .34)',
    warn: 'rgba(224, 166, 46, .44)',
    bad: 'rgba(176, 58, 42, .34)',
  };

  const VERDICT_TITLES = [
    'The air feels fresh.',
    'The air is getting stuffy.',
    'Time to let some air in.',
  ];

  const VERDICT_BADGES = ['Fresh air', 'A little stuffy', 'Needs air'];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const el = {
    connPill: $('#connPill'),
    connLabel: $('#connLabel'),
    updatedAt: $('#updatedAt'),
    refreshBtn: $('#refreshBtn'),
    installBtn: $('#installBtn'),
    verdict: $('#verdict'),
    verdictBadgeText: $('#verdictBadgeText'),
    verdictNote: $('#verdictNote'),
    verdictTitle: $('#verdictTitle'),
    verdictDetail: $('#verdictDetail'),
    heroPeek: $('#heroPeek'),
    peekCo2: $('#peekCo2'),
    peekPm: $('#peekPm'),
    peekTemp: $('#peekTemp'),
    errorBanner: $('#errorBanner'),
    readout: $('#readoutSection'),
    nowTitle: $('#now-title'),
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
    if (value === null || value === undefined || !Number.isFinite(value)) return '–';
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
    // The API returns naive UTC timestamps; make the timezone explicit.
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += 'Z';
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
        ? 'Latest ' + timeHMS(latest.time) + ' · ' + state.readings.length + ' readings'
        : state.readings.length + ' readings';
    }
  }

  function renderConnection() {
    const stale = state.status === 'live' && isStale();
    const name = stale ? 'stale' : state.status;
    el.connPill.dataset.state = name;
    const label = {
      connecting: 'Connecting',
      live: 'Live',
      stale: 'Not updating',
      waiting: 'Waiting',
      offline: 'Offline',
    }[name] || 'Connecting';
    if (el.connLabel.textContent !== label) el.connLabel.textContent = label;
    el.updatedAt.textContent = state.lastSync ? 'Updated ' + timeHMS(state.lastSync) : 'Updated –';
  }

  function renderVerdict(latest) {
    if (!latest) {
      delete el.verdict.dataset.level;
      el.nowTitle.textContent = 'Right now';
      el.verdictBadgeText.textContent = {
        offline: 'Offline',
        waiting: 'Waiting',
        connecting: 'Connecting',
      }[state.status] || 'Connecting';
      el.verdictNote.textContent = 'One room, seven channels';
      el.heroPeek.hidden = true;
      if (state.status === 'offline') {
        el.verdictTitle.textContent = 'The sensor is out of reach.';
        el.verdictDetail.textContent = 'The page keeps trying every 5 seconds.';
      } else if (state.status === 'waiting') {
        el.verdictTitle.textContent = 'No readings yet.';
        el.verdictDetail.textContent = 'The room will show up as soon as the sensor posts a reading.';
      } else {
        el.verdictTitle.textContent = 'Waking up the sensor.';
        el.verdictDetail.textContent = 'Waiting for the first reading.';
      }
      return;
    }

    const channels = AIR_KEYS
      .map(([key, label, unit]) => ({ key, label, unit, value: latest[key], level: levelFor(key, latest[key]) }))
      .filter((channel) => channel.value !== null && channel.level !== null);

    if (!channels.length) {
      delete el.verdict.dataset.level;
      el.verdictBadgeText.textContent = 'Reading received';
      el.verdictNote.textContent = 'One room, seven channels';
      el.verdictTitle.textContent = 'A reading, but no air values.';
      el.verdictDetail.textContent = 'This entry has no air quality values to judge.';
      updatePeek(latest);
      return;
    }

    const level = channels.reduce((worst, channel) => Math.max(worst, channel.level), 0);
    el.verdict.dataset.level = String(level);
    el.verdictBadgeText.textContent = VERDICT_BADGES[level];
    const current = state.status === 'live' && !isStale();
    el.nowTitle.textContent = current ? 'Right now' : 'Last known';
    el.verdictNote.textContent = !current
      ? 'Showing the last known reading'
      : level === 0
        ? 'All air channels are in their comfort bands'
        : level === 1 ? 'One air channel is above its band' : 'One air channel is well above its band';
    el.verdictTitle.textContent = VERDICT_TITLES[level];
    updatePeek(latest);

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

  function updatePeek(latest) {
    el.peekCo2.textContent = formatValue('eco2', latest.eco2);
    el.peekPm.textContent = formatValue('pm2_5', latest.pm2_5);
    el.peekTemp.textContent = formatValue('temperature', latest.temperature);
    el.heroPeek.hidden = false;
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
      drawRuler(key, value, $('[data-ruler-zones]', metric), $('[data-ruler-marker]', metric));

      let status = $('[data-level-text]', metric);
      if (!status) {
        status = document.createElement('span');
        status.className = 'sr-only';
        status.setAttribute('data-level-text', '');
        metric.appendChild(status);
      }
      status.textContent = levelTitle(key, level);

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

  function drawRuler(key, value, zones, marker) {
    const ruler = RULERS[key];
    if (!ruler || !zones || !marker) return;

    if (value === null || !Number.isFinite(value)) {
      marker.style.display = 'none';
      zones.style.background = 'var(--ruler-empty)';
      return;
    }

    marker.style.display = '';
    const span = ruler.max - ruler.min;
    const stops = ruler.bands.map(([from, to, tone]) => {
      const start = ((from - ruler.min) / span) * 100;
      const end = ((to - ruler.min) / span) * 100;
      return ZONE_COLOR[tone] + ' ' + start.toFixed(2) + '% ' + end.toFixed(2) + '%';
    });
    zones.style.background = 'linear-gradient(90deg, ' + stops.join(', ') + ')';
    marker.style.left = Math.min(100, Math.max(0, ((value - ruler.min) / span) * 100)).toFixed(2) + '%';
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
    const height = 30;
    const inset = 2.5;
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
      el.historyMeta.textContent = '–';
      return;
    }
    const newest = rows[0].time;
    const oldest = rows[rows.length - 1].time;
    const span = newest && oldest ? dateHMS(oldest) + ' – ' + timeHMS(newest) : rows.length + ' readings';
    el.historyMeta.textContent = rows.length + (rows.length === 1 ? ' reading · ' : ' readings · ') + span;
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
        row.time ? dateHMS(row.time) : '–',
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
    const sync = state.lastSync ? ' Last good sync ' + timeHMS(state.lastSync) + '.' : '';
    el.errorBanner.textContent = 'The sensor server is out of reach' + reason + '. Showing the last known readings.' + sync + ' Trying again every 5 seconds.';
    el.errorBanner.hidden = false;
  }

  function renderEmpty() {
    if (state.status === 'offline') {
      el.emptyTitle.textContent = 'The sensor is out of reach';
      el.emptyText.textContent = 'We couldn’t load readings from the sensor server' + (state.error && state.error.message ? ' (' + state.error.message + ')' : '') + '. The page keeps trying every 5 seconds.';
    } else if (state.status === 'waiting') {
      el.emptyTitle.textContent = 'No readings yet';
      el.emptyText.textContent = 'The room will show up here as soon as the sensor posts its first reading.';
    } else {
      el.emptyTitle.textContent = 'Waking up the sensor';
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
          font: { family: FONT, size: 11 },
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
          padding: 8,
          font: { family: FONT, size: 11 },
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
        padding: 8,
        font: { family: FONT, size: 11 },
        callback: tickFormat,
      },
    };
    return scales;
  }

  function tooltipOptions() {
    return {
      backgroundColor: COLOR.ink,
      titleColor: '#fff3e8',
      bodyColor: '#fff3e8',
      titleFont: { family: FONT, size: 11, weight: '700' },
      bodyFont: { family: FONT, size: 12, weight: '500' },
      footerFont: { family: FONT, size: 11 },
      padding: 12,
      boxPadding: 5,
      cornerRadius: 10,
      boxWidth: 8,
      boxHeight: 8,
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
      layout: { padding: { top: 4, right: 2, bottom: 0, left: 0 } },
      plugins: { legend: { display: false }, tooltip: tooltipOptions() },
      scales,
    };
  }

  const latestPointPlugin = {
    id: 'latestPoint',
    afterDatasetsDraw(chart) {
      const context = chart.ctx;
      chart.data.datasets.forEach((dataset, index) => {
        const meta = chart.getDatasetMeta(index);
        if (meta.hidden) return;
        for (let item = meta.data.length - 1; item >= 0; item -= 1) {
          const value = dataset.data[item];
          if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
          const point = meta.data[item];
          if (!point) return;
          const props = point.getProps(['x', 'y'], true);
          context.save();
          context.beginPath();
          context.arc(props.x, props.y, 3.8, 0, Math.PI * 2);
          context.fillStyle = dataset.borderColor;
          context.fill();
          context.lineWidth = 2;
          context.strokeStyle = COLOR.card;
          context.stroke();
          context.restore();
          return;
        }
      });
    },
  };

  function makeLineDataset(config) {
    return {
      key: config.key,
      label: config.label,
      unit: config.unit,
      yAxisID: config.axis || 'y',
      data: [],
      borderColor: config.color,
      backgroundColor: config.fill ? hexToRgba(config.color, 0.1) : 'transparent',
      fill: config.fill ? 'start' : false,
      borderWidth: 2.2,
      borderCapStyle: 'round',
      borderDash: config.dash || [],
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 4,
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

    Chart.defaults.font.family = FONT;
    Chart.defaults.font.size = 11;
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
      plugins: [latestPointPlugin],
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
      plugins: [latestPointPlugin],
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
      plugins: [latestPointPlugin],
    });
  }

  function updateCharts(rows) {
    if (!charts.air) return;

    const ordered = rows.slice().reverse();
    const first = ordered[0] && ordered[0].time;
    const last = ordered[ordered.length - 1] && ordered[ordered.length - 1].time;
    const spanMs = first && last ? Math.abs(last.getTime() - first.getTime()) : 0;
    const labels = ordered.map((row) => {
      if (!row.time) return '–';
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
      if (node) node.textContent = latest[key] === null ? '–' : formatValue(key, latest[key]) + ' ' + unit;
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

      // A cached payload means the network is down, even though the request
      // succeeded. Show the saved room and the time it was really fetched.
      if (response.headers.get('X-M701-Cache') === 'hit') {
        const fetchedAt = response.headers.get('Date');
        state.status = 'offline';
        state.lastSync = fetchedAt ? new Date(fetchedAt) : null;
      }
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

  function isStandalone() {
    const mode = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    return Boolean(mode || window.navigator.standalone);
  }

  function bindInstall() {
    if (!el.installBtn || isStandalone()) return;
    let prompt = null;

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      prompt = event;
      el.installBtn.hidden = false;
    });

    el.installBtn.addEventListener('click', async () => {
      if (!prompt) return;
      prompt.prompt();
      try {
        await prompt.userChoice;
      } finally {
        prompt = null;
        el.installBtn.hidden = true;
      }
    });

    window.addEventListener('appinstalled', () => {
      prompt = null;
      el.installBtn.hidden = true;
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.addEventListener('controllerchange', () => refresh(), { once: true });
      navigator.serviceWorker.register('sw.js')
        .then(() => navigator.serviceWorker.ready)
        // The first fetch runs before the worker controls the page, so warm
        // the offline readings cache as soon as the worker is in charge.
        .then(() => refresh())
        .catch(() => {
          /* the dashboard works without offline support */
        });
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
    bindInstall();
    registerServiceWorker();
    render();
    refresh();
    setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_MS);
  }

  init();
})();
