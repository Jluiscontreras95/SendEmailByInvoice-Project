import mysql from "mysql2/promise";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import cron from "node-cron";
import dotenv from "dotenv";
import fs from "fs";
import handlebars from "handlebars";
import crypto from "crypto";
import { ImapFlow } from "imapflow";

dotenv.config();

// 🔹 Carpeta de logs
if (!fs.existsSync("logs")) fs.mkdirSync("logs");

// 🔹 Función para escribir logs
function log(message, level = "INFO") {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toISOString();
  const logMessage = `[${time}] [${level}] ${message}\n`;
  fs.appendFileSync(`logs/app-${date}.log`, logMessage);
}

// 🔹 Cargar plantilla
const templateSource = fs.readFileSync("templates/notification.html", "utf-8");
const template = handlebars.compile(templateSource);

// 🔹 Conexión a MySQL
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// 🔹 Configuración del transporte de correo (SMTP)
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  logger: false, // no imprimir logs en consola
  debug: false,
});

// 🔹 Configuración IMAP
const imapClient = new ImapFlow({
  host: process.env.IMAP_HOST,
  port: process.env.IMAP_PORT,
  secure: true,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  logger: false, // silencia logs de imapflow
});

// 🔹 Generar mensaje raw para guardar en IMAP
async function generarRaw(message) {
  return new Promise((resolve, reject) => {
    const mail = new MailComposer(message);
    mail.compile().build((err, msg) => {
      if (err) reject(err);
      else resolve(msg);
    });
  });
}

// 🔹 Guardar en "Sent"
async function guardarEnEnviados(raw) {
  await imapClient.connect();
  try {
    await imapClient.append("INBOX.Sent", raw, ["\\Seen"], new Date());
    log(`Correo guardado en carpeta Enviados`);
  } catch (err) {
    log(`Error guardando en Enviados: ${err.message}`, "ERROR");
  } finally {
    await imapClient.logout();
  }
}

// 🔹 Revisar registros nuevos
async function revisarRegistros() {
  try {
    const [rows] = await db.query(`
      SELECT qdocumento.doccon, qdocumento.docclicod, qdocumento.docenviado, qdocumento.doceje, qdocumento.docfec, qdocumento.docimptot,
             qdocumento_fichero.qdocumento_id,
             users.name, users.email, users.id
      FROM qdocumento
      JOIN users ON qdocumento.docclicod = users.usuclicod
      JOIN qdocumento_fichero ON qdocumento.doccon = qdocumento_fichero.qdocumento_id
      WHERE (qdocumento.docenviado = 0 OR qdocumento.docenviado IS NULL OR qdocumento.docenviado = '')
        AND qdocumento.doctip = "FC"
        AND qdocumento.docfec >= '2025-09-02'
      ORDER BY qdocumento.doccon DESC
    `);

    if (!rows || rows.length === 0) {
      log("No hay registros nuevos para procesar.");
      return;
    }

    for (const row of rows) {
      const token = crypto.randomBytes(32).toString("hex");

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db.query(
        `INSERT INTO access_tokens (user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`,
        [row.id, token, expiresAt]
      );
      log(`Token generado para usuario ${row.email}: ${token}`);

      const link = `https://gabinetetic.com/documentos/Facturas?token=${token}`;

      const html = template({
        nombre: row.name || "usuario",
        doccon: row.doccon,
        docid: row.qdocumento_id,
        doceje: row.doceje,
        docfec: row.docfec,
        docimptot: row.docimptot,
        link: link,
      });

      const message = {
        from: `"QNotify" <${process.env.MAIL_USER}>`,
        to: row.email,
        subject: "Notificación automática",
        html,
      };

      const info = await transporter.sendMail(message);
      log(
        `Correo enviado a ${row.email} (Doccon: ${row.doccon}) | MessageId: ${info.messageId}`
      );

      if (info.messageId) {
        const rawMessage = await generarRaw(message);
        await guardarEnEnviados(rawMessage);
      }

      await db.query("UPDATE qdocumento SET docenviado = 1 WHERE doccon = ?", [
        row.doccon,
      ]);
    }
  } catch (err) {
    log(`Error revisando registros: ${err.message}`, "ERROR");
  }
}

// 🔹 Ejecutar cada minuto
cron.schedule("* * * * *", async () => {
  console.log("⏳ Iniciando revisión de registros...");
  await revisarRegistros();
  console.log("✅ Proceso de revisión finalizado");
});
