// Coleta de dados publicos. Cada fonte e isolada: falha de uma nao derruba as demais.
import { httpGet, httpPost, retry, num, norm, pool, sleep } from './lib.js';

/* ------------------------------------------------------------------ */
/* Municipios do recorte                                               */
/* ------------------------------------------------------------------ */

export const MUNICIPIOS_ALVO = [
  { nome: 'Atibaia', destaque: true },
  { nome: 'Bragança Paulista' },
  { nome: 'Itatiba' },
  { nome: 'Jarinu' },
  { nome: 'Bom Jesus dos Perdões' },
  { nome: 'Nazaré Paulista' },
  { nome: 'Piracaia' },
  { nome: 'Jundiaí' },
];

const IBGE = 'https://servicodados.ibge.gov.br';

export async function resolverMunicipios() {
  const lista = await retry(() => httpGet(`${IBGE}/api/v1/localidades/estados/35/municipios`));
  const porNome = new Map(lista.map((m) => [norm(m.nome), m]));
  return MUNICIPIOS_ALVO.map((alvo) => {
    const m = porNome.get(norm(alvo.nome));
    if (!m) throw new Error(`Municipio nao encontrado no IBGE: ${alvo.nome}`);
    return {
      codigo: String(m.id),
      nome: m.nome,
      destaque: !!alvo.destaque,
      microrregiao: m.microrregiao?.nome || null,
      mesorregiao: m.microrregiao?.mesorregiao?.nome || null,
      regiaoImediata: m['regiao-imediata']?.nome || null,
      regiaoIntermediaria: m['regiao-imediata']?.['regiao-intermediaria']?.nome || null,
      uf: m.microrregiao?.mesorregiao?.UF?.sigla || 'SP',
    };
  });
}

/* ------------------------------------------------------------------ */
/* IBGE - API de agregados (SIDRA)                                     */
/* ------------------------------------------------------------------ */

export const ibgeMetadados = (agg) =>
  retry(() => httpGet(`${IBGE}/api/v3/agregados/${agg}/metadados`));

export async function ibgeValores({ agg, variaveis, periodos = '-1', localidades, classificacao }) {
  const vars = Array.isArray(variaveis) ? variaveis.join('|') : variaveis;
  const loc = `N6[${localidades.join(',')}]`;
  let url = `${IBGE}/api/v3/agregados/${agg}/periodos/${periodos}/variaveis/${vars}?localidades=${encodeURIComponent(loc)}`;
  if (classificacao) url += `&classificacao=${encodeURIComponent(classificacao)}`;
  const json = await retry(() => httpGet(url, { timeout: 90000 }));
  const out = [];
  for (const v of json || []) {
    for (const r of v.resultados || []) {
      const cat = (r.classificacoes || [])
        .map((c) => Object.values(c.categoria || {})[0])
        .filter(Boolean)
        .join(' / ');
      const valores = {};
      for (const s of r.series || []) {
        const cod = String(s.localidade?.id);
        const serie = {};
        for (const [per, val] of Object.entries(s.serie || {})) {
          const n = num(val);
          if (n !== null) serie[per] = n;
        }
        if (Object.keys(serie).length) valores[cod] = serie;
      }
      out.push({
        variavelId: String(v.id),
        variavel: v.variavel,
        unidade: v.unidade,
        categoria: cat || null,
        valores,
      });
    }
  }
  return out;
}

/**
 * Tabelas do IBGE usadas no painel.
 * `somaCategorias`: soma todas as categorias da classificacao (ex.: valor de todos os produtos).
 * `apenasTotal`: usa somente a categoria "Total" da classificacao.
 */
