# Painel Econômico — Atibaia e Região

Painel interativo de desenvolvimento econômico de **Atibaia/SP** e sete municípios vizinhos
(Bragança Paulista, Itatiba, Jarinu, Bom Jesus dos Perdões, Nazaré Paulista, Piracaia e Jundiaí),
montado exclusivamente a partir de **dados públicos oficiais**, com **coleta automática semanal**.

## Como funciona

```
GitHub Actions (toda segunda-feira)
        │
        ├── consulta as APIs públicas (IBGE, Tesouro Nacional, MDIC, BCB, ANEEL…)
        ├── calcula indicadores derivados (per capita, participações, saldos)
        ├── grava docs/dados.json  ──►  commit automático no repositório
        │
        └── GitHub Pages serve docs/  ──►  painel sempre com o dado mais recente
```

Nenhum servidor para manter, nenhum custo: o motor roda dentro do GitHub Actions
(gratuito para repositórios públicos) e a página é estática.

## Fontes de dados

| Fonte | O que traz | Frequência |
|---|---|---|
| **IBGE — API de Agregados (SIDRA)** | população estimada, Censo 2022, PIB municipal e valor adicionado por setor, Cadastro Central de Empresas, produção agrícola e pecuária, registro civil | anual |
| **Tesouro Nacional — SICONFI/DCA** | receitas e despesas de cada prefeitura, despesa por função (educação, saúde, urbanismo…) | anual |
| **MDIC — Comex Stat** | exportações e importações por município da empresa | mensal |
| **Banco Central — SGS** | IPCA, Selic, IBC-Br, câmbio, desocupação (contexto nacional) | mensal |
| **ANEEL — Dados Abertos** | consumo de energia elétrica por município (em consolidação) | mensal |

Indicadores derivados (per capita, participação setorial, dependência de transferências,
autonomia tributária, saldo comercial) são calculados na coleta e identificados como
“cálculo próprio”.

## Estrutura

```
scripts/lib.js       utilitários de rede (retry, timeout, parsing)
scripts/sources.js   uma função por fonte de dados, isolada — falha de uma não derruba as outras
scripts/coleta.js    orquestra a coleta, calcula derivados e grava docs/dados.json
scripts/build-artifact.js  gera artifact.html (arquivo único, dados embutidos)
scripts/stub-teste.mjs      simulador das APIs para testar o ETL offline
docs/index.html      estrutura e estilos do painel
docs/app.js          gráficos (SVG puro, sem dependências) e interações
docs/dados.json      base gerada pela coleta
docs/diagnostico.json  status de cada fonte na última coleta
```

## Rodando localmente

```bash
node scripts/coleta.js        # coleta e grava docs/dados.json
npx serve docs                # abre o painel em http://localhost:3000
```

Para gerar também o catálogo completo de tabelas municipais do IBGE
(útil para acrescentar novos indicadores):

```bash
GERAR_CATALOGO=1 node scripts/coleta.js
```

## Testando sem rede

`scripts/stub-teste.mjs` simula todas as APIs com respostas no formato real (útil para
validar o parser ou para desenvolver offline):

```bash
npm run teste
```

## Publicando

1. Suba este repositório para o GitHub (público).
2. Em **Settings → Pages**, escolha *Deploy from a branch*, branch `main`, pasta `/docs`.
3. Em **Actions**, rode o workflow *Coleta de dados públicos* uma vez (`Run workflow`)
   para gerar a primeira base. Depois disso ele roda sozinho toda segunda-feira às 06h (Brasília).

O resumo de cada execução mostra, fonte a fonte, o que entrou e o que falhou.

## Licença dos dados

Os dados pertencem às instituições de origem e seguem suas respectivas licenças de uso.
O código deste repositório é livre para uso e adaptação.
