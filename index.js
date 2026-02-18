// backend/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
const { google } = require("googleapis");
const { Readable } = require("stream");
const fs = require("fs");
const path = require("path");

const app = express();

// --------------------- ENV ---------------------
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(
  /\/+$/,
  ""
);
const SIGNING_SECRET = process.env.SIGNING_SECRET;

if (!SIGNING_SECRET) {
  console.warn("⚠️ SIGNING_SECRET não definido no .env (obrigatório para /drive-file assinado)");
}

// --------------------- CORS ---------------------
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowList = new Set([
  "http://localhost:3000",
  "http://localhost:3001",
  ...FRONTEND_ORIGINS,
]);

app.use(
  cors({
    origin(origin, cb) {
      // permite requests sem origin (curl/postman)
      if (!origin) return cb(null, true);
      if (allowList.has(origin)) return cb(null, true);
      return cb(new Error(`CORS bloqueado para: ${origin}`), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// preflight sempre ok
app.options("*", cors());

// body
app.use(express.json({ limit: "25mb" }));

// --------------------- Firebase Admin ---------------------
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const file = path.join(__dirname, "serviceAccountKey.json");
  if (fs.existsSync(file)) return require(file);
  throw new Error(
    "Faltando credencial do Firebase Admin. Use FIREBASE_SERVICE_ACCOUNT_JSON no Render ou serviceAccountKey.json local."
  );
}

const serviceAccount = loadServiceAccount();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// --------------------- Mercado Pago ---------------------
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
function readJsonFlexible(v) {
  if (!v) return null;

  const trimmed = String(v).trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const abs = path.isAbsolute(trimmed) ? trimmed : path.join(__dirname, trimmed);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function createDriveClient() {
  const credsVar = process.env.DRIVE_OAUTH_CREDENTIALS_JSON;
  const tokenVar = process.env.DRIVE_OAUTH_TOKEN_JSON;

  if (!credsVar || !tokenVar) {
    throw new Error("Faltando DRIVE_OAUTH_CREDENTIALS_JSON ou DRIVE_OAUTH_TOKEN_JSON no .env");
  }

  const credentials = readJsonFlexible(credsVar);
  const token = readJsonFlexible(tokenVar);

  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || "http://localhost"
  );

  oAuth2Client.setCredentials(token);
  return google.drive({ version: "v3", auth: oAuth2Client });
}

const drive = createDriveClient();

// --------------------- Helpers Drive ---------------------
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

// --------------------- URL ASSINADA (para <img>) ---------------------
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

// --------------------- Firebase Auth helpers ---------------------
async function getUidFromAuthHeader(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

async function getPortalPerms(uid) {
  const snap = await db.collection("usuarios").doc(uid).get();
  if (!snap.exists) return { rolePortal: null, postosPermitidos: [] };
  const data = snap.data() || {};
  return {
    rolePortal: data.rolePortal || null,
    postosPermitidos: Array.isArray(data.postosPermitidos) ? data.postosPermitidos : [],
  };
}

async function canAccessPosto(uid, codigoPosto) {
  const { rolePortal, postosPermitidos } = await getPortalPerms(uid);
  if (rolePortal === "super_admin") return true;
  if (rolePortal === "admin" && postosPermitidos.includes(String(codigoPosto))) return true;
  return false;
}

// --------------------- Portal: set-access (super_admin only) ---------------------
app.post("/portal/set-access", async (req, res) => {
  try {
    const uidRequester = await getUidFromAuthHeader(req);
    if (!uidRequester) return res.status(401).json({ error: "unauthorized" });

    const perms = await getPortalPerms(uidRequester);
    if (perms.rolePortal !== "super_admin") {
      return res.status(403).json({ error: "forbidden" });
    }

    const { targetUid, rolePortal, postosPermitidos } = req.body;
    if (!targetUid || !rolePortal) {
      return res.status(400).json({ error: "faltando targetUid/rolePortal" });
    }

    await db.collection("usuarios").doc(String(targetUid)).update({
      rolePortal: String(rolePortal),
      postosPermitidos:
        rolePortal === "super_admin"
          ? []
          : Array.isArray(postosPermitidos)
          ? postosPermitidos.map(String)
          : [],
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("portal/set-access error:", e);
    return res.status(500).json({ error: "erro ao atualizar acesso" });
  }
});

// --------------------- (Opcional) criar-posto protegido ---------------------
app.post("/criar-posto", async (req, res) => {
  try {
    const uidFromToken = await getUidFromAuthHeader(req);
    if (!uidFromToken) return res.status(401).json({ error: "unauthorized" });

    const { codigoPosto, nomePosto, uidCriador } = req.body;
    if (!codigoPosto || !nomePosto || !uidCriador) {
      return res.status(400).json({ error: "faltando codigoPosto/nomePosto/uidCriador" });
    }

    // só permite criar se o token for do próprio criador
    if (String(uidCriador) !== String(uidFromToken)) {
      return res.status(403).json({ error: "forbidden" });
    }

    const postoRef = db.collection("postos").doc(String(codigoPosto));
    const snap = await postoRef.get();

    if (!snap.exists) {
      await postoRef.set({
        nome: String(nomePosto).trim(),
        nomePosto: String(nomePosto).trim(),
        codigoPosto: String(codigoPosto),
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        criadoPorUid: String(uidCriador),
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("criar-posto error:", e);
    return res.status(500).json({ error: "falha ao criar posto" });
  }
});

// --------------------- Rotas CHECKLIST FOTO ---------------------
app.post("/upload-foto", async (req, res) => {
  try {
    const { codigoPosto, runId, itemId, mime, base64 } = req.body;

    if (!codigoPosto || !runId || !itemId || !base64) {
      return res.status(400).json({ error: "Dados faltando (codigoPosto/runId/itemId/base64)" });
    }

    const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;

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

    // meta para validar permissões e assinar com segurança
    await db.collection("driveFiles").doc(fileId).set({
      codigoPosto: String(codigoPosto),
      runId: String(runId),
      itemId: String(itemId),
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ fileId });
  } catch (e) {
    console.error("upload-foto error:", e?.message || e);
    return res.status(500).json({ error: "Falha ao fazer upload da foto" });
  }
});

app.post("/signed-urls", async (req, res) => {
  try {
    const { fileIds } = req.body;
    if (!Array.isArray(fileIds)) return res.status(400).json({ error: "fileIds inválido" });

    if (!SIGNING_SECRET) {
      return res.status(500).json({ error: "SIGNING_SECRET não configurado no backend" });
    }

    const uid = await getUidFromAuthHeader(req);

    const expiresAt = Date.now() + 15 * 60 * 1000;
    const urls = {};

    for (const id of fileIds) {
      if (!id) continue;

      // se vier auth, valida permissões do portal
      if (uid) {
        const metaSnap = await db.collection("driveFiles").doc(String(id)).get();
        if (!metaSnap.exists) continue;
        const meta = metaSnap.data();
        const ok = await canAccessPosto(uid, meta?.codigoPosto);
        if (!ok) continue;
      }

      const t = signFileUrl(String(id), expiresAt);
      urls[id] = `${PUBLIC_BASE_URL}/drive-file/${id}?t=${encodeURIComponent(t)}`;
    }

    return res.json({ urls });
  } catch (e) {
    console.error("signed-urls error:", e?.message || e);
    return res.status(500).json({ error: "Falha ao gerar urls" });
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
    if (req.body?.topic === "merchant_order") return res.sendStatus(200);

    const paymentId =
      req.body?.data?.id ||
      (typeof req.body?.resource === "string"
        ? req.body.resource.split("/").pop()
        : req.body?.resource);

    if (!paymentId) return res.sendStatus(200);

    const payment = new Payment(client);
    const result = await payment.get({ id: paymentId });

    if (result.status !== "approved") return res.sendStatus(200);

    const uid = result.metadata?.uid;
    const planoMeta = result.metadata?.plano;
    const planoConfig = PLANOS[planoMeta];
    if (!uid || !planoConfig) return res.sendStatus(200);

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

    return res.sendStatus(200);
  } catch (err) {
    console.error("🔥 ERRO WEBHOOK MP:", err);
    return res.sendStatus(500);
  }
});

// --------------------- Health ---------------------
app.get("/", (req, res) => res.send("OK"));
app.get("/portal/ping", (req, res) => {
  res.json({ ok: true, name: "portal-api" });
});

// --------------------- Listen ---------------------
app.listen(PORT, () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
});
