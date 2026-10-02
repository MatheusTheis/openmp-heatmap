import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';

type Modo = 'sequencial' | 'openmp';

type Ponto = {
  latitude: number;
  longitude: number;
  quantidade: number;
};

type Atualizacao = {
  finalizado: boolean;
  processados: number;
  total: number;
  tempo: number;
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

// Frio (azul) → quente (vermelho)
const CORES: [number, number, number][] = [
  [49, 54, 149],
  [69, 117, 180],
  [116, 173, 209],
  [254, 224, 144],
  [253, 174, 97],
  [244, 109, 67],
  [215, 48, 39],
];

// Escala de cor fixa: a região esquenta conforme os pedidos são somados.
// Sem ela o deck.gl normaliza pelo maior valor e a cor quase não muda entre lotes.
const ESCALA_COR: [number, number] = [20, 800];

function criarCamada(pontos: Ponto[]) {
  return new HeatmapLayer<Ponto>({
    id: 'pedidos',
    data: pontos,
    getPosition: (p) => [p.longitude, p.latitude],
    getWeight: (p) => p.quantidade,
    radiusPixels: 80,
    colorRange: CORES,
    colorDomain: ESCALA_COR,
  });
}

function formatarTempo(segundos: number) {
  return segundos < 1 ? `${(segundos * 1000).toFixed(2)} ms` : `${segundos.toFixed(2)} s`;
}

export default function App() {
  const divMapa = useRef<HTMLDivElement>(null);
  const mapa = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const conexao = useRef<EventSource | null>(null);

  const [cidade, setCidade] = useState('PORTO ALEGRE');
  const [modo, setModo] = useState<Modo>('sequencial');
  const [atualizacao, setAtualizacao] = useState<Atualizacao | null>(null);
  const [executando, setExecutando] = useState(false);
  const [erro, setErro] = useState('');
  const [tempos, setTempos] = useState<Partial<Record<Modo, number>>>({});

  // Cria o mapa uma única vez
  useEffect(() => {
    const novoMapa = new maplibregl.Map({
      container: divMapa.current!,
      style: ESTILO_MAPA,
      center: CIDADES['PORTO ALEGRE'].centro,
      zoom: ZOOM_INICIAL,
    });
    const novoOverlay = new MapboxOverlay({ layers: [] });

    novoMapa.addControl(new maplibregl.NavigationControl(), 'top-right');
    novoMapa.addControl(novoOverlay);

    mapa.current = novoMapa;
    overlay.current = novoOverlay;

    return () => {
      conexao.current?.close();
      novoMapa.remove();
    };
  }, []);

  // A cada atualização troca somente os dados da camada (o mapa não é recriado)
  useEffect(() => {
    overlay.current?.setProps({ layers: [criarCamada(atualizacao?.pontos ?? [])] });
  }, [atualizacao]);

  function encerrarConexao() {
    conexao.current?.close();
    conexao.current = null;
    setExecutando(false);
  }

  function limpar() {
    encerrarConexao();
    setAtualizacao(null);
    setErro('');
  }

  function selecionarCidade(novaCidade: string) {
    limpar();
    setCidade(novaCidade);
    setTempos({});
    mapa.current?.flyTo({ center: CIDADES[novaCidade].centro, zoom: ZOOM_INICIAL });
  }

  function iniciar() {
    limpar();
    setExecutando(true);

    const url = `${URL_BACKEND}/processar?cidade=${encodeURIComponent(cidade)}&modo=${modo}`;
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
  const pedidosContados = atualizacao?.pontos.reduce((soma, p) => soma + p.quantidade, 0) ?? 0;
  const speedup = tempos.sequencial && tempos.openmp ? tempos.sequencial / tempos.openmp : null;

  return (
    <div className="app">
      <header className="controles">
        <h1>OpenMP Heatmap</h1>

        <label className="campo">
          Cidade
          <select value={cidade} disabled={executando} onChange={(e) => selecionarCidade(e.target.value)}>
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
            <button className={modo === 'sequencial' ? 'ativo' : ''} disabled={executando} onClick={() => setModo('sequencial')}>
              Sequencial
            </button>
            <button className={modo === 'openmp' ? 'ativo' : ''} disabled={executando} onClick={() => setModo('openmp')}>
              OpenMP
            </button>
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
          <span className="rotulo">Tempo{atualizacao ? ` (${atualizacao.threads} thread${atualizacao.threads > 1 ? 's' : ''})` : ''}</span>
          <strong>{atualizacao ? formatarTempo(atualizacao.tempo) : '—'}</strong>
        </div>

        <div className="indicador">
          <span className="rotulo">Resultado</span>
          <strong>
            {atualizacao?.pontos.length ?? 0} lojas · {pedidosContados.toLocaleString('pt-BR')} pedidos
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

        <div className="mensagem">
          {erro && <span className="erro">{erro}</span>}
          {executando && !atualizacao && <span>Carregando CSVs no processador C…</span>}
          {!erro && atualizacao?.finalizado && <span className="concluido">Processamento concluído</span>}
        </div>

        <div className="legenda">
          <span>poucos pedidos</span>
          <div className="gradiente" />
          <span>muitos pedidos</span>
        </div>
      </footer>
    </div>
  );
}
