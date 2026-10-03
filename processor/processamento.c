#include <string.h>
#include <time.h>
#include <omp.h>
#include "app.h"

/* =====================================================================
   REGRAS USADAS PELAS DUAS VERSÕES (sequencial e OpenMP)
   ===================================================================== */

/* Relógio em segundos com resolução de nanossegundos (C11).
   O omp_get_wtime() do GCC no Windows (MinGW) só tem precisão de 1 ms,
   e um lote é processado em poucas centenas de microssegundos. */
static double agora(void) {
    struct timespec instante;
    timespec_get(&instante, TIME_UTC);
    return instante.tv_sec + instante.tv_nsec / 1e9;
}

/* Passo 1: encontra a loja do pedido pelo vetor de índice (acesso direto). */
static Loja *buscar_loja(Dados *dados, int store_id) {
    if (store_id < 0 || store_id >= MAX_ID_LOJA) return NULL;

    int posicao = dados->indice_loja[store_id];
    return posicao == -1 ? NULL : &dados->lojas[posicao];
}

/* Passos 2 e 3: a loja é FOOD e o hub dela fica na cidade escolhida? */
static int loja_deve_ser_contada(const Dados *dados, const Loja *loja, const char *cidade) {
    if (loja == NULL) return 0;
    if (strcmp(loja->segmento, "FOOD") != 0) return 0;

    int posicao_hub = dados->indice_hub[loja->hub_id];
    if (posicao_hub == -1) return 0;

    return strcmp(dados->hubs[posicao_hub].cidade, cidade) == 0;
}

static int menor(int a, int b) {
    return a < b ? a : b;
}

/* =====================================================================
   VERSÃO SEQUENCIAL
   Um único fluxo de execução percorre todos os pedidos do lote.
   ===================================================================== */
void processar_sequencial(Dados *dados, const char *cidade) {
    double tempo_total = 0.0;

    for (int inicio = 0; inicio < dados->total_pedidos; inicio += TAMANHO_LOTE) {
        int fim = menor(inicio + TAMANHO_LOTE, dados->total_pedidos);

        double cronometro = agora();

        for (int i = inicio; i < fim; i++) {
            const Pedido *pedido = &dados->pedidos[i];
            Loja *loja = buscar_loja(dados, pedido->store_id);

            if (loja_deve_ser_contada(dados, loja, cidade)) {
                loja->quantidade_pedidos++;

                if (pedido->cancelado) {
                    loja->quantidade_cancelados++;
                }
            }
        }

        tempo_total += agora() - cronometro;

        /* A escrita do JSON fica fora do cronômetro. */
        emitir_resultado(dados, fim, tempo_total, 1, fim == dados->total_pedidos);
    }
}

/* =====================================================================
   VERSÃO OPENMP
   Os pedidos de cada lote são divididos entre as threads.
   ===================================================================== */
void processar_openmp(Dados *dados, const char *cidade) {
    double tempo_total = 0.0;
    int threads = omp_get_max_threads();

    for (int inicio = 0; inicio < dados->total_pedidos; inicio += TAMANHO_LOTE) {
        int fim = menor(inicio + TAMANHO_LOTE, dados->total_pedidos);

        double cronometro = agora();

        #pragma omp parallel for
        for (int i = inicio; i < fim; i++) {
            const Pedido *pedido = &dados->pedidos[i];
            Loja *loja = buscar_loja(dados, pedido->store_id);

            if (loja_deve_ser_contada(dados, loja, cidade)) {
                /* Duas threads podem achar a mesma loja ao mesmo tempo:
                   o atomic garante que nenhum incremento se perde. */
                #pragma omp atomic
                loja->quantidade_pedidos++;

                if (pedido->cancelado) {
                    #pragma omp atomic
                    loja->quantidade_cancelados++;
                }
            }
        }

        tempo_total += agora() - cronometro;

        /* A escrita do JSON fica fora do cronômetro. */
        emitir_resultado(dados, fim, tempo_total, threads, fim == dados->total_pedidos);
    }
}
