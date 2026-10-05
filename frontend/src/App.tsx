import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer } from '@deck.gl/layers';

type Modo = 'sequencial' | 'openmp';
type EstrategiaOpenMP = 'atomic' | 'reduction';
type ConfiguracaoThreads = 'todas' | 'fixo';

// Cada ponto enviado pelo C é um hub (shopping) com a soma das lojas dele
type Ponto = {
  hub: string;
  cidade: string;
  latitude: number;
  longitude: number;
  lojas: number;
  quantidade: number;
  cancelados: number;
};

type Atualizacao = {
  finalizado: boolean;
  processados: number;
  total: number;
  tempo: number;
  tempo_threads: number;
  threads: number;
  pontos: Ponto[];
  erro?: string;
};

const URL_BACKEND = 'http://localhost:3001';
const ESTILO_MAPA = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const ZOOM_INICIAL = 11;

// Usado somente para posicionar o mapa. Não interfere no processamento.
const CIDADES: Record<string, { nome: string; centro: [number, number] }> = {
  'PORTO ALEGRE': { nome: 'Porto Alegre', centro: [-51.2, -30.04] },
  'CURITIBA': { nome: 'Curitiba', centro: [-49.28, -25.45] },
  'SAO PAULO': { nome: 'São Paulo', centro: [-46.65, -23.56] },
  'RIO DE JANEIRO': { nome: 'Rio de Janeiro', centro: [-43.3, -22.95] },
};

// Frio (azul) → quente (vermelho). O azul é claro para aparecer no mapa escuro.
const CORES_BASE: [number, number, number][] = [
  [30, 144, 255],
  [0, 220, 255],
  [0, 230, 118],
  [255, 235, 59],
  [255, 152, 0],
  [244, 67, 54],
];

// Escala fixa: a partir desta quantidade o lugar fica vermelho.
// Assim cada lugar esquenta conforme os lotes chegam.
const PEDIDOS_COR_MAXIMA = 15000;

// Brilho de cada lugar: círculos maiores e transparentes da mesma cor do centro
const BRILHO = [
  { raio: 30, opacidade: 45 },
  { raio: 20, opacidade: 90 },
];
const RAIO_CENTRO = 12;

// Hubs a menos desta distância na tela viram um único lugar, para os
// círculos não ficarem um em cima do outro. Ao dar zoom eles se separam.
const DISTANCIA_MINIMA_PIXELS = 40;

type Lugar = {
  posicao: [number, number];
  hubs: string[];
  lojas: number;
  quantidade: number;
  cancelados: number;
  cor: [number, number, number];
};

type Circulo = {
  posicao: [number, number];
  raio: number;
  cor: [number, number, number, number];
};

// Cor do gradiente CORES_BASE na posição t (0 = frio, 1 = quente)
function corNaPosicao(t: number): [number, number, number] {
  const posicao = t * (CORES_BASE.length - 1);
  const i = Math.min(Math.floor(posicao), CORES_BASE.length - 2);
  const fracao = posicao - i;
  const [r, g, b] = CORES_BASE[i].map((c, k) => Math.round(c + (CORES_BASE[i + 1][k] - c) * fracao));
  return [r, g, b];
}

// Raiz quadrada: lugares com poucos pedidos já ganham uma cor visível
function corDaQuantidade(quantidade: number) {
  return corNaPosicao(Math.sqrt(Math.min(quantidade / PEDIDOS_COR_MAXIMA, 1)));
}

function distanciaMetros(a: [number, number], b: [number, number]) {
  const metrosPorGrau = 111_000;
  const dx = (a[0] - b[0]) * metrosPorGrau * Math.cos((a[1] * Math.PI) / 180);
  const dy = (a[1] - b[1]) * metrosPorGrau;
  return Math.hypot(dx, dy);
}

// Metros que 1 pixel representa no zoom atual (tiles de 512 px do MapLibre)
function metrosPorPixel(zoom: number, latitude: number) {
  return (40_075_016 * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);
}

