# ADR-001: Decisões de implementação do OpenMP Heatmap

- **Status:** aceita
- **Data:** 2026-10-03 (atualizado em 2026-10-05)

## Contexto

O trabalho de Programação Paralela pede para identificar as regiões com maior concentração de pedidos em estabelecimentos alimentícios e comparar **processamento sequencial** com **processamento paralelo**.

Dados: dataset Brazilian Delivery Center (Kaggle), usando apenas:

| Arquivo | Registros | Uso |
|---|---|---|
| `hubs.csv` | 32 hubs | nome, cidade e coordenada do hub |
| `stores.csv` | 951 lojas (384 FOOD) | hub e segmento de cada loja |
| `orders.csv` | 368.999 pedidos | loja e status (`FINISHED` / `CANCELED`) |

Requisitos que guiaram as decisões:

1. As duas versões precisam produzir **exatamente o mesmo resultado**.
2. A comparação de tempo precisa ser **justa**: sem medir disco e sem atrasos artificiais.
3. O mapa deve apresentar os resultados de forma clara, sem incluir atrasos artificiais na comparação.
4. O código deve ser **simples de apresentar**, com a diferença entre as versões visível.

---

## Decisão 1 — OpenMP como ferramenta de paralelismo

**Decisão:** paralelizar o laço de pedidos em C puro, compilado com GCC (`-fopenmp`), oferecendo duas estratégias: `atomic` e `reduction`.

**Alternativas consideradas:**

| Ferramenta | Por que não foi escolhida |
|---|---|
| POSIX threads (pthreads) | Exige dividir o vetor em faixas, criar e juntar threads e usar mutex à mão. É muito código para o mesmo laço, e a comparação com o sequencial deixa de ser direta. |
| MPI | É feito para memória distribuída (vários processos ou máquinas). Os dados cabem numa máquina só, e distribuir e depois somar os vetores custaria mais que o processamento. |
| GPU (CUDA / OpenCL) | Depende de hardware específico. Copiar 369 mil pedidos para a GPU levaria mais tempo que o processamento inteiro, que fica na casa dos milissegundos. |
| `threads.h` (C11) / API do Windows | Tem os mesmos problemas de pthreads e suporte irregular no MinGW. |

**Motivos:**

- O problema é de **memória compartilhada**: todos os pedidos e lojas ficam no mesmo processo.
- As três versões percorrem o mesmo vetor de pedidos, aplicam os mesmos filtros e produzem os mesmos pontos. A diferença fica restrita à forma como os contadores são atualizados.
- A interface permite comparar o sequencial com cada estratégia OpenMP e escolher todas as threads disponíveis ou uma quantidade fixa (de 1 a 256).
- É portável (GCC, Clang, MSVC) e é o padrão usado na disciplina.

**Consequência:** o programa depende do runtime do OpenMP (libgomp). No Windows, esse runtime tem custo alto para criar e acordar threads (ver Decisão 4).

---

## Decisão 2 — Comparar `atomic` e `reduction` para os contadores por loja

**Problema:** duas threads podem encontrar a mesma loja ao mesmo tempo e incrementar seus contadores. Sem sincronização, um dos incrementos se perde (condição de corrida).

**Decisão:** manter os contadores de pedidos e cancelamentos em vetores separados da struct `Loja` e disponibilizar dois modos paralelos:

- **`atomic`:** todas as threads usam os mesmos vetores; cada incremento é protegido com `#pragma omp atomic`.
- **`reduction`:** `reduction(+: pedidos_loja[:n], cancelados_loja[:n])` cria cópias privadas dos vetores para cada thread e as soma ao fim do laço.

**Alternativas não adotadas:**

- `#pragma omp critical`: uma trava única serializaria todos os incrementos.
- Contadores locais por thread com soma manual: tem o mesmo objetivo da reduction, mas exigiria alocação e combinação explícitas.
- Incrementos sem sincronização: falham por condição de corrida; na implementação anterior, São Paulo perdeu entre ~1.200 e ~1.600 pedidos por execução.

**Consequências:** `atomic` é a referência mais direta e evidencia a disputa por um contador compartilhado. `reduction` evita essa disputa durante o laço, mas usa memória adicional proporcional a `número de lojas × número de threads` e inclui a combinação final na medição. Ambos os modos devem ser idênticos ao sequencial no resultado.

---

## Decisão 3 — Vetor de índice para encontrar a loja do pedido

**Decisão:** `indice_loja[store_id]` guarda a posição da loja no vetor de lojas (o mesmo vale para `indice_hub[hub_id]`). Os IDs vão até 4.679, então basta um vetor de 10.000 posições. Cada pedido encontra sua loja em O(1).

**Alternativas medidas durante o desenvolvimento** (Porto Alegre, lote de 25.000, mediana de 7 execuções no mesmo processo):

