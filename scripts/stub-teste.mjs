// Stub de rede para testar o ETL sem acesso externo.
// Uso: node --import ./stub-teste.mjs scripts/coleta.js
const MUNS = [
  [3504107, 'Atibaia'], [3507605, 'Bragança Paulista'], [3523404, 'Itatiba'],
  [3525300, 'Jarinu'], [3507001, 'Bom Jesus dos Perdões'], [3532009, 'Nazaré Paulista'],
  [3538006, 'Piracaia'], [3525904, 'Jundiaí'],
];

const META = {
  6579: { nome: 'População residente estimada', vars: [[9324, 'População residente estimada', 'Pessoas']], cls: [] },
  4714: { nome: 'Censo 2022', vars: [[93, 'População residente', 'Pessoas'], [5936, 'Área da unidade territorial', 'km²'], [614, 'Densidade demográfica', 'hab/km²']], cls: [] },
  5938: { nome: 'PIB dos Municípios', vars: [
    [37, 'Produto Interno Bruto a preços correntes', 'Mil Reais'],
    [513, 'Valor adicionado bruto a preços correntes da agropecuária', 'Mil Reais'],
    [517, 'Valor adicionado bruto a preços correntes da indústria', 'Mil Reais'],
    [6575, 'Valor adicionado bruto a preços correntes dos serviços, exclusive administração, defesa, educação e saúde públicas e seguridade social', 'Mil Reais'],
    [6576, 'Valor adicionado bruto a preços correntes da administração, defesa, educação e saúde públicas e seguridade social', 'Mil Reais'],
    [525, 'Valor adicionado bruto a preços correntes total', 'Mil Reais'],
    [593, 'Produto Interno Bruto per capita', 'Reais'],
  ], cls: [] },
  1685: { nome: 'CEMPRE', vars: [[707, 'Número de unidades locais', 'Unidades'], [708, 'Pessoal ocupado total', 'Pessoas'], [630, 'Salários e outras remunerações', 'Mil Reais']],
    cls: [[12762, [[117897, 'Total'], [117898, 'Indústrias de transformação']]]] },
  5457: { nome: 'PAM', vars: [[214, 'Quantidade produzida', 'Toneladas'], [215, 'Valor da produção', 'Mil Reais']],
    cls: [[782, [[0, 'Total'], [40099, 'Café'], [2717, 'Uva']]]] },
  3939: { nome: 'PPM', vars: [[105, 'Efetivo dos rebanhos', 'Cabeças']], cls: [[79, [[2670, 'Bovino'], [2681, 'Galináceos']]]] },
  2612: { nome: 'Registro civil', vars: [[218, 'Número de nascidos vivos', 'Unidades']], cls: [[2, [[4, 'Total'], [5, 'Homens']]]] },
};

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

function serieAnos(ini, fim) { const a = []; for (let y = ini; y <= fim; y++) a.push(String(y)); return a; }

function valoresV3(agg, varId, periodos, cats) {
  const resultados = [];
  const listaCats = cats.length ? cats : [null];
  for (const cat of listaCats) {
    const series = MUNS.map(([cod]) => {
      const base = 1000 * (1 + rnd() * 40);
      const serie = {};
      periodos.forEach((p, i) => { serie[p] = String(Math.round(base * Math.pow(1.05, i))); });
      return { localidade: { id: String(cod), nivel: { id: 'N6' }, nome: 'x' }, serie };
    });
    resultados.push({
      classificacoes: cat ? [{ id: String(cat.clsId), nome: 'c', categoria: { [cat.id]: cat.nome } }] : [],
      series,
    });
  }
  return resultados;
}

