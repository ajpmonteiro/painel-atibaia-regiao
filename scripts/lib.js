// Utilitarios de rede e helpers compartilhados.

export const UA =
  'painel-atibaia-regiao/1.0 (coleta de dados publicos; contato via GitHub)';

export async function httpGet(url, { timeout = 45000, headers = {}, raw = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', ...headers },
      redirect: 'follow',
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} em ${url} :: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    if (raw) return text;
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error(`Resposta nao-JSON em ${url} :: ${text.slice(0, 200)}`);
      err.body = text.slice(0, 2000);
      throw err;
    }
  } finally {
    clearTimeout(t);
  }
}

export async function httpPost(url, body, { timeout = 60000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url} :: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

export async function retry(fn, tentativas = 3, espera = 1500) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      if (i < tentativas - 1) await sleep(espera * (i + 1));
    }
  }
  throw ultimo;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Converte texto em número aceitando os dois formatos que aparecem nas fontes.
 * O IBGE devolve "331.54" (ponto decimal); planilhas e alguns portais devolvem
 * "1.234,56" (padrão brasileiro). A presença de vírgula é o que distingue os dois:
 * sem vírgula, o ponto é decimal e não pode ser removido — remover transformava
 * 331.54 em 33154.
 */
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '' || ['-', '..', '...', 'X', 'x', '_', 'NA'].includes(s)) return null;
  if (s.includes(',')) {
    const n = Number(s.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Rodar promessas com limite de concorrencia.
export async function pool(itens, limite, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (i < itens.length) {
      const idx = i++;
      out[idx] = await fn(itens[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
