# Post-mortem de pedidos confirmados sem cobrança

## Resumo

O financeiro identificou no fechamento mensal uma divergência entre os pedidos confirmados e as cobranças recebidas. Na reprodução com `cenario-a`, o processador lançou exceções de cobrança e o worker confirmou esses pedidos. A instrumentação associou a criação, a falha e a confirmação ao mesmo pedido e permitiu detectar a divergência durante a execução.

## Impacto

Na reprodução de 6 de novembro de 2026, entre **19:46:49,714 e 19:48:16,828 BRT**, **64 pedidos** foram confirmados após falha técnica de cobrança. A contagem veio dos `pedido_id` distintos nos logs `error` de cobrança do worker. Para esses IDs, a consulta ao Postgres retornou `COUNT(*) = 64` com `status = 'confirmado'` e `SUM(valor_total) = 62114.51`. O **valor envolvido foi 62.114,51 na unidade monetária do catálogo**.

O Prometheus estimou **63,01 tentativas com falha** pela consulta `increase()` da seção Evidências. A diferença em relação aos 64 pedidos é compatível com a extrapolação entre scrapes. O contador mede tentativas, enquanto a contagem exata e o valor vêm do cruzamento dos IDs dos logs com o Postgres.

## Detecção

No cenário original, a divergência apareceu na conciliação financeira de fim de mês. Na reprodução, o receptor recebeu `FalhaEmCobrancas` em `firing` **77,53 s após iniciar `cenario-a`** e **76,84 s após a primeira falha registrada**. O cenário `normal` anterior permaneceu sem notificações por três minutos. Esse sinal antecipa a investigação para o período em que as falhas ocorrem.

## Causa raiz

A falha está na função `decidirStatusDoPedido` em [`src/worker/conciliacao.ts`](../src/worker/conciliacao.ts). `recusado` começa como `false` e só é atualizado quando `processarPagamento` retorna. Se a cobrança lança uma exceção, o `catch` registra o erro e a função chega ao retorno com `recusado` ainda `false`, produzindo `confirmado`.

```ts
let recusado = false;
try {
  const resultado = await processarPagamento(clienteId, valorTotal);
  recusado = !resultado.aprovado;
  cobrancasProcessadas.inc({ resultado: resultado.aprovado ? 'aprovada' : 'recusada' });
} catch (erro) {
  cobrancasProcessadas.inc({ resultado: 'falha' });
  registrarFalhaLegado(erro);
  registrarErro('falha na cobranca do pedido', erro, pedidoId);
}

return recusado ? 'recusado' : 'confirmado';
```

## Evidências

- **Jaeger.** O trace `844486965ab81ec3770e835322f7581e` do pedido `406` mostrou `pedido.criar` (`b7bf77da3df5b6d3`) na API e seu filho `pedido.processar` (`d3d021e4299fa67d`) no worker. O span do worker tinha status de erro, evento de exceção e o atributo `pedido.status=confirmado`.
- **PromQL.** No instante do webhook (`22:48:07,247 UTC`), a expressão abaixo retornou `0.260109`, ou **26,01%** de falhas na janela de dois minutos.

  ```promql
  sum(rate(cobrancas_processadas_total{job="worker",resultado="falha"}[2m]))
  /
  (sum(rate(cobrancas_processadas_total{job="worker"}[2m])) > 0)
  ```

  Para estimar o volume, `sum(increase(cobrancas_processadas_total{job="worker",resultado="falha"}[105s]))` retornou `63.0056` às `22:48:34,452 UTC`, após um scrape adicional com a carga já parada.

- **Logs.** A busca no PowerShell devolveu quatro linhas para o mesmo `trace_id`. A API registrou a criação. O worker registrou a recepção, o erro `gateway respondeu de forma inesperada` e a confirmação do pedido.

  ```powershell
  docker compose --env-file .env.example logs --no-color --no-log-prefix api worker | Select-String -SimpleMatch '844486965ab81ec3770e835322f7581e'
  ```

## Lições aprendidas

- **O que correu bem?** O trace do pedido ligou o POST à falha técnica e ao estado gravado. O alerta permaneceu silencioso durante as recusas legítimas do cenário saudável.
- **O que correu mal?** A decisão de confirmação manteve o valor inicial após a exceção, e as respostas HTTP de sucesso ocultaram a divergência nas métricas externas.
- **Onde tivemos sorte?** A conciliação financeira encontrou a diferença, e os pedidos persistidos permitiram calcular o valor envolvido por ID.

## Itens de ação

| Ação | Tipo | Prioridade |
| --- | --- | --- |
| Vincular a confirmação à autorização de pagamento e tratar falha técnica explicitamente no fluxo de conciliação, em mudança futura | evitar | P0 |
| Adicionar teste de regressão com falha técnica de cobrança e verificar o estado persistido após a correção | evitar | P1 |
| Criar um procedimento de conciliação para identificar e tratar pedidos confirmados sem autorização quando o alerta disparar | mitigar | P1 |

## Timeline

6 de novembro de 2026. Horários em BRT (UTC−03:00).

| Hora | Evento |
| --- | --- |
| 19:43:47,840 | Iniciado o cenário `normal`, após reiniciar o receptor de alertas. |
| 19:46:48,710 | Completados três minutos de tráfego saudável sem notificação. |
| 19:46:49,714 | Iniciado o `cenario-a` com o histórico do Prometheus preservado. |
| 19:46:50,411 | Registrada a primeira falha de cobrança, do pedido `406`, que foi confirmado 4 ms depois. |
| 19:48:07,247 | Recebido o webhook `FalhaEmCobrancas` com `status=firing`. |
| 19:48:16,828 | Encerrada a janela de impacto após parar a carga e aguardar o processamento dos últimos pedidos. |
| 19:48:34,452 | Consultada a estimativa de falhas no Prometheus, após o scrape dos contadores finais. |