export const TABELAS_IBGE = [
  { chave: 'pop', agg: 6579, periodos: '-14', grupo: 'Demografia',
    rotulo: 'Estimativas da População', fonte: 'IBGE — Estimativas da População' },

  { chave: 'censo', agg: 4714, periodos: '-1', grupo: 'Demografia',
    rotulo: 'Censo 2022 — população, área e densidade', fonte: 'IBGE — Censo Demográfico 2022' },

  { chave: 'pib', agg: 5938, periodos: '-14', grupo: 'Economia',
    rotulo: 'PIB dos Municípios', fonte: 'IBGE — Produto Interno Bruto dos Municípios' },

  { chave: 'cempre', agg: 1685, periodos: '-12', grupo: 'Empresas e trabalho',
    rotulo: 'Cadastro Central de Empresas', fonte: 'IBGE — CEMPRE', apenasTotal: true },

  { chave: 'pam', agg: 5457, periodos: '-6', grupo: 'Agropecuária',
    rotulo: 'Produção Agrícola Municipal', fonte: 'IBGE — PAM', somaCategorias: true },

  { chave: 'registro', agg: 2612, periodos: '-8', grupo: 'Demografia',
    rotulo: 'Nascidos vivos — Registro Civil', fonte: 'IBGE — Estatísticas do Registro Civil', apenasTotal: true },
];

function classificacaoTotal(meta) {
  const partes = [];
  for (const c of meta.classificacoes || []) {
    const cats = c.categorias || [];
    const total = cats.find((k) => norm(k.nome) === 'total') || cats.find((k) => norm(k.nome).startsWith('total'));
    if (total) partes.push(`${c.id}[${total.id}]`);
  }
  return partes.length ? partes.join('|') : null;
}

function classificacaoTudo(meta) {
  const partes = (meta.classificacoes || []).map((c) => `${c.id}[all]`);
  return partes.length ? partes.join('|') : null;
}

export async function coletarIBGE(municipios, log) {
  const codigos = municipios.map((m) => m.codigo);
  const indicadores = {};
  const diagnostico = [];

  for (const t of TABELAS_IBGE) {
    const t0 = Date.now();
    try {
      const meta = await ibgeMetadados(t.agg);
      const variaveis = (meta.variaveis || []).map((v) => v.id);
      if (!variaveis.length) throw new Error('metadados sem variaveis');

      let classificacao = null;
      if (t.apenasTotal) classificacao = classificacaoTotal(meta);
      else if (t.somaCategorias) classificacao = classificacaoTudo(meta);

      const blocos = await ibgeValores({
        agg: t.agg, variaveis, periodos: t.periodos, localidades: codigos, classificacao,
      });

      let criados = 0;
      if (t.somaCategorias) {
        // Agrega todas as categorias por variavel
        const porVar = new Map();
        for (const b of blocos) {
          const chave = b.variavelId;
          if (!porVar.has(chave)) porVar.set(chave, { ...b, categoria: null, valores: {} });
          const acc = porVar.get(chave);
          for (const [cod, serie] of Object.entries(b.valores)) {
            acc.valores[cod] = acc.valores[cod] || {};
            for (const [per, val] of Object.entries(serie))
              acc.valores[cod][per] = (acc.valores[cod][per] || 0) + val;
          }
        }
        for (const b of porVar.values()) criados += registrar(indicadores, t, b, ' (total)') ? 1 : 0;
      } else {
        for (const b of blocos) {
          if (t.apenasTotal && b.categoria && !/total/i.test(b.categoria)) continue;
          criados += registrar(indicadores, t, b) ? 1 : 0;
        }
      }

      diagnostico.push({
        fonte: `IBGE ${t.agg}`, rotulo: t.rotulo, ok: criados > 0, indicadores: criados,
        nomeTabela: meta.nome, periodicidade: meta.periodicidade, ms: Date.now() - t0,
      });
      log?.(`IBGE ${t.agg} (${t.rotulo}): ${criados} indicadores`);
    } catch (e) {
      diagnostico.push({ fonte: `IBGE ${t.agg}`, rotulo: t.rotulo, ok: false, erro: String(e.message || e) });
      log?.(`IBGE ${t.agg} FALHOU: ${e.message}`);
    }
    await sleep(400);
  }
  return { indicadores, diagnostico };
}