// Junta os hubs próximos na tela em lugares e soma os pedidos de cada lugar
function agruparPorLugar(pontos: Ponto[], zoom: number): Lugar[] {
  const lugares: Lugar[] = [];

  // Maiores primeiro: cada lugar fica na posição do hub com mais pedidos
  const ordenados = [...pontos].sort((a, b) => b.quantidade - a.quantidade);

  for (const p of ordenados) {
    const posicao: [number, number] = [p.longitude, p.latitude];
    const limite = DISTANCIA_MINIMA_PIXELS * metrosPorPixel(zoom, p.latitude);
    const proximo = lugares.find((l) => distanciaMetros(l.posicao, posicao) < limite);

    if (proximo) {
      proximo.hubs.push(p.hub);
      proximo.lojas += p.lojas;
      proximo.quantidade += p.quantidade;
      proximo.cancelados += p.cancelados;
    } else {
      lugares.push({ posicao, hubs: [p.hub], lojas: p.lojas, quantidade: p.quantidade, cancelados: p.cancelados, cor: [0, 0, 0] });
    }
  }

  lugares.forEach((lugar) => (lugar.cor = corDaQuantidade(lugar.quantidade)));

  // Os mais quentes por último, para ficarem por cima
  return lugares.sort((a, b) => a.quantidade - b.quantidade);
}

function criarCirculos(id: string, circulos: Circulo[]) {
  return new ScatterplotLayer<Circulo>({
    id,
    data: circulos,
    getPosition: (c) => c.posicao,
    getRadius: (c) => c.raio,
    getFillColor: (c) => c.cor,
    radiusUnits: 'pixels',
    pickable: true,
  });
}

// Primeiro o brilho completo de cada lugar (frios antes, quentes por cima),
// depois todos os centros: o centro de um lugar nunca fica coberto.
function criarCamadas(lugares: Lugar[]) {
  const brilhos = lugares.flatMap(({ posicao, cor: [r, g, b] }) =>
    BRILHO.map(({ raio, opacidade }): Circulo => ({ posicao, raio, cor: [r, g, b, opacidade] })),
  );
  const centros = lugares.map(({ posicao, cor: [r, g, b] }): Circulo => ({ posicao, raio: RAIO_CENTRO, cor: [r, g, b, 255] }));

  return [criarCirculos('brilho', brilhos), criarCirculos('centro', centros)];
}

function formatarTempo(segundos: number) {
  return segundos < 1 ? `${(segundos * 1000).toFixed(2)} ms` : `${segundos.toFixed(2)} s`;
}

