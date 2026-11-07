import http from 'node:http';
import { atualizarStatusPedido } from '../db/consultas';
import { esperarBanco, fecharPool, interromperPool, pool } from '../db/pool';
import { migrar } from '../db/migracao';
import { consumirPedido, contextoDoPedido, criarConexaoRedis } from '../fila/fila';
import { log } from '../telemetria/log';
import { TIPO_DE_CONTEUDO, coletar } from '../telemetria/metricas';
import { criarEncerramentoFatal } from '../telemetria/otel';
import { registrarErro, tracer } from '../telemetria/tracing';
import { decidirStatusDoPedido } from './conciliacao';
import { pedidosConfirmados } from './metricas';

const porta = Number(process.env.WORKER_PORT ?? process.env.PORT ?? 8081);

let rodando = true;

function iniciarServidorDeSaude(): http.Server {
  const servidor = http.createServer(async (requisicao, resposta) => {
    if (requisicao.url === '/health') {
      resposta.writeHead(200, { 'content-type': 'application/json' });
      resposta.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (requisicao.url === '/metrics') {
      resposta.writeHead(200, { 'content-type': TIPO_DE_CONTEUDO });
      resposta.end(await coletar());
      return;
    }

    resposta.writeHead(404, { 'content-type': 'application/json' });
    resposta.end(JSON.stringify({ erro: 'rota nao encontrada' }));
  });

  servidor.listen(porta, () => {
    log.info('worker ouvindo na porta ' + porta);
  });

  return servidor;
}

async function processarMensagem(mensagem: Record<string, unknown>): Promise<void> {
  // Continuar o W3C Trace Context da mensagem coloca API e worker no mesmo trace.
  // pedido.processar delimita o processamento de negócio além dos spans automáticos.
  const contexto = contextoDoPedido(mensagem);

  await tracer.startActiveSpan('pedido.processar', {}, contexto, async (span) => {
    let pedidoId: number | undefined;

    try {
      pedidoId = Number(mensagem.pedido_id);
      const clienteId = String(mensagem.cliente_id);
      const valorTotal = Number(mensagem.valor_total);
      span.setAttributes({ 'pedido.id': pedidoId, 'pedido.valor_total': valorTotal });

      log.info('mensagem do pedido ' + pedidoId + ' recebida da fila', pedidoId);

      const status = await decidirStatusDoPedido(clienteId, valorTotal, pedidoId);
      await atualizarStatusPedido(pedidoId, status);
      span.setAttribute('pedido.status', status);
      // O contador representa confirmações persistidas. A aprovação financeira
      // é medida separadamente para tornar a divergência do incidente observável.
      if (status === 'confirmado') {
        pedidosConfirmados.inc();
      }

      log.info('pedido ' + pedidoId + ' ficou ' + status, pedidoId);
    } catch (erro) {
      // O padrão compartilhado une exceção, status ERROR e log com pedido_id.
      // Relançar mantém o laço de consumo responsável pela espera após a falha.
      registrarErro('erro ao processar mensagem da fila', erro, pedidoId);
      throw erro;
    } finally {
      // Encerrar em finally também cobre falhas e libera o span para exportação.
      span.end();
    }
  });
}

async function iniciar(): Promise<void> {
  await esperarBanco();
  await migrar();

  const redis = criarConexaoRedis();
  const servidor = iniciarServidorDeSaude();

  // A falha de uma conexão ociosa do Postgres é fatal como na aplicação base.
  // API e worker compartilham a política de log JSON, span de erro e saída 1.
  // Parar o consumo e as conexões antes da exportação contém o trabalho em andamento.
  const encerramentoFatal = criarEncerramentoFatal(() => {
    rodando = false;
    servidor.close();
    servidor.closeAllConnections();
    redis.disconnect();
    interromperPool();
  });
  pool.on('error', (erro) => {
    // O evento do pool não atravessa o catch do laço de consumo.
    encerramentoFatal.iniciar('erro em conexao ociosa com o banco', erro);
  });

  const encerrar = () => {
    // SIGINT/SIGTERM concorrentes devem respeitar o encerramento fatal já iniciado.
    if (encerramentoFatal.iniciado) return;

    rodando = false;
    servidor.close(async () => {
      redis.disconnect();
      await fecharPool();
      if (!encerramentoFatal.iniciado) process.exit(0);
    });
  };

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  log.info('worker consumindo a fila de pedidos');

  while (rodando) {
    let mensagem: Record<string, unknown> | null = null;
    try {
      mensagem = await consumirPedido(redis);

      if (mensagem) {
        await processarMensagem(mensagem);
      }
    } catch (erro) {
      // processarMensagem já registra os erros de pedidos no span correspondente.
      // Este ponto registra as falhas de leitura/decodificação e aplica a espera.
      if (!mensagem) {
        registrarErro('erro ao ler a fila', erro);
      }
      await new Promise((resolver) => setTimeout(resolver, 1000));
    }
  }
}

iniciar().catch((erro) => {
  // Falhas de inicialização seguem a correlação e o formato JSON dos demais erros.
  registrarErro('worker nao conseguiu iniciar', erro);
  process.exit(1);
});
