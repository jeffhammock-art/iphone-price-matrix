// dashboard.app.js — "show best results" engine
// Criteria that matter: Model, Storage (>= threshold), Battery condition, Price
// Criteria ignored: Colour, SIM option, specific condition grade (price trumps grade)

const STATE = {
  units: [],
  selectedSources: new Set(),
  selectedModels: new Set(),
  selectedStorage: new Set(),
  activeBattery: new Set(),
  selectedConditions: new Set(),
  maxPrice: 2000,
  perModel: false,
  results: [],
  sortBy: 'price',
  sortDir: 'asc'
};

const BATTERY_ORDER = ['Good', 'Standard', 'Great', 'New'];
const CONDITION_ORDER = ['Fair', 'Good', 'Excellent', 'Premium'];

// Refresh button — rebuilds dashboard data on the dev server
window.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('refreshData');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing…';
      try {
        const res = await fetch('/api/rebuild', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          refreshBtn.textContent = 'Done — reloading…';
          setTimeout(() => location.reload(), 1500);
        } else {
          refreshBtn.textContent = 'Refresh failed';
        }
      } catch (e) {
        refreshBtn.textContent = 'Refresh failed (server off?)';
        console.error(e);
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }
});

function storageGb(label) {
  const tb = label && label.match(/([0-9.]+)\s*TB/i);
  if (tb) return Math.round(Number(tb[1]) * 1024);
  const gb = label && label.match(/([0-9.]+)\s*GB/i);
  if (gb) return Number(gb[1]);
  return 0;
}

function buildChipGroup(containerId, items, selected, multi,onChange) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  items.forEach(item => {
    const label = document.createElement('label');
    label.className = 'chip ' + (selected.has(item) ? 'on' : '');
    label.innerHTML = `<input type="${multi ? 'checkbox' : 'radio'}"> ${item}`;
    label.addEventListener('click', (e) => {
      e.preventDefault();
      if (multi) {
        if (selected.has(item)) selected.delete(item);
        else selected.add(item);
        label.classList.toggle('on', selected.has(item));
      } else {
        selected.clear(); selected.add(item);
        [...container.querySelectorAll('.chip')].forEach(c => c.classList.remove('on'));
        label.classList.add('on');
      }
      onChange();
    });
        container.appendChild(label);
  });
}

function applySort() {
  const { sortBy, sortDir } = STATE;
  const dir = sortDir === 'asc' ? 1 : -1;
  STATE.results.sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'source':
        cmp = (a.source || '').localeCompare(b.source || '');
        return cmp * dir;
      case 'model':
        cmp = a.model.localeCompare(b.model);
        if (cmp !== 0) return cmp * dir;
        return (storageGb(b.storage) - storageGb(a.storage)) * dir;
      case 'storage':
        cmp = storageGb(a.storage) - storageGb(b.storage);
        return cmp * dir;
      case 'battery':
        cmp = (BATTERY_ORDER.indexOf(a.battery) - BATTERY_ORDER.indexOf(b.battery));
        if (cmp !== 0) return cmp * dir;
        return (Number(a.price) - Number(b.price)) * dir;
      case 'condition':
        cmp = (CONDITION_ORDER.indexOf(a.condition) - CONDITION_ORDER.indexOf(b.condition));
        return cmp * dir;
      case 'price':
        cmp = Number(a.price) - Number(b.price);
        return cmp * dir;
      case 'colour':
        cmp = (a.colour || '').localeCompare(b.colour || '');
        return cmp * dir;
            case 'url':
        cmp = (a.url || '').localeCompare(b.url || '');
        return cmp * dir;
      case 'capturedAt':
        cmp = (a.capturedAt || '').localeCompare(b.capturedAt || '');
        return cmp * dir;
      default:
        return 0;
    }
  });
}