function formatarPercentual(parte: number, total: number) {
  const percentual = total > 0 ? (parte / total) * 100 : 0;
  return `${percentual.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

// Se o card (acima do ponto) for ficar cortado na borda, desliza o mapa até ele caber
const CARD_LARGURA = 240;
const CARD_ALTURA = 230;

function abrirEspacoParaCard(mapa: maplibregl.Map, x: number, y: number) {
  const { clientWidth: largura } = mapa.getContainer();
  const margem = 12;

  const faltaEmCima = Math.max(0, CARD_ALTURA + margem - y);
  const faltaEsquerda = Math.max(0, CARD_LARGURA / 2 + margem - x);
  const faltaDireita = Math.max(0, x + CARD_LARGURA / 2 + margem - largura);

  if (faltaEmCima || faltaEsquerda || faltaDireita) {
    mapa.panBy([faltaDireita - faltaEsquerda, -faltaEmCima]);
  }
}

function mesmaPosicao(a: [number, number], b: [number, number]) {
  return a[0] === b[0] && a[1] === b[1];
}

// Card do lugar clicado: hub, lojas e pedidos realizados x cancelados
function CardLugar({ lugar, onFechar }: { lugar: Lugar; onFechar: () => void }) {
  const realizados = lugar.quantidade - lugar.cancelados;

  return (
    <div className="card-lugar">
      <div className="card-topo">
        <span className="card-titulo">
          <span className="marcador-cor" style={{ background: `rgb(${lugar.cor.join(',')})` }} />
          {lugar.hubs.length === 1 ? lugar.hubs[0] : `${lugar.hubs.length} hubs próximos`}
        </span>
        <button className="fechar" onClick={onFechar} aria-label="Fechar">
          ×
        </button>
      </div>

      <span className="rotulo">
        {lugar.lojas} {lugar.lojas === 1 ? 'loja' : 'lojas'}
        {lugar.hubs.length > 1 && ` · ${lugar.hubs.join(', ')}`}
      </span>

      <strong className="card-total">
        {lugar.quantidade.toLocaleString('pt-BR')} {lugar.quantidade === 1 ? 'pedido' : 'pedidos'}
      </strong>

      <div className="barra card-barra">
        <div className="parte-realizados" style={{ width: `${(realizados / lugar.quantidade) * 100}%` }} />
        <div className="parte-cancelados" />
      </div>

      <div className="card-linha">
        <span className="legenda-item realizados">Realizados</span>
        <strong>
          {realizados.toLocaleString('pt-BR')} · {formatarPercentual(realizados, lugar.quantidade)}
        </strong>
      </div>
      <div className="card-linha">
        <span className="legenda-item cancelados">Cancelados</span>
        <strong>
          {lugar.cancelados.toLocaleString('pt-BR')} · {formatarPercentual(lugar.cancelados, lugar.quantidade)}
        </strong>
      </div>
    </div>
  );
}

export default function App() {
  const divMapa = useRef<HTMLDivElement>(null);
  const mapa = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const conexao = useRef<EventSource | null>(null);
  const marcador = useRef<maplibregl.Marker | null>(null);
  const [elementoCard] = useState(() => {
    const elemento = document.createElement('div');
    elemento.className = 'marcador-card';
    return elemento;
  });

  const [cidade, setCidade] = useState('PORTO ALEGRE');
  const [modo, setModo] = useState<Modo>('sequencial');
  const [estrategiaOpenMP, setEstrategiaOpenMP] = useState<EstrategiaOpenMP>('reduction');
  const [configuracaoThreads, setConfiguracaoThreads] = useState<ConfiguracaoThreads>('todas');
  const [quantidadeThreads, setQuantidadeThreads] = useState(4);
  const [opcoesOpenMPAbertas, setOpcoesOpenMPAbertas] = useState(false);
  const [atualizacao, setAtualizacao] = useState<Atualizacao | null>(null);
  const [executando, setExecutando] = useState(false);
  const [erro, setErro] = useState('');
  const [tempos, setTempos] = useState<Partial<Record<Modo, number>>>({});
  const [threadsOpenmp, setThreadsOpenmp] = useState<number | null>(null);
  const [zoom, setZoom] = useState(ZOOM_INICIAL);
  const [selecionado, setSelecionado] = useState<[number, number] | null>(null);

  const lugares = useMemo(() => agruparPorLugar(atualizacao?.pontos ?? [], zoom), [atualizacao, zoom]);
  const lugarSelecionado = selecionado ? lugares.find((l) => mesmaPosicao(l.posicao, selecionado)) : undefined;

  // Cria o mapa uma única vez
  useEffect(() => {
    const novoMapa = new maplibregl.Map({
      container: divMapa.current!,
      style: ESTILO_MAPA,
      center: CIDADES['PORTO ALEGRE'].centro,
      zoom: ZOOM_INICIAL,
    });
    const novoOverlay = new MapboxOverlay({
      layers: [],
      // Clique em um lugar abre o card; clique fora fecha
      onClick: (info) => {
        if (!info.object) return setSelecionado(null);
        setSelecionado((info.object as Circulo).posicao);
        abrirEspacoParaCard(novoMapa, info.x, info.y);
      },
      onHover: (info) => (novoMapa.getCanvas().style.cursor = info.object ? 'pointer' : ''),
    });

    // O card fica dentro de um marcador do MapLibre: ele acompanha o lugar ao arrastar o mapa.
    // Os eventos não passam para o mapa, senão um clique no card o fecharia.
    for (const tipo of ['mousedown', 'click', 'dblclick', 'wheel', 'touchstart']) {
      elementoCard.addEventListener(tipo, (evento) => evento.stopPropagation());
    }
    marcador.current = new maplibregl.Marker({ element: elementoCard, anchor: 'bottom', offset: [0, -18] })
      .setLngLat(CIDADES['PORTO ALEGRE'].centro)
      .addTo(novoMapa);

    novoMapa.addControl(new maplibregl.NavigationControl(), 'top-right');
    novoMapa.addControl(novoOverlay);
    novoMapa.on('zoomend', () => setZoom(novoMapa.getZoom()));

    mapa.current = novoMapa;
    overlay.current = novoOverlay;

    return () => {
      conexao.current?.close();
      novoMapa.remove();
    };
  }, []);

  // A cada atualização (ou zoom) troca somente os dados das camadas (o mapa não é recriado)
  useEffect(() => {
    overlay.current?.setProps({ layers: criarCamadas(lugares) });
  }, [lugares]);

  useEffect(() => {
    if (selecionado) marcador.current?.setLngLat(selecionado);
  }, [selecionado]);

  function encerrarConexao() {
    conexao.current?.close();
    conexao.current = null;
    setExecutando(false);
  }

  function limpar() {
    encerrarConexao();
    setAtualizacao(null);
    setErro('');
    setSelecionado(null);
  }

  // O processamento cobre todas as cidades: trocar de cidade só move o mapa
  function selecionarCidade(novaCidade: string) {
    setCidade(novaCidade);
    mapa.current?.flyTo({ center: CIDADES[novaCidade].centro, zoom: ZOOM_INICIAL });
  }

  function iniciar() {
    limpar();
    setExecutando(true);

    const parametros = new URLSearchParams({
      modo: modo === 'openmp' ? estrategiaOpenMP : 'sequencial',
    });
    if (modo === 'openmp' && configuracaoThreads === 'fixo') {
      parametros.set('threads', String(quantidadeThreads));
    }

    const url = `${URL_BACKEND}/processar?${parametros.toString()}`;
    const eventos = new EventSource(url);
    conexao.current = eventos;

    eventos.onmessage = (evento) => {
      const dados: Atualizacao = JSON.parse(evento.data);

      if (dados.erro) {
        setErro(dados.erro);
        encerrarConexao();
        return;
      }

      setAtualizacao(dados);

      if (dados.finalizado) {
        setTempos((anteriores) => ({ ...anteriores, [modo]: dados.tempo }));
        if (modo === 'openmp') setThreadsOpenmp(dados.threads);
        encerrarConexao();
      }
    };

    eventos.onerror = () => {
      setErro('Não foi possível conectar ao backend (http://localhost:3001).');
      encerrarConexao();
    };
  }

  const processados = atualizacao?.processados ?? 0;
  const total = atualizacao?.total ?? 0;
  const progresso = total > 0 ? (processados / total) * 100 : 0;
  // Rodapé mostra os números da cidade selecionada
  const pontos = (atualizacao?.pontos ?? []).filter((p) => p.cidade === cidade);
  const lojasContadas = pontos.reduce((soma, p) => soma + p.lojas, 0);
  const pedidosContados = pontos.reduce((soma, p) => soma + p.quantidade, 0);
  const speedup = tempos.sequencial && tempos.openmp ? tempos.sequencial / tempos.openmp : null;
  const eficiencia = speedup && threadsOpenmp ? (speedup / threadsOpenmp) * 100 : null;

  return (
    <div className="app">
      <header className="controles">
        <h1>OpenMP Heatmap</h1>

        <label className="campo">
          Cidade
          <select value={cidade} onChange={(e) => selecionarCidade(e.target.value)}>
            {Object.entries(CIDADES).map(([id, info]) => (
              <option key={id} value={id}>
                {info.nome}
              </option>
            ))}
          </select>
        </label>

        <div className="campo">
          Método
          <div className="alternador">
            <button
              className={modo === 'sequencial' ? 'ativo' : ''}
              disabled={executando}
              onClick={() => {
                setModo('sequencial');
                setOpcoesOpenMPAbertas(false);
              }}
            >
              Sequencial
            </button>
            <div
              className="openmp-menu"
              onMouseEnter={() => setOpcoesOpenMPAbertas(true)}
              onMouseLeave={(evento) => {
                if (!evento.currentTarget.contains(document.activeElement)) setOpcoesOpenMPAbertas(false);
              }}
              onFocusCapture={() => setOpcoesOpenMPAbertas(true)}
              onBlur={(evento) => {
                if (!evento.currentTarget.contains(evento.relatedTarget as Node | null)) {
                  setOpcoesOpenMPAbertas(false);
                }
              }}
            >
              <button
                type="button"
                className={`openmp-trigger ${modo === 'openmp' ? 'ativo' : ''}`}
                disabled={executando}
                aria-expanded={opcoesOpenMPAbertas}
                aria-controls="opcoes-openmp"
                onClick={() => {
                  setModo('openmp');
                  setOpcoesOpenMPAbertas(true);
                }}
              >
                OpenMP <span aria-hidden="true">⌄</span>
              </button>

              <div
                id="opcoes-openmp"
                className={`openmp-popover ${opcoesOpenMPAbertas ? 'visivel' : ''}`}
                role="group"
                aria-label="Opções OpenMP"
              >
                <span className="openmp-titulo">Quantidade de threads</span>
                <div className="openmp-escolhas" role="radiogroup" aria-label="Quantidade de threads">
                  <label className={`openmp-escolha ${configuracaoThreads === 'todas' ? 'selecionada' : ''}`}>
                    <input
                      type="radio"
                      name="configuracao-threads"
                      value="todas"
                      checked={configuracaoThreads === 'todas'}
                      disabled={executando}
                      onChange={() => {
                        setModo('openmp');
                        setConfiguracaoThreads('todas');
                      }}
                    />
                    <span>Todas as threads</span>
                    <small>automático</small>
                  </label>
                  <label className={`openmp-escolha ${configuracaoThreads === 'fixo' ? 'selecionada' : ''}`}>
                    <input
                      type="radio"
                      name="configuracao-threads"
                      value="fixo"
                      checked={configuracaoThreads === 'fixo'}
                      disabled={executando}
                      onChange={() => {
                        setModo('openmp');
                        setConfiguracaoThreads('fixo');
                      }}
                    />
                    <span>Número fixo</span>
                  </label>
                </div>

                {configuracaoThreads === 'fixo' && (
                  <label className="openmp-quantidade">
                    Threads
                    <input
                      type="number"
                      min="1"
                      max="256"
                      step="1"
                      value={quantidadeThreads}
                      disabled={executando}
                      aria-label="Número fixo de threads"
                      onChange={(evento) => {
                        const valor = Number(evento.target.value);
                        setModo('openmp');
                        setQuantidadeThreads(Math.max(1, Math.min(256, Math.trunc(valor) || 1)));
                      }}
                    />
                  </label>
                )}

                <hr />
                <span className="openmp-titulo">Estratégia de sincronização</span>
                <div className="openmp-algoritmos" role="group" aria-label="Estratégia de sincronização">
                  <button
                    type="button"
                    className={`openmp-algoritmo ${estrategiaOpenMP === 'atomic' ? 'selecionado' : ''}`}
                    aria-pressed={estrategiaOpenMP === 'atomic'}
                    disabled={executando}
                    onClick={() => {
                      setModo('openmp');
                      setEstrategiaOpenMP('atomic');
                    }}
                  >
                    <strong>Atomic</strong>
                    <small>Contador compartilhado</small>
                  </button>
                  <button
                    type="button"
                    className={`openmp-algoritmo ${estrategiaOpenMP === 'reduction' ? 'selecionado' : ''}`}
                    aria-pressed={estrategiaOpenMP === 'reduction'}
                    disabled={executando}
                    onClick={() => {
                      setModo('openmp');
                      setEstrategiaOpenMP('reduction');
                    }}
                  >
                    <strong>Reduction</strong>
                    <small>Soma por thread</small>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="acoes">
          <button className="primario" disabled={executando} onClick={iniciar}>
            {executando ? 'Processando…' : 'Iniciar processamento'}
          </button>
          <button disabled={executando} onClick={limpar}>
            Limpar
          </button>
        </div>
      </header>

      <main ref={divMapa} className="mapa" />
      {lugarSelecionado && createPortal(<CardLugar lugar={lugarSelecionado} onFechar={() => setSelecionado(null)} />, elementoCard)}

      <footer className="status">
        <div className="indicador">
          <span className="rotulo">Processados</span>
          <strong>
            {processados.toLocaleString('pt-BR')} / {total.toLocaleString('pt-BR')}
          </strong>
        </div>

        <div className="indicador progresso">
          <span className="rotulo">Progresso</span>
          <div className="barra">
            <div className="preenchimento" style={{ width: `${progresso}%` }} />
          </div>
        </div>

        <div className="indicador">
          <span className="rotulo">
            Tempo{atualizacao ? ` (${atualizacao.threads} thread${atualizacao.threads > 1 ? 's' : ''})` : ''}
          </span>
          <strong>{atualizacao ? formatarTempo(atualizacao.tempo) : '—'}</strong>
          {modo === 'openmp' && atualizacao && (
            <span className="rotulo">Criação das threads: {formatarTempo(atualizacao.tempo_threads)}</span>
          )}
        </div>

        <div className="indicador">
          <span className="rotulo">Resultado em {CIDADES[cidade].nome}</span>
          <strong>
            {pontos.length} hubs · {lojasContadas} lojas · {pedidosContados.toLocaleString('pt-BR')} pedidos
          </strong>
        </div>

        <div className="indicador">
          <span className="rotulo">Comparação</span>
          <strong>
            Seq. {tempos.sequencial !== undefined ? formatarTempo(tempos.sequencial) : '—'} · OpenMP{' '}
            {tempos.openmp !== undefined ? formatarTempo(tempos.openmp) : '—'}
            {speedup ? ` · ${speedup.toFixed(2)}×` : ''}
          </strong>
        </div>

        <div className="indicador">
          <span className="rotulo">Eficiência</span>
          <strong>{eficiencia !== null ? `${eficiencia.toFixed(1)}%` : '—'}</strong>
        </div>

        <div className="mensagem">
          {erro && <span className="erro">{erro}</span>}
          {executando && !atualizacao && <span>Carregando CSVs no processador C…</span>}
          {!erro && atualizacao?.finalizado && <span className="concluido">Processamento concluído</span>}
        </div>

        <div className="legenda">
          <span>poucos pedidos</span>
          <div className="gradiente" />
          <span>15 mil+ pedidos</span>
        </div>
      </footer>
    </div>
  );
}
