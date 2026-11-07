import express, { type NextFunction, type Request, type Response } from 'express';
import { esperarBanco, fecharPool, interromperPool, pool } from '../db/pool';
import { migrar } from '../db/migracao';
import { criarConexaoRedis } from '../fila/fila';
import { log } from '../telemetria/log';
import { criarEncerramentoFatal } from '../telemetria/otel';
import { registrarErro } from '../telemetria/tracing';
import { medirRequisicoes } from './metricas-http';
import { criarRotas } from './rotas';

const porta = Number(process.env.API_PORT ?? process.env.PORT ?? 8080);

async function iniciar(): Promise<void> {
  await esperarBanco();
  await migrar();

  const redis = criarConexaoRedis();

  const aplicacao = express();
  // Medir antes do parser inclui os 500 por JSON inválido. O middleware registra
  // o resultado em finish e usa o template da rota para limitar a cardinalidade.
  aplicacao.use(medirRequisicoes);
  aplicacao.use(express.json());
  aplicacao.use(criarRotas(redis));

  aplicacao.use(
    (erro: Error, _requisicao: Request, resposta: Response, _proximo: NextFunction) => {
      // O ponto compartilhado padroniza log JSON correlacionado e status ERROR
      // do span para as exceções encaminhadas ao middleware do Express.
      registrarErro('erro ao atender requisicao', erro);
      resposta.status(500).json({ erro: 'erro interno' });
    }
  );

  const servidor = aplicacao.listen(porta, () => {
    log.info('api ouvindo na porta ' + porta);
  });

  // O Express 4 deixa a rejeição do handler async chegar ao processo. Para exportar
  // o diagnóstico dessa falha, o encerramento compartilhado mantém a saída 1.
  // HTTP, Redis e banco são interrompidos antes da espera limitada pela telemetria,
  // evitando que outro pedido seja persistido durante essa espera.
  const encerramentoFatal = criarEncerramentoFatal(() => {
    servidor.close();
    servidor.closeAllConnections();
    redis.disconnect();
    interromperPool();
  });
  process.on('unhandledRejection', (erro) => {
    encerramentoFatal.iniciar('api encerrando por rejeicao nao tratada', erro);
  });
  pool.on('error', (erro) => {
    // Erros de conexão ociosa chegam por evento, fora dos try/catch de consultas.
    // Esse listener substitui a stack em texto por log JSON e span de erro.
    encerramentoFatal.iniciar('erro em conexao ociosa com o banco', erro);
  });

  const encerrar = () => {
    // Um sinal durante a exportação fatal deve preservar a saída 1 daquela falha.
    if (encerramentoFatal.iniciado) return;

    servidor.close(async () => {
      redis.disconnect();
      await fecharPool();
      if (!encerramentoFatal.iniciado) process.exit(0);
    });
  };

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);
}

iniciar().catch((erro) => {
  // A inicialização usa o mesmo esquema de diagnóstico dos erros em requisições.
  registrarErro('api nao conseguiu iniciar', erro);
  process.exit(1);
});
