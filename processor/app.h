#ifndef APP_H
#define APP_H

#define PASTA_DADOS     "../data/"

#define TAMANHO_LINHA   1024
#define MAX_CAMPOS      32
#define TAMANHO_TEXTO   32
#define MAX_ID_HUB      1000
#define MAX_ID_LOJA     10000

/* Hub = shopping onde ficam as dark kitchens. Várias lojas dividem o
   mesmo hub, por isso o hub é o "local" mostrado no mapa. */
typedef struct {
    int id;
    char nome[TAMANHO_TEXTO];
    char cidade[TAMANHO_TEXTO];
    double latitude;
    double longitude;
} Hub;

typedef struct {
    int id;
    int hub_id;
    char segmento[TAMANHO_TEXTO];
} Loja;

typedef struct {
    int store_id;
    int cancelado; /* 1 se order_status == "CANCELED" */
} Pedido;

typedef struct {
    Hub *hubs;
    int total_hubs;

    Loja *lojas;
    int total_lojas;

    /* Contadores por loja, na mesma posição do vetor lojas. Ficam em
       vetores (e não dentro de Loja) para o reduction do OpenMP funcionar. */
    int *pedidos_por_loja;
    int *cancelados_por_loja;

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
void processar_sequencial(Dados *dados);
void processar_openmp_atomic(Dados *dados, int threads);
void processar_openmp_reduction(Dados *dados, int threads);

/* main.c */
void emitir_resultado(const Dados *dados, int processados, double tempo,
                      double tempo_threads, int threads, int finalizado);

#endif
