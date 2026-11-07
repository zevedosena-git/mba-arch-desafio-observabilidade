import { registrarErro } from '../telemetria/tracing';
import { cobrancasProcessadas } from './metricas';
import { processarPagamento } from './pagamento';
import { registrarFalhaLegado } from './registro-legado';

export type StatusDoPedido = 'confirmado' | 'recusado';

export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number,
  pedidoId?: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;
    // Medir o resultado financeiro aqui permite compará-lo ao estado persistido.
    // O label resultado usa apenas os três valores previstos no desafio.
    cobrancasProcessadas.inc({ resultado: resultado.aprovado ? 'aprovada' : 'recusada' });
  } catch (erro) {
    // A falha técnica vira métrica e diagnóstico no span pedido.processar.
    // O estado legado de recusado continua expondo o defeito estudado no incidente.
    cobrancasProcessadas.inc({ resultado: 'falha' });
    registrarFalhaLegado(erro);
    registrarErro('falha na cobranca do pedido', erro, pedidoId);
  }

  return recusado ? 'recusado' : 'confirmado';
}
