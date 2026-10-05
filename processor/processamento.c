#include <string.h>
#include <time.h>
#include <omp.h>
#include "app.h"

/* =====================================================================
   REGRAS USADAS PELAS TRÊS VERSÕES
   ===================================================================== */

/* Relógio em segundos com resolução de nanossegundos (C11).
   O omp_get_wtime() do GCC no Windows (MinGW) só tem precisão de 1 ms,
   o processamento completo pode durar poucos milissegundos. */
static double agora(void) {
    struct timespec instante;
    timespec_get(&instante, TIME_UTC);
    return instante.tv_sec + instante.tv_nsec / 1e9;
}

/* Passo 1: posição da loja do pedido no vetor de lojas (-1 = não existe),
   usando o vetor de índice (acesso direto, sem busca). */
static int buscar_loja(const Dados *dados, int store_id) {
    if (store_id < 0 || store_id >= MAX_ID_LOJA) return -1;
    return dados->indice_loja[store_id];
}

/* Passo 2: a loja é FOOD e pertence a um hub conhecido?
   Todas as cidades são processadas de uma vez; a cidade de cada hub
   vai na saída para o mapa. */
static int loja_deve_ser_contada(const Dados *dados, int loja) {
    if (loja == -1) return 0;
    if (strcmp(dados->lojas[loja].segmento, "FOOD") != 0) return 0;

    return dados->indice_hub[dados->lojas[loja].hub_id] != -1;
}

/* =====================================================================
   VERSÃO SEQUENCIAL
   Uma única thread percorre todos os pedidos. Ninguém disputa os
   contadores, então um ++ simples é suficiente.
   ===================================================================== */
void processar_sequencial(Dados *dados) {
    int *pedidos_loja = dados->pedidos_por_loja;
    int *cancelados_loja = dados->cancelados_por_loja;
    double cronometro = agora();
    for (int i = 0; i < dados->total_pedidos; i++) {
        const Pedido *pedido = &dados->pedidos[i];
        int loja = buscar_loja(dados, pedido->store_id);

        if (loja_deve_ser_contada(dados, loja)) {
            pedidos_loja[loja]++;

            if (pedido->cancelado) {
                cancelados_loja[loja]++;
            }
        }
    }

    double tempo_total = agora() - cronometro;
    /* Emite todos os resultados uma única vez, após percorrer o vetor inteiro. */
    emitir_resultado(dados, dados->total_pedidos, tempo_total, 0.0, 1, 1);
}

/* =====================================================================
   VERSÃO OPENMP COM ATOMIC
   As threads dividem todos os pedidos e escrevem nos MESMOS
   contadores. O atomic faz cada ++ de forma indivisível: nenhum
   incremento se perde, mas threads que acham a mesma loja ao mesmo
   tempo esperam umas pelas outras.
   ===================================================================== */
void processar_openmp_atomic(Dados *dados, int threads) {
    int *pedidos_loja = dados->pedidos_por_loja;
    int *cancelados_loja = dados->cancelados_por_loja;
    double tempo_total = 0.0;
    double tempo_threads = 0.0;
    double cronometro = agora();

    /* As threads são criadas uma vez para processar todos os pedidos. */
    #pragma omp parallel num_threads(threads)
    {
        /* Espera todas as threads existirem: o custo de criá-las é medido à parte. */
        #pragma omp barrier
        #pragma omp single
        {
            tempo_threads = agora() - cronometro;
            cronometro = agora();
        }

        /* Divide o vetor inteiro de pedidos entre as threads. */
        #pragma omp for
        for (int i = 0; i < dados->total_pedidos; i++) {
            const Pedido *pedido = &dados->pedidos[i];
            int loja = buscar_loja(dados, pedido->store_id);

            if (loja_deve_ser_contada(dados, loja)) {
                #pragma omp atomic
                pedidos_loja[loja]++;

                if (pedido->cancelado) {
                    #pragma omp atomic
                    cancelados_loja[loja]++;
                }
            }
        }

        /* O for sincronizou as threads; registra uma medição final do laço. */
        #pragma omp single
        {
            tempo_total = agora() - cronometro;
        }
    }

    /* JSON e envio para a interface ficam fora da região cronometrada. */
    emitir_resultado(dados, dados->total_pedidos, tempo_total, tempo_threads, threads, 1);
}

/* =====================================================================
   VERSÃO OPENMP COM REDUCTION
   Cada thread conta numa CÓPIA PRÓPRIA dos vetores (começa zerada).
   Ao final do laço o OpenMP soma as cópias nos vetores originais.
   Durante o laço ninguém disputa nada, então o ++ é simples.
   ===================================================================== */
void processar_openmp_reduction(Dados *dados, int threads) {
    int *pedidos_loja = dados->pedidos_por_loja;
    int *cancelados_loja = dados->cancelados_por_loja;
    int n = dados->total_lojas;
    double tempo_total = 0.0;
    double tempo_threads = 0.0;
    double cronometro = agora();

    /* As threads são criadas uma vez para processar todos os pedidos. */
    #pragma omp parallel num_threads(threads)
    {
        /* Espera todas as threads existirem: o custo de criá-las é medido à parte. */
        #pragma omp barrier
        #pragma omp single
        {
            tempo_threads = agora() - cronometro;
            cronometro = agora();
        }

        /* Divide todos os pedidos; reduction soma por loja ao fim do laço. */
        #pragma omp for reduction(+: pedidos_loja[:n], cancelados_loja[:n])
        for (int i = 0; i < dados->total_pedidos; i++) {
            const Pedido *pedido = &dados->pedidos[i];
            int loja = buscar_loja(dados, pedido->store_id);

            if (loja_deve_ser_contada(dados, loja)) {
                pedidos_loja[loja]++;

                if (pedido->cancelado) {
                    cancelados_loja[loja]++;
                }
            }
        }

        /* O for sincronizou as threads; registra uma medição final do laço. */
        #pragma omp single
        {
            tempo_total = agora() - cronometro;
        }
    }

    /* JSON e envio para a interface ficam fora da região cronometrada. */
    emitir_resultado(dados, dados->total_pedidos, tempo_total, tempo_threads, threads, 1);
}
