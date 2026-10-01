/* ==========================================================================
   SERVIDOR DE PAGAMENTO PIX — sistema "o águia"
   Roda no Render. Guarda a chave secreta do Mercado Pago e a credencial do
   Firebase, que NUNCA podem ficar no site (GitHub Pages).
   ========================================================================== */

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------- VARIÁVEIS DE AMBIENTE (configuradas no Render, nunca aqui) ---------------- */
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const FIREBASE_SERVICE_ACCOUNT_BASE64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

if (!MP_ACCESS_TOKEN) {
  console.error("ERRO: variável de ambiente MP_ACCESS_TOKEN não configurada.");
}
if (!FIREBASE_SERVICE_ACCOUNT_BASE64) {
  console.error("ERRO: variável de ambiente FIREBASE_SERVICE_ACCOUNT_BASE64 não configurada.");
}

/* ---------------- FIREBASE ADMIN (acesso privilegiado ao Firestore) ---------------- */
function inicializarFirebaseAdmin() {
  if (admin.apps.length) return admin.app();
  const jsonTexto = Buffer.from(FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
  const credenciais = JSON.parse(jsonTexto);
  return admin.initializeApp({
    credential: admin.credential.cert(credenciais)
  });
}

let db = null;
function getDb() {
  if (!db) {
    inicializarFirebaseAdmin();
    db = admin.firestore();
  }
  return db;
}

/* ---------------- MERCADO PAGO (chamadas diretas à API REST, sem SDK extra) ---------------- */
const MP_BASE_URL = "https://api.mercadopago.com";

async function criarCobrancaPix({ valor, descricao, emailPagador, referenciaExterna }) {
  const resposta = await fetch(`${MP_BASE_URL}/v1/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
      "X-Idempotency-Key": referenciaExterna
    },
    body: JSON.stringify({
      transaction_amount: Number(valor),
      description: descricao,
      payment_method_id: "pix",
      external_reference: referenciaExterna,
      payer: {
        email: emailPagador || "cliente@sememail.com"
      }
    })
  });

  const dados = await resposta.json();
  if (!resposta.ok) {
    throw new Error("Mercado Pago recusou a cobrança: " + JSON.stringify(dados));
  }
  return dados;
}

async function consultarPagamento(paymentId) {
  const resposta = await fetch(`${MP_BASE_URL}/v1/payments/${paymentId}`, {
    headers: { "Authorization": `Bearer ${MP_ACCESS_TOKEN}` }
  });
  const dados = await resposta.json();
  if (!resposta.ok) {
    throw new Error("Erro ao consultar pagamento no Mercado Pago: " + JSON.stringify(dados));
  }
  return dados;
}

/* ---------------- ROTAS ---------------- */

// checagem simples pra saber se o servidor está no ar
app.get("/", (req, res) => {
  res.json({ ok: true, servico: "o águia — servidor de pagamento" });
});

// 1) o cliente clicou em "comprar": cria a cobrança Pix e guarda o pedido como pendente
app.post("/criar-pagamento", async (req, res) => {
  try {
    const { lojaId, clienteId, clienteNome, endereco, itens, observacao, valorTotal, emailPagador } = req.body;

    if (!lojaId || !clienteId || !Array.isArray(itens) || itens.length === 0 || !valorTotal) {
      return res.status(400).json({ erro: "dados incompletos para criar o pagamento." });
    }

    const firestore = getDb();
    const pendenteRef = firestore.collection("pagamentosPendentes").doc();

    await pendenteRef.set({
      lojaId,
      clienteId,
      clienteNome: clienteNome || "cliente",
      endereco: endereco || "",
      itens,
      observacao: observacao || "",
      valorTotal: Number(valorTotal),
      status: "aguardando",
      confirmado: false,
      pedidoId: null,
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    });

    const cobranca = await criarCobrancaPix({
      valor: valorTotal,
      descricao: `Pedido — ${clienteNome || "cliente"}`,
      emailPagador,
      referenciaExterna: pendenteRef.id
    });

    await pendenteRef.update({ paymentId: String(cobranca.id) });

    const dadosPix = cobranca.point_of_interaction && cobranca.point_of_interaction.transaction_data;

    res.json({
      pendenteId: pendenteRef.id,
      paymentId: cobranca.id,
      qrCodeBase64: dadosPix ? dadosPix.qr_code_base64 : null,
      copiaCola: dadosPix ? dadosPix.qr_code : null
    });
  } catch (erro) {
    console.error("erro em /criar-pagamento:", erro);
    res.status(500).json({ erro: "não foi possível gerar o pagamento. tente novamente." });
  }
});

// 2) o Mercado Pago chama essa rota sozinho quando o status de um pagamento muda
app.post("/webhook", async (req, res) => {
  // responde rápido pro Mercado Pago não ficar tentando de novo
  res.sendStatus(200);

  try {
    const paymentId = (req.body && req.body.data && req.body.data.id) || req.query.id || req.query["data.id"];
    if (!paymentId) return;

    const pagamento = await consultarPagamento(paymentId);
    if (pagamento.status !== "approved") return;

    const pendenteId = pagamento.external_reference;
    if (!pendenteId) return;

    const firestore = getDb();
    const pendenteRef = firestore.collection("pagamentosPendentes").doc(pendenteId);
    const pendenteSnap = await pendenteRef.get();
    if (!pendenteSnap.exists) return;

    const pendente = pendenteSnap.data();
    if (pendente.confirmado) return; // já processado antes, evita duplicar pedido

    const lojaRef = firestore.collection("lojas").doc(pendente.lojaId);
    const novoPedidoRef = lojaRef.collection("pedidos").doc();

    await novoPedidoRef.set({
      clienteId: pendente.clienteId,
      clienteNome: pendente.clienteNome,
      endereco: pendente.endereco,
      itens: pendente.itens,
      observacao: pendente.observacao,
      formaPagamento: "Pix",
      pago: true,
      aceito: false,
      saiu: false,
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    });

    await pendenteRef.update({
      confirmado: true,
      status: "aprovado",
      pedidoId: novoPedidoRef.id
    });

    await lojaRef.collection("notificacoesPagamento").add({
      mensagem: `pagamento confirmado — pedido de ${pendente.clienteNome}`,
      clienteNome: pendente.clienteNome,
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (erro) {
    console.error("erro em /webhook:", erro);
  }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`servidor de pagamento rodando na porta ${PORTA}`);
});