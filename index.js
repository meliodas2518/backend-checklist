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

/**
 * ✅ CORS
 * - Em produção, o app (Expo Go) não precisa de CORS, mas seu Portal Web precisa.
 * - Coloque seu domínio do portal aqui se quiser travar.
 * - Como você usa Render e talvez Netlify, deixei permissivo com fallback.
 */
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

app.use(express.json({ limit: "25mb" })); // mantém base64 compatível (rota antiga)
app.use(express.urlencoded({ extended: true })); // necessário p/ multipart

// ✅ multer (upload rápido por multipart)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const SIGNING_SECRET = process.env.SIGNING_SECRET;

if (!SIGNING_SECRET) {
  console.warn("⚠️ SIGNING_SECRET não definido (obrigatório para /drive-file assinado)");
}

// ---------- Firebase Admin ----------
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const file = path.join(__dirname, "serviceAccountKey.json");
  if (fs.existsSync(file)) return require(file);
  throw new Error("Faltando credencial Firebase Admin.");
}

admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount()),
});
const db = admin.firestore();

// ---------- Google Drive (OAuth) ----------
function readJsonFlexible(v) {
  if (!v) return null;
  const trimmed = String(v).trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return JSON.parse(trimmed);

  const abs = path.isAbsolute(trimmed) ? trimmed : path.join(__dirname, trimmed);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function createDriveClient() {
  const credsVar = process.env.DRIVE_OAUTH_CREDENTIALS_JSON;
  const tokenVar = process.env.DRIVE_OAUTH_TOKEN_JSON;

  if (!credsVar || !tokenVar) {
    throw new Error("Faltando DRIVE_OAUTH_CREDENTIALS_JSON ou DRIVE_OAUTH_TOKEN_JSON");
  }

  const credentials = readJsonFlexible(credsVar);
  const token = readJsonFlexible(tokenVar);

  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || "http://localhost"
  );

  oAuth2Client.setCredentials(token);
  return google.drive({ version: "v3", auth: oAuth2Client });
}

const drive = createDriveClient();

async function findOrCreateFolder(name, parentId) {
  const safeName = name.replace(/'/g, "\\'");
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

  if (list.data.files?.length) return list.data.files[0].id;

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

// ✅ upload via buffer (multipart)
async function uploadBufferToDrive({ buffer, mime, filename, parentId }) {
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

// ---------- Assinatura URL ----------
function signFileUrl(fileId, expiresAtMs) {
  const payload = `${fileId}.${expiresAtMs}`;
  const sig = crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest("hex");
  return `${expiresAtMs}.${sig}`;
}

function verifySignedToken(fileId, token) {
  if (!SIGNING_SECRET) return false;
  if (!token) return false;

  const [expStr, sig] = token.split(".");
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

// ---------- Rotas ----------
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
  } catch (e) {
    return res.status(401).json({ error: "invalid token" });
  }
}

async function requireSuperAdmin(req, res, next) {
  try {
    const uid = req.user?.uid;
    const snap = await db.collection("usuarios").doc(uid).get();
    const role = snap.exists ? snap.data()?.rolePortal : null;
    if (role !== "super_admin") return res.status(403).json({ error: "only super_admin" });
    next();
  } catch (e) {
    return res.status(500).json({ error: "role check failed" });
  }
}

app.post("/portal/set-access", requireFirebaseAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { targetUid, rolePortal, postosPermitidos } = req.body || {};

    if (!targetUid) return res.status(400).json({ error: "targetUid obrigatório" });
    if (!rolePortal || !["admin", "super_admin"].includes(String(rolePortal)))
      return res.status(400).json({ error: "rolePortal inválido" });

    const lista = Array.isArray(postosPermitidos) ? postosPermitidos.map(String) : [];

    const patch = {
      rolePortal: String(rolePortal),
      postosPermitidos: rolePortal === "super_admin" ? [] : lista,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("usuarios").doc(String(targetUid)).set(patch, { merge: true });
    return res.json({ ok: true });
  } catch (e) {
    console.error("set-access error:", e);
    return res.status(500).json({ error: e?.message || "Falha ao atualizar acesso" });
  }
});
// ---------- Mercado Pago ----------
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
if (!MP_ACCESS_TOKEN) {
  console.warn("⚠️ MP_ACCESS_TOKEN não definido (Mercado Pago desativado)");
}

const mpClient = MP_ACCESS_TOKEN
  ? new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN })
  : null;