function registrar(indicadores, t, b, sufixo = '') {
  const periodos = new Set();
  for (const v of Object.values(b.valores)) Object.keys(v).forEach((p) => periodos.add(p));
  if (!periodos.size) return false;
  const catSlug = b.categoria && !/^total/i.test(b.categoria)
    ? '_' + norm(b.categoria).replace(/\W+/g, '').slice(0, 24) : '';
  const id = `ibge_${t.chave}_${b.variavelId}${catSlug}`;
  indicadores[id] = {
    id,
    rotulo: b.variavel + (b.categoria && !/^total/i.test(b.categoria) ? ` — ${b.categoria}` : sufixo),
    unidade: b.unidade,
    grupo: t.grupo,
    tabela: t.rotulo,
    fonte: t.fonte,
    fonteUrl: `https://sidra.ibge.gov.br/tabela/${t.agg}`,
    periodos: [...periodos].sort(),
    valores: b.valores,
  };
  return true;
}

/* Catalogo de tabelas municipais do IBGE (para evolucao do painel) */
export async function catalogoIBGE() {
  return retry(() => httpGet(`${IBGE}/api/v3/agregados?nivel=N6`, { timeout: 120000 }));
}

/* ------------------------------------------------------------------ */
/* Tesouro Nacional - SICONFI                                          */
/* ------------------------------------------------------------------ */

const SICONFI = 'https://apidatalake.tesouro.gov.br/ords/siconfi/tt';

const siconfiDCA = ({ ano, anexo, ente }) =>
  retry(
    () =>
      httpGet(
        `${SICONFI}/dca?an_exercicio=${ano}&no_anexo=${encodeURIComponent(anexo)}&id_ente=${ente}`,
        { timeout: 90000 }
      ),
    2,
    3000
  ).then((j) => j.items || []);

const DEF_FIN = {
  grupo: 'Finanças públicas',
  fonte: 'Tesouro Nacional — SICONFI / DCA',
  fonteUrl: 'https://siconfi.tesouro.gov.br/siconfi/pages/public/consulta_finbra/finbra_list.jsf',
  unidade: 'R$',
};

// Funcoes de governo publicadas no Anexo I-E (conta no formato "NN - Nome").
const FUNCOES = {
  '01': 'Legislativa', '02': 'Judiciária', '03': 'Essencial à Justiça', '04': 'Administração',
  '06': 'Segurança Pública', '08': 'Assistência Social', '09': 'Previdência Social',
  '10': 'Saúde', '11': 'Trabalho', '12': 'Educação', '13': 'Cultura',
  '14': 'Direitos da Cidadania', '15': 'Urbanismo', '16': 'Habitação', '17': 'Saneamento',
  '18': 'Gestão Ambiental', '19': 'Ciência e Tecnologia', '20': 'Agricultura',
  '21': 'Organização Agrária', '22': 'Indústria', '23': 'Comércio e Serviços',
  '24': 'Comunicações', '25': 'Energia', '26': 'Transporte', '27': 'Desporto e Lazer',
  '28': 'Encargos Especiais',
};

// Receitas do Anexo I-C, identificadas pelo cod_conta da natureza orcamentaria.
const RECEITAS = [
  { cod: 'ReceitasExcetoIntraOrcamentarias', id: 'fin_receita_total', rotulo: 'Receita orçamentária total (exceto intra)' },
  { cod: 'RO1.0.0.0.00.0.0', id: 'fin_receita_corrente', rotulo: 'Receitas correntes' },
  { cod: 'RO1.1.0.0.00.0.0', id: 'fin_receita_tributaria', rotulo: 'Receita tributária (impostos, taxas e contribuição de melhoria)' },
  { cod: 'RO1.3.0.0.00.0.0', id: 'fin_receita_patrimonial', rotulo: 'Receita patrimonial' },
  { cod: 'RO1.6.0.0.00.0.0', id: 'fin_receita_servicos', rotulo: 'Receita de serviços' },
  { cod: 'RO1.7.0.0.00.0.0', id: 'fin_transferencias', rotulo: 'Transferências correntes recebidas' },
  { cod: 'RO2.0.0.0.00.0.0', id: 'fin_receita_capital', rotulo: 'Receitas de capital' },
  { cod: 'RO2.1.0.0.00.0.0', id: 'fin_operacoes_credito', rotulo: 'Operações de crédito' },
];

