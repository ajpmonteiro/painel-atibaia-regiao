// Coleta de dados publicos. Cada fonte e isolada: falha de uma nao derruba as demais.
import { httpGet, httpPost, retry, num, norm, pool, sleep } from './lib.js';

/* ------------------------------------------------------------------ */
/* Municipios do recorte                                               */
/* ------------------------------------------------------------------ */

/**
 * Os códigos vêm da própria API de localidades do IBGE (verificados em 25/08/2026) e
 * ficam gravados aqui de propósito: são estáveis por décadas, e sem eles uma oscilação
 * de rede na primeira chamada derrubava a coleta inteira — inclusive Tesouro, Comex e
 * Banco Central, que não dependem do IBGE para nada.
 */
export const MUNICIPIOS_ALVO = [
  { codigo: '3504107', nome: 'Atibaia', destaque: true },
  { codigo: '3507605', nome: 'Bragança Paulista' },
  { codigo: '3523404', nome: 'Itatiba' },
  { codigo: '3525201', nome: 'Jarinu' },
  { codigo: '3507100', nome: 'Bom Jesus dos Perdões' },
  { codigo: '3532405', nome: 'Nazaré Paulista' },
  { codigo: '3538600', nome: 'Piracaia' },
  { codigo: '3525904', nome: 'Jundiaí' },
];

const IBGE = 'https://servicodados.ibge.gov.br';

const municipioBasico = (alvo) => ({
  codigo: alvo.codigo,
  nome: alvo.nome,
  destaque: !!alvo.destaque,
  microrregiao: 'Bragança Paulista',
  mesorregiao: 'Macro Metropolitana Paulista',
  regiaoImediata: null,
  regiaoIntermediaria: null,
  uf: 'SP',
});

/**
 * Enriquece o recorte com os dados de região do IBGE. Se a API não responder,
 * segue com os códigos gravados: a coleta não pode morrer numa oscilação de rede.
 */
