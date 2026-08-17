// POST /api/reservar { slotId, nome, tel } -> { url }
//
// Trava o horario (disponivel:false, pendente:true) por HOLD_MINUTES e cria a
// preferencia de pagamento no Mercado Pago. O horario so vira reserva de
// verdade quando o webhook confirmar o pagamento aprovado -- ate la fica
// "pendente" e ninguem mais consegue escolhe-lo. Se o pagamento nao chegar
// a ser aprovado (ou o hold expirar), o proprio agendar.html libera o
// horario de volta sozinho.

const DB = 'https://mentorias-bruno-default-rtdb.firebaseio.com'
const SITE_URL = 'https://brunesk.github.io/mentorias-agenda'
const HOLD_MINUTES = 15

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })

  const slotId = String(req.body?.slotId || '').trim()
  const nome   = String(req.body?.nome ?? '').trim()
  const tel    = String(req.body?.tel ?? '').trim()
  if (!slotId || !nome || !tel) {
    return res.status(400).json({ error: 'Preencha nome, WhatsApp e escolha um horário.' })
  }

  // Confere se o horario ainda esta livre (nao confia no que o navegador mandou)
  const slotRes = await fetch(`${DB}/slots/${slotId}.json`)
  const slot = await slotRes.json()
  if (!slot || slot.disponivel !== true) {
    return res.status(409).json({ error: 'Esse horário acabou de ser reservado por outra pessoa. Escolha outro.' })
  }

  const configRes = await fetch(`${DB}/config.json`)
  const config = (await configRes.json()) || {}
  const preco = parseFloat(config.preco)
  if (!preco || preco <= 0) {
    return res.status(500).json({ error: 'Preço da mentoria não configurado.' })
  }

  // Trava o horario (hold temporario) antes de mandar pro pagamento, pra
  // ninguem mais conseguir escolher o mesmo enquanto essa pessoa paga.
  const holdExpira = Date.now() + HOLD_MINUTES * 60 * 1000
  await fetch(`${DB}/slots/${slotId}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      disponivel: false, pendente: true,
      clienteNome: nome, clienteTel: tel,
      holdExpira, agendadoEm: null, mpPaymentId: null,
    }),
  })

  try {
    const prefRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ id: 'mentoria', title: 'Mentoria — Acelera Shopee', quantity: 1, unit_price: preco, currency_id: 'BRL' }],
        payer: { name: nome },
        external_reference: slotId,
        back_urls: {
          success: `${SITE_URL}/agendar.html?aguardando=1&slot=${slotId}`,
          pending: `${SITE_URL}/agendar.html?aguardando=1&slot=${slotId}`,
          failure: `${SITE_URL}/agendar.html?erro=1`,
        },
        auto_return: 'approved',
        notification_url: `https://${req.headers.host}/api/webhook`,
        statement_descriptor: 'MENTORIA SHOPEE',
      }),
    })
    const pref = await prefRes.json()
    if (!prefRes.ok || !pref.init_point) {
      throw new Error(pref?.message || 'Falha ao criar preferência de pagamento')
    }
    return res.status(200).json({ url: pref.init_point })
  } catch (e) {
    // Nao conseguiu gerar o pagamento -- libera o horario de volta
    await fetch(`${DB}/slots/${slotId}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disponivel: true, pendente: false, clienteNome: null, clienteTel: null, holdExpira: null }),
    })
    console.error('reservar:', e)
    return res.status(502).json({ error: 'Não foi possível gerar o pagamento. Tente novamente.' })
  }
}
