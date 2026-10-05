#include <string.h>
#include <time.h>
#include <omp.h>
#include "app.h"

/* =====================================================================
   REGRAS USADAS PELAS TRÊS VERSÕES
   ===================================================================== */

/* Relógio em segundos com resolução de nanossegundos (C11).
   O omp_get_wtime() do GCC no Windows (MinGW) só tem precisão de 1 ms,
   e um lote é processado em poucas centenas de microssegundos. */
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

static int menor(int a, int b) {
    return a < b ? a : b;
}

/* =====================================================================
   VERSÃO SEQUENCIAL
   Uma única thread percorre todos os pedidos. Ninguém disputa os
   contadores, então um ++ simples é suficiente.
   ===================================================================== */
void processar_sequencial(Dados *dados) {
    int *pedidos_loja = dados->pedidos_por_loja;
    int *cancelados_loja = dados->cancelados_por_loja;
    double tempo_total = 0.0;

    for (int inicio = 0; inicio < dados->total_pedidos; inicio += TAMANHO_LOTE) {
        int fim = menor(inicio + TAMANHO_LOTE, dados->total_pedidos);

        double cronometro = agora();

        for (int i = inicio; i < fim; i++) {
            const Pedido *pedido = &dados->pedidos[i];
            int loja = buscar_loja(dados, pedido->store_id);

            if (loja_deve_ser_contada(dados, loja)) {
                pedidos_loja[loja]++;

                if (pedido->cancelado) {
                    cancelados_loja[loja]++;
                }
            }
        }

        tempo_total += agora() - cronometro;

        /* A escrita do JSON fica fora do cronômetro. */
        emitir_resultado(dados, fim, tempo_total, 0.0, 1, fim == dados->total_pedidos);
    }
}

/* =====================================================================
   VERSÃO OPENMP COM ATOMIC
   As threads dividem os pedidos de cada lote e escrevem nos MESMOS
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

    /* As threads são criadas uma única vez e reaproveitadas em todos os lotes. */
    #pragma omp parallel num_threads(threads)
    {
        /* Espera todas as threads existirem: o custo de criá-las é medido à parte. */
        #pragma omp barrier
        #pragma omp single
        {
            tempo_threads = agora() - cronometro;
            cronometro = agora();
        }

        for (int inicio = 0; inicio < dados->total_pedidos; inicio += TAMANHO_LOTE) {
            int fim = menor(inicio + TAMANHO_LOTE, dados->total_pedidos);

            /* Divide os pedidos do lote entre as threads. */
            #pragma omp for
            for (int i = inicio; i < fim; i++) {
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

            /* Uma thread mede o tempo e escreve o JSON; as outras esperam. */
            #pragma omp single
            {
                tempo_total += agora() - cronometro;
                emitir_resultado(dados, fim, tempo_total, tempo_threads, threads, fim == dados->total_pedidos);
                cronometro = agora();
            }
        }
    }
}

/* =====================================================================
   VERSÃO OPENMP COM REDUCTION
   Cada thread conta numa CÓPIA PRÓPRIA dos vetores (começa zerada).
   No fim de cada lote o OpenMP soma as cópias nos vetores originais.
   Durante o laço ninguém disputa nada, então o ++ é simples.
   ===================================================================== */
void processar_openmp_reduction(Dados *dados, int threads) {
    int *pedidos_loja = dados->pedidos_por_loja;
    int *cancelados_loja = dados->cancelados_por_loja;
    int n = dados->total_lojas;
    double tempo_total = 0.0;
    double tempo_threads = 0.0;
    double cronometro = agora();

    /* As threads são criadas uma única vez e reaproveitadas em todos os lotes. */
    #pragma omp parallel num_threads(threads)
    {
        /* Espera todas as threads existirem: o custo de criá-las é medido à parte. */
        #pragma omp barrier
        #pragma omp single
        {
            tempo_threads = agora() - cronometro;
            cronometro = agora();
        }

        for (int inicio = 0; inicio < dados->total_pedidos; inicio += TAMANHO_LOTE) {
            int fim = menor(inicio + TAMANHO_LOTE, dados->total_pedidos);

            /* Divide os pedidos do lote entre as threads; cada uma soma na sua cópia. */
            #pragma omp for reduction(+: pedidos_loja[:n], cancelados_loja[:n])
            for (int i = inicio; i < fim; i++) {
                const Pedido *pedido = &dados->pedidos[i];
                int loja = buscar_loja(dados, pedido->store_id);

                if (loja_deve_ser_contada(dados, loja)) {
                    pedidos_loja[loja]++;

                    if (pedido->cancelado) {
                        cancelados_loja[loja]++;
                    }
                }
            }

            /* Uma thread mede o tempo e escreve o JSON; as outras esperam. */
            #pragma omp single
            {
                tempo_total += agora() - cronometro;
                emitir_resultado(dados, fim, tempo_total, tempo_threads, threads, fim == dados->total_pedidos);
                cronometro = agora();
            }
        }
    }
}