function mustHaveMP(req, res) {
  if (!mpClient) {
    res.status(500).json({ error: "MP_ACCESS_TOKEN não configurado no backend." });
    return false;
  }
  return true;
}
// ✅ TABELA DE PLANOS (UI + BACKEND)
const PLANS = {
  mensal:     { label: "Mensal",      price: 24.99, months: 1,  acessos: 1 },
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
/**
 * ✅ Criar preferência (gera link de pagamento)
 * Body esperado:
 * {
 *   uid: "uid do usuário",
 *   plano: "mensal" | "trimestral" | "anual" | "anual_plus",
 *   email: "email do pagador",
 *   nomePosto: "..."
 * }
 */
app.post("/mp/create-preference", async (req, res) => {
  try {
    if (!mustHaveMP(req, res)) return;

    const { uid, plano, email, nomePosto } = req.body || {};
    if (!uid || !plano) {
      return res.status(400).json({ error: "faltando uid/plano" });
    }

    const plan = PLANS[String(plano)];
    if (!plan) return res.status(400).json({ error: "plano inválido" });

    const preference = new Preference(mpClient);
    const notification_url = `${PUBLIC_BASE_URL}/mp/webhook`;

    const result = await preference.create({
      body: {
        items: [
          {
            title: `Plano ${plan.label} - Análise de Combustível`,
            quantity: 1,
            currency_id: "BRL",
            unit_price: Number(plan.price),
          },
        ],
        payer: email ? { email: String(email) } : undefined,
        metadata: {
          uid: String(uid),
          plano: String(plano),
          nomePosto: nomePosto ? String(nomePosto) : "",
        },
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

/**
 * ✅ Webhook do Mercado Pago
 * O MP manda: ?type=payment&data.id=xxxx (ou em body dependendo do modo)
 */
app.post("/mp/webhook", async (req, res) => {
  try {
    if (!mustHaveMP(req, res)) return;

    const type = req.query.type || req.body?.type;
    const dataId = req.query["data.id"] || req.body?.data?.id;

    // Sempre responde 200 rápido pro MP não ficar reenviando
    res.sendStatus(200);

    if (type !== "payment" || !dataId) return;

    const paymentApi = new Payment(mpClient);
    const pay = await paymentApi.get({ id: String(dataId) });

    const status = pay?.status; // approved, rejected, pending...
    const metadata = pay?.metadata || {};
    const uid = metadata?.uid;
    const plano = metadata?.plano;

    if (!uid) {
      console.log("mp/webhook: pagamento sem uid no metadata", dataId);
      return;
    }

    // ✅ Atualiza Firestore via Admin SDK (não depende de rules)
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

    console.log("mp/webhook ok:", dataId, status, uid, plano);
  } catch (e) {
    console.error("mp/webhook error:", e);
    // não responde aqui porque já respondemos 200
  }
});

/**
 * ✅ Consultar status manual (debug)
 * GET /mp/payment-status/:id
 */
app.get("/mp/payment-status/:id", async (req, res) => {
  try {
    if (!mustHaveMP(req, res)) return;

    const paymentApi = new Payment(mpClient);
    const pay = await paymentApi.get({ id: String(req.params.id) });

    return res.json({
      id: pay.id,
      status: pay.status,
      status_detail: pay.status_detail,
      metadata: pay.metadata,
      payer: pay.payer?.email,
      transaction_amount: pay.transaction_amount,
    });
  } catch (e) {
    console.error("mp/payment-status error:", e);
    return res.status(500).json({ error: e?.message || "Falha ao consultar pagamento" });
  }
});
/**
 * ✅ ROTA ANTIGA (base64)
 * Mantive para compatibilidade.
 * Se quiser mais rápido: use /upload-foto-multipart no app.
 */
app.post("/upload-foto", async (req, res) => {
  try {
    const { codigoPosto, runId, itemId, mime, base64 } = req.body;

    if (!codigoPosto || !runId || !itemId || !base64) {
      return res.status(400).json({ error: "faltando codigoPosto/runId/itemId/base64" });
    }

    const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;

    // CHECKLISTS/{codigoPosto}/{runId}/arquivo.jpg
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
    });

    return res.json({ fileId });
  } catch (e) {
    console.error("upload-foto error:", e);
    // ✅ mostra erro real no Render pra você diagnosticar mais fácil
    return res.status(500).json({ error: e?.message || "Falha ao fazer upload da foto" });
  }
});

/**
 * ✅ ROTA NOVA (MULTIPART) - MUITO MAIS RÁPIDA
 * No app, envie FormData com:
 * - codigoPosto, runId, itemId
 * - file (jpeg/png)
 */
app.post("/upload-foto-multipart", upload.single("file"), async (req, res) => {
  try {
    const { codigoPosto, runId, itemId } = req.body;
    const file = req.file;

    if (!codigoPosto || !runId || !itemId || !file) {
      return res.status(400).json({ error: "faltando codigoPosto/runId/itemId/file" });
    }

    const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;

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

// Gera URLs assinadas (APP e PORTAL)
app.post("/signed-urls", async (req, res) => {
  try {
    const { fileIds } = req.body;
    if (!Array.isArray(fileIds)) return res.status(400).json({ error: "fileIds inválido" });
    if (!SIGNING_SECRET) return res.status(500).json({ error: "SIGNING_SECRET não configurado" });

    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 min
    const urls = {};

    for (const id of fileIds) {
      if (!id) continue;
      const token = signFileUrl(String(id), expiresAt);
      urls[id] = `${PUBLIC_BASE_URL}/drive-file/${id}?t=${encodeURIComponent(token)}`;
    }

    return res.json({ urls });
  } catch (e) {
    console.error("signed-urls error:", e);
    return res.status(500).json({ error: e?.message || "Falha ao gerar urls" });
  }
});

app.get("/drive-file/:id", async (req, res) => {
  try {
    const fileId = String(req.params.id);
    const token = String(req.query.t || "");

    if (!SIGNING_SECRET) return res.status(500).send("SIGNING_SECRET missing");
    if (!verifySignedToken(fileId, token)) return res.status(403).send("forbidden");

    const meta = await drive.files.get({ fileId, fields: "mimeType,name" });
    const mimeType = meta.data.mimeType || "image/jpeg";

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=900");

    const file = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });

    file.data.on("error", (err) => {
      console.error("Drive stream error:", err);
      res.sendStatus(500);
    });

    file.data.pipe(res);
  } catch (e) {
    console.error("drive-file error:", e);
    return res.sendStatus(404);
  }
});

app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