const COL_BRUTA = 'receitas brutas realizadas';
const COL_DEDUCOES = ['deducoes - fundeb', 'outras deducoes da receita'];

export async function coletarSiconfi(municipios, log) {
  const anoAtual = new Date().getFullYear();
  const anos = [];
  for (let a = anoAtual - 1; a >= anoAtual - 8; a--) anos.push(a);

  const indicadores = {};
  const set = (id, def, cod, per, val) => {
    if (val === null || val === undefined || !Number.isFinite(Number(val))) return;
    if (!indicadores[id]) indicadores[id] = { id, valores: {}, periodos: [], ...def };
    const ind = indicadores[id];
    ind.valores[cod] = ind.valores[cod] || {};
    ind.valores[cod][per] = Number(val);
    if (!ind.periodos.includes(per)) ind.periodos.push(per);
  };

  const tarefas = [];
  for (const m of municipios) for (const ano of anos) tarefas.push({ m, ano });

  let receitasOk = 0, despesasOk = 0, vazios = 0, erros = 0;
  const errosExemplo = [];

  await pool(tarefas, 4, async ({ m, ano }) => {
    const per = String(ano);

    /* ---- Receitas (Anexo I-C) ---- */
    try {
      const linhas = await siconfiDCA({ ano, anexo: 'DCA-Anexo I-C', ente: m.codigo });
      if (linhas.length) {
        receitasOk++;
        // Cada conta aparece em varias linhas, uma por coluna: bruta e deducoes.
        const porConta = new Map();
        for (const r of linhas) {
          const c = String(r.cod_conta || '');
          if (!porConta.has(c)) porConta.set(c, { bruta: 0, deducoes: 0 });
          const alvo = porConta.get(c);
          const col = norm(r.coluna);
          const v = Number(r.valor) || 0;
          if (col === COL_BRUTA) alvo.bruta += v;
          else if (COL_DEDUCOES.includes(col)) alvo.deducoes += v;
        }
        for (const rec of RECEITAS) {
          const v = porConta.get(rec.cod);
          if (!v || !v.bruta) continue;
          set(rec.id, { ...DEF_FIN, rotulo: rec.rotulo }, m.codigo, per, v.bruta - v.deducoes);
          if (rec.id === 'fin_receita_total')
            set('fin_receita_bruta', { ...DEF_FIN, rotulo: 'Receita orçamentária bruta (antes das deduções)' },
              m.codigo, per, v.bruta);
        }
        const pop = linhas.find((r) => r.populacao)?.populacao;
        if (pop) set('fin_pop_ref', { ...DEF_FIN, grupo: 'Demografia', unidade: 'Pessoas',
          rotulo: 'População de referência (Tesouro Nacional)' }, m.codigo, per, pop);
      } else vazios++;
    } catch (e) {
      erros++;
      if (errosExemplo.length < 3) errosExemplo.push(`I-C ${m.nome}/${ano}: ${e.message}`);
    }

    /* ---- Despesas por função (Anexo I-E) ---- */
    try {
      const linhas = await siconfiDCA({ ano, anexo: 'DCA-Anexo I-E', ente: m.codigo });
      if (linhas.length) {
        despesasOk++;
        const porFuncao = {};
        for (const r of linhas) {
          if (norm(r.coluna) !== 'despesas empenhadas') continue;
          const mm = /^(\d{2}) - (.+)$/.exec(String(r.conta || '').trim());
          if (!mm) continue; // ignora subfunções (NN.NNN) e linhas de totalização
          porFuncao[mm[1]] = (porFuncao[mm[1]] || 0) + (Number(r.valor) || 0);
        }
        const total = Object.values(porFuncao).reduce((s, v) => s + v, 0);
        if (total) set('fin_despesa_total', { ...DEF_FIN, rotulo: 'Despesa empenhada total' }, m.codigo, per, total);
        for (const [num, valor] of Object.entries(porFuncao)) {
          const nome = FUNCOES[num];
          if (!nome || !valor) continue;
          set(`fin_desp_${num}`, { ...DEF_FIN, rotulo: `Despesa empenhada — ${nome}` }, m.codigo, per, valor);
        }
      } else vazios++;
    } catch (e) {
      erros++;
      if (errosExemplo.length < 3) errosExemplo.push(`I-E ${m.nome}/${ano}: ${e.message}`);
    }
  });

  for (const ind of Object.values(indicadores)) ind.periodos.sort();
  const diagnostico = [{
    fonte: 'Tesouro Nacional / SICONFI', rotulo: 'Declaração de Contas Anuais (DCA)',
    ok: receitasOk > 0, receitasOk, despesasOk, vazios, erros, errosExemplo,
    anos, indicadores: Object.keys(indicadores).length,
  }];
  log?.(`SICONFI: receitas ${receitasOk}, despesas ${despesasOk}, vazios ${vazios}, erros ${erros}`);
  return { indicadores, diagnostico };
}

