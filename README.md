# Observabilidade de pedidos

## Como rodar

Pré-requisitos: Docker com Docker Compose v2, Git para o clone e curl.

```sh
git clone https://github.com/zevedosena-git/mba-arch-desafio-observabilidade.git
cd mba-arch-desafio-observabilidade
cp .env.example .env
docker compose up -d --wait
curl -fsS http://localhost:8080/health
curl -fsS http://localhost:8081/health
```

No PowerShell, use `Copy-Item .env.example .env`, `curl.exe` para chamar o curl e `Select-String -SimpleMatch` para buscar texto nos logs. O Grafana usa o usuário e a senha definidos no `.env`.

Antes de enviar pedidos, confira `curl -fsS http://localhost:8080/metrics` e `curl -fsS http://localhost:8081/metrics`. Os contadores de negócio começam em zero. [Alvos no Prometheus](http://localhost:9090/targets) · [Dashboard Pedidos](http://localhost:3000/d/pedidos/pedidos) · [Jaeger](http://localhost:16686).

Liste os produtos, escolha um ID válido e substitua `1` se necessário. O POST retorna `202` e um `pedido_id` com status `pendente`. Consulte `GET /pedidos/<pedido_id>` para ver o estado processado.

```sh
curl -fsS http://localhost:8080/produtos
curl -isS http://localhost:8080/pedidos -H 'Content-Type: application/json' \
  -d '{"cliente_id":"verificacao1","itens":[{"produto_id":1,"quantidade":1}]}'
```

Para enviar o mesmo POST no PowerShell:

```powershell
$corpo = @{ cliente_id = 'verificacao1'; itens = @(@{ produto_id = 1; quantidade = 1 }) } | ConvertTo-Json -Depth 4
Invoke-WebRequest http://localhost:8080/pedidos -Method Post -ContentType 'application/json' -Body $corpo
```

Confira os logs recentes com `docker compose logs --no-log-prefix --tail 20 api worker`. No Jaeger, selecione o serviço `api` e a operação `POST /pedidos`. Abra o trace e procure os spans `pedido.criar` e `pedido.processar`. Copie o ID do trace e busque as duas origens nos logs.

```sh
docker compose logs --no-log-prefix api worker | grep -F 'TRACE_ID_COPIADO'
```

Depois de mudar arquivos em `src/`, execute `docker compose restart api worker`. Para verificar o provisionamento em um ambiente descartável, use `docker compose down -v` e depois `docker compose up -d --wait`. A opção `-v` remove os volumes locais desse ambiente.

## Equivalências com o curso

| Pilar | Java no curso | TypeScript neste projeto |
| --- | --- | --- |
| Métricas | Spring Boot Actuator e Micrometer com Prometheus | `prom-client` e `/metrics` na API e no worker |
| Tracing | Micrometer Tracing e bridge para OpenTelemetry | OpenTelemetry Node SDK, instrumentação automática, spans manuais e OTLP HTTP direto para o Jaeger |
| Logs estruturados | SLF4J com Logback, `logstash-logback-encoder` para JSON e MDC para dados de contexto | Logger compartilhado, `JSON.stringify` no stdout e IDs do span ativo |
| Propagação de contexto | W3C Trace Context com Micrometer Tracing e OpenTelemetry | `propagation.inject` e `propagation.extract` com `traceparent` e `tracestate` na fila Redis |

[Guia prático de logs da Full Cycle](https://github.com/devfullcycle/mba-observabilidade/blob/d6caa3d80a1979bfe64e54432feaa7e846cd0d41/how-to-logs.md) · [Tracing no Spring Boot](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)

## Decisões técnicas

O caminho concreto no label `route` criava séries de histograma para cada ID ou URL inédita, multiplicando buckets sem limite e podendo esgotar a memória do Prometheus. O histograma usa o template da rota, como `/produtos/:id`, e `sem_rota` para caminhos sem correspondência.

| Métrica | O que responde |
| --- | --- |
| `pedidos_criados_total` | Quantos pedidos a API persistiu? |
| `pedidos_confirmados_total` | Quantos pedidos o worker gravou como confirmados? |
| `cobrancas_processadas_total` | Quantas tentativas terminaram como `aprovada`, `recusada` ou `falha`? |

| Painel | Pergunta |
| --- | --- |
| Erros HTTP 5xx | O sistema está com erro? |
| Falhas técnicas de cobrança | O sistema está com erro? |
| Latência p95 da API | O sistema está lento? |
| Pedidos confirmados e cobranças aprovadas | O dinheiro está entrando? |

A diferença entre confirmações e aprovações indica uma divergência a investigar. Os valores financeiros são obtidos no Postgres para os IDs afetados. Veja o [post-mortem](reports/post-mortem.md).

## SLO e alerta

O SLI mede a proporção de tentativas de cobrança processadas sem falha técnica. Aprovações e recusas legítimas completam o processamento. A consulta fica sem resultado enquanto não houver tentativas na janela.

Obs: Inicialmente estava definido com 30 dias, mas foi modificado para 15 dias para ter mais precisão nas medições com os dados atuais.

```promql
sum(increase(cobrancas_processadas_total{job="worker",resultado=~"aprovada|recusada"}[15d]))
/
(sum(increase(cobrancas_processadas_total{job="worker"}[15d])) > 0)
```

O SLO é **pelo menos 99% em uma janela móvel de 15 dias**. A janela coincide com a retenção do Prometheus nesta stack e permite acompanhar a saúde das cobranças antes do fechamento mensal. Como uma falha técnica pode deixar um pedido confirmado sem receita, o objetivo tolera até uma falha a cada 100 tentativas. O error budget é `1 - 0,99 = 0,01`, ou **1%** das tentativas.

A regra `FalhaEmCobrancas` compara a taxa de falhas técnicas à taxa total em `2m` e dispara acima de `0.01` por `45s`, quando há tentativas na janela. A janela do alerta serve à detecção rápida, e a de 15 dias serve à avaliação do objetivo. A chegada do webhook também depende do scrape, da avaliação a cada 15 segundos e dos 10 segundos de agrupamento inicial do Alertmanager. Confira a regra em [Prometheus /rules](http://localhost:9090/rules).

Com esses parâmetros, o cenário saudável completou três minutos sem notificações. O receptor recebeu o primeiro `firing` do `cenario-a` em **77,53 s** na reprodução registrada. [Post-mortem](reports/post-mortem.md)

Para validar o alerta em uma stack recém-iniciada, execute os cenários em sequência. A janela saudável deve ficar três minutos sem novas notificações. Depois, mantenha o mesmo Prometheus e acompanhe o receptor até ver `alerta=FalhaEmCobrancas status=firing`, em até cinco minutos após iniciar `cenario-a`.

```sh
docker compose restart receptor-alertas
NORMAL_INICIO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose run --rm -d --name carga-observabilidade-normal carga normal
sleep 180
docker compose logs --since "$NORMAL_INICIO" receptor-alertas
docker stop --time 1 carga-observabilidade-normal

INCIDENTE_INICIO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose run --rm -d --name carga-observabilidade-incidente carga cenario-a
docker compose logs --since "$INCIDENTE_INICIO" -f receptor-alertas
```

Após conferir o disparo, encerre o acompanhamento dos logs com Ctrl+C e rode `docker stop --time 1 carga-observabilidade-incidente`. No PowerShell, obtenha o horário UTC com `[DateTimeOffset]::UtcNow.ToString('o')` e use `Start-Sleep -Seconds 180` para aguardar o cenário normal.
