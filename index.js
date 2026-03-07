// backend/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const { Readable } = require("stream");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

const app = express();

// ===============================
// CORS
// ===============================
app.use(
  cors({
    origin: [
      "https://portalchecklist.netlify.app",
      process.env.PORTAL_ORIGIN, // opcional
      process.env.APP_ORIGIN, // opcional
    ].filter(Boolean),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// multer (upload por multipart)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const SIGNING_SECRET = String(process.env.SIGNING_SECRET || "").trim();

if (!SIGNING_SECRET) {
  console.warn("⚠️ SIGNING_SECRET não definido (recomendado para /drive-file assinado)");
}

// ===============================
// Firebase Admin
// ===============================
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const file = path.join(__dirname, "serviceAccountKey.json");
  if (fs.existsSync(file)) return require(file);
  throw new Error("Faltando credencial Firebase Admin (FIREBASE_SERVICE_ACCOUNT_JSON ou serviceAccountKey.json).");
}

admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount()),
});
const db = admin.firestore();

// ===============================
// Helpers
// ===============================
function readJsonFlexible(v) {
  if (!v) return null;
  const trimmed = String(v).trim();

  // JSON direto na env
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return JSON.parse(trimmed);

  // caminho de arquivo
  const abs = path.isAbsolute(trimmed) ? trimmed : path.join(__dirname, trimmed);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function mustEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Faltando ${name} no ambiente.`);
  return v;
}

function getDriveRootFolderIdOrThrow() {
  // esse é o ID da pasta "Checklists_App" OU "CHECKLISTS" (o que você preferir como root)
  // o código cria {ROOT}/CHECKLISTS/{codigoPosto}/{runId}
  return mustEnv("DRIVE_ROOT_FOLDER_ID");
}

// ===============================
// Google Drive (OAuth) ✅
// ===============================
function createDriveClient() {
  const credsVar = mustEnv("DRIVE_OAUTH_CREDENTIALS_JSON");
  const tokenVar = mustEnv("DRIVE_OAUTH_TOKEN_JSON");

  const credentials = readJsonFlexible(credsVar);
  const token = readJsonFlexible(tokenVar);

  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web;

  if (!client_id || !client_secret) {
    throw new Error("Credenciais OAuth inválidas (client_id/client_secret ausentes).");
  }

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || "http://localhost"
  );

  oAuth2Client.setCredentials(token);

  // log quando renovar
  oAuth2Client.on("tokens", (t) => {
    if (t.access_token) console.log("✅ Drive: access_token renovado");
    if (t.refresh_token) console.log("✅ Drive: NOVO refresh_token recebido (guarde!)");
  });

  return google.drive({ version: "v3", auth: oAuth2Client });
}

const drive = createDriveClient();

// valida o acesso ao root no start (log claro)
(async () => {
  try {
    const rootId = getDriveRootFolderIdOrThrow();
    const meta = await drive.files.get({ fileId: rootId, fields: "id,name,mimeType" });
    console.log("✅ Drive root OK:", meta.data?.name, rootId);
  } catch (e) {
    console.error("❌ Drive root check error:", e?.message || e);
  }
})();

async function findOrCreateFolder(name, parentId) {
  if (!parentId) throw new Error("parentId ausente em findOrCreateFolder.");

  const safeName = name.replace(/'/g, "\\'");
  const q = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${safeName}'`,
    `trashed=false`,
    `'${parentId}' in parents`,
  ].join(" and ");

  const list = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive",
  });

  if (list.data.files?.length) return list.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });

  return created.data.id;
}

async function uploadBufferToDrive({ buffer, mime, filename, parentId }) {
  if (!parentId) throw new Error("parentId ausente em uploadBufferToDrive.");

  const stream = Readable.from(buffer);

  const created = await drive.files.create({
    requestBody: { name: filename, parents: [parentId] },
    media: { mimeType: mime || "image/jpeg", body: stream },
    fields: "id",
  });

  return created.data.id;
}