function findBestResults() {
  const candidates = STATE.units.filter(row => {
    if (row.status !== 'Available') return false;
    if (!row.price || Number(row.price) <= 0) return false;
    if (Number(row.price) > STATE.maxPrice) return false;
    if (STATE.selectedSources.size > 0 && !STATE.selectedSources.has(row.source)) return false;
    if (STATE.selectedModels.size > 0 && !STATE.selectedModels.has(row.model)) return false;
    if (STATE.selectedStorage.size > 0 && !STATE.selectedStorage.has(row.storage)) return false;
    if (STATE.activeBattery.size > 0 && !STATE.activeBattery.has(row.battery)) return false;
    if (STATE.selectedConditions.size > 0 && !STATE.selectedConditions.has(row.condition)) return false;
    return true;
  });

  const groups = new Map();
  candidates.forEach(row => {
    // perModel mode: one row per model (its cheapest configuration).
    const key = STATE.perModel ? row.model : `${row.model}|${row.battery}|${row.storage}`;
    if (!groups.has(key) || Number(row.price) < Number(groups.get(key).price)) {
      groups.set(key, row);
    }
  });

  STATE.results = Array.from(groups.values());
  applySort();
}

function renderResults() {
  const tbody = document.querySelector('#tbl tbody');
  const thead = document.querySelector('#tbl thead');
  tbody.innerHTML = '';

  const columns = [
        { key: 'source', label: 'Source', cls: '' },
    { key: 'model', label: 'Model', cls: 'l' },
    { key: 'storage', label: 'Storage', cls: 'num' },
    { key: 'battery', label: 'Battery', cls: '' },
    { key: 'price', label: 'Price (£)', cls: 'num' },
    { key: 'condition', label: 'Condition', cls: '' },
    { key: 'colour', label: 'Colour', cls: '' },
    { key: 'capturedAt', label: 'Retrieved', cls: '' },
    { key: 'url', label: 'Link', cls: 'l' }
  ];

  thead.innerHTML = '<tr>' + columns.map(col => {
    const active = STATE.sortBy === col.key;
    const dirClass = active ? (STATE.sortDir === 'asc' ? 'sort-asc' : 'sort-desc') : '';
    return `<th data-sort="${col.key}" class="${dirClass}">${col.label}</th>`;
  }).join('') + '</tr>';

  thead.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (STATE.sortBy === key) {
        STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        STATE.sortBy = key;
        STATE.sortDir = 'asc';
      }
      applySort();
      renderResults();
    });
  });

  STATE.results.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = [
      `<td>${row.source}</td>`,
      `<td class="l">${row.model}</td>`,
      `<td class="num">${row.storage}</td>`,
      `<td class="bc-${row.battery}">${row.battery}</td>`,
      `<td class="num">£${Number(row.price).toFixed(2)}</td>`,
      `<td>${row.condition}</td>`,
                  `<td>${row.colour}</td>`,
      `<td class="l">${row.capturedAt || ''}</td>`,
      `<td class="l">${row.url ? `<a href="${row.url}" target="_blank">link</a>` : ''}</td>`
    ].join('');
    tbody.appendChild(tr);
  });

  document.getElementById('countLabel').textContent = `(${STATE.results.length} best results)`;
  const summary = document.getElementById('summaryPanel');
  const sourceCounts = {};
  STATE.results.forEach(r => { sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1; });
  const sourceSummary = Object.entries(sourceCounts).map(([s, c]) => `${c} ${s}`).join(', ');
  summary.innerHTML = STATE.results.length > 0
    ? `<div class="stat"><b>Showing:</b> ${STATE.results.length} best prices across ${new Set(STATE.results.map(r => r.model)).size} models (${sourceSummary})</div>`
    : '<div class="stat">No units match your criteria</div>';
}

