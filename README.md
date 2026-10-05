# OpenMP Heatmap

Identificação de regiões com maior concentração de pedidos em estabelecimentos alimentícios, comparando **processamento sequencial** e **processamento paralelo com OpenMP** em C.

O heatmap mostra a concentração de pedidos **pela localização das lojas FOOD** (o dataset não tem a localização dos clientes).

## Dataset

Dados de exemplo: [Brazilian Delivery Center](https://www.kaggle.com/datasets/nosbielcs/brazilian-delivery-center) (Kaggle).

O projeto usa só `hubs.csv`, `stores.csv` e `orders.csv`, sem alterações, na pasta `data/`. Os demais CSVs do dataset não são necessários.

Relação: `orders.store_id → stores.store_id`, `stores.hub_id → hubs.hub_id` (a cidade vem de `hubs.hub_city`).

## Estrutura

```
data/        CSVs originais
processor/   C + OpenMP (leitura, processamento e saída JSON)
  app.h            structs, constantes e protótipos
  dados.c          leitura dos CSVs e liberação de memória
  processamento.c  processar_sequencial() e processar_openmp()
  main.c           argumentos, fluxo principal e saída JSON
backend/     server.js: executa o processor e repassa cada linha via SSE
frontend/    React + TypeScript + MapLibre + deck.gl (ScatterplotLayer: cor = quantidade de pedidos)
docs/        ADR com as decisões de implementação
```

## Como executar

Requisitos: GCC com OpenMP (ex.: MinGW/WinLibs no Windows) e Node.js 20+.

**1. Compilar o C**

```bash
cd processor
gcc -O2 main.c dados.c processamento.c -o processor.exe -fopenmp
```

> Se o Windows reclamar de `libgomp-1.dll`, acrescente `-static` ao comando.

### macOS

Com o Homebrew instalado, o suporte a OpenMP pode ser instalado com:

```bash
brew install libomp
```

No macOS, o comando `gcc` normalmente aponta para o Apple Clang, que não habilita OpenMP diretamente. Compile usando o `clang` e o `libomp` instalado pelo Homebrew:

```bash
cd processor
clang -O2 main.c dados.c processamento.c -o processor \
  -Xpreprocessor -fopenmp \
  -I"$(brew --prefix libomp)/include" \
  -L"$(brew --prefix libomp)/lib" \
  -lomp
```

Para testar o processador no macOS:

```bash
./processor "PORTO ALEGRE" sequencial
./processor "PORTO ALEGRE" openmp
```

**2. Backend**

```bash
cd backend
npm install
npm start
```

**3. Frontend** 

```bash
cd frontend
npm install
npm run dev
```

## Sequencial x OpenMP

Pela interface: escolha a cidade, o método (**Sequencial** ou **OpenMP**) e clique em **Iniciar processamento**.

Pelo terminal (dentro de `processor/`):

```bash
processor.exe "PORTO ALEGRE" sequencial
processor.exe "PORTO ALEGRE" openmp
```

Cada lote de 25 000 pedidos gera uma linha JSON com o estado acumulado:

```json
{"finalizado":false,"processados":25000,"total":368999,"tempo":0.000162,"threads":1,"pontos":[{"hub":"GREEN SHOPPING","latitude":-30.0374149,"longitude":-51.2035200,"lojas":11,"quantidade":1705,"cancelados":45}]}
```

Os pedidos são contados por loja (`orders.store_id`) e somados por **hub**: as dark kitchens ficam dentro de hubs (shoppings), e várias lojas diferentes dividem o mesmo endereço. Cada ponto é um hub, na coordenada do `hubs.csv`; `quantidade` é o total de pedidos das lojas do hub e `cancelados` quantos têm `order_status = CANCELED` (o resto foi realizado). Clicar em um ponto no mapa abre um card com esses números.

O `tempo` mede **só o processamento** (CSVs já em memória; escrita do JSON fora do cronômetro). Os dois modos produzem exatamente os mesmos pontos — muda apenas o tempo.

## Métricas de paralelismo

Depois de executar os dois modos para a mesma cidade, a interface mostra o speedup e a eficiência do OpenMP.

### Speedup

O speedup compara o tempo sequencial com o tempo paralelo:

```text
speedup = tempo sequencial / tempo OpenMP
```

Um valor maior que `1` indica que o OpenMP foi mais rápido.

### Eficiência

A eficiência relaciona o speedup com a quantidade de threads usadas:

```text
eficiência = speedup / número de threads × 100
```

Ela indica quanto do potencial das threads foi aproveitado. Neste projeto, a eficiência pode ser limitada pelo custo de criar e sincronizar as regiões paralelas, pela operação `atomic` e pelo pequeno tempo de processamento de cada pedido.

### Aplicação das leis de Amdahl e Gustafson

As duas leis entram como modelos para interpretar os resultados deste trabalho. O programa mede diretamente os tempos, o speedup e a eficiência; as leis ajudam a explicar esses valores e a discutir como o comportamento mudaria com outros tamanhos de problema.

A Lei de Amdahl explica o limite do ganho quando existe uma parte sequencial no programa. Neste projeto, mesmo aumentando o número de threads, etapas como a leitura dos CSVs, a emissão do JSON, a criação das regiões paralelas e as sincronizações com `atomic` continuam limitando o speedup:

```text
speedup máximo = 1 / (s + (1 - s) / P)
```

Nessa fórmula, `s` é a fração sequencial e `P` é o número de threads. Portanto, ela ajuda a explicar por que o OpenMP pode ter pouco ganho quando o processamento de cada lote é muito rápido.

A Lei de Gustafson considera o aumento do tamanho do problema. Se este trabalho passasse de 368.999 pedidos para milhões de pedidos, a parte paralelizável do laço de pedidos cresceria, enquanto os custos fixos teriam menor impacto relativo:

```text
speedup de Gustafson = P - s × (P - 1)
```

No frontend, ficam visíveis os valores medidos de tempo, speedup e eficiência. As leis de Amdahl e Gustafson ficam documentadas aqui porque são modelos teóricos para interpretar os resultados, não medições diretas feitas pelo programa. Para este dataset, Amdahl é a melhor explicação para os limites observados; Gustafson complementa a análise de escalabilidade para volumes maiores de pedidos.