async function uploadBase64ToDrive({ base64, mime, filename, parentId }) {
  if (!parentId) throw new Error("parentId ausente em uploadBase64ToDrive.");

  const buffer = Buffer.from(base64, "base64");
  const stream = Readable.from(buffer);

  const created = await drive.files.create({
    requestBody: { name: filename, parents: [parentId] },
    media: { mimeType: mime || "image/jpeg", body: stream },
    fields: "id",
  });

  return created.data.id;
}

// ===============================
// Assinatura URL (pra não expor Drive direto)
// ===============================
function signFileUrl(fileId, expiresAtMs) {
  if (!SIGNING_SECRET) return null;
  const payload = `${fileId}.${expiresAtMs}`;
  const sig = crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest("hex");
  return `${expiresAtMs}.${sig}`;
}

function verifySignedToken(fileId, token) {
  if (!SIGNING_SECRET) return false;
  if (!token) return false;

  const [expStr, sig] = String(token).split(".");
  const exp = Number(expStr);
  if (!exp || !sig) return false;
  if (Date.now() > exp) return false;

  const payload = `${fileId}.${exp}`;
  const expected = crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ===============================
// Rotas básicas
// ===============================
app.get("/", (req, res) => res.send("OK"));
app.get("/portal/ping", (req, res) => res.json({ ok: true, name: "portal-api" }));

async function requireFirebaseAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing token" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}

// ===============================
// Telegram (opcional) - 1 função só ✅
// ===============================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, skipped: true };

  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: String(TELEGRAM_CHAT_ID), text: String(text || "") }),
  }).catch(() => null);

  if (!resp || !resp.ok) return { ok: false };
  return { ok: true };
}

app.post("/app/telegram/new-user", requireFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "unauthorized" });

    const deviceFromApp = req.body?.deviceName ? String(req.body.deviceName) : "";

    const snap = await db.collection("usuarios").doc(String(uid)).get();
    if (!snap.exists) return res.status(404).json({ error: "perfil nao encontrado" });

    const u = snap.data() || {};
    const email = String(u.email || req.user?.email || "");
    const nomePosto = String(u.nomePosto || "");
    const codigoPosto = String(u.codigoPosto || "");
    const telefone = String(u.telefone || "");
    const device = deviceFromApp || String(u.deviceNameAtual1 || u.deviceName1 || "");

    const text =
      `👤 NOVO CADASTRO (APP)\n` +
      `📧 Email: ${email}\n` +
      `🆔 UID: ${uid}\n` +
      `📱 Device: ${device || "—"}\n` +
      `📞 Telefone: ${telefone || "—"}\n` +
      `🏪 Posto: ${nomePosto || "—"}\n` +
      `🏷 Código: ${codigoPosto || "—"}`;

    await sendTelegram(text);
    return res.json({ ok: true });
  } catch (e) {
    console.error("/app/telegram/new-user error:", e);
    return res.status(500).json({ error: e?.message || "falha ao enviar telegram" });
  }
});

// ===============================
// Mercado Pago (opcional)
// ===============================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
if (!MP_ACCESS_TOKEN) console.warn("⚠️ MP_ACCESS_TOKEN não definido (Mercado Pago desativado)");

const mpClient = MP_ACCESS_TOKEN ? new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN }) : null;

function mustHaveMP(req, res) {
  if (!mpClient) {
    res.status(500).json({ error: "MP_ACCESS_TOKEN não configurado no backend." });
    return false;
  }
  return true;
}

const PLANS = {
  mensal:     { label: "Mensal",      price: 1.99, months: 1,  acessos: 1 },
  trimestral: { label: "Trimestral",  price: 64.99, months: 3,  acessos: 1 },
  anual:      { label: "Anual",       price: 149.99, months: 12, acessos: 1 },
  anual_plus: { label: "Anual Plus",  price: 189.99, months: 12, acessos: 2 },
};

