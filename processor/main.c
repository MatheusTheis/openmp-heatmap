#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <omp.h>
#include "app.h"

/* Escreve uma linha JSON com o resultado final de cada hub (soma das
   lojas do hub). Só aparecem hubs que já receberam pelo menos um pedido. */
void emitir_resultado(const Dados *dados, int processados, double tempo,
                      double tempo_threads, int threads, int finalizado) {
    int primeiro = 1;

    printf("{\"finalizado\":%s,\"processados\":%d,\"total\":%d,\"tempo\":%.6f,"
           "\"tempo_threads\":%.6f,\"threads\":%d,\"pontos\":[",
           finalizado ? "true" : "false", processados, dados->total_pedidos, tempo,
           tempo_threads, threads);

    for (int h = 0; h < dados->total_hubs; h++) {
        const Hub *hub = &dados->hubs[h];
        int lojas = 0, quantidade = 0, cancelados = 0;

        for (int i = 0; i < dados->total_lojas; i++) {
            if (dados->lojas[i].hub_id != hub->id || dados->pedidos_por_loja[i] == 0) continue;

            lojas++;
            quantidade += dados->pedidos_por_loja[i];
            cancelados += dados->cancelados_por_loja[i];
        }

        if (quantidade == 0) continue;

        printf("%s{\"hub\":\"%s\",\"cidade\":\"%s\",\"latitude\":%.7f,\"longitude\":%.7f,"
               "\"lojas\":%d,\"quantidade\":%d,\"cancelados\":%d}",
               primeiro ? "" : ",", hub->nome, hub->cidade, hub->latitude, hub->longitude,
               lojas, quantidade, cancelados);
        primeiro = 0;
    }

    printf("]}\n");
    fflush(stdout); /* envia a linha agora, sem esperar o buffer encher */
}

static void emitir_erro(const char *mensagem) {
    printf("{\"erro\":\"%s\"}\n", mensagem);
    fflush(stdout);
}

/* Uso: processor.exe <sequencial|atomic|reduction> [threads]
   Sem o número de threads, as versões OpenMP usam todas as do computador. */
int main(int argc, char *argv[]) {
    static Dados dados;

    if (argc < 2 || argc > 3) {
        fprintf(stderr, "Uso: processor.exe <sequencial|atomic|reduction> [threads]\n");
        emitir_erro("Uso: processor.exe <sequencial|atomic|reduction> [threads]");
        return 1;
    }

    const char *modo = argv[1];
    int threads = argc == 3 ? atoi(argv[2]) : omp_get_num_procs();

    if (strcmp(modo, "sequencial") != 0 && strcmp(modo, "atomic") != 0 && strcmp(modo, "reduction") != 0) {
        emitir_erro("Modo invalido. Use sequencial, atomic ou reduction.");
        return 1;
    }

    if (threads < 1) {
        emitir_erro("Numero de threads invalido.");
        return 1;
    }

    /* 1. Leitura dos CSVs: acontece antes e fica fora da medição de tempo. */
    if (!carregar_hubs(&dados, PASTA_DADOS "hubs.csv") ||
        !carregar_lojas(&dados, PASTA_DADOS "stores.csv") ||
        !carregar_pedidos(&dados, PASTA_DADOS "orders.csv")) {
        emitir_erro("Falha ao carregar os CSVs da pasta data.");
        liberar_dados(&dados);
        return 1;
    }

    /* 2. Processamento com os dados já em memória (cronometrado). */
    if (strcmp(modo, "atomic") == 0) {
        processar_openmp_atomic(&dados, threads);
    } else if (strcmp(modo, "reduction") == 0) {
        processar_openmp_reduction(&dados, threads);
    } else {
        processar_sequencial(&dados);
    }

    /* 3. Libera toda a memória alocada em dados.c. */
    liberar_dados(&dados);
    return 0;
}