| Busca da loja | Sequencial | OpenMP |
|---|---|---|
| Vetor de índice — O(1) | 4,6 ms | 1,4 ms |
| Busca binária — O(log n) | 13,5 ms | 2,8 ms |
| Busca linear nas 951 lojas — O(n) | 48,3 ms | 10,2 ms |

**Motivo:** é a opção mais rápida e simples, e a mesma estrutura é usada nos dois modos.

**Consequência:** o trabalho por pedido fica pequeno (~15 ns), e o processamento inteiro leva poucos milissegundos. Por isso o ganho do OpenMP fica limitado pelo custo fixo das threads. Uma busca binária ou linear daria um speedup maior, mas seria escolher um algoritmo pior só para favorecer o paralelismo.

---

## Decisão 4 — Processar todos os pedidos e cidades em uma execução

**Contexto:** a versão inicial processava uma cidade por vez em lotes e enviava atualizações graduais. Na prática, elas chegavam rápido demais para serem percebidas e obrigavam o usuário a repetir o processamento para trocar de cidade.

**Decisão:** carregar os três CSVs uma vez e percorrer todo o vetor de pedidos em um único laço. A saída contém todos os hubs, inclusive sua cidade; depois de processar, o seletor da interface apenas move o mapa e filtra os pontos já recebidos.

Nos modos OpenMP, uma única região `#pragma omp parallel` cria as threads uma vez e `#pragma omp for` distribui o vetor completo. Não há mais lotes nem múltiplos eventos intermediários.

**Consequências:** elimina custos repetidos de fork/join e disponibiliza todas as cidades após uma execução. O processador agora emite uma única linha JSON final; o SSE é mantido como canal entre C, backend e navegador.

---

## Decisão 5 — Medir só o processamento, com `timespec_get`

**Decisão:** o cronômetro principal envolve apenas o laço que percorre todos os pedidos. Nos modos OpenMP, a criação e o despertar das threads são medidos separadamente em `tempo_threads`; o tempo do laço é enviado em `tempo`.

- A leitura dos CSVs fica **fora** da medição, para não comparar velocidade de disco.
- A escrita do JSON também fica **fora**, porque é saída e não processamento.
- A criação das threads fica fora de `tempo`, mas é exposta em `tempo_threads`; isso permite analisar separadamente o custo fixo do runtime sem escondê-lo.

**Por que não `omp_get_wtime()`:** no GCC para Windows (MinGW), `omp_get_wtime()` usa `_ftime` e só mede de 1 em 1 ms (`omp_get_wtick()` retorna 0,001). Isso é maior que o tempo de um lote inteiro.

**Escolha:** `timespec_get` (padrão C11), com resolução abaixo de 1 µs no Windows e no Linux.

---

## Decisão 6 — Nenhum atraso artificial

Não há `sleep`, `usleep` nem `setTimeout` para deixar o processamento mais lento ou mais visível. Depois da leitura dos CSVs, apenas o resultado final é enviado. A interface informa que o CSV completo está sendo processado em vez de simular progresso que não seria percebido.

---

## Decisão 7 — C escreve JSON no stdout e o Node repassa por SSE

**Decisão:**

1. O `processor.exe` imprime uma única linha JSON final (`printf` + `fflush`), com os hubs de todas as cidades, o tempo de processamento, o custo de criação das threads e a quantidade de threads usada.
2. O backend (Node + Express) executa o processo e transforma cada linha em um evento **Server-Sent Events**.
3. O navegador recebe os eventos com `EventSource`.

**Alternativas:**

- **Servidor HTTP em C:** muito código sem relação com paralelismo.
- **WebSocket:** é bidirecional, e só precisamos de um sentido (servidor → navegador).
- **Gravar arquivo e consultar periodicamente:** gera atraso e não mostra o progresso.

**Consequência:** o C fica focado no processamento, e o backend (`server.js`) tem 66 linhas, sem regra de negócio.

---

## Decisão 8 — O hub é o "local" mostrado no mapa

**Contexto:** as dark kitchens funcionam dentro de hubs (shoppings), e várias lojas **diferentes** compartilham a mesma coordenada. O COFFEE SHOPPING, por exemplo, tem 15 lojas no mesmo ponto. Outras lojas do mesmo hub foram cadastradas a poucas centenas de metros dele.

**Decisão:**

- A contagem continua **por loja**: a parte paralela não muda.
- Na saída, o C **soma as lojas de cada hub** e usa a coordenada do `hubs.csv`.
- O card do mapa mostra o nome do hub, o número de lojas e os pedidos realizados × cancelados.

**Consequências:**

- As 4 lojas FOOD sem coordenada própria passam a ser contadas, pela coordenada do hub delas.
- O hub "HUBLESS SHOPPING" está marcado como São Paulo no CSV, mas a coordenada dele fica no Rio (5 pedidos). Foi mantido como está no dado.