/* ------------------------------------------------------------------ */
/* Comex Stat (MDIC) - comercio exterior por municipio                 */
/* ------------------------------------------------------------------ */

const COMEX = 'https://api-comexstat.mdic.gov.br';

export async function coletarComex(municipios, log) {
  const indicadores = {};
  const diagnostico = [];
  let atualizado = null, ultimoAno = null, ultimoMes = null;
  try {
    const upd = await retry(() => httpGet(`${COMEX}/general/dates/updated`), 2, 2000);
    atualizado = upd?.data?.updated || null;
    ultimoAno = Number(upd?.data?.year) || new Date().getFullYear();
    ultimoMes = Number(upd?.data?.monthNumber) || 12;
  } catch {
    ultimoAno = new Date().getFullYear() - 1;
    ultimoMes = 12;
  }

  // Só anos completos entram na série anual: um ano em curso pareceria uma queda.
  const anoFim = ultimoMes >= 12 ? ultimoAno : ultimoAno - 1;
  const anoIni = anoFim - 7;

  const consultar = async (fluxo, corpo) => {
    const j = await retry(() => httpPost(`${COMEX}/cities`, corpo), 2, 4000);
    return j?.data?.list || (Array.isArray(j?.data) ? j.data : []) || [];
  };
  const codMun = (r) => String(r.coMun ?? r.city ?? r.coMunicipio ?? '').replace(/\D/g, '');
  const casar = (raw) => municipios.find((m) => m.codigo.slice(0, 6) === raw.slice(0, 6));

  for (const fluxo of ['export', 'import']) {
    const ehExp = fluxo === 'export';
    /* --- série anual (anos fechados) --- */
    try {
      const lista = await consultar(fluxo, {
        flow: fluxo, monthDetail: false,
        period: { from: `${anoIni}-01`, to: `${anoFim}-12` },
        filters: [{ filter: 'city', values: municipios.map((m) => Number(m.codigo)) }],
        details: ['city', 'year'], metrics: ['metricFOB', 'metricKG'],
      });
      const id = ehExp ? 'comex_export_fob' : 'comex_import_fob';
      const ind = {
        id, rotulo: ehExp ? 'Exportações (US$ FOB)' : 'Importações (US$ FOB)',
        unidade: 'US$ FOB', grupo: 'Comércio exterior',
        fonte: 'MDIC — Comex Stat (município de domicílio fiscal da empresa)',
        fonteUrl: 'https://comexstat.mdic.gov.br/pt/municipio',
        nota: `Somente anos fechados. Base atualizada em ${atualizado || 's/d'}.`,
        periodos: [], valores: {},
      };
      for (const r of lista) {
        const alvo = casar(codMun(r));
        const ano = String(r.year ?? r.coAno ?? '');
        const fob = num(r.metricFOB ?? r.vlFob ?? r.fob);
        if (!alvo || !/^\d{4}$/.test(ano) || fob === null || Number(ano) > anoFim) continue;
        ind.valores[alvo.codigo] = ind.valores[alvo.codigo] || {};
        ind.valores[alvo.codigo][ano] = (ind.valores[alvo.codigo][ano] || 0) + fob;
        if (!ind.periodos.includes(ano)) ind.periodos.push(ano);
      }
      ind.periodos.sort();
      if (ind.periodos.length) indicadores[id] = ind;
      diagnostico.push({ fonte: 'Comex Stat', rotulo: `${fluxo} anual`, ok: ind.periodos.length > 0,
        registros: lista.length, periodo: `${anoIni}–${anoFim}`, atualizado });
      log?.(`Comex ${fluxo} anual: ${lista.length} registros (${anoIni}–${anoFim})`);
    } catch (e) {
      diagnostico.push({ fonte: 'Comex Stat', rotulo: `${fluxo} anual`, ok: false, erro: String(e.message || e) });
      log?.(`Comex ${fluxo} anual FALHOU: ${e.message}`);
    }
    await sleep(800);

    /* --- acumulado dos últimos 12 meses --- */
    try {
      const de = new Date(Date.UTC(ultimoAno, ultimoMes - 12, 1));
      const desde = `${de.getUTCFullYear()}-${String(de.getUTCMonth() + 1).padStart(2, '0')}`;
      const ate = `${ultimoAno}-${String(ultimoMes).padStart(2, '0')}`;
      const lista = await consultar(fluxo, {
        flow: fluxo, monthDetail: false,
        period: { from: desde, to: ate },
        filters: [{ filter: 'city', values: municipios.map((m) => Number(m.codigo)) }],
        details: ['city'], metrics: ['metricFOB'],
      });
      const id = ehExp ? 'comex_export_12m' : 'comex_import_12m';
      const per = ate;
      const ind = {
        id, rotulo: ehExp ? 'Exportações — acumulado 12 meses' : 'Importações — acumulado 12 meses',
        unidade: 'US$ FOB', grupo: 'Comércio exterior',
        fonte: 'MDIC — Comex Stat (município de domicílio fiscal da empresa)',
        fonteUrl: 'https://comexstat.mdic.gov.br/pt/municipio',
        nota: `Soma de ${desde} a ${ate}.`, periodos: [per], valores: {},
      };
      for (const r of lista) {
        const alvo = casar(codMun(r));
        const fob = num(r.metricFOB ?? r.vlFob ?? r.fob);
        if (!alvo || fob === null) continue;
        ind.valores[alvo.codigo] = ind.valores[alvo.codigo] || {};
        ind.valores[alvo.codigo][per] = (ind.valores[alvo.codigo][per] || 0) + fob;
      }
      if (Object.keys(ind.valores).length) indicadores[id] = ind;
      diagnostico.push({ fonte: 'Comex Stat', rotulo: `${fluxo} 12 meses`,
        ok: Object.keys(ind.valores).length > 0, janela: `${desde}–${ate}`, registros: lista.length });
      log?.(`Comex ${fluxo} 12m: ${lista.length} registros (${desde}–${ate})`);
    } catch (e) {
      diagnostico.push({ fonte: 'Comex Stat', rotulo: `${fluxo} 12 meses`, ok: false, erro: String(e.message || e) });
    }
    await sleep(800);
  }
  return { indicadores, diagnostico };
}