function calcVencimentoByPlano(planoKey) {
  const cfg = PLANS[String(planoKey)] || PLANS.mensal;
  const now = new Date();
  const venc = new Date(now);
  venc.setMonth(venc.getMonth() + Number(cfg.months || 1));
  return { venc, cfg };
}

app.post("/mp/create-preference", async (req, res) => {
  try {
    if (!mustHaveMP(req, res)) return;

    const { uid, plano, email, nomePosto } = req.body || {};
    if (!uid || !plano) return res.status(400).json({ error: "faltando uid/plano" });

    const plan = PLANS[String(plano)];
    if (!plan) return res.status(400).json({ error: "plano inválido" });

    const preference = new Preference(mpClient);
    const notification_url = `${PUBLIC_BASE_URL}/mp/webhook`;

    const result = await preference.create({
      body: {
        items: [{
          title: `Plano ${plan.label} - Análise de Combustível`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: Number(plan.price),
        }],
        payer: email ? { email: String(email) } : undefined,
        metadata: { uid: String(uid), plano: String(plano), nomePosto: nomePosto ? String(nomePosto) : "" },
        notification_url,
      },
    });

    return res.json({
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
    });
  } catch (e) {
    console.error("mp/create-preference error:", e);
    return res.status(500).json({ error: e?.message || "Falha ao criar preferência" });
  }
});

