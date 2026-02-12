// backend/index.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
const { google } = require("googleapis");
const { Readable } = require("stream");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" })); // base64 grande

// --------------------- Utils ---------------------
function mustEnv(name) {
  if (!process.env[name]) {
    throw new Error(`ENV faltando: ${name}`);
  }
}

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// --------------------- Firebase Admin ---------------------
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// --------------------- Mercado Pago ---------------------
mustEnv("MP_ACCESS_TOKEN");
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const PLANOS = {
  mensal: { plano: "mensal", meses: 1, acessos: 1 },
  trimestral: { plano: "trimestral", meses: 3, acessos: 1 },
  anual: { plano: "anual", meses: 12, acessos: 1 },
  anual_plus: { plano: "anual_plus", meses: 12, acessos: 2 },
};

console.log("MP TOKEN:", process.env.MP_ACCESS_TOKEN ? "OK" : "FALTANDO");

// --------------------- Google Drive (OAuth) ---------------------
// Você usa:
// DRIVE_OAUTH_CREDENTIALS_JSON=./driveOAuthClient.json
// DRIVE_OAUTH_TOKEN_JSON=./driveToken.json
mustEnv("DRIVE_OAUTH_CREDENTIALS_JSON");
mustEnv("DRIVE_OAUTH_TOKEN_JSON");

// Root folder (pasta onde vai criar CHECKLISTS dentro)
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || null;

function loadJson(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

const oauthClientInfo = loadJson(process.env.DRIVE_OAUTH_CREDENTIALS_JSON);
const tokenInfo = loadJson(process.env.DRIVE_OAUTH_TOKEN_JSON);

// driveOAuthClient.json normalmente vem como:
// { "installed": { client_id, client_secret, redirect_uris[] } }
// ou { "web": { ... } }
const oauthCfg = oauthClientInfo.installed || oauthClientInfo.web;
if (!oauthCfg?.client_id || !oauthCfg?.client_secret) {
  throw new Error("driveOAuthClient.json inválido: faltando client_id/client_secret");
}

const oAuth2Client = new google.auth.OAuth2(
  oauthCfg.client_id,
  oauthCfg.client_secret,
  (oauthCfg.redirect_uris && oauthCfg.redirect_uris[0]) || "http://localhost"
);

// tokenInfo precisa ter refresh_token
if (!tokenInfo?.refresh_token) {
  throw new Error("driveToken.json inválido: faltando refresh_token");
}

oAuth2Client.setCredentials({
  refresh_token: tokenInfo.refresh_token,
  access_token: tokenInfo.access_token, // pode existir, mas refresh_token é o principal
  expiry_date: tokenInfo.expiry_date,
});

const drive = google.drive({ version: "v3", auth: oAuth2Client });

// --------------------- Drive helpers ---------------------
async function findOrCreateFolder(name, parentId) {
  const safeName = String(name).replace(/'/g, "\\'");
  const qParts = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${safeName}'`,
    `trashed=false`,
  ];
  if (parentId) qParts.push(`'${parentId}' in parents`);

  const list = await drive.files.list({
    q: qParts.join(" and "),
    fields: "files(id,name)",
    spaces: "drive",
  });

  if (list.data.files && list.data.files.length > 0) return list.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined,
    },
    fields: "id",
  });

  return created.data.id;
}

async function uploadBase64ToDrive({ base64, mime, filename, parentId }) {
  const buffer = Buffer.from(base64, "base64");
  const stream = Readable.from(buffer);

  const created = await drive.files.create({
    requestBody: {
      name: filename,
      parents: parentId ? [parentId] : undefined,
    },
    media: {
      mimeType: mime || "image/jpeg",
      body: stream,
    },
    fields: "id",
  });

  return created.data.id;
}

// --------------------- Rotas de FOTO ---------------------
app.get("/health", (_, res) => res.json({ ok: true }));

// Upload foto: salva no Drive e retorna fileId
app.post("/upload-foto", async (req, res) => {
  try {
    const { codigoPosto, runId, itemId, mime, base64 } = req.body;

    if (!codigoPosto || !runId || !itemId || !base64) {
      return res.status(400).json({ error: "Dados faltando (codigoPosto/runId/itemId/base64)" });
    }

    // Estrutura: ROOT/(opcional) -> CHECKLISTS -> {codigoPosto} -> {runId}
    const baseFolder = await findOrCreateFolder("CHECKLISTS", DRIVE_ROOT_FOLDER_ID);
    const postoFolder = await findOrCreateFolder(String(codigoPosto), baseFolder);
    const runFolder = await findOrCreateFolder(String(runId), postoFolder);

    const m = (mime || "image/jpeg").toLowerCase();
    const ext =
      m.includes("png") ? "png" :
      m.includes("webp") ? "webp" :
      "jpg";

    const filename = `${itemId}_${Date.now()}.${ext}`;

    const fileId = await uploadBase64ToDrive({
      base64,
      mime: mime || "image/jpeg",
      filename,
      parentId: runFolder,
    });

    return res.json({ fileId });
  } catch (e) {
    console.error("upload-foto error:", e?.message || e);
    return res.status(500).json({ error: "Falha ao fazer upload da foto" });
  }
});

