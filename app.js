// Thresholds for risk levels
const THRESHOLDS = { high: 0.75, medium: 0.50 };

const form = document.getElementById('checkForm');
const submitBtn = document.getElementById('submitBtn');
const resultsSection = document.getElementById('results');
const riskBadge = document.getElementById('riskBadge');
const sourcesReport = document.getElementById('sourcesReport');
const resultsList = document.getElementById('resultsList');
const noResults = document.getElementById('noResults');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('title').value.trim();
  const description = document.getElementById('description').value.trim();
  if (!title || !description) return;

  setLoading(true);
  resultsSection.classList.add('hidden');

  const query = `${title} ${description}`.slice(0, 250);

  const sourceResults = await Promise.allSettled([
    fetchSemanticScholar(query),
    fetchCrossRef(query),
  ]);

  const ssResult  = sourceResults[0];
  const crResult  = sourceResults[1];

  const sources = [
    { name: 'Semantic Scholar', status: ssResult.status === 'fulfilled' ? 'ok' : 'err', papers: ssResult.value || [] },
    { name: 'CrossRef',          status: crResult.status  === 'fulfilled' ? 'ok' : 'err', papers: crResult.value  || [] },
    { name: 'WIPO PATENTSCOPE',  status: 'skip', papers: [] },
    { name: 'Scopus',            status: 'skip', papers: [] },
    { name: 'Роспатент / ФИПС', status: 'skip', papers: [] },
  ];

  let all = [];
  sources.forEach(s => {
    s.papers.forEach(p => { p.source = s.name; });
    all = all.concat(s.papers);
  });

  // Score and deduplicate
  all = scoreAndRank(all, title, description);

  renderSourcesReport(sources);
  renderResults(all);
  setLoading(false);
  resultsSection.classList.remove('hidden');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

async function fetchSemanticScholar(query) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=8&fields=title,abstract,year,externalIds,url,authors`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('SS error');
  const data = await res.json();
  return (data.data || []).map(p => ({
    id: p.paperId,
    title: p.title || '(без названия)',
    abstract: p.abstract || '',
    year: p.year,
    url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
    source: 'Semantic Scholar',
  }));
}

async function fetchCrossRef(query) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=8&select=title,abstract,published,URL,DOI`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('CR error');
  const data = await res.json();
  return ((data.message || {}).items || []).map(p => ({
    id: p.DOI,
    title: Array.isArray(p.title) ? p.title[0] : (p.title || '(без названия)'),
    abstract: p.abstract ? p.abstract.replace(/<[^>]+>/g, '') : '',
    year: p.published?.['date-parts']?.[0]?.[0],
    url: p.URL || `https://doi.org/${p.DOI}`,
    source: 'CrossRef',
  }));
}

// Simple TF-IDF-like similarity using term overlap
function scoreAndRank(papers, title, description) {
  const queryTerms = tokenize(`${title} ${description}`);

  return papers
    .map(p => {
      const docTerms = tokenize(`${p.title} ${p.abstract}`);
      const score = jaccardSim(queryTerms, docTerms);
      const risk = score >= THRESHOLDS.high ? 'high'
                 : score >= THRESHOLDS.medium ? 'medium'
                 : 'low';
      return { ...p, score, risk };
    })
    .filter(p => p.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function tokenize(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^\wа-яёa-z\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
  );
}

function jaccardSim(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach(t => { if (b.has(t)) inter++; });
  return inter / (a.size + b.size - inter);
}

function renderSourcesReport(sources) {
  sourcesReport.innerHTML = sources.map(s => `
    <div class="source-report-item">
      <span class="source-dot ${s.status}"></span>
      <span>${s.name}</span>
      <span style="color:var(--gray-300);font-size:.75rem">${
        s.status === 'ok'   ? 'опрошен' :
        s.status === 'err'  ? 'ошибка'  : 'не подключён'
      }</span>
    </div>
  `).join('');
}

function renderResults(papers) {
  resultsList.innerHTML = '';
  noResults.classList.add('hidden');

  if (papers.length === 0) {
    riskBadge.className = 'risk-badge none';
    riskBadge.textContent = 'Дублей не обнаружено';
    noResults.classList.remove('hidden');
    return;
  }

  const topRisk = papers[0].risk;
  riskBadge.className = `risk-badge ${topRisk}`;
  riskBadge.textContent = topRisk === 'high' ? '🔴 Высокий риск'
                        : topRisk === 'medium' ? '🟡 Средний риск'
                        : '🟢 Низкий риск';

  papers.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = `result-card ${p.risk}`;
    card.innerHTML = `
      <div class="result-top">
        <a class="result-title" href="${escHtml(p.url)}" target="_blank" rel="noopener">${escHtml(p.title)}</a>
        <div class="result-meta">
          <span class="result-source">${escHtml(p.source)}</span>
          <span class="score-badge ${p.risk}">${(p.score * 100).toFixed(0)}%</span>
        </div>
      </div>
      ${p.abstract ? `<p class="result-snippet">${escHtml(p.abstract)}</p>` : ''}
      <div class="result-footer">
        <span class="result-year">${p.year ? `Год: ${p.year}` : ''}</span>
        <div class="feedback-btns" id="fb-${i}">
          <button class="btn btn-sm btn-confirm" onclick="feedback(${i}, 'confirmed')">✓ Реальный дубль</button>
          <button class="btn btn-sm btn-reject" onclick="feedback(${i}, 'rejected')">✗ Не дубль</button>
        </div>
      </div>
    `;
    resultsList.appendChild(card);
  });
}

function feedback(idx, verdict) {
  const fb = document.getElementById(`fb-${idx}`);
  if (!fb) return;
  const msg = verdict === 'confirmed' ? '✓ Отмечено как реальный дубль' : '✗ Отмечено как не дубль';
  fb.innerHTML = `<span class="feedback-done">${msg}</span>`;
  // In production this would POST to /feedback endpoint
  console.log(`[feedback] idx=${idx} verdict=${verdict}`);
}

function setLoading(on) {
  submitBtn.disabled = on;
  submitBtn.querySelector('.btn-text').textContent = on ? 'Проверяем...' : 'Проверить новизну';
  submitBtn.querySelector('.spinner').classList.toggle('hidden', !on);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