app.post("/mp/webhook", async (req, res) => {
  try {
    if (!mustHaveMP(req, res)) return;

    const type = req.query.type || req.body?.type;
    const dataId = req.query["data.id"] || req.body?.data?.id;

    res.sendStatus(200); // responde rápido

    if (type !== "payment" || !dataId) return;

    const paymentApi = new Payment(mpClient);
    const pay = await paymentApi.get({ id: String(dataId) });

    const status = pay?.status;
    const metadata = pay?.metadata || {};
    const uid = metadata?.uid;
    const plano = metadata?.plano;

    if (!uid) return;

    const userRef = db.collection("usuarios").doc(String(uid));
    const { venc, cfg } = calcVencimentoByPlano(plano);

    const patch = {
      pagamento: {
        gateway: "MERCADO_PAGO",
        paymentId: String(dataId),
        status: String(status || ""),
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
    };

    if (status === "approved") {
      patch.autorizado = true;
      patch.plano = String(plano || "mensal");
      patch.vencimento = venc;
      patch.acessosPermitidos = Number(cfg.acessos || 1);
    }

    await userRef.set(patch, { merge: true });
  } catch (e) {
    console.error("mp/webhook error:", e);
  }
});

// ===============================
// Upload de fotos (Drive OAuth) ✅
// Estrutura: {ROOT}/CHECKLISTS/{codigoPosto}/{runId}/arquivo.jpg
// ===============================

// Rota antiga base64
app.post("/upload-foto", async (req, res) => {
  try {
    const { codigoPosto, runId, itemId, mime, base64 } = req.body || {};
    if (!codigoPosto || !runId || !itemId || !base64) {
      return res.status(400).json({ error: "faltando codigoPosto/runId/itemId/base64" });
    }

    const rootId = getDriveRootFolderIdOrThrow();

    const baseFolder = await findOrCreateFolder("CHECKLISTS", rootId);
    const postoFolder = await findOrCreateFolder(String(codigoPosto), baseFolder);
    const runFolder = await findOrCreateFolder(String(runId), postoFolder);

    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const filename = `${itemId}_${Date.now()}.${ext}`;

    const fileId = await uploadBase64ToDrive({
      base64,
      mime: mime || "image/jpeg",
      filename,
      parentId: runFolder,
    });

    await db.collection("driveFiles").doc(String(fileId)).set({
      codigoPosto: String(codigoPosto),
      runId: String(runId),
      itemId: String(itemId),
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      mime: mime || "image/jpeg",
    });

    return res.json({ fileId });
  } catch (e) {
    console.error("upload-foto error:", e);
    return res.status(500).json({ error: e?.message || "Falha ao fazer upload da foto" });
  }
});

// Rota nova multipart
app.post("/upload-foto-multipart", upload.single("file"), async (req, res) => {
  try {
    const { codigoPosto, runId, itemId } = req.body || {};
    const file = req.file;

    if (!codigoPosto || !runId || !itemId || !file) {
      return res.status(400).json({ error: "faltando codigoPosto/runId/itemId/file" });
    }

    const rootId = getDriveRootFolderIdOrThrow();

    const baseFolder = await findOrCreateFolder("CHECKLISTS", rootId);
    const postoFolder = await findOrCreateFolder(String(codigoPosto), baseFolder);
    const runFolder = await findOrCreateFolder(String(runId), postoFolder);

    const mime = file.mimetype || "image/jpeg";
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const filename = `${itemId}_${Date.now()}.${ext}`;

    const fileId = await uploadBufferToDrive({
      buffer: file.buffer,
      mime,
      filename,
      parentId: runFolder,
    });

    await db.collection("driveFiles").doc(String(fileId)).set({
      codigoPosto: String(codigoPosto),
      runId: String(runId),
      itemId: String(itemId),
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      originalName: file.originalname || null,
      size: file.size || null,
      mime,
    });

    return res.json({ fileId });
  } catch (e) {
    console.error("upload-foto-multipart error:", e);
    return res.status(500).json({ error: e?.message || "Falha ao fazer upload da foto" });
  }
});

// ===============================
// Signed URLs (APP/PORTAL)
// Body: { fileIds: ["id1","id2"] }
// Retorna:
// {
//   items: [{ fileId, url }],
//   urls: { [fileId]: url },
//   expiresAt
// }
// ===============================
app.post("/signed-urls", requireFirebaseAuth, async (req, res) => {
  try {
    const { fileIds } = req.body || {};

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ error: "fileIds inválido" });
    }

    if (!SIGNING_SECRET) {
      return res.status(500).json({ error: "SIGNING_SECRET não configurado no backend" });
    }

    const exp = Date.now() + 1000 * 60 * 20; // 20 min

    const out = fileIds
      .map((id) => String(id || "").trim())
      .filter(Boolean)
      .map((id) => {
        const token = signFileUrl(id, exp);
        return {
          fileId: id,
          url: `${PUBLIC_BASE_URL}/drive-file/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`,
        };
      });

    const urls = Object.fromEntries(out.map((x) => [x.fileId, x.url]));

    return res.json({
      items: out,
      urls,
      expiresAt: exp,
    });
  } catch (e) {
    console.error("signed-urls error:", e);
    return res.status(500).json({ error: e?.message || "Falha ao gerar signed urls" });
  }

});

// ===============================
// Proxy de download (não expõe Drive)
// GET /drive-file/:fileId?token=...
// ===============================
app.get("/drive-file/:fileId", async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "");
    const token = String(req.query.token || "");

    if (!fileId) return res.status(400).send("missing fileId");

    if (SIGNING_SECRET) {
      if (!verifySignedToken(fileId, token)) return res.status(401).send("invalid token");
    } else {
      // se não configurar SIGNING_SECRET, deixa aberto (não recomendado)
      console.warn("⚠️ /drive-file sem SIGNING_SECRET (rota aberta).");
    }

    // pega metadata para content-type e nome
    const meta = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,size",
    });

    const name = meta.data?.name || `${fileId}.jpg`;
    const mimeType = meta.data?.mimeType || "application/octet-stream";

    // stream do arquivo
    const streamResp = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(name)}"`);

    streamResp.data
      .on("error", (err) => {
        console.error("drive-file stream error:", err?.message || err);
        if (!res.headersSent) res.status(500).end();
      })
      .pipe(res);
  } catch (e) {
    console.error("drive-file error:", e?.message || e);
    return res.status(500).send("drive-file failed");
  }
});

// ===============================
app.listen(PORT, () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
});