// Retorna urls (proxy) para cada fileId
app.post("/signed-urls", async (req, res) => {
  try {
    const { fileIds } = req.body;
    if (!Array.isArray(fileIds)) return res.status(400).json({ error: "fileIds inválido" });

    const urls = {};
    for (const id of fileIds) {
      if (!id) continue;
      urls[id] = `${PUBLIC_BASE_URL}/drive-file/${id}`;
    }
    return res.json({ urls });
  } catch (e) {
    console.error("signed-urls error:", e?.message || e);
    return res.status(500).json({ error: "Falha ao gerar urls" });
  }
});

// Proxy do Drive: entrega a imagem
app.get("/drive-file/:id", async (req, res) => {
  try {
    const fileId = req.params.id;

    const meta = await drive.files.get({
      fileId,
      fields: "mimeType,name",
    });

    const mimeType = meta.data.mimeType || "image/jpeg";
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const file = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    file.data.on("error", (err) => {
      console.error("Drive stream error:", err);
      res.sendStatus(500);
    });

    file.data.pipe(res);
  } catch (e) {
    console.error("drive-file error:", e?.message || e);
    return res.sendStatus(404);
  }
});

// --------------------- Pagamento (MercadoPago) ---------------------
app.post("/criar-pagamento", async (req, res) => {
  try {
    const { plano, uid, email } = req.body;

    const planos = {
      mensal: { valor: 1.0, meses: 1, acessos: 1 },
      trimestral: { valor: 64.99, meses: 3, acessos: 1 },
      anual: { valor: 149.99, meses: 12, acessos: 1 },
      anual_plus: { valor: 189.99, meses: 12, acessos: 2 },
    };

    const p = planos[plano];
    if (!p) return res.status(400).json({ error: "Plano inválido" });
    if (!uid || !email || !plano) return res.status(400).json({ error: "Dados faltando" });

    const preference = new Preference(client);

    const result = await preference.create({
      body: {
        items: [
          {
            purpose: "wallet_purchase",
            title: `Plano ${plano}`,
            quantity: 1,
            unit_price: p.valor,
          },
        ],
        payer: { email },
        notification_url: `${PUBLIC_BASE_URL}/webhook/mercadopago`,
        metadata: { uid, plano, meses: p.meses, acessos: p.acessos },
        payment_methods: {
          excluded_payment_types: [],
          excluded_payment_methods: [],
          installments: 1,
        },
      },
    });

    res.json({ checkout_url: result.init_point });
  } catch (err) {
    console.error("🔥 ERRO CRIAR PAGAMENTO:", err);
    res.status(500).json({ error: "Erro ao criar pagamento" });
  }
});

app.post("/webhook/mercadopago", async (req, res) => {
  try {
    console.log("🔔 WEBHOOK MP:", JSON.stringify(req.body, null, 2));

    if (req.body?.topic === "merchant_order") {
      console.log("ℹ️ merchant_order recebido, ignorando por enquanto");
      return res.sendStatus(200);
    }

    const paymentId =
      req.body?.data?.id ||
      (typeof req.body?.resource === "string"
        ? req.body.resource.split("/").pop()
        : req.body?.resource);

    if (!paymentId) return res.sendStatus(200);

    const payment = new Payment(client);

    let result;
    try {
      result = await payment.get({ id: paymentId });
    } catch (err) {
      if (err?.error === "not_found") {
        console.log("❌ Pagamento não encontrado, ignorando:", paymentId);
        return res.sendStatus(200);
      }
      throw err;
    }

    if (result.status !== "approved") {
      console.log("⚠️ Pagamento não aprovado:", paymentId, result.status);
      return res.sendStatus(200);
    }

    const uid = result.metadata?.uid;
    const planoMeta = result.metadata?.plano;

    if (!uid) return res.sendStatus(200);

    const planoConfig = PLANOS[planoMeta];
    if (!planoConfig) return res.sendStatus(200);

    const userRef = db.collection("usuarios").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.sendStatus(200);

    const vencimento = new Date();
    vencimento.setMonth(vencimento.getMonth() + planoConfig.meses);

    await userRef.update({
      plano: planoConfig.plano,
      acessosPermitidos: planoConfig.acessos,
      autorizado: true,
      vencimento,
      pagamento: {
        gateway: "MERCADO_PAGO",
        status: "APPROVED",
        paymentId: String(paymentId),
        plano: planoConfig.plano,
        bruto: result.transaction_amount || null,
        liquido: result.transaction_details?.net_received_amount || null,
        taxas: result.fee_details || [],
      },
    });

    console.log("✅ PLANO LIBERADO UID:", uid, "PLANO:", planoConfig.plano);
    return res.sendStatus(200);
  } catch (err) {
    console.error("🔥 ERRO WEBHOOK MP:", err);
    return res.sendStatus(500);
  }
});

// --------------------- Start ---------------------
app.listen(PORT, () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
  console.log("🌍 PUBLIC_BASE_URL:", PUBLIC_BASE_URL);
});
