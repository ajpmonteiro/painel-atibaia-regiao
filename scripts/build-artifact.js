#!/usr/bin/env node
// Gera uma versão de arquivo único (HTML + CSS + JS + dados embutidos),
// usada para publicar o painel como Artifact no claude.ai.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(RAIZ, 'docs');

const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(DOCS, 'app.js'), 'utf8');
const dados = fs.readFileSync(path.join(DOCS, 'dados.json'), 'utf8');

// O Artifact envolve o conteúdo no esqueleto da página: enviamos só o miolo.
const miolo = html
  .replace(/^[\s\S]*?<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .trim();
const estilo = html.match(/<style>[\s\S]*?<\/style>/)[0];
const titulo = (html.match(/<title>([\s\S]*?)<\/title>/) || [, 'Painel'])[1];

const saida = `<title>${titulo}</title>
${estilo}
${miolo.replace(/<script src="app\.js"[^>]*><\/script>/, '')}
<script>window.DADOS = ${dados};</script>
<script type="module">
${app}
</script>
`;

const destino = path.join(RAIZ, 'artifact.html');
fs.writeFileSync(destino, saida);
console.log(`artifact.html gerado: ${(saida.length / 1024).toFixed(0)} KB`);