/* ------------------------------------------------------------------ */
/* Banco Central - contexto macro                                      */
/* ------------------------------------------------------------------ */

const SGS = [
  { serie: 433, id: 'macro_ipca', rotulo: 'IPCA — variação mensal', unidade: '% a.m.' },
  { serie: 4390, id: 'macro_selic', rotulo: 'Selic — taxa mensal', unidade: '% a.m.' },
  { serie: 24363, id: 'macro_ibcbr', rotulo: 'IBC-Br — atividade econômica', unidade: 'índice' },
  { serie: 1, id: 'macro_cambio', rotulo: 'Dólar comercial (venda)', unidade: 'R$/US$' },
  { serie: 24380, id: 'macro_desocupacao', rotulo: 'Taxa de desocupação (PNAD Contínua)', unidade: '%' },
];

export async function coletarMacro(log) {
  const macro = {};
  const diagnostico = [];
  for (const s of SGS) {
    try {
      const j = await retry(
        () => httpGet(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${s.serie}/dados/ultimos/72?formato=json`),
        2, 1500
      );
      macro[s.id] = {
        id: s.id, rotulo: s.rotulo, unidade: s.unidade,
        fonte: 'Banco Central do Brasil — SGS',
        fonteUrl: `https://www3.bcb.gov.br/sgspub/consultarvalores/telaCvsSelecionarSeries.paint?SERIE=${s.serie}`,
        pontos: (j || []).map((p) => ({ data: p.data, valor: num(p.valor) })).filter((p) => p.valor !== null),
      };
    } catch (e) {
      diagnostico.push({ fonte: 'BCB SGS', rotulo: String(s.serie), ok: false, erro: String(e.message || e) });
    }
  }
  diagnostico.push({ fonte: 'Banco Central — SGS', rotulo: 'contexto macroeconômico',
    ok: Object.keys(macro).length > 0, series: Object.keys(macro).length });
  log?.(`BCB: ${Object.keys(macro).length} séries`);
  return { macro, diagnostico };
}

/* ------------------------------------------------------------------ */
/* ANEEL - consumo de energia eletrica por municipio (proxy de         */
/* atividade economica, mensal)                                        */
/* ------------------------------------------------------------------ */

export async function coletarAneel(municipios, log) {
  const indicadores = {};
  const diagnostico = [];
  try {
    const busca = await retry(
      () => httpGet('https://dadosabertos.aneel.gov.br/api/3/action/package_search?q=consumo+mensal+classe+municipio&rows=10'),
      2, 2500
    );
    const pacotes = busca?.result?.results || [];
    const recursos = pacotes
      .flatMap((p) => (p.resources || []).map((r) => ({ ...r, pacote: p.title })))
      .filter((r) => /datastore|csv/i.test(r.format || '') && r.datastore_active);
    const alvo = recursos[0];
    if (!alvo) throw new Error('nenhum recurso datastore encontrado');

    const nomes = municipios.map((m) => m.nome.toUpperCase());
    const linhas = [];
    for (const nome of nomes) {
      const url =
        `https://dadosabertos.aneel.gov.br/api/3/action/datastore_search?resource_id=${alvo.id}` +
        `&q=${encodeURIComponent(nome)}&limit=2000`;
      const j = await retry(() => httpGet(url, { timeout: 90000 }), 2, 2000);
      linhas.push(...(j?.result?.records || []));
      await sleep(400);
    }
    diagnostico.push({
      fonte: 'ANEEL', rotulo: alvo.pacote || alvo.name, ok: linhas.length > 0,
      recurso: alvo.id, registros: linhas.length,
      camposExemplo: linhas[0] ? Object.keys(linhas[0]) : [],
    });
    log?.(`ANEEL: ${linhas.length} registros brutos (recurso ${alvo.id})`);
    // A estrutura de campos da ANEEL varia por publicacao; o diagnostico acima
    // registra os campos disponiveis para consolidacao na proxima rodada.
  } catch (e) {
    diagnostico.push({ fonte: 'ANEEL', rotulo: 'consumo de energia', ok: false, erro: String(e.message || e) });
    log?.(`ANEEL FALHOU: ${e.message}`);
  }
  return { indicadores, diagnostico };
}

/* ------------------------------------------------------------------ */
/* Ministerio do Trabalho - Novo CAGED (saldo de empregos formais)      */
/* ------------------------------------------------------------------ */

export async function coletarCaged(municipios, log) {
  const indicadores = {};
  const diagnostico = [];
  const candidatos = [
    'https://dadosabertos.mte.gov.br/api/3/action/package_search?q=novo+caged&rows=5',
    'https://pdet.mte.gov.br/api/novocaged',
  ];
  for (const url of candidatos) {
    try {
      const j = await httpGet(url, { timeout: 45000 });
      diagnostico.push({ fonte: 'CAGED', rotulo: url, ok: true,
        amostra: JSON.stringify(j).slice(0, 400) });
      log?.(`CAGED: resposta de ${url}`);
      break;
    } catch (e) {
      diagnostico.push({ fonte: 'CAGED', rotulo: url, ok: false, erro: String(e.message || e) });
    }
  }
  return { indicadores, diagnostico };
}
