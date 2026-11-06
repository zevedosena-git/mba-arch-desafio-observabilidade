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
    cobrancasProcessadas.inc({ resultado: resultado.aprovado ? 'aprovada' : 'recusada' });
  } catch (erro) {
    cobrancasProcessadas.inc({ resultado: 'falha' });
    registrarFalhaLegado(erro);
    registrarErro('falha na cobranca do pedido', erro, pedidoId);
  }

  return recusado ? 'recusado' : 'confirmado';
}