const jsonRes = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes('/localidades/estados/35/municipios'))
    return jsonRes(MUNS.map(([id, nome]) => ({
      id, nome,
      microrregiao: { nome: 'Bragança Paulista', mesorregiao: { nome: 'Campinas', UF: { sigla: 'SP' } } },
      'regiao-imediata': { nome: 'Bragança Paulista', 'regiao-intermediaria': { nome: 'Campinas' } },
    })));

  let m = u.match(/agregados\/(\d+)\/metadados/);
  if (m) {
    const t = META[m[1]];
    if (!t) return new Response('não encontrado', { status: 404 });
    return jsonRes({
      id: Number(m[1]), nome: t.nome, periodicidade: { frequencia: 'anual', inicio: 2010, fim: 2024 },
      variaveis: t.vars.map(([id, nome, unidade]) => ({ id, nome, unidade, sumarizacao: [] })),
      classificacoes: t.cls.map(([id, cats]) => ({ id, nome: 'classe', categorias: cats.map(([cid, cnome]) => ({ id: cid, nome: cnome, nivel: 0 })) })),
    });
  }

  m = u.match(/agregados\/(\d+)\/periodos\/(-?\d+)\/variaveis\/([^?]+)/);
  if (m) {
    const t = META[m[1]];
    const n = Math.min(12, Math.abs(Number(m[2])));
    const periodos = serieAnos(2024 - n + 1, 2024);
    const varIds = decodeURIComponent(m[3]).split('|').map(Number);
    const usaCls = /classificacao=/.test(u);
    const clsSpec = usaCls ? decodeURIComponent(u.split('classificacao=')[1].split('&')[0]) : '';
    let cats = [];
    if (usaCls && t.cls.length) {
      const [clsId, dentro] = clsSpec.split('[');
      const lista = t.cls.find((c) => String(c[0]) === clsId)?.[1] || [];
      cats = (dentro.includes('all') ? lista : lista.filter(([cid]) => dentro.includes(String(cid))))
        .map(([cid, cnome]) => ({ clsId, id: cid, nome: cnome }));
    }
    return jsonRes(varIds.map((vid) => {
      const def = t.vars.find(([id]) => id === vid) || [vid, 'var', 'un'];
      return { id: vid, variavel: def[1], unidade: def[2], resultados: valoresV3(m[1], vid, periodos, cats) };
    }));
  }

  if (u.includes('agregados?nivel=N6')) return jsonRes([{ id: 1, nome: 'pesquisa', agregados: [] }]);

  if (u.includes('siconfi')) {
    const ano = Number(u.match(/an_exercicio=(\d+)/)[1]);
    const anexo = decodeURIComponent(u.match(/no_anexo=([^&]+)/)[1]);
    if (ano > 2024) return jsonRes({ items: [] });
    const pop = 100000 + Math.round(rnd() * 100000);
    if (anexo.includes('I-C')) {
      const contas = [
        ['ReceitasExcetoIntraOrcamentarias', 'RECEITAS (EXCETO INTRA-ORÇAMENTÁRIAS) (I)'],
        ['RO1.0.0.0.00.0.0', '1.0.0.0.00.0.0 - Receitas Correntes'],
        ['RO1.1.0.0.00.0.0', '1.1.0.0.00.0.0 - Impostos, Taxas e Contribuições de Melhoria'],
        ['RO1.3.0.0.00.0.0', '1.3.0.0.00.0.0 - Receita Patrimonial'],
        ['RO1.6.0.0.00.0.0', '1.6.0.0.00.0.0 - Receita de Serviços'],
        ['RO1.7.0.0.00.0.0', '1.7.0.0.00.0.0 - Transferências Correntes'],
        ['RO2.0.0.0.00.0.0', '2.0.0.0.00.0.0 - Receitas de Capital'],
      ];
      const items = [];
      for (const [cod, conta] of contas) {
        const bruta = 1e8 * (1 + rnd() * 8);
        items.push({ exercicio: ano, cod_conta: cod, conta, coluna: 'Receitas Brutas Realizadas', valor: bruta, populacao: pop });
        items.push({ exercicio: ano, cod_conta: cod, conta, coluna: 'Deduções - FUNDEB', valor: bruta * 0.05, populacao: pop });
        items.push({ exercicio: ano, cod_conta: cod, conta, coluna: 'Outras Deduções da Receita', valor: bruta * 0.01, populacao: pop });
      }
      return jsonRes({ items, hasMore: false });
    }
    if (anexo.includes('I-E')) {
      const funcoes = [['04', 'Administração'], ['08', 'Assistência Social'], ['09', 'Previdência Social'],
        ['10', 'Saúde'], ['12', 'Educação'], ['15', 'Urbanismo'], ['26', 'Transporte'], ['28', 'Encargos Especiais']];
      const items = [];
      for (const [n, nome] of funcoes) {
        const v = 1e7 * (1 + rnd() * 30);
        items.push({ exercicio: ano, cod_conta: 'TotalDespesas', conta: `${n} - ${nome}`, coluna: 'Despesas Empenhadas', valor: v, populacao: pop });
        items.push({ exercicio: ano, cod_conta: 'TotalDespesas', conta: `${n}.${n}1 - Sub`, coluna: 'Despesas Empenhadas', valor: v * 0.4, populacao: pop });
        items.push({ exercicio: ano, cod_conta: 'TotalDespesas', conta: `${n} - ${nome}`, coluna: 'Despesas Pagas', valor: v * 0.9, populacao: pop });
      }
      return jsonRes({ items, hasMore: false });
    }
    return jsonRes({ items: [] });
  }

  if (u.includes('api-comexstat')) {
    if (u.includes('dates/updated')) return jsonRes({ data: { updated: '2026-08-06', year: '2026', monthNumber: '07' }, success: true });
    const corpo = JSON.parse(opts.body || '{}');
    const [aDe, mDe] = String(corpo?.period?.from || '2019-01').split('-').map(Number);
    const [aAte, mAte] = String(corpo?.period?.to || '2025-12').split('-').map(Number);
    const list = [];
    if (corpo.monthDetail) {
      // detalhe mensal: uma linha por município por mês da janela
      for (let y = aDe, m = mDe; y < aAte || (y === aAte && m <= mAte); m === 12 ? (m = 1, y++) : m++)
        for (const [, nome] of MUNS)
          list.push({ noMunMinsgUf: `${nome} - SP`, year: String(y), month: String(m), state: 'SP', metricFOB: String(Math.round(1e6 * (1 + rnd() * 3))) });
    } else {
      // agregado anual: a API só responde a janelas de anos inteiros
      if (mDe !== 1) return jsonRes({ data: { list: [] }, success: true });
      for (let ano = aDe; ano <= aAte; ano++) {
        for (const [, nome] of MUNS)
          list.push({ noMunMinsgUf: `${nome} - SP`, year: String(ano), state: 'SP', metricFOB: String(Math.round(1e7 * (1 + rnd() * 20))) });
        list.push({ noMunMinsgUf: 'Sorocaba - SP', year: String(ano), state: 'SP', metricFOB: '999' });
        list.push({ noMunMinsgUf: 'Atibaia - MG', year: String(ano), state: 'MG', metricFOB: '111' });
      }
    }
    return jsonRes({ data: { list }, success: true });
  }

  if (u.includes('api.bcb.gov.br')) {
    const pontos = [];
    for (let i = 0; i < 60; i++) pontos.push({ data: `01/${String((i % 12) + 1).padStart(2, '0')}/2025`, valor: (rnd() * 2).toFixed(2) });
    return jsonRes(pontos);
  }

  if (u.includes('aneel')) return new Response('erro simulado ANEEL', { status: 503 });
  if (u.includes('mte')) return new Response('erro simulado CAGED', { status: 404 });

  return new Response('rota nao simulada: ' + u, { status: 500 });
};