function exportCsv() {
    const headers = ['Source', 'Model', 'Storage', 'Battery', 'Price', 'Currency', 'Status', 'Condition', 'Colour', 'Retrieved', 'Warranty', 'URL', 'Notes'];
  const lines = [headers.join(',')];
  STATE.results.forEach(row => {
        lines.push([
      row.source, row.model, row.storage, row.battery, row.price, row.currency,
      row.status, row.condition, row.colour, row.capturedAt || '', row.warranty || '', row.url,
      row.notes || ''
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'iphone-dashboard-results.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function init() {
  STATE.units = window.DASH || [];

  const sources = [...new Set(STATE.units.map(u => u.source))].sort();
  const models = [...new Set(STATE.units.map(u => u.model))].sort();
  const storages = [...new Set(STATE.units.map(u => u.storage))].sort((a, b) => storageGb(a) - storageGb(b));
  const batteries = [...new Set(STATE.units.map(u => u.battery))].sort((a, b) => {
    return (BATTERY_ORDER.indexOf(a) - BATTERY_ORDER.indexOf(b)) || a.localeCompare(b);
  });
  const conditions = [...new Set(STATE.units.map(u => u.condition))].sort((a, b) => {
    return (CONDITION_ORDER.indexOf(a) - CONDITION_ORDER.indexOf(b)) || a.localeCompare(b);
  });

  sources.forEach(s => STATE.selectedSources.add(s));
  models.forEach(m => STATE.selectedModels.add(m));
  storages.forEach(s => STATE.selectedStorage.add(s));
  batteries.forEach(b => STATE.activeBattery.add(b));
  conditions.forEach(c => STATE.selectedConditions.add(c));

  buildChipGroup('f-source', sources, STATE.selectedSources, true, () => {
    findBestResults();
    renderResults();
  });
  buildChipGroup('f-model', models, STATE.selectedModels, true, () => {
    findBestResults();
    renderResults();
  });
  buildChipGroup('f-storage', storages, STATE.selectedStorage, true, () => {
    findBestResults();
    renderResults();
  });
  buildChipGroup('f-battery', batteries, STATE.activeBattery, true, () => {
    findBestResults();
    renderResults();
  });
  buildChipGroup('f-condition', conditions, STATE.selectedConditions, true, () => {
    findBestResults();
    renderResults();
  });

  const maxPriceSlider = document.getElementById('maxPrice');
  const maxP = Math.max(STATE.maxPrice, ...STATE.units.map(u => Number(u.price) || 0));
  maxPriceSlider.max = String(Math.ceil(maxP / 100) * 100);
  maxPriceSlider.value = maxPriceSlider.max;
  STATE.maxPrice = Number(maxPriceSlider.max);
  document.getElementById('maxPriceLabel').textContent = `£${STATE.maxPrice}`;
  document.getElementById('maxPriceVal').textContent = `£${STATE.maxPrice}`;

  maxPriceSlider.addEventListener('input', (e) => {
    STATE.maxPrice = Number(e.target.value);
    document.getElementById('maxPriceLabel').textContent = `£${STATE.maxPrice}`;
    document.getElementById('maxPriceVal').textContent = `£${STATE.maxPrice}`;
    findBestResults();
    renderResults();
  });

  document.getElementById('dl').addEventListener('click', exportCsv);

  document.getElementById('p-reset').addEventListener('click', () => {
    STATE.perModel = false;
    document.getElementById('p-price').classList.remove('on');
    document.getElementById('modeLabel').textContent = 'One row per model+battery+storage. Click column headers to sort.';
    STATE.selectedSources = new Set(sources);
    STATE.selectedModels = new Set(models);
    STATE.selectedStorage = new Set(storages);
    STATE.activeBattery = new Set(batteries);
    STATE.selectedConditions = new Set(conditions);
    STATE.maxPrice = Number(maxPriceSlider.max);
    maxPriceSlider.value = maxPriceSlider.max;
    document.getElementById('maxPriceLabel').textContent = `£${STATE.maxPrice}`;
    document.getElementById('maxPriceVal').textContent = `£${STATE.maxPrice}`;
    buildChipGroup('f-source', sources, STATE.selectedSources, true, () => {});
    buildChipGroup('f-model', models, STATE.selectedModels, true, () => {});
    buildChipGroup('f-storage', storages, STATE.selectedStorage, true, () => {});
    buildChipGroup('f-battery', batteries, STATE.activeBattery, true, () => {});
    buildChipGroup('f-condition', conditions, STATE.selectedConditions, true, () => {});
    findBestResults();
    renderResults();
  });

  document.getElementById('p-price').addEventListener('click', () => {
    STATE.perModel = !STATE.perModel;
    STATE.sortBy = 'price';
    STATE.sortDir = 'asc';
    document.getElementById('p-price').classList.toggle('on', STATE.perModel);
    document.getElementById('modeLabel').textContent = STATE.perModel
      ? 'One row per model — its cheapest configuration.'
      : 'One row per model+battery+storage. Click column headers to sort.';
    findBestResults();
    renderResults();
  });

  document.getElementById('p-batt').addEventListener('click', () => {
    STATE.activeBattery = new Set(['New']);
    buildChipGroup('f-battery', batteries, STATE.activeBattery, true, () => {});
    findBestResults();
    renderResults();
  });

  findBestResults();
  renderResults();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