export async function resolverMunicipios(log) {
  try {
    const lista = await retry(
      () => httpGet(`${IBGE}/api/v1/localidades/estados/35/municipios`, { timeout: 60000 }),
      4, 4000
    );
    const porCodigo = new Map(lista.map((m) => [String(m.id), m]));
    return MUNICIPIOS_ALVO.map((alvo) => {
      const m = porCodigo.get(alvo.codigo);
      if (!m) return municipioBasico(alvo);
      return {
        codigo: alvo.codigo,
        nome: m.nome,
        destaque: !!alvo.destaque,
        microrregiao: m.microrregiao?.nome || null,
        mesorregiao: m.microrregiao?.mesorregiao?.nome || null,
        regiaoImediata: m['regiao-imediata']?.nome || null,
        regiaoIntermediaria: m['regiao-imediata']?.['regiao-intermediaria']?.nome || null,
        uf: m.microrregiao?.mesorregiao?.UF?.sigla || 'SP',
      };
    });
  } catch (e) {
    log?.(`Localidades do IBGE indisponível (${e.message}); seguindo com os códigos gravados.`);
    return MUNICIPIOS_ALVO.map(municipioBasico);
  }
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
      const catMap = {};
      for (const c of r.classificacoes || []) {
        const nome = Object.values(c.categoria || {})[0];
        if (nome) catMap[String(c.id)] = nome;
      }
      const cat = Object.values(catMap).filter(Boolean).join(' / ');
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
        catMap,
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
    rotulo: 'PIB dos Municípios', fonte: 'IBGE — Produto Interno Bruto dos Municípios',
    // As variáveis "Participação ..." repetem o mesmo rótulo para Brasil, UF e região;
    // o painel calcula as suas próprias participações a partir dos valores absolutos.
    excluir: /^particip/i },

  { chave: 'cempre', agg: 1685, periodos: '-12', grupo: 'Empresas e trabalho',
    rotulo: 'Cadastro Central de Empresas', fonte: 'IBGE — CEMPRE', apenasTotal: true },

  { chave: 'pam', agg: 5457, periodos: '-6', grupo: 'Agropecuária',
    rotulo: 'Produção Agrícola Municipal', fonte: 'IBGE — PAM', somaCategorias: true,
    // Rendimento médio é uma razão: somá-lo entre culturas não produz nada.
    excluir: /percentual do total geral|rendimento m[ée]dio/i },

  { chave: 'crescimento', agg: 4709, periodos: '-1', grupo: 'Demografia',
    rotulo: 'Censo 2022 — variação e taxa de crescimento', fonte: 'IBGE — Censo Demográfico 2022' },

  { chave: 'agua', agg: 6804, periodos: '-1', grupo: 'Infraestrutura urbana',
    rotulo: 'Censo 2022 — abastecimento de água', fonte: 'IBGE — Censo Demográfico 2022',
    fatia: { classificacao: /abastecimento/i, destaque: /^rede geral/i,
             rotulo: 'Domicílios com água de rede geral' } },

  { chave: 'esgoto', agg: 6805, periodos: '-1', grupo: 'Infraestrutura urbana',
    rotulo: 'Censo 2022 — esgotamento sanitário', fonte: 'IBGE — Censo Demográfico 2022',
    fatia: { classificacao: /esgotamento/i, destaque: /^rede geral/i,
             rotulo: 'Domicílios com esgotamento adequado (rede geral, pluvial ou fossa ligada à rede)' } },

  { chave: 'lixo', agg: 6892, periodos: '-1', grupo: 'Infraestrutura urbana',
    rotulo: 'Censo 2022 — destino do lixo', fonte: 'IBGE — Censo Demográfico 2022',
    fatia: { classificacao: /lixo/i, destaque: /^coletado$/i,
             rotulo: 'Domicílios com coleta de lixo' } },

  { chave: 'registro', agg: 2612, periodos: '-8', grupo: 'Demografia',
    rotulo: 'Nascidos vivos — Registro Civil', fonte: 'IBGE — Estatísticas do Registro Civil',
    apenasTotal: true, excluir: /percentual do total geral/i },
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

/**
 * Uma classificação é o tema (todas as categorias); as demais ficam no "Total",
 * para não multiplicar o cruzamento e contar o mesmo domicílio duas vezes.
 */
function classificacaoFatia(meta, re) {
  const cls = meta.classificacoes || [];
  if (!cls.length) return { spec: null, temaId: null };
  // Escolha do tema, em ordem de confiança: nome bate com o esperado; é a única
  // classificação; ou é a que tem mais categorias. O nome das classificações não
  // é estável entre tabelas do IBGE — por isso os dois planos B.
  let tema = cls.find((c) => re.test(c.nome || ''));
  if (!tema && cls.length === 1) tema = cls[0];
  if (!tema) tema = [...cls].sort((a, b) => (b.categorias?.length || 0) - (a.categorias?.length || 0))[0];

  const partes = [];
  for (const c of cls) {
    if (String(c.id) === String(tema.id)) { partes.push(`${c.id}[all]`); continue; }
    const total = (c.categorias || []).find((k) => norm(k.nome) === 'total');
    partes.push(`${c.id}[${total ? total.id : 'all'}]`);
  }
  return { spec: partes.join('|'), temaId: String(tema.id), temaNome: tema.nome };
}

