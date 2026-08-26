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
| **IBGE — API de Agregados (SIDRA)** | população estimada, Censo 2022 (população, área, densidade, crescimento, água, esgoto, lixo), PIB municipal e valor adicionado por setor, Cadastro Central de Empresas, produção agrícola, registro civil | anual |
| **Tesouro Nacional — SICONFI/DCA** | receitas e despesas de cada prefeitura, despesa por função (educação, saúde, urbanismo…) | anual |
| **MDIC — Comex Stat** | exportações e importações por município da empresa | anual¹ |
| **Banco Central — SGS** | IPCA, Selic, IBC-Br, câmbio, desocupação (contexto nacional) | mensal |
| **SSP-SP** (via Dados Abertos SP) | ocorrências criminais por município — homicídio doloso, roubo, furto e veículos | mensal² |

¹ O recorte municipal do Comex Stat só é publicado por ano fechado. Janelas parciais e
`monthDetail: true` devolvem lista vazia — por isso a série usa apenas anos completos.
A API identifica o município pelo **nome com a sigla da UF** (`"Atibaia - SP"`), não por
código do IBGE; o casamento é feito por nome, exigindo `SP` para evitar homônimos.

² Não existe "índice de criminalidade" oficial: a SSP-SP publica contagens de
ocorrências por município, mês e natureza. O painel extrai as naturezas comparáveis e
calcula a **taxa por 100 mil habitantes**. Em municípios pequenos essa taxa é volátil —
uma ocorrência a mais move vários pontos —, o que está dito na própria seção do painel.

Indicadores derivados (PIB por habitante, per capita de receita e despesa, participação
setorial, dependência de transferências, autonomia tributária, saldo comercial) são
calculados na coleta e identificados como “cálculo próprio”. O PIB por habitante é
calculado porque a tabela 5938 do SIDRA não publica essa variável.

### Fontes verificadas e descartadas

**ANEEL — Dados Abertos.** O consumo mensal de energia por município seria o único
indicador de frequência mensal e recorte local do painel. A leitura do catálogo
completo (72 conjuntos) não encontrou consumo por município: o mais próximo é o SAMP,
cujo recorte é a **distribuidora**, que atende dezenas de municípios e não permite
atribuir consumo a nenhum. O restante é tarifa, qualidade, interrupção, geração e
subsídio. Consumo municipal é publicado pela EPE em planilhas do Anuário Estatístico,
sem API — exigiria um raspador, não um cliente de API.

**Novo CAGED.** Saldo mensal de empregos formais por município. Não há API pública
estável; os dois hosts testados não resolvem DNS. Os microdados existem em FTP, em
arquivos mensais compactados de Brasil inteiro.

### Armadilhas já encontradas nestas fontes

| Sintoma | Causa |
|---|---|
| Densidade de 33.154 hab/km² | O IBGE usa ponto decimal (`331.54`); tratar como separador de milhar destrói o valor |
| `HTTP 400` no Banco Central | O endpoint `/ultimos/N` do SGS recusa N > 20; usar janela por datas |
| Comex responde mas nada casa | O município vem por nome, não por código |
| Workflow verde sem gravar dados | `git add` aborta inteiro se um dos caminhos não existir |
| Percentual acima de 100% | Duas causas: cruzar todas as classificações (fixe as outras no "Total") **e** somar categorias hierárquicas — "Coletado" já contém "Coletado no domicílio" e "Depositado em caçamba". Use só o nível mais alto (`nivel` nos metadados) |
| Push rejeitado, coleta perdida | O repositório avança enquanto a coleta roda; é preciso rebasear antes do push (e clone completo, senão o rebase falha) |
| Uma oscilação de rede derruba tudo | A primeira chamada não pode ser um ponto único de falha: os códigos dos municípios ficam gravados no código |

O simulador (`npm run teste`) gera categorias que somam exatamente o "Total" —
sem isso, um erro de razão passa despercebido no teste.

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
