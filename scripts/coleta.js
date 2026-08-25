#!/usr/bin/env node
// Motor de coleta. Executado pelo GitHub Actions (semanalmente) ou localmente:
//   node scripts/coleta.js
// Gera docs/dados.json (consumido pelo painel) e docs/diagnostico.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolverMunicipios, coletarIBGE, coletarSiconfi, coletarComex,
  coletarMacro, catalogoIBGE,
} from './sources.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(RAIZ, 'docs');

const registro = [];
const log = (m) => {
  const linha = `${new Date().toISOString().slice(11, 19)} ${m}`;
  registro.push(linha);
  console.log(linha);
};

async function principal() {
  const t0 = Date.now();
  const municipios = await resolverMunicipios();
  log(`Municípios: ${municipios.map((m) => m.nome).join(', ')}`);

  const blocos = await Promise.allSettled([
    coletarIBGE(municipios, log),
    coletarSiconfi(municipios, log),
    coletarComex(municipios, log),
    coletarMacro(log),
  ]);

  const indicadores = {};
  const diagnostico = [];
  let macro = {};
  for (const b of blocos) {
    if (b.status === 'fulfilled') {
      Object.assign(indicadores, b.value.indicadores || {});
      if (b.value.macro) macro = b.value.macro;
      diagnostico.push(...(b.value.diagnostico || []));
    } else {
      diagnostico.push({ fonte: 'bloco', ok: false, erro: String(b.reason?.message || b.reason) });
      log(`Bloco falhou: ${b.reason?.message || b.reason}`);
    }
  }

  Object.assign(indicadores, derivados(municipios, indicadores));

  const grupos = {};
  for (const i of Object.values(indicadores)) {
    grupos[i.grupo] = grupos[i.grupo] || [];
    grupos[i.grupo].push(i.id);
  }

  const dados = {
    versao: 1,
    geradoEm: new Date().toISOString(),
    duracaoSegundos: Math.round((Date.now() - t0) / 1000),
    municipios,
    grupos,
    indicadores,
    macro,
    fontes: fontesUsadas(indicadores, macro),
  };

  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'dados.json'), JSON.stringify(dados));
  fs.writeFileSync(
    path.join(DOCS, 'diagnostico.json'),
    JSON.stringify({ geradoEm: dados.geradoEm, diagnostico, registro }, null, 2)
  );

  if (process.env.GERAR_CATALOGO === '1') {
    try {
      const cat = await catalogoIBGE();
      fs.writeFileSync(path.join(DOCS, 'catalogo-ibge.json'), JSON.stringify(cat));
      log('Catálogo de agregados municipais do IBGE gravado');
    } catch (e) {
      log(`Catálogo IBGE falhou: ${e.message}`);
    }
  }

  const ok = diagnostico.filter((d) => d.ok).length;
  const exp = diagnostico.filter((d) => d.experimental).length;
  log(`Concluído: ${Object.keys(indicadores).length} indicadores, ${ok}/${diagnostico.length - exp} fontes ok (${exp} em avaliação), ${dados.duracaoSegundos}s`);
  if (!Object.keys(indicadores).length) {
    console.error('Nenhum indicador coletado — mantendo dados anteriores.');
    process.exit(1);
  }
}

function fontesUsadas(indicadores, macro) {
  const m = new Map();
  let derivados = 0;
  for (const i of [...Object.values(indicadores), ...Object.values(macro)]) {
    if (!i.fonte) continue;
    if (/cálculo próprio/i.test(i.fonte)) { derivados++; continue; }
    if (!m.has(i.fonte)) m.set(i.fonte, { nome: i.fonte, url: i.fonteUrl || null, indicadores: 0 });
    m.get(i.fonte).indicadores++;
  }
  const lista = [...m.values()].sort((a, b) => b.indicadores - a.indicadores);
  if (derivados)
    lista.push({
      nome: 'Indicadores derivados — cálculo deste painel sobre as bases acima',
      url: null, indicadores: derivados,
    });
  return lista;
}

/* ---------------- indicadores derivados ---------------- */

