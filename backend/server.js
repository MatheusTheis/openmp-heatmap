const express = require('express');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const PORTA = 3001;
const PASTA_PROCESSOR = path.join(__dirname, '..', 'processor');
const EXECUTAVEL = path.join(PASTA_PROCESSOR, process.platform === 'win32' ? 'processor.exe' : 'processor');
const MODOS = ['sequencial', 'openmp'];

const app = express();

// GET /processar?cidade=PORTO%20ALEGRE&modo=sequencial
app.get('/processar', (req, res) => {
  const cidade = String(req.query.cidade || '');
  const modo = String(req.query.modo || '');

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();

  const enviar = (linha) => res.write(`data: ${linha}\n\n`);

  if (!cidade || !MODOS.includes(modo)) {
    enviar(JSON.stringify({ erro: 'Parametros invalidos: informe cidade e modo (sequencial ou openmp).' }));
    return res.end();
  }

  // O C roda dentro de /processor para encontrar os CSVs em ../data
  const processo = spawn(EXECUTAVEL, [cidade, modo], { cwd: PASTA_PROCESSOR });
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
