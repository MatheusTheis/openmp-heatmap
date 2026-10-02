#include <stdio.h>
#include <string.h>
#include "app.h"

/* Escreve uma linha JSON com o estado acumulado das lojas.
   Só aparecem as lojas que já receberam pelo menos um pedido. */
void emitir_resultado(const Dados *dados, int processados, double tempo, int threads, int finalizado) {
    int primeiro = 1;

    printf("{\"finalizado\":%s,\"processados\":%d,\"total\":%d,\"tempo\":%.6f,\"threads\":%d,\"pontos\":[",
           finalizado ? "true" : "false", processados, dados->total_pedidos, tempo, threads);

    for (int i = 0; i < dados->total_lojas; i++) {
        const Loja *loja = &dados->lojas[i];
        if (loja->quantidade_pedidos == 0) continue;

        printf("%s{\"latitude\":%.7f,\"longitude\":%.7f,\"quantidade\":%d}",
               primeiro ? "" : ",", loja->latitude, loja->longitude, loja->quantidade_pedidos);
        primeiro = 0;
    }

    printf("]}\n");
    fflush(stdout); /* envia a linha agora, sem esperar o buffer encher */
}

static void emitir_erro(const char *mensagem) {
    printf("{\"erro\":\"%s\"}\n", mensagem);
    fflush(stdout);
}

static int cidade_existe(const Dados *dados, const char *cidade) {
    for (int i = 0; i < dados->total_hubs; i++) {
        if (strcmp(dados->hubs[i].cidade, cidade) == 0) return 1;
    }
    return 0;
}

int main(int argc, char *argv[]) {
    static Dados dados;

    if (argc != 3) {
        fprintf(stderr, "Uso: processor.exe <cidade> <sequencial|openmp>\n");
        emitir_erro("Uso: processor.exe <cidade> <sequencial|openmp>");
        return 1;
    }

    const char *cidade = argv[1];
    const char *modo = argv[2];

    if (strcmp(modo, "sequencial") != 0 && strcmp(modo, "openmp") != 0) {
        emitir_erro("Modo invalido. Use sequencial ou openmp.");
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

    if (!cidade_existe(&dados, cidade)) {
        emitir_erro("Cidade nao encontrada em hubs.csv.");
        liberar_dados(&dados);
        return 1;
    }

    /* 2. Processamento com os dados já em memória (cronometrado). */
    if (strcmp(modo, "openmp") == 0) {
        processar_openmp(&dados, cidade);
    } else {
        processar_sequencial(&dados, cidade);
    }

    /* 3. Libera toda a memória alocada em dados.c. */
    liberar_dados(&dados);
    return 0;
}