// Exportada para permitir recalcular os derivados sobre uma base já coletada.
export function derivados(municipios, ind) {
  const out = {};
  const cods = municipios.map((m) => m.codigo);
  const acha = (re) => Object.values(ind).find((i) => re.test(i.rotulo || ''));

  const pop = acha(/^população residente estimada/i) || ind['fin_pop_ref'];
  const pib = acha(/^produto interno bruto a preços correntes/i);
  const vaTotal = acha(/valor adicionado.*total$/i);
  const setores = {
    agro: acha(/valor adicionado.*da agropecu/i),
    ind: acha(/valor adicionado.*da ind[úu]stria/i),
    serv: acha(/valor adicionado.*dos servi[çc]os/i),
    adm: acha(/valor adicionado.*da administra[çc][ãa]o/i),
  };
  const rotSetor = { agro: 'Agropecuária', ind: 'Indústria', serv: 'Serviços (exceto adm. pública)', adm: 'Administração pública' };

  const razao = (id, def, a, b, fator = 1) => {
    if (!a || !b) return;
    const valores = {};
    const periodos = new Set();
    for (const c of cods) {
      const A = a.valores?.[c] || {};
      const B = b.valores?.[c] || {};
      const ultimoB = Object.keys(B).sort().pop();
      for (const p of Object.keys(A)) {
        const den = B[p] ?? (ultimoB ? B[ultimoB] : null);
        if (!den) continue;
        valores[c] = valores[c] || {};
        valores[c][p] = (A[p] / den) * fator;
        periodos.add(p);
      }
    }
    if (periodos.size) out[id] = { id, ...def, periodos: [...periodos].sort(), valores };
  };

  if (vaTotal)
    for (const [k, src] of Object.entries(setores))
      razao(`der_part_${k}`, {
        rotulo: `Participação no Valor Adicionado — ${rotSetor[k]}`, unidade: '%',
        grupo: 'Estrutura econômica', fonte: 'IBGE — PIB dos Municípios (cálculo próprio)',
        fonteUrl: 'https://sidra.ibge.gov.br/tabela/5938',
      }, src, vaTotal, 100);

  // A tabela 5938 do SIDRA não publica PIB per capita: calculamos.
  // O PIB vem em mil reais, daí o fator 1000.
  razao('der_pib_pc', {
    rotulo: 'PIB por habitante', unidade: 'Reais', grupo: 'Economia',
    fonte: 'IBGE — PIB dos Municípios e Estimativas (cálculo próprio)',
    fonteUrl: 'https://sidra.ibge.gov.br/tabela/5938',
  }, pib, pop, 1000);

  razao('der_receita_pc', {
    rotulo: 'Receita municipal por habitante', unidade: 'R$/hab', grupo: 'Finanças públicas',
    fonte: 'Tesouro Nacional + IBGE (cálculo próprio)', fonteUrl: 'https://siconfi.tesouro.gov.br/',
  }, ind['fin_receita_total'], ind['fin_pop_ref'] || pop);

  razao('der_desp_pc', {
    rotulo: 'Despesa municipal por habitante', unidade: 'R$/hab', grupo: 'Finanças públicas',
    fonte: 'Tesouro Nacional + IBGE (cálculo próprio)', fonteUrl: 'https://siconfi.tesouro.gov.br/',
  }, ind['fin_despesa_total'], ind['fin_pop_ref'] || pop);

  razao('der_dep_transf', {
    rotulo: 'Dependência de transferências (% da receita)', unidade: '%', grupo: 'Finanças públicas',
    fonte: 'Tesouro Nacional — SICONFI (cálculo próprio)', fonteUrl: 'https://siconfi.tesouro.gov.br/',
  }, ind['fin_transferencias'], ind['fin_receita_total'], 100);

  razao('der_autonomia', {
    rotulo: 'Autonomia tributária (receita própria / receita total)', unidade: '%', grupo: 'Finanças públicas',
    fonte: 'Tesouro Nacional — SICONFI (cálculo próprio)', fonteUrl: 'https://siconfi.tesouro.gov.br/',
  }, ind['fin_receita_tributaria'], ind['fin_receita_total'], 100);

  razao('der_educ_share', {
    rotulo: 'Educação — % da despesa empenhada', unidade: '%', grupo: 'Finanças públicas',
    fonte: 'Tesouro Nacional — SICONFI (cálculo próprio)', fonteUrl: 'https://siconfi.tesouro.gov.br/',
  }, ind['fin_desp_12'], ind['fin_despesa_total'], 100);

  razao('der_saude_share', {
    rotulo: 'Saúde — % da despesa empenhada', unidade: '%', grupo: 'Finanças públicas',
    fonte: 'Tesouro Nacional — SICONFI (cálculo próprio)', fonteUrl: 'https://siconfi.tesouro.gov.br/',
  }, ind['fin_desp_10'], ind['fin_despesa_total'], 100);

  razao('der_export_pc', {
    rotulo: 'Exportações por habitante', unidade: 'US$/hab', grupo: 'Comércio exterior',
    fonte: 'MDIC + IBGE (cálculo próprio)', fonteUrl: 'https://comexstat.mdic.gov.br/',
  }, ind['comex_export_fob'], pop);

  // Saldo comercial
  const exp = ind['comex_export_fob'], imp = ind['comex_import_fob'];
  if (exp && imp) {
    const valores = {}; const periodos = new Set();
    for (const c of cods) {
      const A = exp.valores?.[c] || {}, B = imp.valores?.[c] || {};
      for (const p of new Set([...Object.keys(A), ...Object.keys(B)])) {
        valores[c] = valores[c] || {};
        valores[c][p] = (A[p] || 0) - (B[p] || 0);
        periodos.add(p);
      }
    }
    if (periodos.size)
      out['der_saldo_comercial'] = {
        id: 'der_saldo_comercial', rotulo: 'Saldo comercial (exportações − importações)',
        unidade: 'US$ FOB', grupo: 'Comércio exterior', fonte: 'MDIC — Comex Stat (cálculo próprio)',
        fonteUrl: 'https://comexstat.mdic.gov.br/', periodos: [...periodos].sort(), valores,
      };
  }

  // Empresas e pessoal ocupado por mil habitantes
  const empresas = Object.values(ind).find((i) => /^número de unidades locais/i.test(i.rotulo || ''));
  const pessoal = Object.values(ind).find((i) => /pessoal ocupado total/i.test(i.rotulo || ''));
  razao('der_empresas_mil', {
    rotulo: 'Unidades locais por mil habitantes', unidade: 'por mil hab.', grupo: 'Empresas e trabalho',
    fonte: 'IBGE — CEMPRE + Estimativas (cálculo próprio)', fonteUrl: 'https://sidra.ibge.gov.br/tabela/1685',
  }, empresas, pop, 1000);
  razao('der_ocupados_mil', {
    rotulo: 'Pessoal ocupado por mil habitantes', unidade: 'por mil hab.', grupo: 'Empresas e trabalho',
    fonte: 'IBGE — CEMPRE + Estimativas (cálculo próprio)', fonteUrl: 'https://sidra.ibge.gov.br/tabela/1685',
  }, pessoal, pop, 1000);

  // Crescimento populacional acumulado (base = primeiro ano disponível)
  if (pop) {
    const valores = {}; const periodos = new Set();
    for (const c of cods) {
      const s = pop.valores?.[c] || {};
      const anos = Object.keys(s).sort();
      if (anos.length < 2) continue;
      const base = s[anos[0]];
      for (const a of anos) { valores[c] = valores[c] || {}; valores[c][a] = ((s[a] / base) - 1) * 100; periodos.add(a); }
    }
    if (periodos.size)
      out['der_cresc_pop'] = {
        id: 'der_cresc_pop', rotulo: 'Crescimento populacional acumulado (base = primeiro ano da série)',
        unidade: '%', grupo: 'Demografia', fonte: 'IBGE — Estimativas (cálculo próprio)',
        fonteUrl: 'https://sidra.ibge.gov.br/tabela/6579', periodos: [...periodos].sort(), valores,
      };
  }

  return out;
}

// Só executa a coleta quando chamado direto (permite importar as funções em testes).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  principal().catch((e) => {
    console.error('Falha geral na coleta:', e);
    process.exit(1);
  });
}