/** Soma, célula a célula, os valores de dois blocos. */
function somarValores(acc, b) {
  const out = acc || {};
  for (const [cod, serie] of Object.entries(b.valores)) {
    out[cod] = out[cod] || {};
    for (const [per, val] of Object.entries(serie)) out[cod][per] = (out[cod][per] || 0) + val;
  }
  return out;
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
      const variaveis = (meta.variaveis || [])
        .filter((v) => !t.excluir || !t.excluir.test(v.nome || ''))
        .map((v) => v.id);
      if (!variaveis.length) throw new Error('metadados sem variaveis utilizáveis');

      let classificacao = null;
      let temaId = null;
      let temaEscolhido = null;
      const somadas = [];
      if (t.apenasTotal) classificacao = classificacaoTotal(meta);
      else if (t.somaCategorias) classificacao = classificacaoTudo(meta);
      else if (t.fatia) {
        const f = classificacaoFatia(meta, t.fatia.classificacao);
        classificacao = f.spec;
        temaId = f.temaId;
        if (!temaId) throw new Error('tabela sem classificação para fatiar');
        temaEscolhido = f.temaNome;
      }

      const blocos = await ibgeValores({
        agg: t.agg, variaveis, periodos: t.periodos, localidades: codigos, classificacao,
      });

      let criados = 0;
      if (t.fatia) {
        // As categorias do IBGE são hierárquicas: "Coletado" contém "Coletado no
        // domicílio..." e "Depositado em caçamba...". Somar pai e filhos conta o
        // mesmo domicílio duas vezes — por isso só o nível mais alto entra na conta.
        const clsTema = (meta.classificacoes || []).find((c) => String(c.id) === temaId);
        const semTotal = (clsTema?.categorias || []).filter((k) => norm(k.nome) !== 'total');
        const nivelTopo = Math.min(...semTotal.map((k) => k.nivel ?? 0));
        const doTopo = new Set(
          semTotal.filter((k) => (k.nivel ?? 0) === nivelTopo).map((k) => norm(k.nome))
        );
        const porVar = new Map();
        for (const b of blocos) {
          if (/%|percentual/i.test(b.unidade || '')) continue;
          const nomeCat = b.catMap?.[temaId];
          if (!nomeCat) continue;
          if (norm(nomeCat) !== 'total' && !doTopo.has(norm(nomeCat))) continue;
          if (!porVar.has(b.variavelId)) porVar.set(b.variavelId, { ref: b, total: null, destaque: null, soma: null });
          const g = porVar.get(b.variavelId);
          if (norm(nomeCat) === 'total') g.total = b.valores;
          else {
            g.soma = somarValores(g.soma, b);
            if (t.fatia.destaque.test(nomeCat)) {
              g.destaque = somarValores(g.destaque, b);
              if (!somadas.includes(nomeCat)) somadas.push(nomeCat);
            }
          }
        }
        for (const [varId, g] of porVar) {
          if (!g.destaque) continue;
          const denominador = g.total || g.soma;
          const periodos = new Set();
          const pct = {};
          for (const [cod, serie] of Object.entries(g.destaque)) {
            for (const [per, val] of Object.entries(serie)) {
              const den = denominador?.[cod]?.[per];
              if (!den) continue;
              pct[cod] = pct[cod] || {};
              pct[cod][per] = (val / den) * 100;
              periodos.add(per);
            }
          }
          // Uma parte não pode ser maior que o todo: se for, algo na hierarquia de
          // categorias mudou e é melhor não publicar do que publicar errado.
          const maior = Math.max(0, ...Object.values(pct).flatMap((v) => Object.values(v)));
          if (maior > 100.5) {
            log?.(`IBGE ${t.agg}: percentual de ${maior.toFixed(1)}% — categorias somadas: ${somadas.join(' + ')}. Indicador descartado.`);
            continue;
          }
          const base = { grupo: t.grupo, tabela: t.rotulo, fonte: t.fonte,
            fonteUrl: `https://sidra.ibge.gov.br/tabela/${t.agg}` };
          const idAbs = `ibge_${t.chave}_${varId}`;
          indicadores[idAbs] = { id: idAbs, rotulo: t.fatia.rotulo, unidade: g.ref.unidade,
            ...base, periodos: [...periodos].sort(), valores: g.destaque };
          criados++;
          if (Object.keys(pct).length) {
            const idPct = `ibge_${t.chave}_${varId}_pct`;
            indicadores[idPct] = { id: idPct, rotulo: `${t.fatia.rotulo} — % do total`,
              unidade: '%', ...base, periodos: [...periodos].sort(), valores: pct };
            criados++;
          }
        }
      } else if (t.somaCategorias) {
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
        classificacaoUsada: temaEscolhido || undefined,
        categoriasVistas: t.fatia
          ? [...new Set(blocos.map((b) => b.catMap?.[temaId]).filter(Boolean))].slice(0, 20)
          : undefined,
        categoriasSomadas: t.fatia ? somadas : undefined,
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

/**
 * Aprendido com as respostas reais da API:
 *  - o município vem pelo NOME com a sigla da UF (`noMunMinsgUf`, ex.: "Atibaia - SP"),
 *    não por código: o filtro numérico por `city` não casa com nada;
 *  - "year" não é um `detail` válido (400 "Invalid detail item"), mas o ano volta
 *    de qualquer forma quando `monthDetail` é falso;
 *  - o recorte municipal existe apenas em granularidade ANUAL: janelas parciais e
 *    `monthDetail: true` devolvem lista vazia, sem erro;
 *  - há limite de frequência de chamadas (429, "tente novamente em 10 segundos").
 * Por isso: uma consulta por fluxo cobrindo todos os anos fechados, sem filtro,
 * casando os nomes localmente.
 */
let ultimaChamadaComex = 0;
async function comexCities(corpo) {
  const espera = 4000 - (Date.now() - ultimaChamadaComex);
  if (espera > 0) await sleep(espera);
  ultimaChamadaComex = Date.now();
  const pedir = async () => {
    const j = await httpPost(`${COMEX}/cities`, corpo, { timeout: 120000 });
    return j?.data?.list || (Array.isArray(j?.data) ? j.data : []) || [];
  };
  try {
    return await pedir();
  } catch (e) {
    if (!/HTTP 429/.test(e.message)) throw e;
    await sleep(15000);
    ultimaChamadaComex = Date.now();
    return pedir();
  }
}

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

  // Um ano em curso pareceria uma queda: a série anual só usa anos fechados.
  const anoFim = ultimoMes >= 12 ? ultimoAno : ultimoAno - 1;
  const anoIni = anoFim - 7;

  const porNome = new Map(municipios.map((m) => [norm(m.nome), m]));
  const naoCasados = new Set();
  /** "Atibaia - SP" -> município do recorte (a UF evita homônimos de outros estados). */
  const casar = (r) => {
    const bruto = String(r.noMunMinsgUf ?? r.noMun ?? r.city ?? r.coMun ?? '');
    const m = /^(.*?)\s*-\s*([A-Za-z]{2})\s*$/.exec(bruto);
    if (!m) return null;
    if (m[2].toUpperCase() !== 'SP') return null;
    const achado = porNome.get(norm(m[1]));
    if (!achado && naoCasados.size < 25) naoCasados.add(bruto);
    return achado || null;
  };
  const fobDe = (r) => num(r.metricFOB ?? r.vlFob ?? r.fob);

  // Com monthDetail falso a API agrega por ano e só responde a janelas de anos
  // inteiros — uma janela móvel que atravessa o ano volta vazia. Para o acumulado
  // de 12 meses pedimos detalhe mensal e somamos.
  const corpo = (fluxo, de, ate, mensal = false) => ({
    flow: fluxo,
    monthDetail: mensal,
    period: { from: de, to: ate },
    filters: [],
    details: ['state', 'city'],
    metrics: ['metricFOB'],
  });

  for (const fluxo of ['export', 'import']) {
    const ehExp = fluxo === 'export';

    /* --- série anual --- */
    try {
      const lista = await comexCities(corpo(fluxo, `${anoIni}-01`, `${anoFim}-12`));
      const id = ehExp ? 'comex_export_fob' : 'comex_import_fob';
      const ind = {
        id, rotulo: ehExp ? 'Exportações (US$ FOB)' : 'Importações (US$ FOB)',
        unidade: 'US$ FOB', grupo: 'Comércio exterior',
        fonte: 'MDIC — Comex Stat (município de domicílio fiscal da empresa)',
        fonteUrl: 'https://comexstat.mdic.gov.br/pt/municipio',
        nota: `Somente anos fechados. Base atualizada em ${atualizado || 's/d'}.`,
        periodos: [], valores: {},
      };
      let casados = 0;
      for (const r of lista) {
        const m = casar(r);
        const ano = String(r.year ?? r.coAno ?? '');
        const fob = fobDe(r);
        if (!m || !/^\d{4}$/.test(ano) || fob === null || Number(ano) > anoFim) continue;
        ind.valores[m.codigo] = ind.valores[m.codigo] || {};
        ind.valores[m.codigo][ano] = (ind.valores[m.codigo][ano] || 0) + fob;
        if (!ind.periodos.includes(ano)) ind.periodos.push(ano);
        casados++;
      }
      ind.periodos.sort();
      if (ind.periodos.length) indicadores[id] = ind;
      diagnostico.push({
        fonte: 'Comex Stat', rotulo: `${fluxo} — série anual`,
        ok: ind.periodos.length > 0, periodo: `${anoIni}–${anoFim}`, atualizado,
        linhasRecebidas: lista.length, linhasCasadas: casados,
        camposRecebidos: lista[0] ? Object.keys(lista[0]) : [],
        exemploNaoCasado: ind.periodos.length ? undefined : [...naoCasados].slice(0, 8),
      });
      log?.(`Comex ${fluxo} anual: ${casados} linhas casadas de ${lista.length}, anos ${ind.periodos.join(',')}`);
    } catch (e) {
      diagnostico.push({ fonte: 'Comex Stat', rotulo: `${fluxo} — série anual`,
        ok: false, erro: String(e.message || e).slice(0, 220) });
      log?.(`Comex ${fluxo} anual FALHOU: ${e.message}`);
    }

    /* --- acumulado do ano corrente ---
       Tentativa: janela de janeiro ao último mês publicado. Se o recorte municipal
       não aceitar ano parcial, degrada sem barulho — o dado simplesmente não existe
       nessa granularidade. */
    if (ultimoMes < 12) {
      try {
        const ate = `${ultimoAno}-${String(ultimoMes).padStart(2, '0')}`;
        const lista = await comexCities(corpo(fluxo, `${ultimoAno}-01`, ate));
        const idYtd = ehExp ? 'comex_export_ytd' : 'comex_import_ytd';
        const indYtd = {
          id: idYtd,
          rotulo: ehExp ? 'Exportações — acumulado do ano' : 'Importações — acumulado do ano',
          unidade: 'US$ FOB', grupo: 'Comércio exterior',
          fonte: 'MDIC — Comex Stat (município de domicílio fiscal da empresa)',
          fonteUrl: 'https://comexstat.mdic.gov.br/pt/municipio',
          nota: `Janeiro a ${ate}. Ano ainda em curso: não comparável aos anos fechados.`,
          periodos: [ate], valores: {},
        };
        for (const r of lista) {
          const m = casar(r);
          const fob = fobDe(r);
          if (!m || fob === null) continue;
          indYtd.valores[m.codigo] = indYtd.valores[m.codigo] || {};
          indYtd.valores[m.codigo][ate] = (indYtd.valores[m.codigo][ate] || 0) + fob;
        }
        const veio = Object.keys(indYtd.valores).length > 0;
        if (veio) indicadores[idYtd] = indYtd;
        diagnostico.push({
          fonte: 'Comex Stat', rotulo: `${fluxo} — acumulado do ano corrente`,
          ok: veio, experimental: !veio, janela: `${ultimoAno}-01–${ate}`,
          linhasRecebidas: lista.length,
          nota: veio ? undefined : 'O recorte municipal do Comex Stat só é publicado por ano fechado.',
        });
      } catch (e) {
        diagnostico.push({ fonte: 'Comex Stat', rotulo: `${fluxo} — acumulado do ano corrente`,
          ok: false, experimental: true, erro: String(e.message || e).slice(0, 220) });
      }
    }
  }
  return { indicadores, diagnostico };
}

// O endpoint /ultimos/N do SGS recusa N > 20 ("A quantidade máxima de valores
// deve ser 20"), então a série vem por janela de datas.
const SGS = [
  { serie: 433, id: 'macro_ipca', rotulo: 'IPCA — variação mensal', unidade: '% a.m.', meses: 72 },
  { serie: 4390, id: 'macro_selic', rotulo: 'Selic — taxa mensal', unidade: '% a.m.', meses: 72 },
  { serie: 24363, id: 'macro_ibcbr', rotulo: 'IBC-Br — atividade econômica', unidade: 'índice', meses: 72 },
  { serie: 1, id: 'macro_cambio', rotulo: 'Dólar comercial (venda)', unidade: 'R$/US$', meses: 12 },
  { serie: 24369, id: 'macro_desocupacao', rotulo: 'Taxa de desocupação (PNAD Contínua)', unidade: '%', meses: 72 },
];

const dataBR = (d) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

export async function coletarMacro(log) {
  const macro = {};
  const diagnostico = [];
  const hoje = new Date();
  for (const s of SGS) {
    try {
      const de = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - s.meses, 1));
      const url =
        `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${s.serie}/dados?formato=json` +
        `&dataInicial=${dataBR(de)}&dataFinal=${dataBR(hoje)}`;
      const j = await retry(() => httpGet(url, { timeout: 45000 }), 2, 1500);
      const pontos = (j || [])
        .map((p) => ({ data: p.data, valor: num(p.valor) }))
        .filter((p) => p.valor !== null);
      if (!pontos.length) throw new Error('série vazia no período');
      macro[s.id] = {
        id: s.id, rotulo: s.rotulo, unidade: s.unidade,
        fonte: 'Banco Central do Brasil — SGS',
        fonteUrl: `https://www3.bcb.gov.br/sgspub/consultarvalores/telaCvsSelecionarSeries.paint?SERIE=${s.serie}`,
        pontos: pontos.slice(-120),
      };
    } catch (e) {
      diagnostico.push({ fonte: 'Banco Central — SGS', rotulo: `série ${s.serie} (${s.rotulo})`,
        ok: false, erro: String(e.message || e) });
    }
  }
  diagnostico.push({ fonte: 'Banco Central — SGS', rotulo: 'contexto macroeconômico',
    ok: Object.keys(macro).length > 0, series: Object.keys(macro).length });
  log?.(`BCB: ${Object.keys(macro).length} séries`);
  return { macro, diagnostico };
}

/* ------------------------------------------------------------------ */
/* ANEEL - verificada e descartada                                     */
/* ------------------------------------------------------------------ */

/*
 * O consumo mensal de energia por município seria o único indicador de frequência
 * mensal e recorte local do painel. A rodada de reconhecimento de 25/08/2026 leu o
 * catálogo inteiro do portal de dados abertos da ANEEL: 72 conjuntos, nenhum com
 * consumo por município. O mais próximo é o SAMP (Sistema de Acompanhamento de
 * Informações de Mercado), cujo recorte é a distribuidora — que atende dezenas de
 * municípios e não permite atribuir consumo a nenhum deles. Os demais conjuntos são
 * de tarifas, qualidade, interrupções, geração e subsídios.
 *
 * Conclusão: a fonte foi removida do pipeline em vez de permanecer como uma linha
 * permanentemente vermelha no diagnóstico. Consumo municipal de energia é publicado
 * pela EPE (Empresa de Pesquisa Energética), em planilhas do Anuário Estatístico,
 * sem API — o que exigiria um raspador, não um cliente de API.
 */
