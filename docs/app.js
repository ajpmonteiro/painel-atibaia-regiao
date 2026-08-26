/* Painel econômico — Atibaia e região.
   Lê window.DADOS (versão embutida) ou ./dados.json (versão hospedada). */

const CORES = ['--s1','--s2','--s3','--s4','--s5','--s6','--s7','--s8'];
const cor = (i) => `var(${CORES[i % CORES.length]})`;

let D = null;
let MUNS = [];
let destaque = null;
let ativos = new Set();
let anoRef = null;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, filhos = []) => {
  const n = document.createElementNS(
    /^(svg|g|path|rect|circle|line|text|polyline|polygon|defs|clipPath|tspan)$/.test(tag)
      ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const f of [].concat(filhos)) if (f) n.appendChild(f);
  return n;
};

/* ---------------- formatação ---------------- */
const nf = (d = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
function compacto(v, prefixo = '') {
  const a = Math.abs(v);
  if (a >= 1e9) return `${prefixo}${nf(a >= 1e10 ? 0 : 1).format(v / 1e9)} bi`;
  if (a >= 1e6) return `${prefixo}${nf(a >= 1e7 ? 0 : 1).format(v / 1e6)} mi`;
  if (a >= 1e3) return `${prefixo}${nf(0).format(v)}`;
  return `${prefixo}${nf(a < 10 ? 1 : 0).format(v)}`;
}
function fmt(v, unidade = '') {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const u = (unidade || '').toLowerCase();
  if (u.includes('%')) return `${nf(1).format(v)}%`;
  if (u.includes('us$')) return compacto(v, 'US$ ');
  if (u.includes('/hab')) return `R$ ${nf(0).format(v)}`;
  if (u.includes('mil reais')) return compacto(v * 1000, 'R$ ');
  if (u.startsWith('r$') || u.includes('reais')) return compacto(v, 'R$ ');
  if (u.includes('pessoa') || u.includes('unidade') || u.includes('cabeça')) return nf(0).format(v);
  if (u.includes('por mil')) return nf(1).format(v);
  return nf(Math.abs(v) < 10 ? 1 : 0).format(v);
}
const unidadeCurta = (u) => {
  if (!u) return '';
  const m = { 'Mil Reais': 'R$', 'Pessoas': 'pessoas', 'Unidades': 'unidades' };
  return m[u] || u;
};

/* ---------------- acesso aos dados ---------------- */
// Indicadores em que estar no topo do gráfico é ruim: o ranking e a cor da
// variação seguem o significado, não o valor.
const MENOR_MELHOR = /depend[êe]ncia de transfer|homic[íi]dio|roubo|furto/i;
/* Largura reservada aos nomes: o mais longo do recorte manda, com teto para
   não engolir a área do gráfico. Unidades são do viewBox, com nomes a 12px. */
const margemNomes = (W) => {
  const maior = MUNS.reduce((n, m) => Math.max(n, m.nome.length), 0);
  return Math.round(Math.min(W * 0.42, Math.max(W * 0.24, maior * 6.4 + 18)));
};
const ind = (id) => D.indicadores[id];
const serie = (i, cod) => (i && i.valores[cod]) || {};
function valor(i, cod, ano) {
  if (!i) return null;
  const s = serie(i, cod);
  if (ano && s[ano] !== undefined) return s[ano];
  return null;
}
function ultimoAno(i, cods = MUNS.map((m) => m.codigo)) {
  if (!i) return null;
  const anos = [...new Set(cods.flatMap((c) => Object.keys(serie(i, c))))].sort();
  return anos.pop() || null;
}
function valorRecente(i, cod) {
  const s = serie(i, cod);
  const a = Object.keys(s).sort().pop();
  return a ? { ano: a, v: s[a] } : { ano: null, v: null };
}
function acharInd(re) {
  return Object.values(D.indicadores).find((i) => re.test(i.rotulo || ''));
}
function ranking(i, ano, maiorMelhor = true) {
  const linhas = MUNS.map((m) => ({ m, v: valor(i, m.codigo, ano) })).filter((r) => r.v !== null);
  linhas.sort((a, b) => (maiorMelhor ? b.v - a.v : a.v - b.v));
  return linhas;
}

/* ---------------- tooltip ---------------- */
const dica = $('#dica');
function mostrarDica(ev, titulo, linhas) {
  dica.innerHTML = '';
  dica.appendChild(el('div', { class: 't', text: titulo }));
  for (const l of linhas) {
    dica.appendChild(el('div', { class: 'l', html:
      `<span>${l.cor ? `<i style="background:${l.cor}"></i>` : ''}${l.rot}</span><b>${l.val}</b>` }));
  }
  dica.style.opacity = '1';
  dica.setAttribute('aria-hidden', 'false');
  posicionarDica(ev);
}
function posicionarDica(ev) {
  const r = dica.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY - 10;
  if (x + r.width > innerWidth - 10) x = ev.clientX - r.width - 14;
  if (y + r.height > innerHeight - 10) y = innerHeight - r.height - 10;
  dica.style.left = `${Math.max(8, x)}px`;
  dica.style.top = `${Math.max(8, y)}px`;
}
const esconderDica = () => { dica.style.opacity = '0'; dica.setAttribute('aria-hidden', 'true'); };

/* ---------------- gráfico de linhas ---------------- */
function grafLinhas(indic, cods, { altura = 260, largura = 760 } = {}) {
  const W = largura, H = altura * (largura / 760), ml = Math.round(W * 0.135), mr = Math.round(W * 0.03), mt = 12, mb = 26;
  const anos = [...new Set(cods.flatMap((c) => Object.keys(serie(indic, c))))].sort();
  if (anos.length < 2) return el('div', { class: 'vazio', text: 'Série temporal insuficiente para este indicador.' });

  const vals = cods.flatMap((c) => anos.map((a) => serie(indic, c)[a])).filter((v) => v !== undefined);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min > 0 && min / max > 0.35) min = min * 0.92; else if (min > 0) min = 0;
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.06; max += pad; if (min < 0) min -= pad;

  const x = (a) => ml + (anos.indexOf(a) / (anos.length - 1)) * (W - ml - mr);
  const y = (v) => mt + (1 - (v - min) / (max - min)) * (H - mt - mb);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  // grade
  const nT = 5;
  for (let k = 0; k <= nT; k++) {
    const v = min + ((max - min) * k) / nT;
    svg.appendChild(el('line', { class: k === 0 ? 'baseline' : 'gridline', x1: ml, x2: W - mr, y1: y(v), y2: y(v) }));
    svg.appendChild(el('text', { class: 'tick', x: ml - 8, y: y(v) + 3.5, 'text-anchor': 'end', text: fmt(v, indic.unidade) }));
  }
  const passo = Math.max(1, Math.ceil(anos.length / 9));
  anos.forEach((a, i) => {
    if (i % passo && i !== anos.length - 1) return;
    svg.appendChild(el('text', { class: 'tick', x: x(a), y: H - 8, 'text-anchor': 'middle', text: a }));
  });

  const ordem = cods.map((c) => MUNS.findIndex((m) => m.codigo === c));
  cods.forEach((c, k) => {
    const s = serie(indic, c);
    const pts = anos.filter((a) => s[a] !== undefined).map((a) => [x(a), y(s[a])]);
    if (pts.length < 2) return;
    const cc = cor(ordem[k]);
    const ehDestaque = c === destaque;
    svg.appendChild(el('polyline', {
      points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: cc,
      'stroke-width': ehDestaque ? 2.8 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      opacity: ehDestaque || cods.length <= 4 ? 1 : .85,
    }));
    const ult = pts[pts.length - 1];
    if (cods.length <= 5) {
      svg.appendChild(el('circle', { cx: ult[0], cy: ult[1], r: 4, fill: cc, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
      svg.appendChild(el('text', {
        class: 'rotulo-serie', x: ult[0] + 8, y: ult[1] + 3.5, fill: cc,
        text: MUNS[ordem[k]].nome.split(' ')[0],
      }));
    }
  });

  // camada de interação
  const foco = el('line', { class: 'gridline', y1: mt, y2: H - mb, opacity: 0, 'stroke-width': 1.5 });
  svg.appendChild(foco);
  const cap = el('rect', { x: ml, y: mt, width: W - ml - mr, height: H - mt - mb, fill: 'transparent', style: 'cursor:crosshair' });
  svg.appendChild(cap);
  cap.addEventListener('mousemove', (ev) => {
    const bb = svg.getBoundingClientRect();
    const px = ((ev.clientX - bb.left) / bb.width) * W;
    const i = Math.round(((px - ml) / (W - ml - mr)) * (anos.length - 1));
    const a = anos[Math.max(0, Math.min(anos.length - 1, i))];
    foco.setAttribute('x1', x(a)); foco.setAttribute('x2', x(a)); foco.setAttribute('opacity', 1);
    const linhas = cods.map((c, k) => ({
      rot: MUNS[ordem[k]].nome, cor: cor(ordem[k]),
      val: fmt(serie(indic, c)[a], indic.unidade),
    })).filter((l) => l.val !== '—');
    mostrarDica(ev, a, linhas);
  });
  cap.addEventListener('mouseleave', () => { foco.setAttribute('opacity', 0); esconderDica(); });
  return svg;
}

/* ---------------- barras comparativas ---------------- */
function grafBarras(indic, ano, { maiorMelhor = true, largura = 760 } = {}) {
  const linhas = ranking(indic, ano, maiorMelhor);
  if (!linhas.length) return el('div', { class: 'vazio', text: 'Sem dados para o ano selecionado.' });

  const W = largura, alturaLinha = 30;
  const ml = margemNomes(W), mr = Math.round(W * 0.17);
  const plot = W - ml - mr;
  const H = linhas.length * alturaLinha + 8;

  const vals = linhas.map((l) => l.v);
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals);
  const escala = (v) => ((v - minV) / ((maxV - minV) || 1)) * plot;
  const x0 = ml + escala(0);
  const temNegativo = minV < 0;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  linhas.forEach((l, i) => {
    const idx = MUNS.findIndex((m) => m.codigo === l.m.codigo);
    const yy = i * alturaLinha + 6;
    const bruto = escala(l.v) - escala(0);
    const comp = Math.max(2, Math.abs(bruto));
    const bx = bruto >= 0 ? x0 : x0 - comp;
    const ehD = l.m.codigo === destaque;
    const cc = cor(idx);

    svg.appendChild(el('text', {
      x: ml - 12, y: yy + 13, 'text-anchor': 'end', class: 'tick',
      style: `font-size:12px;fill:${ehD ? 'var(--ink-1)' : 'var(--ink-2)'};font-weight:${ehD ? 700 : 500}`,
      text: l.m.nome,
    }));

    const r = el('rect', { x: bx, y: yy, width: comp, height: 18, rx: 4, fill: cc,
      opacity: ehD ? 1 : .82, style: 'cursor:pointer' });
    r.addEventListener('mousemove', (ev) => mostrarDica(ev, l.m.nome, [
      { rot: indic.rotulo, val: fmt(l.v, indic.unidade), cor: cc },
      { rot: 'Posição na região', val: `${i + 1}º de ${linhas.length}` },
    ]));
    r.addEventListener('mouseleave', esconderDica);
    svg.appendChild(r);

    const txt = fmt(l.v, indic.unidade);
    const largTexto = txt.length * 5.8;
    const foraDireita = bruto >= 0 && bx + comp + 9 + largTexto > W;
    const foraEsquerda = bruto < 0 && bx - 9 - largTexto < ml;
    const dentro = foraDireita || foraEsquerda;
    svg.appendChild(el('text', {
      x: bruto >= 0 ? (dentro ? bx + comp - 8 : bx + comp + 9) : (dentro ? bx + 8 : bx - 9),
      y: yy + 13,
      'text-anchor': bruto >= 0 ? (dentro ? 'end' : 'start') : (dentro ? 'start' : 'end'),
      class: 'tick',
      style: `font-size:11.5px;font-weight:${ehD ? 700 : 500};fill:${dentro ? '#fff' : (ehD ? 'var(--ink-1)' : 'var(--ink-2)')}`,
      text: txt,
    }));
  });
  svg.appendChild(el('line', { class: 'baseline', x1: x0, x2: x0, y1: 0, y2: H - 4,
    'stroke-width': temNegativo ? 1.5 : 1 }));
  return svg;
}

/* ---------------- barras empilhadas 100% ---------------- */
function grafEmpilhado(indicadores, ano, rotulos, largura = 760) {
  const W = largura, alturaLinha = 34, ml = margemNomes(W), mr = Math.round(W * 0.03);
  const linhas = MUNS.map((m) => {
    const partes = indicadores.map((i) => valor(i, m.codigo, ano));
    const total = partes.reduce((s, v) => s + (v || 0), 0);
    return { m, partes, total };
  }).filter((l) => l.total > 0);
  if (!linhas.length) return el('div', { class: 'vazio', text: 'Sem dados para o ano selecionado.' });
  linhas.sort((a, b) => (b.partes[1] || 0) / b.total - (a.partes[1] || 0) / a.total);

  const H = linhas.length * alturaLinha + 6;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  linhas.forEach((l, i) => {
    const yy = i * alturaLinha + 6;
    const ehD = l.m.codigo === destaque;
    svg.appendChild(el('text', {
      x: ml - 12, y: yy + 14, 'text-anchor': 'end', class: 'tick',
      style: `font-size:12px;fill:${ehD ? 'var(--ink-1)' : 'var(--ink-2)'};font-weight:${ehD ? 700 : 500}`,
      text: l.m.nome,
    }));
    let acc = 0;
    l.partes.forEach((v, k) => {
      if (!v) return;
      const frac = v / l.total;
      const larg = frac * (W - ml - mr);
      const r = el('rect', {
        x: ml + acc + (acc ? 2 : 0), y: yy, width: Math.max(1, larg - (acc ? 2 : 0)), height: 20,
        rx: k === 0 || k === l.partes.length - 1 ? 4 : 0, fill: cor(k), style: 'cursor:pointer',
      });
      r.addEventListener('mousemove', (ev) => mostrarDica(ev, l.m.nome, [
        { rot: rotulos[k], val: `${nf(1).format(frac * 100)}%`, cor: cor(k) },
        ...l.partes.map((vv, kk) => vv ? { rot: rotulos[kk], cor: cor(kk), val: `${nf(1).format((vv / l.total) * 100)}%` } : null).filter(Boolean),
      ]));
      r.addEventListener('mouseleave', esconderDica);
      svg.appendChild(r);
      if (frac > 0.11)
        svg.appendChild(el('text', {
          x: ml + acc + larg / 2, y: yy + 14, 'text-anchor': 'middle',
          style: 'font-size:11px;fill:#fff;font-weight:650', text: `${Math.round(frac * 100)}%`,
        }));
      acc += larg;
    });
  });
  return svg;
}

/* ---------------- sparkline ---------------- */
function spark(pontos, cc) {
  const W = 200, H = 42;
  const vs = pontos.map((p) => p.valor);
  const min = Math.min(...vs), max = Math.max(...vs);
  const x = (i) => (i / (pontos.length - 1)) * W;
  const y = (v) => H - 3 - ((v - min) / (max - min || 1)) * (H - 8);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
  svg.appendChild(el('polyline', {
    points: pontos.map((p, i) => `${x(i)},${y(p.valor)}`).join(' '),
    fill: 'none', stroke: cc, 'stroke-width': 2, 'stroke-linejoin': 'round',
  }));
  svg.appendChild(el('circle', { cx: x(pontos.length - 1), cy: y(vs[vs.length - 1]), r: 3.2, fill: cc }));
  return svg;
}

/* ---------------- montagem das seções ---------------- */
function bloco(titulo, descricao, corpo, fonteTxt) {
  const s = el('section');
  s.appendChild(el('h2', { text: titulo }));
  if (descricao) s.appendChild(el('p', { class: 'desc', html: descricao }));
  s.appendChild(corpo);
  if (fonteTxt) s.appendChild(el('p', { class: 'fonte', html: fonteTxt }));
  return s;
}

function cartaoGrafico(tituloForte, sub, no, legendaCods) {
  const c = el('div', { class: 'cartao' });
  const fig = el('figure');
  fig.appendChild(el('figcaption', { html: `<b>${tituloForte}</b>${sub || ''}` }));
  fig.appendChild(no);
  if (legendaCods) fig.appendChild(legenda(legendaCods));
  c.appendChild(fig);
  return c;
}

function legenda(cods) {
  const d = el('div', { class: 'legenda' });
  for (const c of cods) {
    const i = MUNS.findIndex((m) => m.codigo === c);
    d.appendChild(el('span', { class: 'it', html: `<i style="background:${cor(i)}"></i>${MUNS[i].nome}` }));
  }
  return d;
}
function legendaLivre(rotulos) {
  const d = el('div', { class: 'legenda' });
  rotulos.forEach((r, i) => d.appendChild(el('span', { class: 'it', html: `<i style="background:${cor(i)}"></i>${r}` })));
  return d;
}

/* --- 1. panorama --- */
function secPanorama() {
  const m = MUNS.find((x) => x.codigo === destaque);
  const escolhas = [
    { re: /^população residente estimada/i, rot: 'População estimada' },
    { re: /^produto interno bruto a preços correntes$/i, rot: 'PIB' },
    { id: 'der_pib_pc', rot: 'PIB por habitante' },
    { re: /^número de unidades locais/i, rot: 'Unidades locais (empresas)' },
    { re: /pessoal ocupado total/i, rot: 'Pessoal ocupado' },
    { id: 'der_receita_pc', rot: 'Receita municipal por habitante' },
    { id: 'comex_export_fob', rot: 'Exportações' },
    { id: 'der_dep_transf', rot: 'Dependência de transferências' },
  ];
  const g = el('div', { class: 'grade g4' });
  let n = 0;
  for (const e of escolhas) {
    const i = e.id ? ind(e.id) : acharInd(e.re);
    if (!i) continue;
    const { ano, v } = valorRecente(i, destaque);
    if (v === null) continue;
    const s = serie(i, destaque);
    const anos = Object.keys(s).sort();
    const ant = anos.length > 1 ? s[anos[anos.length - 2]] : null;
    const varPct = ant ? ((v / ant) - 1) * 100 : null;
    const menorMelhor = MENOR_MELHOR.test(i.rotulo);
    const rk = ranking(i, ano, !menorMelhor);
    const pos = rk.findIndex((r) => r.m.codigo === destaque) + 1;

    const t = el('div', { class: 'cartao tile' });
    t.appendChild(el('div', { class: 'rot', text: e.rot }));
    t.appendChild(el('div', { class: 'val', text: fmt(v, i.unidade) }));
    t.appendChild(el('div', { class: 'un', text: `${unidadeCurta(i.unidade)} · ${ano}` }));
    const pe = el('div', { class: 'pe' });
    if (pos) pe.appendChild(el('span', { class: 'rank', text: `${pos}º de ${rk.length} na região` }));
    // Em "dependência de transferências", subir é piorar: a cor segue o sentido, não o sinal.
    const bom = menorMelhor ? varPct < 0 : varPct >= 0;
    if (varPct !== null && Number.isFinite(varPct))
      pe.appendChild(el('span', { class: bom ? 'pos' : 'neg',
        text: `${varPct >= 0 ? '▲' : '▼'} ${nf(1).format(Math.abs(varPct))}% vs. ${anos[anos.length - 2]}` }));
    t.appendChild(pe);
    if (anos.length > 3) {
      const pts = anos.map((a) => ({ valor: s[a] }));
      t.appendChild(spark(pts, cor(MUNS.findIndex((x) => x.codigo === destaque))));
    }
    g.appendChild(t); n++;
  }
  if (!n) return null;
  return bloco(`Panorama de ${m.nome}`,
    'Cada indicador traz o valor mais recente publicado, a posição do município entre os oito vizinhos e a variação em relação ao período anterior.',
    g);
}

/* --- seletor de indicador --- */
function seletorIndicadores(filtro, aoMudar, valorInicial) {
  const sel = el('select');
  const porGrupo = {};
  for (const i of Object.values(D.indicadores)) {
    if (filtro && !filtro(i)) continue;
    (porGrupo[i.grupo] = porGrupo[i.grupo] || []).push(i);
  }
  for (const [g, lista] of Object.entries(porGrupo).sort()) {
    const og = el('optgroup', { label: g });
    lista.sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR'))
      .forEach((i) => og.appendChild(el('option', { value: i.id, text: i.rotulo })));
    sel.appendChild(og);
  }
  if (valorInicial && D.indicadores[valorInicial]) sel.value = valorInicial;
  sel.addEventListener('change', () => aoMudar(sel.value));
  return sel;
}

/* --- 2. comparativo --- */
function secComparativo() {
  const inicial = ['der_receita_pc', 'comex_export_fob'].find((x) => ind(x))
    || acharInd(/produto interno bruto per capita/i)?.id
    || Object.keys(D.indicadores)[0];
  const caixa = el('div');
  const cabec = el('div', { style: 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px' });
  const rot = el('label', { class: 'campo', text: 'Indicador' });
  const sel = seletorIndicadores(null, (v) => desenhar(v), inicial);
  rot.appendChild(sel); cabec.appendChild(rot);
  const anoRotulo = el('span', { class: 'fonte', style: 'margin:0 0 6px' });
  cabec.appendChild(anoRotulo);
  caixa.appendChild(cabec);
  const alvo = el('div');
  caixa.appendChild(alvo);

  function desenhar(id) {
    const i = ind(id);
    alvo.innerHTML = '';
    const ano = (i.periodos.includes(anoRef) ? anoRef : ultimoAno(i));
    anoRotulo.textContent = `Ano de referência: ${ano}`;
    alvo.appendChild(cartaoGrafico(i.rotulo,
      `<span style="color:var(--ink-3)">${unidadeCurta(i.unidade)} · ${ano} · ${i.fonte}</span>`,
      grafBarras(i, ano, { maiorMelhor: !MENOR_MELHOR.test(i.rotulo) })));
  }
  desenhar(sel.value || inicial);
  caixa.__redesenhar = () => desenhar(sel.value);

  const s = bloco('Comparativo regional', 'Os oito municípios lado a lado em qualquer indicador da base. Atibaia aparece destacada.', caixa);
  s.__caixa = caixa;
  return s;
}

/* --- 3. séries temporais --- */
function secEvolucao() {
  const inicial = acharInd(/^população residente estimada/i)?.id || Object.keys(D.indicadores)[0];
  const caixa = el('div');
  const cabec = el('div', { style: 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px' });
  const rot = el('label', { class: 'campo', text: 'Indicador' });
  const sel = seletorIndicadores((i) => i.periodos.length > 2, (v) => desenhar(v), inicial);
  rot.appendChild(sel); cabec.appendChild(rot);
  caixa.appendChild(cabec);
  const alvo = el('div');
  caixa.appendChild(alvo);

  function desenhar(id) {
    const i = ind(id) || ind(inicial);
    alvo.innerHTML = '';
    const cods = MUNS.filter((m) => ativos.has(m.codigo)).map((m) => m.codigo);
    alvo.appendChild(cartaoGrafico(i.rotulo,
      `<span style="color:var(--ink-3)">${unidadeCurta(i.unidade)} · ${i.fonte}</span>`,
      grafLinhas(i, cods), cods));
  }
  desenhar(sel.value || inicial);
  caixa.__redesenhar = () => desenhar(sel.value);
  const s = bloco('Evolução no tempo',
    'Use os botões de município na barra superior para incluir ou tirar cidades da comparação.', caixa);
  s.__caixa = caixa;
  return s;
}

/* --- 4. estrutura econômica --- */
function secEstrutura() {
  const setores = [
    acharInd(/valor adicionado.*da agropecu/i),
    acharInd(/valor adicionado.*da ind[úu]stria/i),
    acharInd(/valor adicionado.*dos servi[çc]os/i),
    acharInd(/valor adicionado.*da administra[çc][ãa]o/i),
  ];
  if (setores.filter(Boolean).length < 3) return null;
  const rotulos = ['Agropecuária', 'Indústria', 'Serviços privados', 'Administração pública'];
  const ano = ultimoAno(setores.find(Boolean));
  const g = el('div', { class: 'grade g2' });

  const c1 = el('div', { class: 'cartao' });
  const f1 = el('figure');
  f1.appendChild(el('figcaption', { html: `<b>Composição do Valor Adicionado</b><span style="color:var(--ink-3)">% do VA total · ${ano} · IBGE</span>` }));
  f1.appendChild(grafEmpilhado(setores.filter(Boolean), ano, rotulos, 540));
  f1.appendChild(legendaLivre(rotulos));
  c1.appendChild(f1); g.appendChild(c1);

  const pibpc = ind('der_pib_pc');
  if (pibpc) {
    const a2 = ultimoAno(pibpc);
    g.appendChild(cartaoGrafico('PIB por habitante',
      `<span style="color:var(--ink-3)">R$ · ${a2} · IBGE</span>`, grafBarras(pibpc, a2, { largura: 540 })));
  }
  return bloco('Estrutura econômica',
    'Quanto de cada economia local vem do campo, da indústria, dos serviços privados e do setor público — e quanto de produto isso gera por habitante.',
    g);
}

/* --- 5. finanças públicas --- */
function secFinancas() {
  const rec = ind('der_receita_pc'), dep = ind('der_dep_transf'), aut = ind('der_autonomia');
  const funcoes = ['12', '10', '15', '04', '09', '08'].map((f) => ind(`fin_desp_${f}`));
  if (!rec && !dep && !funcoes.some(Boolean)) return null;
  const g = el('div', { class: 'grade g2' });
  if (rec) {
    const a = ultimoAno(rec);
    g.appendChild(cartaoGrafico('Receita municipal por habitante',
      `<span style="color:var(--ink-3)">R$/hab · ${a} · Tesouro Nacional</span>`, grafBarras(rec, a, { largura: 540 })));
  }
  if (dep) {
    const a = ultimoAno(dep);
    g.appendChild(cartaoGrafico('Dependência de transferências',
      `<span style="color:var(--ink-3)">% da receita realizada · ${a} · quanto menor, mais autonomia</span>`,
      grafBarras(dep, a, { maiorMelhor: false, largura: 540 })));
  }
  if (funcoes.some(Boolean)) {
    const usadas = funcoes.filter(Boolean);
    const rotulos = ['Educação', 'Saúde', 'Urbanismo', 'Administração', 'Previdência', 'Assistência social']
      .filter((_, k) => funcoes[k]);
    const a = ultimoAno(usadas[0]);
    const c = el('div', { class: 'cartao' });
    const f = el('figure');
    f.appendChild(el('figcaption', { html: `<b>Para onde vai a despesa</b><span style="color:var(--ink-3)">participação das principais funções · ${a} · Tesouro Nacional</span>` }));
    f.appendChild(grafEmpilhado(usadas, a, rotulos, 540));
    f.appendChild(legendaLivre(rotulos));
    c.appendChild(f); g.appendChild(c);
  }
  if (aut) {
    const a = ultimoAno(aut);
    g.appendChild(cartaoGrafico('Autonomia tributária',
      `<span style="color:var(--ink-3)">receita própria como % da receita total · ${a}</span>`, grafBarras(aut, a, { largura: 540 })));
  }
  return bloco('Finanças públicas',
    'Capacidade de arrecadação, grau de dependência de repasses e destino do gasto — o retrato fiscal de cada prefeitura, direto das Contas Anuais entregues ao Tesouro Nacional.',
    g);
}

/* --- infraestrutura urbana --- */
function secInfra() {
  const pcts = Object.values(D.indicadores)
    .filter((i) => i.grupo === 'Infraestrutura urbana' && i.unidade === '%');
  if (!pcts.length) return null;
  const g = el('div', { class: 'grade g2' });
  for (const i of pcts) {
    const a = ultimoAno(i);
    const curto = i.rotulo.replace(/ — % do total$/, '').replace(/^Domicílios /, 'Domicílios ');
    g.appendChild(cartaoGrafico(curto,
      `<span style="color:var(--ink-3)">% dos domicílios · Censo ${a} · IBGE</span>`,
      grafBarras(i, a, { largura: 540 })));
  }
  return bloco('Infraestrutura urbana',
    'Água encanada, esgoto tratado e coleta de lixo são o retrato mais direto de quanto a urbanização acompanhou o crescimento — e o que mais separa as cidades desta região.',
    g);
}

/* --- segurança pública --- */
function secSeguranca() {
  const taxas = Object.values(D.indicadores)
    .filter((i) => i.grupo === 'Segurança pública' && /100 mil/.test(i.unidade || ''));
  if (!taxas.length) return null;
  const ordem = ['homicidio', 'roubo_veiculo', 'roubo', 'furto_veiculo', 'furto'];
  taxas.sort((a, b) => ordem.findIndex((k) => a.id.includes(k)) - ordem.findIndex((k) => b.id.includes(k)));

  const g = el('div', { class: 'grade g2' });
  for (const i of taxas) {
    const a = ultimoAno(i);
    g.appendChild(cartaoGrafico(i.rotulo.replace(' por 100 mil habitantes', ''),
      `<span style="color:var(--ink-3)">por 100 mil habitantes · ${a} · SSP-SP · menor é melhor</span>`,
      grafBarras(i, a, { maiorMelhor: false, largura: 540 })));
  }
  const s = bloco('Segurança pública',
    'Ocorrências registradas pela Secretaria da Segurança Pública, convertidas em taxa por 100 mil habitantes para permitir a comparação entre cidades de portes diferentes. ' +
    '<b>Leia com cuidado nas cidades pequenas:</b> onde a população é de poucos milhares, uma ocorrência a mais move a taxa vários pontos — a variação de um ano para o outro diz mais sobre o acaso do que sobre tendência.',
    g);
  return s;
}

/* --- 6. comércio exterior --- */
function secComex() {
  const exp = ind('comex_export_fob'), imp = ind('comex_import_fob'), sal = ind('der_saldo_comercial');
  if (!exp && !imp) return null;
  const g = el('div', { class: 'grade g2' });
  const cods = MUNS.filter((m) => ativos.has(m.codigo)).map((m) => m.codigo);
  if (exp) g.appendChild(cartaoGrafico('Exportações', '<span style="color:var(--ink-3)">US$ FOB por ano · MDIC/Comex Stat</span>', grafLinhas(exp, cods, { largura: 540 }), cods));
  if (sal) { const a = ultimoAno(sal); g.appendChild(cartaoGrafico('Saldo comercial', `<span style="color:var(--ink-3)">exportações − importações · ${a}</span>`, grafBarras(sal, a, { largura: 540 }))); }
  if (imp) g.appendChild(cartaoGrafico('Importações', '<span style="color:var(--ink-3)">US$ FOB por ano · MDIC/Comex Stat</span>', grafLinhas(imp, cods, { largura: 540 }), cods));
  const jund = MUNS.find((m) => /jundia/i.test(m.nome));
  const avisoEscala = jund && ativos.has(jund.codigo)
    ? ' <b>Jundiaí opera em outra ordem de grandeza</b> e achata as demais nos gráficos: desligue-a nos botões de município, no topo da página, para comparar o resto da região.'
    : '';
  return bloco('Comércio exterior',
    'Valores atribuídos ao município de domicílio fiscal da empresa exportadora ou importadora — um bom termômetro da presença industrial e da inserção externa de cada cidade.'
    + avisoEscala,
    g);
}

/* --- 7. contexto macro --- */
function secMacro() {
  const ms = Object.values(D.macro || {});
  if (!ms.length) return null;
  const g = el('div', { class: 'grade g4' });
  ms.forEach((m, k) => {
    if (!m.pontos?.length) return;
    const t = el('div', { class: 'cartao tile' });
    const ult = m.pontos[m.pontos.length - 1];
    t.appendChild(el('div', { class: 'rot', text: m.rotulo }));
    t.appendChild(el('div', { class: 'val', text: nf(2).format(ult.valor) }));
    t.appendChild(el('div', { class: 'un', text: `${m.unidade} · ${ult.data}` }));
    t.appendChild(spark(m.pontos.slice(-36), cor(k)));
    g.appendChild(t);
  });
  return bloco('Contexto macroeconômico',
    'O pano de fundo nacional em que esses números foram gerados — série do Banco Central, atualizada a cada coleta.',
    g);
}

/* --- 8. tabela completa --- */
function secTabela() {
  const caixa = el('div');
  const busca = el('input', { type: 'search', placeholder: 'Filtrar indicadores…', style: 'margin-bottom:12px;width:280px' });
  caixa.appendChild(busca);
  const cartao = el('div', { class: 'cartao', style: 'padding:0;overflow:hidden' });
  const rol = el('div', { class: 'rolagem', style: 'max-height:70vh' });
  cartao.appendChild(rol); caixa.appendChild(cartao);

  function desenhar() {
    const q = busca.value.trim().toLowerCase();
    const tab = el('table');
    const thead = el('thead');
    const tr = el('tr');
    tr.appendChild(el('th', { text: 'Indicador' }));
    MUNS.forEach((m) => tr.appendChild(el('th', { text: m.nome })));
    tr.appendChild(el('th', { text: 'Ano' }));
    thead.appendChild(tr); tab.appendChild(thead);
    const tb = el('tbody');
    const lista = Object.values(D.indicadores)
      .filter((i) => !q || (i.rotulo + ' ' + i.grupo).toLowerCase().includes(q))
      .sort((a, b) => (a.grupo + a.rotulo).localeCompare(b.grupo + b.rotulo, 'pt-BR'));
    let grupoAtual = null;
    for (const i of lista) {
      if (i.grupo !== grupoAtual) {
        grupoAtual = i.grupo;
        const trg = el('tr');
        trg.appendChild(el('td', { colspan: MUNS.length + 2, text: grupoAtual,
          style: 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);padding-top:16px' }));
        tb.appendChild(trg);
      }
      const ano = ultimoAno(i);
      const vals = MUNS.map((m) => valor(i, m.codigo, ano));
      const finitos = vals.filter((v) => v !== null);
      const max = finitos.length ? Math.max(...finitos) : null;
      const linha = el('tr');
      linha.appendChild(el('td', { text: i.rotulo, title: `${i.fonte} — ${unidadeCurta(i.unidade)}` }));
      vals.forEach((v, k) => linha.appendChild(el('td', {
        text: fmt(v, i.unidade),
        class: [MUNS[k].codigo === destaque ? 'destaque' : '', v !== null && v === max ? 'melhor' : ''].join(' ').trim(),
      })));
      linha.appendChild(el('td', { text: ano || '—', style: 'color:var(--ink-3)' }));
      tb.appendChild(linha);
    }
    tab.appendChild(tb);
    rol.innerHTML = ''; rol.appendChild(tab);
  }
  busca.addEventListener('input', desenhar);
  desenhar();
  caixa.__redesenhar = desenhar;
  const s = bloco('Base completa',
    `Todos os ${Object.keys(D.indicadores).length} indicadores coletados, no ano mais recente de cada série. Em verde, o maior valor da região; em negrito, o município em destaque.`,
    caixa);
  s.__caixa = caixa;
  return s;
}

/* --- 9. fontes --- */
function secFontes() {
  const c = el('div', { class: 'cartao' });
  const ul = el('ul', { style: 'margin:0;padding-left:18px;line-height:1.9' });
  for (const f of D.fontes || [])
    ul.appendChild(el('li', { html: `${f.url ? `<a href="${f.url}" target="_blank" rel="noopener">${f.nome}</a>` : f.nome} <span style="color:var(--ink-3)">— ${f.indicadores} indicadores</span>` }));
  c.appendChild(ul);
  const d = el('details');
  d.appendChild(el('summary', { text: 'Como o painel se mantém atualizado' }));
  d.appendChild(el('p', { class: 'desc', html:
    'Um robô roda toda segunda-feira, consulta as APIs oficiais listadas acima, recalcula todos os indicadores derivados e regrava a base que alimenta esta página. ' +
    'Cada indicador carrega o ano da sua própria série: bases anuais (PIB, Censo, CEMPRE) mudam uma vez por ano, enquanto Tesouro e Comex Stat mudam ao longo do ano. ' +
    'Quando uma fonte está fora do ar, a coleta preserva o dado anterior em vez de apagá-lo.' }));
  c.appendChild(d);
  return bloco('Fontes e método', 'Tudo aqui vem de bases públicas e verificáveis. Os links levam à origem de cada número.', c);
}

/* ---------------- controles ---------------- */
function montarControles() {
  const selMun = $('#selMun');
  selMun.innerHTML = '';
  MUNS.forEach((m) => selMun.appendChild(el('option', { value: m.codigo, text: m.nome })));
  selMun.value = destaque;
  selMun.addEventListener('change', () => { destaque = selMun.value; ativos.add(destaque); render(); });

  const anos = [...new Set(Object.values(D.indicadores).flatMap((i) => i.periodos))]
    .filter((a) => /^\d{4}$/.test(a)).sort().reverse();
  const selAno = $('#selAno');
  selAno.innerHTML = '';
  anos.forEach((a) => selAno.appendChild(el('option', { value: a, text: a })));
  anoRef = anoRef || anos[0];
  selAno.value = anoRef;
  selAno.addEventListener('change', () => { anoRef = selAno.value; render(); });

  const chips = $('#chipsMun');
  chips.innerHTML = '';
  MUNS.forEach((m, i) => {
    const b = el('button', {
      class: 'chip', 'aria-pressed': ativos.has(m.codigo) ? 'true' : 'false',
      style: `color:${ativos.has(m.codigo) ? cor(i) : 'var(--ink-3)'}`,
      html: `<span class="pt"></span>${m.nome}`,
    });
    b.addEventListener('click', () => {
      if (ativos.has(m.codigo)) { if (ativos.size > 1) ativos.delete(m.codigo); }
      else ativos.add(m.codigo);
      montarControles(); render();
    });
    chips.appendChild(b);
  });
}

function render() {
  const c = $('#conteudo');
  c.innerHTML = '';
  const secoes = [secPanorama(), secComparativo(), secEvolucao(), secEstrutura(),
    secInfra(), secSeguranca(), secFinancas(), secComex(), secMacro(),
    secTabela(), secFontes()].filter(Boolean);
  secoes.forEach((s) => c.appendChild(s));
}

function cabecalho() {
  const d = new Date(D.geradoEm);
  const fmtData = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });
  $('#selo').innerHTML =
    `<span><b>${MUNS.length}</b> municípios</span>` +
    `<span><b>${Object.keys(D.indicadores).length}</b> indicadores</span>` +
    `<span><b>${(D.fontes || []).length}</b> fontes oficiais</span>` +
    `<span>Última coleta: <b>${fmtData.format(d)}</b></span>`;
  $('#rodape').innerHTML =
    `Painel gerado automaticamente a partir de dados públicos. Coleta de ${fmtData.format(d)}. ` +
    `Os dados pertencem às instituições de origem; erros de agregação são deste painel, não delas.`;
}

async function iniciar() {
  try {
    D = window.DADOS || await (await fetch('./dados.json', { cache: 'no-store' })).json();
  } catch (e) {
    $('#conteudo').innerHTML = '<div class="vazio">Não foi possível carregar a base de dados.</div>';
    return;
  }
  MUNS = D.municipios;
  destaque = (MUNS.find((m) => m.destaque) || MUNS[0]).codigo;
  ativos = new Set(MUNS.map((m) => m.codigo));
  cabecalho();
  montarControles();
  render();
  addEventListener('mousemove', (ev) => { if (dica.style.opacity === '1') posicionarDica(ev); });
}
iniciar();
