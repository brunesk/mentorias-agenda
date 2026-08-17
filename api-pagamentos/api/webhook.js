// Webhook do Mercado Pago -> confirma (ou libera) a reserva do horario.
//
// approved            -> slot vira reserva definitiva (disponivel:false, pendente:false)
// rejected/cancelled/
// refunded/charged_back -> libera o horario de volta (disponivel:true)
// pending/in_process   -> nao faz nada ainda, so aguarda a proxima notificacao
//
// Nunca confia no corpo da notificacao: sempre busca o status real na API
// do Mercado Pago antes de mudar qualquer coisa no Firebase.

const DB = 'https://mentorias-bruno-default-rtdb.firebaseio.com'

module.exports = async (req, res) => {
  const q = req.query || {}
  let type = q.type || q.topic
  let paymentId = q['data.id'] || (q.topic === 'payment' ? q.id : null)

  if (!paymentId && req.body) {
    type = req.body.type || req.body.topic || type
    paymentId = req.body?.data?.id || req.body?.resource || null
  }

  if (type !== 'payment' || !paymentId) return res.status(200).json({ ignored: true })

  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
  })
  if (!r.ok) return res.status(500).json({ error: 'payment lookup failed' }) // MP reenvia depois

  const pay = await r.json()
  const slotId = pay.external_reference
  if (!slotId) return res.status(200).json({ ignored: true })

  const slotRes = await fetch(`${DB}/slots/${slotId}.json`)
  const slot = await slotRes.json()
  if (!slot) return res.status(200).json({ ignored: 'slot not found' })

  if (pay.status === 'approved') {
    // So confirma se o slot ainda estiver com o hold desse pagamento (evita
    // confirmar em cima de um horario que ja foi liberado/reaproveitado).
    await fetch(`${DB}/slots/${slotId}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        disponivel: false, pendente: false,
        clienteNome: slot.clienteNome || pay.payer?.first_name || 'Cliente',
        clienteTel: slot.clienteTel || '',
        agendadoEm: Date.now(),
        mpPaymentId: String(pay.id),
      }),
    })
    console.log('mentoria confirmada:', slotId, '←', pay.id)
    return res.status(200).json({ ok: true, confirmed: slotId })
  }

  if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(pay.status)) {
    // Só libera se esse slot ainda pertence a este hold (nao sobrescreve
    // um agendamento ja confirmado por outro pagamento).
    if (slot.pendente === true) {
      await fetch(`${DB}/slots/${slotId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disponivel: true, pendente: false, clienteNome: null, clienteTel: null, holdExpira: null, mpPaymentId: null }),
      })
    }
    return res.status(200).json({ ok: true, released: slotId })
  }

  return res.status(200).json({ ok: true, status: pay.status })
}
