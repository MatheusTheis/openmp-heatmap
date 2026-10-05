#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "app.h"

/* Troca cada vírgula por '\0' e guarda o início de cada campo.
   Campos vazios ("a,,b") continuam sendo contados. */
static int separar_campos(char *linha, char *campos[]) {
    int total = 0;

    linha[strcspn(linha, "\r\n")] = '\0';
    campos[total++] = linha;

    for (char *c = linha; *c != '\0' && total < MAX_CAMPOS; c++) {
        if (*c == ',') {
            *c = '\0';
            campos[total++] = c + 1;
        }
    }
    return total;
}

/* hubs.csv está em ISO-8859-1: "SÃO PAULO" vira "SAO PAULO". */
static void remover_acentos(char *texto) {
    for (unsigned char *c = (unsigned char *)texto; *c != '\0'; c++) {
        if (*c >= 0xC0 && *c <= 0xC5) *c = 'A';
        else if (*c == 0xC7)           *c = 'C';
        else if (*c >= 0xC8 && *c <= 0xCB) *c = 'E';
        else if (*c >= 0xCC && *c <= 0xCF) *c = 'I';
        else if (*c >= 0xD2 && *c <= 0xD6) *c = 'O';
        else if (*c >= 0xD9 && *c <= 0xDC) *c = 'U';
    }
}

/* Abre o CSV, conta as linhas de dados (sem cabeçalho) e deixa o
   arquivo posicionado na primeira linha de dados. */
static FILE *abrir_csv(const char *caminho, int *total_linhas) {
    char linha[TAMANHO_LINHA];
    FILE *arquivo = fopen(caminho, "r");

    if (arquivo == NULL) {
        fprintf(stderr, "Erro ao abrir %s\n", caminho);
        return NULL;
    }

    *total_linhas = 0;
    while (fgets(linha, sizeof(linha), arquivo) != NULL) {
        (*total_linhas)++;
    }
    (*total_linhas)--; /* desconta o cabeçalho */

    rewind(arquivo);
    fgets(linha, sizeof(linha), arquivo);
    return arquivo;
}

/* hubs.csv: hub_id,hub_name,hub_city,hub_state,hub_latitude,hub_longitude */
int carregar_hubs(Dados *dados, const char *caminho) {
    char linha[TAMANHO_LINHA];
    char *campos[MAX_CAMPOS];
    int total_linhas;
    FILE *arquivo = abrir_csv(caminho, &total_linhas);

    if (arquivo == NULL) return 0;

    for (int i = 0; i < MAX_ID_HUB; i++) dados->indice_hub[i] = -1;

    dados->hubs = malloc(total_linhas * sizeof(Hub));
    if (dados->hubs == NULL) {
        fclose(arquivo);
        return 0;
    }
    dados->total_hubs = 0;

    while (fgets(linha, sizeof(linha), arquivo) != NULL) {
        if (separar_campos(linha, campos) < 6) continue;

        Hub *hub = &dados->hubs[dados->total_hubs];
        hub->id = atoi(campos[0]);
        if (hub->id < 0 || hub->id >= MAX_ID_HUB) continue;

        snprintf(hub->nome, TAMANHO_TEXTO, "%s", campos[1]);
        snprintf(hub->cidade, TAMANHO_TEXTO, "%s", campos[2]);
        remover_acentos(hub->cidade);
        hub->latitude = atof(campos[4]);
        hub->longitude = atof(campos[5]);

        dados->indice_hub[hub->id] = dados->total_hubs;
        dados->total_hubs++;
    }

    fclose(arquivo);
    return 1;
}

/* stores.csv: store_id,hub_id,store_name,store_segment,store_plan_price,store_latitude,store_longitude
   A posição no mapa vem do hub, então as coordenadas da loja não são lidas. */
int carregar_lojas(Dados *dados, const char *caminho) {
    char linha[TAMANHO_LINHA];
    char *campos[MAX_CAMPOS];
    int total_linhas;
    FILE *arquivo = abrir_csv(caminho, &total_linhas);

    if (arquivo == NULL) return 0;

    for (int i = 0; i < MAX_ID_LOJA; i++) dados->indice_loja[i] = -1;

    dados->lojas = malloc(total_linhas * sizeof(Loja));
    if (dados->lojas == NULL) {
        fclose(arquivo);
        return 0;
    }
    dados->total_lojas = 0;

    while (fgets(linha, sizeof(linha), arquivo) != NULL) {
        if (separar_campos(linha, campos) < 4) continue;

        Loja *loja = &dados->lojas[dados->total_lojas];
        loja->id = atoi(campos[0]);
        loja->hub_id = atoi(campos[1]);
        if (loja->id < 0 || loja->id >= MAX_ID_LOJA) continue;
        if (loja->hub_id < 0 || loja->hub_id >= MAX_ID_HUB) continue;

        snprintf(loja->segmento, TAMANHO_TEXTO, "%s", campos[3]);

        dados->indice_loja[loja->id] = dados->total_lojas;
        dados->total_lojas++;
    }

    fclose(arquivo);

    /* Contadores começam zerados (calloc) */
    dados->pedidos_por_loja = calloc(dados->total_lojas, sizeof(int));
    dados->cancelados_por_loja = calloc(dados->total_lojas, sizeof(int));
    return dados->pedidos_por_loja != NULL && dados->cancelados_por_loja != NULL;
}

/* orders.csv: usa store_id (2ª coluna) e order_status (6ª coluna). */
int carregar_pedidos(Dados *dados, const char *caminho) {
    char linha[TAMANHO_LINHA];
    char *campos[MAX_CAMPOS];
    int total_linhas;
    FILE *arquivo = abrir_csv(caminho, &total_linhas);

    if (arquivo == NULL) return 0;

    dados->pedidos = malloc(total_linhas * sizeof(Pedido));
    if (dados->pedidos == NULL) {
        fclose(arquivo);
        return 0;
    }
    dados->total_pedidos = 0;

    while (fgets(linha, sizeof(linha), arquivo) != NULL) {
        if (separar_campos(linha, campos) < 6) continue;

        Pedido *pedido = &dados->pedidos[dados->total_pedidos];
        pedido->store_id = atoi(campos[1]);
        pedido->cancelado = strcmp(campos[5], "CANCELED") == 0;
        dados->total_pedidos++;
    }

    fclose(arquivo);
    return 1;
}

void liberar_dados(Dados *dados) {
    free(dados->hubs);
    free(dados->lojas);
    free(dados->pedidos_por_loja);
    free(dados->cancelados_por_loja);
    free(dados->pedidos);

    dados->hubs = NULL;
    dados->lojas = NULL;
    dados->pedidos_por_loja = NULL;
    dados->cancelados_por_loja = NULL;
    dados->pedidos = NULL;
}
