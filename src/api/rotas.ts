import { Router } from 'express';
import type Redis from 'ioredis';
import client from 'prom-client';
import {
  buscarPedido,
  buscarProduto,
  buscarProdutosPorIds,
  criarPedido,
  listarProdutos,
  type ItemNovoPedido,
} from '../db/consultas';
import { publicarPedido } from '../fila/fila';
import { log } from '../telemetria/log';
import { TIPO_DE_CONTEUDO, coletar, registro } from '../telemetria/metricas';
import { registrarErro, tracer } from '../telemetria/tracing';

const pedidosCriados = new client.Counter({
  name: 'pedidos_criados_total',
  help: 'Pedidos criados e persistidos pela API',
  registers: [registro],
});
pedidosCriados.inc(0);

export function criarRotas(redis: Redis): Router {
  const rotas = Router();

  rotas.get('/health', (_requisicao, resposta) => {
    resposta.status(200).json({ status: 'ok' });
  });

  rotas.get('/metrics', async (_requisicao, resposta) => {
    resposta.set('content-type', TIPO_DE_CONTEUDO);
    resposta.status(200).send(await coletar());
  });

  rotas.get('/produtos', async (_requisicao, resposta) => {
    const produtos = await listarProdutos();
    resposta.status(200).json(produtos);
  });

  rotas.get('/produtos/:id', async (requisicao, resposta) => {
    const id = Number(requisicao.params.id);

    if (!Number.isInteger(id)) {
      resposta.status(400).json({ erro: 'id invalido' });
      return;
    }

    const produto = await buscarProduto(id);

    if (!produto) {
      resposta.status(404).json({ erro: 'produto nao encontrado' });
      return;
    }

    resposta.status(200).json(produto);
  });

  rotas.post('/pedidos', async (requisicao, resposta) => {
    // O span fica ativo durante a publicação para que o contexto injetado na fila seja o dele.
    await tracer.startActiveSpan('pedido.criar', async (span) => {
      let pedidoId: number | undefined;

      try {
        const clienteId = requisicao.body?.cliente_id;
        const itens: ItemNovoPedido[] = requisicao.body?.itens;

        if (typeof clienteId !== 'string' || !Array.isArray(itens) || itens.length === 0) {
          resposta.status(400).json({ erro: 'cliente_id e itens sao obrigatorios' });
          return;
        }

        span.setAttribute('pedido.itens', itens.length);
        const produtos = await buscarProdutosPorIds(itens.map((item) => item.produto_id));
        const precoPorProduto = new Map(produtos.map((produto) => [produto.id, produto.preco]));

        const faltando = itens.filter((item) => !precoPorProduto.has(item.produto_id));
        if (faltando.length > 0) {
          resposta.status(400).json({ erro: 'produto inexistente no pedido' });
          return;
        }

        const pedido = await criarPedido(clienteId, itens, precoPorProduto);
        pedidoId = pedido.id;
        span.setAttribute('pedido.id', pedido.id);
        pedidosCriados.inc();

        await publicarPedido(redis, {
          pedido_id: pedido.id,
          cliente_id: clienteId,
          valor_total: pedido.valor_total,
        });

        log.info('pedido ' + pedido.id + ' criado para ' + clienteId, pedido.id);

        resposta.status(202).json({ pedido_id: pedido.id, status: 'pendente' });
      } catch (erro) {
        // Relançar preserva o comportamento do Express 4 com handler async.
        registrarErro('erro ao criar pedido', erro, pedidoId);
        throw erro;
      } finally {
        span.end();
      }
    });
  });

  rotas.get('/pedidos/:id', async (requisicao, resposta) => {
    const id = Number(requisicao.params.id);

    if (!Number.isInteger(id)) {
      resposta.status(400).json({ erro: 'id invalido' });
      return;
    }

    const pedido = await buscarPedido(id);

    if (!pedido) {
      resposta.status(404).json({ erro: 'pedido nao encontrado' });
      return;
    }

    resposta.status(200).json(pedido);
  });

  return rotas;
}
