require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
const { google } = require("googleapis");
const { Readable } = require("stream");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// --------------------- Utils ---------------------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function loadJsonEnv(name) {
  const raw = mustEnv(name);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in env var ${name}: ${e.message}`);
  }
}

// --------------------- Firebase Admin (via ENV) ---------------------
const firebaseServiceAccount = loadJsonEnv("FIREBASE_SERVICE_ACCOUNT_JSON");

admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount),
});
const db = admin.firestore();

// --------------------- Mercado Pago ---------------------
const client = new MercadoPagoConfig({
  accessToken: mustEnv("MP_ACCESS_TOKEN"),
});

const PLANOS = {
  mensal: { plano: "mensal", meses: 1, acessos: 1 },
  trimestral: { plano: "trimestral", meses: 3, acessos: 1 },
  anual: { plano: "anual", meses: 12, acessos: 1 },
  anual_plus: { plano: "anual_plus", meses: 12, acessos: 2 },
};

console.log("MP TOKEN:", process.env.MP_ACCESS_TOKEN ? "OK" : "FALTANDO");

// --------------------- Google Drive (OAuth via ENV) ---------------------
function buildDriveClient() {
  const credentials = loadJsonEnv("DRIVE_OAUTH_CREDENTIALS_JSON");
  const token = loadJsonEnv("DRIVE_OAUTH_TOKEN_JSON");

  // suporta "installed" ou "web"
  const cfg = credentials.installed || credentials.web;
  if (!cfg) throw new Error("DRIVE_OAUTH_CREDENTIALS_JSON precisa ter installed ou web");

  const redirectUri =
    (cfg.redirect_uris && cfg.redirect_uris[0]) || "http://localhost";

  const oauth2Client = new google.auth.OAuth2(
    cfg.client_id,
    cfg.client_secret,
    redirectUri
  );

  oauth2Client.setCredentials(token);

  return google.drive({ version: "v3", auth: oauth2Client });
}

const drive = buildDriveClient();

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
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (list.data.files && list.data.files.length > 0) {
    return list.data.files[0].id;
  }

  const created = await drive.files.create({
    requestBody: {
      name: String(name),
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined,
    },
    fields: "id",
    supportsAllDrives: true,
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
    supportsAllDrives: true,
  });

  return created.data.id;
}

// --------------------- Rotas: Fotos (Drive) ---------------------

// POST /upload-foto
// body: { codigoPosto, runId, itemId, mime, base64 }
app.post("/upload-foto", async (req, res) => {
  try {
    const { codigoPosto, runId, itemId, mime, base64 } = req.body || {};

    if (!codigoPosto || !runId || !itemId || !base64) {
      return res
        .status(400)
        .json({ error: "Dados faltando (codigoPosto/runId/itemId/base64)" });
    }

    const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;

    // Estrutura:
    // {ROOT}/CHECKLISTS/{codigoPosto}/{runId}
    const baseFolder = await findOrCreateFolder("CHECKLISTS", rootId);
    const postoFolder = await findOrCreateFolder(String(codigoPosto), baseFolder);
    const runFolder = await findOrCreateFolder(String(runId), postoFolder);

    const ext =
      mime === "image/png" ? "png" :
      mime === "image/webp" ? "webp" :
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

// POST /signed-urls
// body: { fileIds: string[] }
app.post("/signed-urls", async (req, res) => {
  try {
    const { fileIds } = req.body || {};
    if (!Array.isArray(fileIds)) {
      return res.status(400).json({ error: "fileIds inválido" });
    }

    const baseUrl =
      process.env.PUBLIC_BASE_URL ||
      `http://localhost:${process.env.PORT || 3000}`;

    const urls = {};
    for (const id of fileIds) {
      if (!id) continue;
      urls[id] = `${baseUrl}/drive-file/${id}`;
    }

    return res.json({ urls });
  } catch (e) {
    console.error("signed-urls error:", e?.message || e);
    return res.status(500).json({ error: "Falha ao gerar urls" });
  }
});

// GET /drive-file/:id
// Proxy do arquivo do Drive (imagem) sem login do cliente
app.get("/drive-file/:id", async (req, res) => {
  try {
    const fileId = req.params.id;

    const meta = await drive.files.get({
      fileId,
      fields: "mimeType,name",
      supportsAllDrives: true,
    });

    const mimeType = meta.data.mimeType || "image/jpeg";
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const file = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
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
    const { plano, uid, email } = req.body || {};
    if (!uid || !email || !plano) {
      return res.status(400).json({ error: "Dados faltando" });
    }

    // valores (ajuste aqui)
    const planos = {
      mensal: { valor: 1.0, meses: 1, acessos: 1 },
      trimestral: { valor: 64.99, meses: 3, acessos: 1 },
      anual: { valor: 149.99, meses: 12, acessos: 1 },
      anual_plus: { valor: 189.99, meses: 12, acessos: 2 },
    };

    const p = planos[plano];
    if (!p) return res.status(400).json({ error: "Plano inválido" });

    const preference = new Preference(client);

    const notificationUrl = `${mustEnv("PUBLIC_BASE_URL")}/webhook/mercadopago`;

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
        notification_url: notificationUrl,
        metadata: { uid, plano, meses: p.meses, acessos: p.acessos },
        payment_methods: {
          excluded_payment_types: [],
          excluded_payment_methods: [],
          installments: 1,
        },
      },
    });

    return res.json({ checkout_url: result.init_point });
  } catch (err) {
    console.error("🔥 ERRO CRIAR PAGAMENTO:", err?.message || err);
    return res.status(500).json({ error: "Erro ao criar pagamento" });
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
      console.log("⚠️ erro consultando pagamento:", err?.message || err);
      return res.sendStatus(200);
    }

    if (result.status !== "approved") {
      console.log("⚠️ Pagamento não aprovado:", paymentId, result.status);
      return res.sendStatus(200);
    }

    const uid = result.metadata?.uid;
    const planoMeta = result.metadata?.plano;

    if (!uid) {
      console.log("❌ metadata.uid não veio no pagamento:", paymentId);
      return res.sendStatus(200);
    }

    const planoConfig = PLANOS[planoMeta];
    if (!planoConfig) {
      console.log("❌ Plano inválido no metadata:", planoMeta);
      return res.sendStatus(200);
    }

    const userRef = db.collection("usuarios").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      console.log("❌ Usuário não encontrado por UID:", uid);
      return res.sendStatus(200);
    }

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
    console.error("🔥 ERRO WEBHOOK MP:", err?.message || err);
    return res.sendStatus(500);
  }
});

// --------------------- Healthcheck ---------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "backend-checklist", ts: Date.now() });
});

// --------------------- Start ---------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
