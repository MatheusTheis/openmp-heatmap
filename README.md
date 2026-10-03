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
```

## Como executar

Requisitos: GCC com OpenMP (ex.: MinGW/WinLibs no Windows) e Node.js 20+.

**1. Compilar o C**

```bash
cd processor
gcc -O2 main.c dados.c processamento.c -o processor.exe -fopenmp
```

> Se o Windows reclamar de `libgomp-1.dll`, acrescente `-static` ao comando.

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