---

## Decisão 9 — Círculos com brilho em vez de HeatmapLayer

**Primeira versão:** `HeatmapLayer` do deck.gl, que desenha um mapa de calor por densidade (KDE).

**Problemas encontrados:**

- Os pontos variam de 1 a 42.871 pedidos. Em escala linear, os hubs pequenos ficavam invisíveis.
- A borda de um ponto quente sempre passava pelas cores frias (azul), porque a cor depende do valor somado em cada pixel.
- Pontos próximos se somavam e as cores se misturavam.

**Decisão:** usar `ScatterplotLayer`, com um círculo por hub:

- Uma **cor única** por círculo, definida pela quantidade de pedidos.
- Escala de cor em **raiz quadrada**, para os hubs pequenos continuarem visíveis.
- Escala **fixa** (vermelho a partir de 15.000 pedidos), para o mapa "esquentar" conforme os lotes chegam.
- Hubs a menos de 40 px na tela viram um único círculo e se separam ao dar zoom.
- O card fica dentro de um `Marker` do MapLibre, então acompanha o ponto quando o mapa é arrastado.

**Consequência:** deixa de ser um mapa de densidade no sentido estrito e passa a ser um mapa de calor por ponto. Isso diverge do enunciado original, que pedia `HeatmapLayer`.

---

## Decisão 10 — Leitura dos dados em C puro

- **Sem biblioteca de CSV:** `separar_campos` troca as vírgulas por `'\0'` e mantém os campos vazios.
- **Só as colunas necessárias:** a struct `Pedido` guarda apenas `store_id` e se o pedido foi cancelado.
- **Alocação exata:** as linhas são contadas antes, e a memória é liberada no final (3 `malloc`, 3 `free`).
- **Encoding:** `hubs.csv` está em ISO-8859-1, então "SÃO PAULO" vira "SAO PAULO" na comparação de cidade.
- **Filtros:** só lojas `FOOD`. A cidade de uma loja vem do hub dela, sem API externa.
- **CSVs intactos:** os arquivos originais não são alterados.

---

## Medições históricas da arquitetura por cidade e por lotes

> Estes números pertencem à arquitetura anterior, substituída pelas Decisões 2 e 4. São mantidos como registro do experimento original, não como benchmark da implementação atual.

Ambiente: AMD Ryzen 7 5700X3D (8 núcleos / 16 threads), Windows 11, GCC 16.2 (WinLibs), `-O2`, 16 threads no OpenMP.

Valores: mediana de 21 execuções (entre parênteses, o intervalo interquartil), em ms.

| Cidade | Sequencial | OpenMP | Speedup |
|---|---|---|---|
| Porto Alegre | 2,61 (2,41–2,73) | 3,67 (3,19–5,49) | 0,71× |
| Curitiba | 3,07 (2,78–3,38) | 3,21 (2,87–3,53) | 0,96× |
| São Paulo | 5,27 (4,85–5,43) | 3,84 (3,53–4,05) | 1,37× |
| Rio de Janeiro | 5,47 (5,16–6,09) | 3,85 (3,68–4,93) | 1,42× |

**Leitura dos resultados:**

- **Mesmo laço, custo diferente:** as quatro cidades percorrem os mesmos 368.999 pedidos. O que muda é quantos pertencem à cidade e passam pela comparação completa e pelo incremento: 37% em SP, 34% no RJ, 9% em Porto Alegre e 7% em Curitiba. Por isso o sequencial é mais lento em SP e RJ.
- **Custo fixo do OpenMP:** o OpenMP fica perto de 3–4 ms em todas as cidades, porque esse tempo é dominado por custo fixo: criar as threads (1 a 8 ms na primeira região) e abrir 15 regiões paralelas.
- **Granularidade:** paralelizar só compensa quando há trabalho suficiente para pagar esse custo. Quando o sequencial leva menos de ~3 ms, o OpenMP perde.
- **Correção:** em todas as cidades, os dois modos produzem exatamente o mesmo resultado.

---

## Consequências e próximos passos

- O dataset continua pequeno para mostrar ganho grande de modo estável; a comparação deve usar múltiplas execuções, registrando o modo e a quantidade de threads.
- A interface calcula e mostra `speedup = tempo sequencial / tempo OpenMP` e `eficiência = speedup / threads × 100`. São métricas da execução corrente; não são valores fixos do ADR.
- `tempo_threads` permite discutir o custo de criação da equipe OpenMP sem misturá-lo ao tempo do laço. A leitura dos CSVs e a emissão do JSON continuam fora das métricas.
- Para investigar escalabilidade, vale testar mais pedidos, diferentes quantidades de threads e Linux, onde o custo do runtime pode ser diferente.
