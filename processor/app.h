#ifndef APP_H
#define APP_H

#define PASTA_DADOS     "../data/"

/* Pedidos processados antes de cada atualização do mapa. Com lotes muito
   pequenos (ex.: 5000) o custo de acordar as threads do OpenMP a cada lote
   fica maior que o próprio trabalho do lote. */
#define TAMANHO_LOTE    25000
#define TAMANHO_LINHA   1024
#define MAX_CAMPOS      32
#define TAMANHO_TEXTO   32
#define MAX_ID_HUB      1000
#define MAX_ID_LOJA     10000

typedef struct {
    int id;
    char cidade[TAMANHO_TEXTO];
} Hub;

typedef struct {
    int id;
    int hub_id;
    char segmento[TAMANHO_TEXTO];
    double latitude;
    double longitude;
    int quantidade_pedidos;
} Loja;

typedef struct {
    int store_id;
} Pedido;

typedef struct {
    Hub *hubs;
    int total_hubs;

    Loja *lojas;
    int total_lojas;

    Pedido *pedidos;
    int total_pedidos;

    /* Vetores de índice: indice_hub[hub_id] e indice_loja[store_id]
       guardam a posição no vetor correspondente (-1 = não existe). */
    int indice_hub[MAX_ID_HUB];
    int indice_loja[MAX_ID_LOJA];
} Dados;

/* dados.c */
int  carregar_hubs(Dados *dados, const char *caminho);
int  carregar_lojas(Dados *dados, const char *caminho);
int  carregar_pedidos(Dados *dados, const char *caminho);
void liberar_dados(Dados *dados);

/* processamento.c */
void processar_sequencial(Dados *dados, const char *cidade);
void processar_openmp(Dados *dados, const char *cidade);

/* main.c */
void emitir_resultado(const Dados *dados, int processados, double tempo, int threads, int finalizado);

#endif
