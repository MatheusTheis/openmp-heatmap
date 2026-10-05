const express = require('express');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const PORTA = 3001;
const PASTA_PROCESSOR = path.join(__dirname, '..', 'processor');
const EXECUTAVEL = path.join(PASTA_PROCESSOR, process.platform === 'win32' ? 'processor.exe' : 'processor');
const MODOS = ['sequencial', 'atomic', 'reduction'];

const app = express();

// GET /processar?modo=reduction&threads=4  (processa todas as cidades)
// threads é opcional: sem ele o C usa todas as threads do computador
app.get('/processar', (req, res) => {
  const modo = String(req.query.modo || '');
  const threads = req.query.threads === undefined ? null : Number(req.query.threads);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();

  const enviar = (linha) => res.write(`data: ${linha}\n\n`);

  if (!MODOS.includes(modo) || (threads !== null && !(Number.isInteger(threads) && threads >= 1 && threads <= 256))) {
    enviar(JSON.stringify({ erro: 'Parametros invalidos: modo (sequencial, atomic ou reduction) e threads (1 a 256).' }));
    return res.end();
  }

  // O C roda dentro de /processor para encontrar os CSVs em ../data
  const argumentos = threads === null ? [modo] : [modo, String(threads)];
  const processo = spawn(EXECUTAVEL, argumentos, { cwd: PASTA_PROCESSOR });
  let finalizado = false;

  // Cada linha JSON escrita pelo C vira um evento SSE
  readline.createInterface({ input: processo.stdout }).on('line', (linha) => {
    linha = linha.trim();
    if (!linha) return;
    if (linha.includes('"finalizado":true') || linha.includes('"erro"')) finalizado = true;
    enviar(linha);
  });

  processo.stderr.on('data', (dados) => process.stderr.write(dados));

  processo.on('error', (erro) => {
    finalizado = true;
    enviar(JSON.stringify({ erro: `Nao foi possivel executar o processor: ${erro.message}` }));
    res.end();
  });

  processo.on('close', (codigo) => {
    if (!finalizado) enviar(JSON.stringify({ erro: `O processor terminou antes de finalizar (codigo ${codigo}).` }));
    res.end();
  });

  // Navegador fechou a conexão antes do fim: encerra o processo C
  res.on('close', () => {
    if (processo.exitCode === null) processo.kill();
  });
});

app.listen(PORTA, () => {
  console.log(`Backend em http://localhost:${PORTA}`);
});
